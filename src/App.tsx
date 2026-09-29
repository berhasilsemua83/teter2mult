import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

// ====================================================
// ISI TEKS MANUAL BOOK
// ====================================================
const MANUAL_BOOK_TEXT = `=========================================================
      BUKU PANDUAN PENGGUNA (USER MANUAL)
            THREADS AUTOMATOR v2.0
=========================================================

DAFTAR ISI:
1. Persiapan Kredensial (API & Token)
2. Persiapan Folder & Program
3. Aturan Penamaan File (Konten, Slide, Utas, Affiliate)
4. Balasan Komentar (Trigger & AI Gemini)
5. Mengatur Jadwal & Mengaktifkan Bot
6. Membaca Dashboard & Penanganan Error

---------------------------------------------------------
BAGIAN 1: PERSIAPAN KREDENSIAL (API & TOKEN)
---------------------------------------------------------
Di menu aplikasi, Anda wajib mengisi data penghubung:

A. THREADS API
   1. Threads User ID: Ini adalah ID ANGKA UNIK dari profil akun Threads Anda (contoh: 17841400...). 
      ⚠️ PENTING: Ini BEDA dengan "App ID" (ID Aplikasi yang anda buat di Meta). Jangan sampai tertukar! Dapatkan User ID ini dari Graph API Explorer Meta.
   2. Threads Access Token: Long-Lived Token dari Meta (Di-refresh otomatis tiap minggu).

B. CLOUDFLARE R2 (Untuk Hosting Gambar/Video Sementara)
   1. Account ID: Dari dashboard Cloudflare -> R2 -> Kanan atas.
   2. Access Key ID & Secret Access Key: Dari menu "Manage R2 API Tokens".
   3. Nama Bucket: Nama wadah yang Anda buat (misal: "threads-media").
   4. Public URL Base: URL subdomain R2.dev (misal: https://pub-xxx.r2.dev).

C. GEMINI API KEY (Untuk Balasan AI)
   1. Dapatkan gratis dari: https://aistudio.google.com/app/apikey
   2. Bisa isi lebih dari 1 key. Jika key pertama limit, otomatis pakai key kedua.

---------------------------------------------------------
BAGIAN 2: PERSIAPAN FOLDER & PROGRAM
---------------------------------------------------------
1. Folder Queue  : Wadah untuk bahan postingan baru.
2. Folder Posted : Wadah arsip file yang SUKSES tayang.
3. Path node.exe : Klik tombol "Deteksi Otomatis".
4. Folder Proyek : Buat folder khusus (Misal: C:\\BotThreads). 
WAJIB: Klik tombol "⚡ Setup Otomatis" setelah Folder Proyek dipilih.

---------------------------------------------------------
BAGIAN 3: ATURAN PENAMAAN FILE (SANGAT PENTING)
---------------------------------------------------------
Bot membaca urutan antrean berdasarkan waktu file dimasukkan.

1. POSTINGAN BIASA (1 Teks, 1 Gambar/Video) -> Syarat: Nama file sama.
   - promosi.txt
   - promosi.jpg

2. CAROUSEL / SLIDE (Maks 10 Foto/Video) -> Gunakan akhiran "_slide(Angka)".
   - sepatu.txt 
   - sepatu_slide1.jpg
   - sepatu_slide2.mp4

3. UTAS BERANTAI / THREAD -> Gunakan akhiran "_part(Angka)". Jeda antar part 1 menit.
   - cerita_part1.txt
   - cerita_part1.jpg
   - cerita_part2.txt

4. KOMBINASI UTAS & SLIDE (CAROUSEL BERANTAI)
   Anda bisa menggabungkan keduanya! 
   ⚠️ ATURAN: Tulis "_part" dulu, baru "_slide" di belakangnya.
   - event_part1.txt (Teks untuk post utama)
   - event_part1_slide1.jpg (Gambar slide 1 di post utama)
   - event_part1_slide2.jpg (Gambar slide 2 di post utama)
   - event_part2.txt (Balasan teks di bawahnya)
   - event_part2.jpg (Foto tunggal nempel di part 2)

5. BALASAN LINK AFFILIATE (JUALAN) -> Gunakan akhiran "_reply.txt".
   Bot mengirim link affiliate ke kolom komentar Anda sendiri dengan jeda acak (15-50 menit).
   - tas_kerja.txt
   - tas_kerja_slide1.jpg
   - tas_kerja_reply.txt (Isinya misal: "Beli di sini kak: https://shopee.xx")

---------------------------------------------------------
BAGIAN 4: BALASAN KOMENTAR (TRIGGER & AI)
---------------------------------------------------------
A. POST JUALAN (Punya file "_reply.txt")
   Bot TIDAK memakai AI. Bot membalas berdasarkan KATA KUNCI.
   -> Buka "trigger-rules.json" di Folder Proyek untuk mengedit kata kunci & jawaban (misal: "berapa", "harga").

B. POST NON-JUALAN (Konten Umum)
   Bot AKAN memakai AI Gemini. AI menyesuaikan "Gaya Bahasa" yang Anda pilih di Aplikasi.

---------------------------------------------------------
BAGIAN 5: MENGATUR JADWAL & MENGAKTIFKAN BOT
---------------------------------------------------------
- Format Jam: Wajib 24 Jam (Contoh: 07:00, 14:30).
- Klik tombol Hijau "▶ Aktifkan Bot (Simpan & Terapkan)" agar jadwal jalan di latar belakang.
- Klik tombol Merah "⏹ Matikan Bot (OFF)" jika ingin menyetop seluruh operasi bot sementara.

---------------------------------------------------------
BAGIAN 6: PENANGANAN ERROR (FOLDER "FAILED")
---------------------------------------------------------
Jika error karena salah file (teks > 500 huruf, format video rusak) dan gagal 3x berturut-turut, file akan otomatis diseret ke folder "failed" agar antrean tidak macet.
-> Solusi: Perbaiki file di folder "failed", lalu kembalikan ke folder "queue".`;

