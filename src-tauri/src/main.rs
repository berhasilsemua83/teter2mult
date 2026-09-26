#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// main.rs
// Backend Tauri dengan sistem MULTI-PROFIL: satu aplikasi bisa menyimpan
// beberapa profil (masing-masing = 1 akun Threads + kredensial + folder
// proyek + jadwal sendiri). Semua profil disimpan dalam satu file
// profiles.json, dan nama task di Task Scheduler diberi akhiran unik
// per profil supaya tidak saling menimpa.

use serde::{Deserialize, Serialize};
use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

// ====== SCRIPT DIEMBED LANGSUNG KE DALAM APLIKASI ======
const SCRIPT_THREAD_POSTER: &str = include_str!("../scripts/thread-poster.js");
const SCRIPT_REPLY_CHECKER: &str = include_str!("../scripts/reply-checker.js");
const SCRIPT_COMMENT_RESPONDER: &str = include_str!("../scripts/comment-responder.js");
const SCRIPT_REFRESH_TOKEN: &str = include_str!("../scripts/refresh-token.js");
const SCRIPT_REPLY_MANUAL: &str = include_str!("../scripts/reply-manual.js");
const SCRIPT_TRIGGER_RULES: &str = include_str!("../scripts/trigger-rules.json");
const SCRIPT_PACKAGE_JSON: &str = include_str!("../scripts/package.json");

// ====== STRUKTUR DATA ======

#[derive(Serialize, Deserialize, Clone, Default)]
struct CloudinaryConfig {
    cloud_name: String,
    api_key: String,
    api_secret: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct ScheduleConfig {
    thread_poster_times: Vec<String>,
    reply_checker_interval_minutes: u32,
    comment_responder_interval_minutes: u32,
    refresh_token_day: String,
    refresh_token_time: String,
}

// Satu Profile = satu akun Threads lengkap dengan semua pengaturannya.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Profile {
    id: String,
    name: String,
    threads_user_id: String,
    threads_access_token: String,
    cloudinary: CloudinaryConfig,
    gemini_api_keys: Vec<String>,
    ai_reply_enabled: bool,
    queue_folder: String,
    posted_folder: String,
    node_exe_path: String,
    project_folder: String,
    schedule: ScheduleConfig,
    ai_style_preset: String,
    ai_max_sentences: u32,
    ai_custom_instruction: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct ProfilesStore {
    profiles: Vec<Profile>,
    active_profile_id: String,
}

#[derive(Serialize, Clone)]
struct ProfileSummary {
    id: String,
    name: String,
}

fn new_profile_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("p{millis}")
}

fn default_profile(name: &str) -> Profile {
    let mut p = Profile::default();
    p.id = new_profile_id();
    p.name = name.to_string();
    p.gemini_api_keys = vec!["".to_string()];
    p.schedule.thread_poster_times = vec!["07:00".to_string()];
    p.schedule.reply_checker_interval_minutes = 5;
    p.schedule.comment_responder_interval_minutes = 15;
    p.schedule.refresh_token_day = "MON".to_string();
    p.schedule.refresh_token_time = "03:00".to_string();
    p.ai_style_preset = "ramah_sopan".to_string();
    p.ai_max_sentences = 2;
    p
}

// Ubah nama profil jadi "slug" aman dipakai di nama task Task Scheduler
// (huruf/angka saja, spasi & simbol lain jadi underscore)
fn slugify(input: &str) -> String {
    let cleaned: String = input
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    if cleaned.is_empty() {
        "profil".to_string()
    } else {
        cleaned
    }
}

// ====================================================
// PENYIMPANAN profiles.json
// ====================================================

fn profiles_file_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Gagal menemukan folder data aplikasi: {e}"))?;

    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Gagal membuat folder data: {e}"))?;
    }

    Ok(dir.join("profiles.json"))
}