// ====================================================
// TIPE DATA & DEFAULT CONFIG
// ====================================================
interface ScheduleConfig {
  thread_poster_times: string[];
  reply_checker_interval_minutes: number;
  comment_responder_interval_minutes: number;
  refresh_token_day: string;
  refresh_token_time: string;
}

interface Profile {
  id: string;
  name: string;
  threads_user_id: string;
  threads_access_token: string;
  r2: { account_id: string; access_key_id: string; secret_access_key: string; bucket_name: string; public_url_base: string; };
  gemini_api_keys: string[];
  ai_reply_enabled: boolean;
  queue_folder: string;
  posted_folder: string;
  node_exe_path: string;
  project_folder: string;
  schedule: ScheduleConfig;
  ai_style_preset: string;
  ai_max_sentences: number;
  ai_custom_instruction: string;
}

interface ProfileSummary { id: string; name: string; }

interface DashboardState {
  last_post_id: string | null;
  last_post_type: string | null;
  last_post_time: string | null;
  queue_count: number;
  next_in_queue: string | null;
}

const EMPTY_CONFIG: Profile = {
  id: "", name: "", threads_user_id: "", threads_access_token: "",
  r2: { account_id: "", access_key_id: "", secret_access_key: "", bucket_name: "", public_url_base: "" },
  gemini_api_keys: [""], ai_reply_enabled: false, queue_folder: "", posted_folder: "", node_exe_path: "", project_folder: "",
  schedule: { thread_poster_times: ["07:00"], reply_checker_interval_minutes: 5, comment_responder_interval_minutes: 15, refresh_token_day: "MON", refresh_token_time: "03:00" },
  ai_style_preset: "ramah_sopan", ai_max_sentences: 2, ai_custom_instruction: "",
};

const STYLE_PRESET_OPTIONS = [
  { value: "ramah_sopan", label: "Ramah & Sopan (formal ringan)" },
  { value: "santai_gaul", label: "Santai & Akrab" },
  { value: "lucu_receh", label: "Lucu & Receh" },
  { value: "custom", label: "Custom (tulis sendiri)" },
];

const HARI_OPTIONS = [
  { value: "MON", label: "Senin" }, { value: "TUE", label: "Selasa" }, { value: "WED", label: "Rabu" },
  { value: "THU", label: "Kamis" }, { value: "FRI", label: "Jumat" }, { value: "SAT", label: "Sabtu" }, { value: "SUN", label: "Minggu" },
];