fn read_store(app: &tauri::AppHandle) -> Result<ProfilesStore, String> {
    let path = profiles_file_path(app)?;

    if !path.exists() {
        // Belum pernah dipakai sama sekali -> buat 1 profil default otomatis
        let default = default_profile("Profil 1");
        let store = ProfilesStore {
            active_profile_id: default.id.clone(),
            profiles: vec![default],
        };
        write_store(app, &store)?;
        return Ok(store);
    }

    let content = fs::read_to_string(&path).map_err(|e| format!("Gagal membaca profiles.json: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("profiles.json rusak/tidak valid: {e}"))
}

fn write_store(app: &tauri::AppHandle, store: &ProfilesStore) -> Result<(), String> {
    let path = profiles_file_path(app)?;
    let content = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Gagal mengubah profiles jadi JSON: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("Gagal menyimpan profiles.json: {e}"))
}

#[tauri::command]
fn list_profiles(app: tauri::AppHandle) -> Result<Vec<ProfileSummary>, String> {
    let store = read_store(&app)?;
    Ok(store
        .profiles
        .iter()
        .map(|p| ProfileSummary { id: p.id.clone(), name: p.name.clone() })
        .collect())
}

// Ambil profil aktif (dipakai saat app pertama kali dibuka)
#[tauri::command]
fn get_active_profile(app: tauri::AppHandle) -> Result<Profile, String> {
    let store = read_store(&app)?;

    if let Some(p) = store.profiles.iter().find(|p| p.id == store.active_profile_id) {
        return Ok(p.clone());
    }
    // Kalau active_profile_id tidak valid, pakai profil pertama
    if let Some(p) = store.profiles.first() {
        return Ok(p.clone());
    }
    Err("Tidak ada profil sama sekali.".into())
}

#[tauri::command]
fn load_profile(app: tauri::AppHandle, id: String) -> Result<Profile, String> {
    let store = read_store(&app)?;
    store
        .profiles
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| format!("Profil dengan id {id} tidak ditemukan."))
}

#[tauri::command]
fn create_profile(app: tauri::AppHandle, name: String) -> Result<Profile, String> {
    let mut store = read_store(&app)?;
    let new_p = default_profile(if name.trim().is_empty() { "Profil Baru" } else { &name });
    store.profiles.push(new_p.clone());
    store.active_profile_id = new_p.id.clone();
    write_store(&app, &store)?;
    Ok(new_p)
}

#[tauri::command]
fn delete_profile(app: tauri::AppHandle, id: String) -> Result<Vec<ProfileSummary>, String> {
    let mut store = read_store(&app)?;

    // Hapus juga task Task Scheduler milik profil ini biar tidak nyangkut
    if let Some(p) = store.profiles.iter().find(|p| p.id == id) {
        cleanup_tasks_for_profile(&p.name);
    }

    store.profiles.retain(|p| p.id != id);

    if store.active_profile_id == id {
        store.active_profile_id = store.profiles.first().map(|p| p.id.clone()).unwrap_or_default();
    }

    write_store(&app, &store)?;

    Ok(store
        .profiles
        .iter()
        .map(|p| ProfileSummary { id: p.id.clone(), name: p.name.clone() })
        .collect())
}

fn upsert_profile_in_store(app: &tauri::AppHandle, profile: &Profile) -> Result<(), String> {
    let mut store = read_store(app)?;

    if let Some(existing) = store.profiles.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile.clone();
    } else {
        store.profiles.push(profile.clone());
    }
    store.active_profile_id = profile.id.clone();

    write_store(app, &store)
}

// ====================================================
// SINKRONISASI .env dan ai-style.json (per profil)
// ====================================================

fn sync_env_file(profile: &Profile) -> Result<(), String> {
    if profile.project_folder.trim().is_empty() {
        return Ok(());
    }

    let gemini_keys_joined = profile.gemini_api_keys.join(",");

    let content = format!(
        "THREADS_USER_ID={}\nTHREADS_ACCESS_TOKEN={}\nCLOUDINARY_CLOUD_NAME={}\nCLOUDINARY_API_KEY={}\nCLOUDINARY_API_SECRET={}\nGEMINI_API_KEYS={}\nQUEUE_FOLDER={}\nPOSTED_FOLDER={}\n",
        profile.threads_user_id,
        profile.threads_access_token,
        profile.cloudinary.cloud_name,
        profile.cloudinary.api_key,
        profile.cloudinary.api_secret,
        gemini_keys_joined,
        profile.queue_folder,
        profile.posted_folder,
    );

    let env_path = format!("{}\\.env", profile.project_folder.trim_end_matches('\\'));
    fs::write(&env_path, content).map_err(|e| format!("Gagal menulis .env: {e}"))
}