function ChoiceButtons({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; }) {
  return (
    <div className="choice-row">
      {options.map((o) => (
        <button type="button" key={o.value} className={`choice-btn ${o.value === value ? "active" : ""}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const APP_BUILD = "profil-v5-final";

// Fungsi Matematika Waktu (Menghitung jadwal selanjutnya)
function getNextScheduleInfo(times: string[]) {
  if (!times || times.length === 0) return "Tidak ada jadwal";
  const now = new Date();
  const currentTotal = now.getHours() * 60 + now.getMinutes();
  const sorted = [...times].sort();

  for (const t of sorted) {
    const [h, m] = t.split(":").map(Number);
    if ((h * 60 + m) > currentTotal) return `Hari ini, ${t} WIB`;
  }
  return `Besok, ${sorted[0]} WIB`;
}

// Fungsi Format Tanggal
function formatReadableDate(isoString: string) {
  try {
    const d = new Date(isoString);
    return d.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + " WIB";
  } catch { return isoString; }
}

export default function App() {
  const [config, setConfig] = useState<Profile>(EMPTY_CONFIG);
  const [profileList, setProfileList] = useState<ProfileSummary[]>([]);
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  
  // STATE BARU UNTUK MANUAL BOOK MODAL
  const [showManual, setShowManual] = useState(false);
  
  const [status, setStatus] = useState("");
  const [scheduleLog, setScheduleLog] = useState<string[]>([]);
  const [setupLog, setSetupLog] = useState<string[]>([]);
  
  const [settingUp, setSettingUp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [showNewProfileForm, setShowNewProfileForm] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  function normalizeProfile(loaded: Profile): Profile {
    if (!loaded.gemini_api_keys || loaded.gemini_api_keys.length === 0) loaded.gemini_api_keys = [""];
    if (!loaded.schedule) loaded.schedule = EMPTY_CONFIG.schedule;
    if (!loaded.schedule.thread_poster_times || loaded.schedule.thread_poster_times.length === 0) loaded.schedule.thread_poster_times = ["07:00"];
    return loaded;
  }

  async function fetchDashboardData(profileId: string) {
    if (!profileId) return;
    try {
      const data = await invoke<DashboardState>("get_dashboard_data", { profileId });
      setDashboard(data);
    } catch (e) { console.error("Gagal ambil dashboard:", e); }
  }

  useEffect(() => {
    (async () => {
      try {
        const list = await invoke<ProfileSummary[]>("list_profiles");
        setProfileList(list);
        const active = await invoke<Profile>("get_active_profile");
        setConfig(normalizeProfile(active));
        await fetchDashboardData(active.id);
      } catch (err) { setStatus(`Gagal memuat: ${err}`); } 
      finally { setLoading(false); }
    })();
  }, []);

  // Timer: Refresh Dashboard tiap 10 detik
  useEffect(() => {
    if (config.id) {
      const interval = setInterval(() => fetchDashboardData(config.id), 10000);
      return () => clearInterval(interval);
    }
  }, [config.id]);

  async function handleSwitchProfile(id: string) {
    setLoading(true);
    try {
      const loaded = await invoke<Profile>("load_profile", { id });
      setConfig(normalizeProfile(loaded));
      await fetchDashboardData(id);
      setScheduleLog([]); setSetupLog([]);
      setStatus(`Pindah ke profil "${loaded.name}".`);
    } catch (err) { setStatus(`Gagal: ${err}`); } 
    finally { setLoading(false); }
  }

  async function handleCreateProfile() {
    const name = newProfileName.trim() || "Profil Baru";
    try {
      const created = await invoke<Profile>("create_profile", { name });
      const list = await invoke<ProfileSummary[]>("list_profiles");
      setProfileList(list);
      setConfig(normalizeProfile(created));
      await fetchDashboardData(created.id);
      setShowNewProfileForm(false); setNewProfileName(""); setStatus(`Profil "${created.name}" dibuat.`);
    } catch (err) { setStatus(`Gagal: ${err}`); }
  }

  async function handleDeleteProfile() {
    if (!config.id) return;
    try {
      const remaining = await invoke<ProfileSummary[]>("delete_profile", { id: config.id });
      setProfileList(remaining);
      if (remaining.length > 0) {
        const loaded = await invoke<Profile>("load_profile", { id: remaining[0].id });
        setConfig(normalizeProfile(loaded));
        await fetchDashboardData(loaded.id);
      } else {
        const created = await invoke<Profile>("create_profile", { name: "Profil 1" });
        const list = await invoke<ProfileSummary[]>("list_profiles");
        setProfileList(list);
        setConfig(normalizeProfile(created));
        await fetchDashboardData(created.id);
      }
      setConfirmDelete(false); setStatus("Profil dihapus.");
    } catch (err) { setStatus(`Gagal: ${err}`); }
  }

  function cleanedConfig(): Profile {
    return {
      ...config,
      gemini_api_keys: config.gemini_api_keys.filter((k) => k.trim() !== ""),
      schedule: { ...config.schedule, thread_poster_times: config.schedule.thread_poster_times.filter((t) => t.trim() !== "") },
    };
  }

  async function handleSave() {
    setStatus("Menyimpan...");
    try {
      await invoke("save_profile", { profile: cleanedConfig() });
      const list = await invoke<ProfileSummary[]>("list_profiles");
      setProfileList(list);
      setStatus("Pengaturan tersimpan.");
    } catch (err) { setStatus(`Gagal: ${err}`); }
  }

  async function handleApplySchedule() {
    setApplying(true); setScheduleLog([]); setStatus("Menerapkan jadwal...");
    try {
      const log = await invoke<string[]>("apply_schedule", { profile: cleanedConfig() });
      setScheduleLog(log); setStatus("Jadwal diterapkan.");
    } catch (err) { setStatus(`Gagal: ${err}`); } 
    finally { setApplying(false); }
  }
  
  async function handleDisableSchedule() {
    if (!confirm(`Matikan bot untuk profil "${config.name}"? Jadwal tidak akan berjalan sampai Anda mengaktifkannya lagi.`)) return;
    
    setApplying(true); setScheduleLog([]); setStatus("Mematikan bot...");
    try {
      const msg = await invoke<string>("disable_schedule", { profileName: config.name });
      setScheduleLog([`[OFF] ${msg}`]);
      setStatus("Bot dinonaktifkan.");
    } catch (err) {
      setStatus(`Gagal mematikan bot: ${err}`);
    } finally {
      setApplying(false);
    }
  }

  async function handleSetupProject() {
    setSettingUp(true); setSetupLog([]); setStatus("Menyiapkan otomatis...");
    try {
      const log = await invoke<string[]>("setup_project", { profile: cleanedConfig() });
      setSetupLog(log); setStatus("Setup selesai.");
      const reloaded = await invoke<Profile>("load_profile", { id: config.id });
      setConfig(normalizeProfile(reloaded));
    } catch (err) { setStatus(`Gagal: ${err}`); } 
    finally { setSettingUp(false); }
  }

  async function handleDetectNode() {
    try {
      const path = await invoke<string>("detect_node_path");
      setConfig((prev) => ({ ...prev, node_exe_path: path })); setStatus(`Node.js ditemukan.`);
    } catch (err) { setStatus(`${err}`); }
  }

  async function pickFolder(target: "queue_folder" | "posted_folder" | "project_folder") {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setConfig((prev) => ({ ...prev, [target]: selected }));
  }

  if (loading) return <div className="container">Memuat pengaturan...</div>;

  return (
    <div className="container">
      {/* HEADER DENGAN TOMBOL MANUAL BOOK */}
      <div className="header-row">
        <h1>Threads Automator</h1>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <button 
            type="button" 
            className="choice-btn" 
            style={{ padding: "5px 12px", fontSize: "11px", fontWeight: "bold" }}
            onClick={() => setShowManual(true)}
          >
            📖 Manual Book
          </button>
          
          <div className="status-indicator">
            <span className={`status-dot ${config.threads_access_token && config.node_exe_path && config.project_folder ? "active" : ""}`} />
            {config.threads_access_token && config.node_exe_path && config.project_folder ? "Siap Jalan" : "Belum Lengkap"}
          </div>
        </div>
      </div>
      <p className="subtitle">Pengaturan kredensial & jadwal · build {APP_BUILD}</p>

      {/* DASHBOARD LIVE PANEL */}
      <div className="dashboard-panel">
        <div className="dash-header">
          Monitoring Bot <div className="live-badge"><span className="live-dot"></span> REAL-TIME</div>
        </div>
        <div className="dash-grid">
          <div className="dash-box">
            <div className="dash-title">Terakhir Tayang</div>
            <div className="dash-text">
              {dashboard?.last_post_id ? (
                <>
                  <span className="dash-highlight">ID: {dashboard.last_post_id}</span>
                  Tipe: {dashboard.last_post_type === "jualan" ? "🛒 Jualan" : "💬 Umum"}<br/>
                  Pada: {formatReadableDate(dashboard.last_post_time || "")}
                </>
              ) : "Belum ada post tayang"}
            </div>
          </div>
          <div className="dash-box">
            <div className="dash-title">Antrean Selanjutnya</div>
            <div className="dash-text">
              {dashboard?.queue_count && dashboard.queue_count > 0 ? (
                <>
                  <span className="dash-highlight">Ada {dashboard.queue_count} konten antre</span>
                  Target: "{dashboard.next_in_queue}"<br/>
                  Jam: <span style={{color: "#86efac"}}>{getNextScheduleInfo(config.schedule.thread_poster_times)}</span>
                </>
              ) : "Antrean kosong, mohon isi Queue"}
            </div>
          </div>
        </div>
      </div>

      <section>
        <h2>Profil Akun</h2>
        <ChoiceButtons options={profileList.map((p) => ({ value: p.id, label: p.name || "(tanpa nama)" }))} value={config.id} onChange={handleSwitchProfile} />
        
        <div className="key-input-group" style={{ marginTop: 10 }}>
          <button type="button" onClick={() => { setShowNewProfileForm(!showNewProfileForm); setConfirmDelete(false); }}>+ Profil Baru</button>
          <button type="button" className="btn-remove" onClick={() => { setConfirmDelete(!confirmDelete); setShowNewProfileForm(false); }}>Hapus Profil Ini</button>
        </div>

        {showNewProfileForm && (
          <div style={{ marginTop: 10 }}>
            <label className="field-label">Nama profil baru</label>
            <div className="key-input-group">
              <input type="text" placeholder="Nama profil" value={newProfileName} onChange={(e) => setNewProfileName(e.target.value)} />
              <button type="button" onClick={handleCreateProfile}>Buat Profil</button>
            </div>
          </div>
        )}

        {confirmDelete && (
          <div style={{ marginTop: 10 }}>
            <p className="hint" style={{ color: "#fca5a5" }}>Hapus profil "{config.name}"? Jadwalnya akan ikut terhapus.</p>
            <div className="key-input-group">
              <button type="button" className="btn-remove" onClick={handleDeleteProfile}>Ya, hapus</button>
              <button type="button" onClick={() => setConfirmDelete(false)}>Batal</button>
            </div>
          </div>
        )}

        <label className="field-label" style={{ marginTop: 12 }}>Nama Profil</label>
        <input type="text" value={config.name} onChange={(e) => setConfig({ ...config, name: e.target.value })} />
      </section>

      <section>
        <h2>Threads API</h2>
        <label className="field-label">Threads User ID</label>
        <input type="text" value={config.threads_user_id} onChange={(e) => setConfig({ ...config, threads_user_id: e.target.value })} />
        <label className="field-label">Threads Access Token</label>
        <input type="password" value={config.threads_access_token} onChange={(e) => setConfig({ ...config, threads_access_token: e.target.value })} />
      </section>

      <section>
        <h2>Cloudflare R2 (hosting video/gambar)</h2>
        <label className="field-label">Cloudflare Account ID</label>
        <input type="text" value={config.r2.account_id} onChange={(e) => setConfig({ ...config, r2: { ...config.r2, account_id: e.target.value } })} />
        <label className="field-label">R2 Access Key ID</label>
        <input type="text" value={config.r2.access_key_id} onChange={(e) => setConfig({ ...config, r2: { ...config.r2, access_key_id: e.target.value } })} />
        <label className="field-label">R2 Secret Access Key</label>
        <input type="password" value={config.r2.secret_access_key} onChange={(e) => setConfig({ ...config, r2: { ...config.r2, secret_access_key: e.target.value } })} />
        <label className="field-label">Nama Bucket</label>
        <input type="text" value={config.r2.bucket_name} onChange={(e) => setConfig({ ...config, r2: { ...config.r2, bucket_name: e.target.value } })} />
        <label className="field-label">Public URL Base</label>
        <input type="text" value={config.r2.public_url_base} onChange={(e) => setConfig({ ...config, r2: { ...config.r2, public_url_base: e.target.value } })} />
      </section>

      <section>
        <h2>Gemini API Key</h2>
        {config.gemini_api_keys.map((key, index) => (
          <div className="gemini-key-row" key={index}>
            <label className="field-label">Key #{index + 1}</label>
            <div className="key-input-group">
              <input type="password" value={key} onChange={(e) => {
                const arr = [...config.gemini_api_keys]; arr[index] = e.target.value; setConfig({ ...config, gemini_api_keys: arr });
              }} />
              {config.gemini_api_keys.length > 1 && (
                <button type="button" className="btn-remove" onClick={() => {
                  const arr = config.gemini_api_keys.filter((_, i) => i !== index); setConfig({ ...config, gemini_api_keys: arr.length > 0 ? arr : [""] });
                }}>✕</button>
              )}
            </div>
          </div>
        ))}
        <button type="button" className="btn-add" onClick={() => setConfig({ ...config, gemini_api_keys: [...config.gemini_api_keys, ""] })}>+ Tambah Key</button>
      </section>

      <section>
        <h2>Balasan Komentar Otomatis (AI)</h2>
        <label className="toggle-row">
          <input type="checkbox" checked={config.ai_reply_enabled} onChange={(e) => setConfig({ ...config, ai_reply_enabled: e.target.checked })} />
          <span>{config.ai_reply_enabled ? "AKTIF" : "NONAKTIF"}</span>
        </label>
        {config.ai_reply_enabled && (
          <>
            <label className="field-label" style={{ marginTop: 16 }}>Gaya Bahasa</label>
            <ChoiceButtons options={STYLE_PRESET_OPTIONS} value={config.ai_style_preset} onChange={(v) => setConfig({ ...config, ai_style_preset: v })} />
            <label className="field-label">Panjang Balasan (kalimat)</label>
            <input type="number" min={1} max={5} value={config.ai_max_sentences} onChange={(e) => setConfig({ ...config, ai_max_sentences: Number(e.target.value) })} />
            <label className="field-label">Instruksi Tambahan</label>
            <textarea rows={3} value={config.ai_custom_instruction} onChange={(e) => setConfig({ ...config, ai_custom_instruction: e.target.value })} />
          </>
        )}
      </section>

      <section>
        <h2>Folder Konten</h2>
        <label className="field-label">Folder Queue</label>
        <div className="folder-picker-row"><input type="text" readOnly value={config.queue_folder} /><button type="button" onClick={() => pickFolder("queue_folder")}>Pilih</button></div>
        <label className="field-label">Folder Posted</label>
        <div className="folder-picker-row"><input type="text" readOnly value={config.posted_folder} /><button type="button" onClick={() => pickFolder("posted_folder")}>Pilih</button></div>
      </section>

      <section>
        <h2>Lokasi Program</h2>
        <label className="field-label">Path node.exe</label>
        <div className="folder-picker-row">
          <input type="text" value={config.node_exe_path} onChange={(e) => setConfig({ ...config, node_exe_path: e.target.value })} />
          <button type="button" onClick={handleDetectNode}>Deteksi</button>
        </div>
                    {/* === TAMBAHKAN KODE INI DI SINI === */}
        <span className="hint" style={{ marginTop: "6px", marginBottom: "14px", color: "#fca5a5" }}>
          *Wajib install Node.js (versi LTS) dari nodejs.org terlebih dahulu sebelum klik Deteksi atau Memakai Aplikasi ini.
        </span>
        {/* ================================= */}
        <label className="field-label">Folder Proyek</label>
        <div className="folder-picker-row"><input type="text" readOnly value={config.project_folder} /><button type="button" onClick={() => pickFolder("project_folder")}>Pilih</button></div>
        
        <button type="button" className="btn-save" style={{ marginTop: 14 }} onClick={handleSetupProject} disabled={settingUp}>
          {settingUp ? "Menyiapkan..." : "⚡ Setup Otomatis (folder + file + npm install)"}
        </button>
        {setupLog.length > 0 && <div className="log-box">{setupLog.map((l, i) => <div key={i} className={l.includes("GAGAL") ? "log-fail" : "log-ok"}>{l}</div>)}</div>}
      </section>

      <section>
        <h2>Jadwal (Windows Task Scheduler)</h2>
        <label className="field-label">Jam Posting (Format 24 Jam)</label>
        {config.schedule.thread_poster_times.map((time, index) => (
          <div className="key-input-group" key={index} style={{ marginBottom: 6 }}>
            <input type="text" maxLength={5} placeholder="07:30" value={time} onChange={(e) => {
              const arr = [...config.schedule.thread_poster_times]; arr[index] = e.target.value; setConfig({ ...config, schedule: { ...config.schedule, thread_poster_times: arr } });
            }} />
            {config.schedule.thread_poster_times.length > 1 && (
              <button type="button" className="btn-remove" onClick={() => {
                const arr = config.schedule.thread_poster_times.filter((_, i) => i !== index); setConfig({ ...config, schedule: { ...config.schedule, thread_poster_times: arr.length > 0 ? arr : ["07:00"] } });
              }}>✕</button>
            )}
          </div>
        ))}
        <button type="button" className="btn-add" onClick={() => setConfig({ ...config, schedule: { ...config.schedule, thread_poster_times: [...config.schedule.thread_poster_times, "12:00"] } })}>+ Tambah Jam</button>

        <label className="field-label" style={{ marginTop: 16 }}>Interval Reply Checker (menit)</label>
        <input type="number" min={1} value={config.schedule.reply_checker_interval_minutes} onChange={(e) => setConfig({ ...config, schedule: { ...config.schedule, reply_checker_interval_minutes: Number(e.target.value) } })} />

        <label className="field-label">Interval Comment Responder (menit)</label>
        <input type="number" min={1} disabled={!config.ai_reply_enabled} value={config.schedule.comment_responder_interval_minutes} onChange={(e) => setConfig({ ...config, schedule: { ...config.schedule, comment_responder_interval_minutes: Number(e.target.value) } })} />

        <label className="field-label">Refresh Token (Hari & Jam)</label>
        <ChoiceButtons options={HARI_OPTIONS} value={config.schedule.refresh_token_day} onChange={(v) => setConfig({ ...config, schedule: { ...config.schedule, refresh_token_day: v } })} />
        <div className="key-input-group" style={{ marginTop: 8 }}>
          <input type="text" maxLength={5} placeholder="03:00" value={config.schedule.refresh_token_time} onChange={(e) => setConfig({ ...config, schedule: { ...config.schedule, refresh_token_time: e.target.value } })} />
        </div>

        {/* TOMBOL ON & OFF */}
        <div style={{ display: "flex", gap: "10px", marginTop: "16px" }}>
          <button type="button" className="btn-save" style={{ flex: 2 }} onClick={handleApplySchedule} disabled={applying}>
            {applying ? "Proses..." : "▶ Aktifkan Bot (Simpan & Terapkan)"}
          </button>
          
          <button type="button" className="btn-save" style={{ flex: 1, background: "#ef4444", boxShadow: "none" }} onClick={handleDisableSchedule} disabled={applying}>
            ⏹ Matikan (OFF)
          </button>
        </div>
        
        {scheduleLog.length > 0 && <div className="log-box">{scheduleLog.map((l, i) => <div key={i} className={l.includes("GAGAL") ? "log-fail" : "log-ok"}>{l}</div>)}</div>}
      </section>

      <button type="button" className="btn-save" onClick={handleSave}>Simpan Pengaturan Saja</button>
      {status && <p className="status">{status}</p>}

      {/* ==================================================== */}
      {/* MODAL MANUAL BOOK */}
      {/* ==================================================== */}
      {showManual && (
        <div className="modal-overlay" onClick={() => setShowManual(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            
            <div className="modal-header">
              <h2 className="dash-highlight" style={{ margin: 0 }}>📖 Buku Panduan</h2>
              <button className="modal-close" onClick={() => setShowManual(false)}>✕</button>
            </div>
            
            <div className="modal-body">
              <pre className="manual-text">{MANUAL_BOOK_TEXT}</pre>
            </div>

          </div>
        </div>
      )}
      
    </div>
  );
}