fn sync_ai_style_file(profile: &Profile) -> Result<(), String> {
    if profile.project_folder.trim().is_empty() {
        return Ok(());
    }

    #[derive(Serialize)]
    struct AiStyleFile {
        style_preset: String,
        max_sentences: u32,
        custom_instruction: String,
    }

    let style = AiStyleFile {
        style_preset: if profile.ai_style_preset.is_empty() {
            "ramah_sopan".to_string()
        } else {
            profile.ai_style_preset.clone()
        },
        max_sentences: if profile.ai_max_sentences == 0 { 2 } else { profile.ai_max_sentences },
        custom_instruction: profile.ai_custom_instruction.clone(),
    };

    let content = serde_json::to_string_pretty(&style)
        .map_err(|e| format!("Gagal membuat ai-style.json: {e}"))?;

    let path = format!("{}\\ai-style.json", profile.project_folder.trim_end_matches('\\'));
    fs::write(&path, content).map_err(|e| format!("Gagal menulis ai-style.json: {e}"))
}

#[tauri::command]
fn save_profile(app: tauri::AppHandle, profile: Profile) -> Result<(), String> {
    upsert_profile_in_store(&app, &profile)?;
    sync_env_file(&profile)?;
    sync_ai_style_file(&profile)?;
    Ok(())
}

// ====================================================
// MANAJEMEN TASK SCHEDULER (nama task diberi akhiran per-profil)
// ====================================================

const MAX_THREAD_POSTER_SLOTS: u32 = 30;

fn task_name_thread_poster(slug: &str, index: u32) -> String {
    format!("ThreadsAutomator_{slug}_ThreadPoster_{index}")
}
fn task_name_reply_checker(slug: &str) -> String {
    format!("ThreadsAutomator_{slug}_ReplyChecker")
}
fn task_name_comment_responder(slug: &str) -> String {
    format!("ThreadsAutomator_{slug}_CommentResponder")
}
fn task_name_refresh_token(slug: &str) -> String {
    format!("ThreadsAutomator_{slug}_RefreshToken")
}

fn run_schtasks(args: &[&str]) -> String {
    let output = Command::new("schtasks").args(args).output();
    match output {
        Ok(out) => {
            if out.status.success() {
                format!("OK: schtasks {}", args.join(" "))
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr);
                format!("GAGAL: schtasks {} -> {}", args.join(" "), stderr.trim())
            }
        }
        Err(e) => format!("ERROR menjalankan schtasks: {e}"),
    }
}

fn delete_task_silent(name: &str) {
    let _ = Command::new("schtasks").args(["/Delete", "/TN", name, "/F"]).output();
}

// Dipanggil saat profil dihapus, supaya task-nya ikut hilang dari Task Scheduler
fn cleanup_tasks_for_profile(profile_name: &str) {
    let slug = slugify(profile_name);
    for i in 1..=MAX_THREAD_POSTER_SLOTS {
        delete_task_silent(&task_name_thread_poster(&slug, i));
    }
    delete_task_silent(&task_name_reply_checker(&slug));
    delete_task_silent(&task_name_comment_responder(&slug));
    delete_task_silent(&task_name_refresh_token(&slug));
}

fn build_tr_value(node_exe: &str, script_path: &str) -> String {
    format!("\"{node_exe}\" \"{script_path}\"")
}

#[tauri::command]
fn apply_schedule(app: tauri::AppHandle, profile: Profile) -> Result<Vec<String>, String> {
    upsert_profile_in_store(&app, &profile)?;
    sync_env_file(&profile)?;
    sync_ai_style_file(&profile)?;

    if profile.node_exe_path.trim().is_empty() {
        return Err("Path node.exe belum diisi.".into());
    }
    if profile.project_folder.trim().is_empty() {
        return Err("Folder proyek (tempat file .js) belum diisi.".into());
    }

    let slug = slugify(&profile.name);
    let mut log: Vec<String> = Vec::new();
    let node_exe = &profile.node_exe_path;
    let project = profile.project_folder.trim_end_matches('\\');

    // ---------- 1. THREAD POSTER ----------
    for i in 1..=MAX_THREAD_POSTER_SLOTS {
        delete_task_silent(&task_name_thread_poster(&slug, i));
    }

    let script_path = format!("{project}\\thread-poster.js");
    let tr_value = build_tr_value(node_exe, &script_path);

    for (idx, time) in profile.schedule.thread_poster_times.iter().enumerate() {
        let name = task_name_thread_poster(&slug, (idx as u32) + 1);
        let result = run_schtasks(&[
            "/Create", "/SC", "DAILY", "/ST", time, "/TN", &name, "/TR", &tr_value,
            "/RU", "SYSTEM", "/F",
        ]);
        log.push(format!("[{} - Thread Poster @ {time}] {result}", profile.name));
    }

    // ---------- 2. REPLY CHECKER ----------
    let name_rc = task_name_reply_checker(&slug);
    delete_task_silent(&name_rc);
    if profile.schedule.reply_checker_interval_minutes > 0 {
        let script_path = format!("{project}\\reply-checker.js");
        let tr_value = build_tr_value(node_exe, &script_path);
        let interval = profile.schedule.reply_checker_interval_minutes.to_string();

        let result = run_schtasks(&[
            "/Create", "/SC", "MINUTE", "/MO", &interval, "/TN", &name_rc, "/TR", &tr_value,
            "/RU", "SYSTEM", "/F",
        ]);
        log.push(format!("[{} - Reply Checker tiap {interval} menit] {result}", profile.name));
    } else {
        log.push(format!("[{}] Reply Checker dilewati (interval 0).", profile.name));
    }

    // ---------- 3. COMMENT RESPONDER ----------
    let name_cr = task_name_comment_responder(&slug);
    delete_task_silent(&name_cr);
    if profile.ai_reply_enabled && profile.schedule.comment_responder_interval_minutes > 0 {
        let script_path = format!("{project}\\comment-responder.js");
        let tr_value = build_tr_value(node_exe, &script_path);
        let interval = profile.schedule.comment_responder_interval_minutes.to_string();

        let result = run_schtasks(&[
            "/Create", "/SC", "MINUTE", "/MO", &interval, "/TN", &name_cr, "/TR", &tr_value,
            "/RU", "SYSTEM", "/F",
        ]);
        log.push(format!("[{} - Comment Responder tiap {interval} menit] {result}", profile.name));
    } else {
        log.push(format!("[{}] Comment Responder dilewati (toggle AI nonaktif).", profile.name));
    }

    // ---------- 4. REFRESH TOKEN ----------
    let name_rt = task_name_refresh_token(&slug);
    delete_task_silent(&name_rt);
    if !profile.schedule.refresh_token_day.trim().is_empty()
        && !profile.schedule.refresh_token_time.trim().is_empty()
    {
        let script_path = format!("{project}\\refresh-token.js");
        let tr_value = build_tr_value(node_exe, &script_path);

        let result = run_schtasks(&[
            "/Create", "/SC", "WEEKLY", "/D", &profile.schedule.refresh_token_day,
            "/ST", &profile.schedule.refresh_token_time, "/TN", &name_rt, "/TR", &tr_value,
            "/RU", "SYSTEM", "/F",
        ]);
        log.push(format!("[{} - Refresh Token] {result}", profile.name));
    } else {
        log.push(format!("[{}] Refresh Token dilewati (hari/jam belum diisi).", profile.name));
    }

    Ok(log)
}

// ====================================================
// SETUP OTOMATIS (folder + file + npm install), per profil
// ====================================================

fn write_embedded_if_missing(project: &str, filename: &str, content: &str) -> String {
    let path = format!("{project}\\{filename}");
    if std::path::Path::new(&path).exists() {
        return format!("DILEWATI: {filename} sudah ada, tidak ditimpa.");
    }
    match fs::write(&path, content) {
        Ok(_) => format!("OK: {filename} dibuat."),
        Err(e) => format!("GAGAL menulis {filename}: {e}"),
    }
}

fn write_embedded_always(project: &str, filename: &str, content: &str) -> String {
    let path = format!("{project}\\{filename}");
    match fs::write(&path, content) {
        Ok(_) => format!("OK: {filename} ditulis/diupdate."),
        Err(e) => format!("GAGAL menulis {filename}: {e}"),
    }
}

#[tauri::command]
fn setup_project(app: tauri::AppHandle, profile: Profile) -> Result<Vec<String>, String> {
    if profile.project_folder.trim().is_empty() {
        return Err("Isi dulu Folder Proyek sebelum menjalankan Setup Otomatis.".into());
    }
    if profile.node_exe_path.trim().is_empty() {
        return Err("Isi dulu Path node.exe sebelum menjalankan Setup Otomatis.".into());
    }

    let project = profile.project_folder.trim_end_matches('\\').to_string();
    let mut log: Vec<String> = Vec::new();

    if !std::path::Path::new(&project).exists() {
        fs::create_dir_all(&project).map_err(|e| format!("Gagal membuat folder proyek: {e}"))?;
        log.push(format!("OK: folder proyek dibuat di {project}"));
    } else {
        log.push("DILEWATI: folder proyek sudah ada.".into());
    }

    log.push(write_embedded_always(&project, "thread-poster.js", SCRIPT_THREAD_POSTER));
    log.push(write_embedded_always(&project, "reply-checker.js", SCRIPT_REPLY_CHECKER));
    log.push(write_embedded_always(&project, "comment-responder.js", SCRIPT_COMMENT_RESPONDER));
    log.push(write_embedded_always(&project, "refresh-token.js", SCRIPT_REFRESH_TOKEN));
    log.push(write_embedded_always(&project, "reply-manual.js", SCRIPT_REPLY_MANUAL));
    log.push(write_embedded_if_missing(&project, "trigger-rules.json", SCRIPT_TRIGGER_RULES));
    log.push(write_embedded_if_missing(&project, "package.json", SCRIPT_PACKAGE_JSON));

    let queue_path = if profile.queue_folder.trim().is_empty() {
        format!("{project}\\queue")
    } else {
        profile.queue_folder.clone()
    };
    let posted_path = if profile.posted_folder.trim().is_empty() {
        format!("{project}\\posted")
    } else {
        profile.posted_folder.clone()
    };

    for (label, path) in [("queue", &queue_path), ("posted", &posted_path)] {
        if !std::path::Path::new(path).exists() {
            fs::create_dir_all(path).map_err(|e| format!("Gagal membuat folder {label}: {e}"))?;
            log.push(format!("OK: folder {label} dibuat di {path}"));
        } else {
            log.push(format!("DILEWATI: folder {label} sudah ada."));
        }
    }

    let mut updated_profile = profile.clone();
    if updated_profile.queue_folder.trim().is_empty() {
        updated_profile.queue_folder = queue_path;
    }
    if updated_profile.posted_folder.trim().is_empty() {
        updated_profile.posted_folder = posted_path;
    }

    upsert_profile_in_store(&app, &updated_profile)?;
    sync_env_file(&updated_profile)?;
    sync_ai_style_file(&updated_profile)?;
    log.push("OK: .env dan ai-style.json ditulis.".into());

    let node_dir = std::path::Path::new(&profile.node_exe_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let npm_path = format!("{node_dir}\\npm.cmd");

    log.push(format!("Menjalankan npm install di {project} (bisa beberapa menit)..."));

    let npm_output = Command::new(&npm_path).arg("install").current_dir(&project).output();

    match npm_output {
        Ok(out) => {
            if out.status.success() {
                log.push("OK: npm install selesai.".into());
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr);
                log.push(format!("GAGAL: npm install -> {}", stderr.trim()));
            }
        }
        Err(e) => {
            log.push(format!("ERROR menjalankan npm install: {e}. Pastikan npm.cmd ada di {npm_path}"));
        }
    }

    log.push("SELESAI. Folder proyek siap dipakai.".into());

    Ok(log)
}

#[tauri::command]
fn detect_node_path() -> Result<String, String> {
    let output = Command::new("where")
        .arg("node")
        .output()
        .map_err(|e| format!("Gagal menjalankan 'where node': {e}"))?;

    if !output.status.success() {
        return Err("node.exe tidak ditemukan di PATH. Isi manual path-nya.".into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_line = stdout.lines().next().unwrap_or("").trim();

    if first_line.is_empty() {
        Err("node.exe tidak ditemukan.".into())
    } else {
        Ok(first_line.to_string())
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            get_active_profile,
            load_profile,
            create_profile,
            delete_profile,
            save_profile,
            apply_schedule,
            setup_project,
            detect_node_path
        ])
        .run(tauri::generate_context!())
        .expect("Gagal menjalankan aplikasi Tauri");
}