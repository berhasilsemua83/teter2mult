import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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
  r2: {
    account_id: string;
    access_key_id: string;
    secret_access_key: string;
    bucket_name: string;
    public_url_base: string;
  };
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

interface ProfileSummary {
  id: string;
  name: string;
}

interface DashboardState {
  last_post_id: string | null;
  last_post_type: string | null;
  last_post_time: string | null;
  queue_count: number;
  next_in_queue: string | null;
}

const EMPTY_CONFIG: Profile = {
  id: "",
  name: "",
  threads_user_id: "",
  threads_access_token: "",
  r2: { account_id: "", access_key_id: "", secret_access_key: "", bucket_name: "", public_url_base: "" },
  gemini_api_keys: [""],
  ai_reply_enabled: false,
  queue_folder: "",
  posted_folder: "",
  node_exe_path: "",
  project_folder: "",
  schedule: {
    thread_poster_times: ["07:00"],
    reply_checker_interval_minutes: 5,
    comment_responder_interval_minutes: 15,
    refresh_token_day: "MON",
    refresh_token_time: "03:00",
  },
  ai_style_preset: "ramah_sopan",
  ai_max_sentences: 2,
  ai_custom_instruction: "",
};

const STYLE_PRESET_OPTIONS = [
  { value: "ramah_sopan", label: "Ramah & Sopan (formal ringan)" },
  { value: "santai_gaul", label: "Santai & Akrab" },
  { value: "lucu_receh", label: "Lucu & Receh" },
  { value: "custom", label: "Custom (tulis sendiri)" },
];

const HARI_OPTIONS = [
  { value: "MON", label: "Senin" },
  { value: "TUE", label: "Selasa" },
  { value: "WED", label: "Rabu" },
  { value: "THU", label: "Kamis" },
  { value: "FRI", label: "Jumat" },
  { value: "SAT", label: "Sabtu" },
  { value: "SUN", label: "Minggu" },
];

function ChoiceButtons({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="choice-row">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          className={`choice-btn ${o.value === value ? "active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const APP_BUILD = "profil-v4-dash";

// Fungsi Matematika Waktu (Menghitung jadwal selanjutnya)
function getNextScheduleInfo(times: string[]) {
  if (!times || times.length === 0) return "Tidak ada jadwal";
  
  const now = new Date();
  const currentTotal = now.getHours() * 60 + now.getMinutes();
  
  // Mengurutkan jadwal dari jam terkecil
  const sorted = [...times].sort();

  for (const t of sorted) {
    const [h, m] = t.split(":").map(Number);
    if ((h * 60 + m) > currentTotal) {
      return `Hari ini, ${t} WIB`;
    }
  }
  return `Besok, ${sorted[0]} WIB`;
}

// Fungsi Format Tanggal jadi ramah dibaca (Misal: "23 Jan, 14:00")
function formatReadableDate(isoString: string) {
  try {
    const d = new Date(isoString);
    return d.toLocaleString('id-ID', { 
      day: 'numeric', 
      month: 'short', 
      hour: '2-digit', 
      minute: '2-digit' 
    }) + " WIB";
  } catch {
    return isoString;
  }
}

export default function App() {
  const [config, setConfig] = useState<Profile>(EMPTY_CONFIG);
  const [profileList, setProfileList] = useState<ProfileSummary[]>([]);
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  
  const [status, setStatus] = useState<string>("");
  const [scheduleLog, setScheduleLog] = useState<string[]>([]);
  const [setupLog, setSetupLog] = useState<string[]>([]);
  
  const [settingUp, setSettingUp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [showNewProfileForm, setShowNewProfileForm] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  function normalizeProfile(loaded: Profile): Profile {
    if (!loaded.gemini_api_keys || loaded.gemini_api_keys.length === 0) {
      loaded.gemini_api_keys = [""];
    }
    if (!loaded.schedule) {
      loaded.schedule = EMPTY_CONFIG.schedule;
    }
    if (!loaded.schedule.thread_poster_times || loaded.schedule.thread_poster_times.length === 0) {
      loaded.schedule.thread_poster_times = ["07:00"];
    }
    return loaded;
  }

  // Fungsi khusus panggil data dashboard ke Rust
  async function fetchDashboardData(profileId: string) {
    if (!profileId) return;
    try {
      const data = await invoke<DashboardState>("get_dashboard_data", { profileId });
      setDashboard(data);
    } catch (e) {
      console.error("Gagal ambil data dashboard:", e);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const list = await invoke<ProfileSummary[]>("list_profiles");
        setProfileList(list);
        const active = await invoke<Profile>("get_active_profile");
        setConfig(normalizeProfile(active));
        
        // Ambil data dashboard untuk profil aktif
        await fetchDashboardData(active.id);
      } catch (err) {
        setStatus(`Gagal memuat profil: ${err}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Timer: Refresh Dashboard setiap 10 detik otomatis
  useEffect(() => {
    if (config.id) {
      const interval = setInterval(() => {
        fetchDashboardData(config.id);
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [config.id]);

  async function handleSwitchProfile(id: string) {
    setLoading(true);
    try {
      const loaded = await invoke<Profile>("load_profile", { id });
      setConfig(normalizeProfile(loaded));
      
      // Ambil data dashboard saat pindah profil
      await fetchDashboardData(id);
      
      setScheduleLog([]);
      setSetupLog([]);
      setStatus(`Pindah ke profil "${loaded.name}".`);
    } catch (err) {
      setStatus(`Gagal memuat profil: ${err}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateProfile() {
    const name = newProfileName.trim() || "Profil Baru";
    try {
      const created = await invoke<Profile>("create_profile", { name });
      const list = await invoke<ProfileSummary[]>("list_profiles");
      setProfileList(list);
      
      setConfig(normalizeProfile(created));
      await fetchDashboardData(created.id);
      
      setScheduleLog([]);
      setSetupLog([]);
      setShowNewProfileForm(false);
      setNewProfileName("");
      setStatus(`Profil "${created.name}" dibuat.`);
    } catch (err) {
      setStatus(`Gagal membuat profil: ${err}`);
    }
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
      
      setConfirmDelete(false);
      setStatus("Profil dihapus.");
    } catch (err) {
      setStatus(`Gagal menghapus profil: ${err}`);
    }
  }

  function cleanedConfig(): Profile {
    return {
      ...config,
      gemini_api_keys: config.gemini_api_keys.filter((k) => k.trim() !== ""),
      schedule: {
        ...config.schedule,
        thread_poster_times: config.schedule.thread_poster_times.filter((t) => t.trim() !== ""),
      },
    };
  }

  async function handleSave() {
    setStatus("Menyimpan...");
    try {
      await invoke("save_profile", { profile: cleanedConfig() });
      const list = await invoke<ProfileSummary[]>("list_profiles");
      setProfileList(list);
      setStatus("Pengaturan tersimpan.");
    } catch (err) {
      setStatus(`Gagal menyimpan: ${err}`);
    }
  }

  async function handleSetupProject() {
    setSettingUp(true);
    setSetupLog([]);
    setStatus("Menjalankan setup otomatis...");
    try {
      const log = await invoke<string[]>("setup_project", { profile: cleanedConfig() });
      setSetupLog(log);
      setStatus("Setup selesai. Cek detail di bawah.");
      
      const reloaded = await invoke<Profile>("load_profile", { id: config.id });
      setConfig(normalizeProfile(reloaded));
    } catch (err) {
      setStatus(`Gagal setup: ${err}`);
    } finally {
      setSettingUp(false);
    }
  }

  async function handleApplySchedule() {
    setApplying(true);
    setScheduleLog([]);
    setStatus("Menerapkan jadwal ke Windows Task Scheduler...");
    try {
      const log = await invoke<string[]>("apply_schedule", { profile: cleanedConfig() });
      setScheduleLog(log);
      setStatus("Jadwal berhasil diterapkan. Cek detail di bawah.");
    } catch (err) {
      setStatus(`Gagal menerapkan jadwal: ${err}`);
    } finally {
      setApplying(false);
    }
  }

  async function handleDetectNode() {
    try {
      const path = await invoke<string>("detect_node_path");
      setConfig((prev) => ({ ...prev, node_exe_path: path }));
      setStatus(`node.exe ditemukan: ${path}`);
    } catch (err) {
      setStatus(`${err}`);
    }
  }

  async function pickFolder(target: "queue_folder" | "posted_folder" | "project_folder") {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      setConfig((prev) => ({ ...prev, [target]: selected }));
    }
  }

  function updateGeminiKey(index: number, value: string) {
    setConfig((prev) => {
      const updated = [...prev.gemini_api_keys];
      updated[index] = value;
      return { ...prev, gemini_api_keys: updated };
    });
  }

  function addGeminiKeyField() {
    setConfig((prev) => ({ ...prev, gemini_api_keys: [...prev.gemini_api_keys, ""] }));
  }

  function removeGeminiKeyField(index: number) {
    setConfig((prev) => {
      const updated = prev.gemini_api_keys.filter((_, i) => i !== index);
      return { ...prev, gemini_api_keys: updated.length > 0 ? updated : [""] };
    });
  }

  function updateThreadPosterTime(index: number, value: string) {
    setConfig((prev) => {
      const updated = [...prev.schedule.thread_poster_times];
      updated[index] = value;
      return { ...prev, schedule: { ...prev.schedule, thread_poster_times: updated } };
    });
  }

  function addThreadPosterTime() {
    setConfig((prev) => ({
      ...prev,
      schedule: {
        ...prev.schedule,
        thread_poster_times: [...prev.schedule.thread_poster_times, "12:00"],
      },
    }));
  }

  function removeThreadPosterTime(index: number) {
    setConfig((prev) => {
      const updated = prev.schedule.thread_poster_times.filter((_, i) => i !== index);
      return {
        ...prev,
        schedule: {
          ...prev.schedule,
          thread_poster_times: updated.length > 0 ? updated : ["07:00"],
        },
      };
    });
  }

  if (loading) return <div className="container">Memuat pengaturan...</div>;

  return (
    <div className="container">
      <div className="header-row">
        <h1>Threads Automator</h1>
        <div className="status-indicator">
          <span
            className={`status-dot ${
              config.threads_access_token && config.node_exe_path && config.project_folder
                ? "active"
                : ""
            }`}
          />
          {config.threads_access_token && config.node_exe_path && config.project_folder
            ? "Siap Jalan"
            : "Belum Lengkap"}
        </div>
      </div>
      <p className="subtitle">
        Pengaturan kredensial &amp; jadwal · build {APP_BUILD}
      </p>

      {/* ==== DASHBOARD LIVE PANEL ==== */}
      <div className="dashboard-panel">
        <div className="dash-header">
          Monitoring Bot 
          <div className="live-badge">
            <span className="live-dot"></span> REAL-TIME
          </div>
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
              ) : (
                "Belum ada post yang tayang dari antrean"
              )}
            </div>
          </div>
          
          <div className="dash-box">
            <div className="dash-title">Antrean Selanjutnya</div>
            <div className="dash-text">
              {dashboard?.queue_count && dashboard.queue_count > 0 ? (
                <>
                  <span className="dash-highlight">Ada {dashboard.queue_count} konten siap tayang</span>
                  Target file: "{dashboard.next_in_queue}"<br/>
                  Jadwal: <span style={{color: "#86efac", fontWeight: "600"}}>{getNextScheduleInfo(config.schedule.thread_poster_times)}</span>
                </>
              ) : (
                "Antrean kosong, mohon isi folder Queue agar bot bisa memposting."
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ===== PEMILIH PROFIL ===== */}
      <section>
        <h2>Profil Akun</h2>

        <ChoiceButtons
          options={profileList.map((p) => ({ value: p.id, label: p.name || "(tanpa nama)" }))}
          value={config.id}
          onChange={(id) => handleSwitchProfile(id)}
        />
        {profileList.length === 0 && (
          <p className="hint">Daftar profil kosong atau belum termuat. Coba klik "+ Profil Baru".</p>
        )}

        <div className="key-input-group" style={{ marginTop: 10 }}>
          <button
            type="button"
            onClick={() => {
              setShowNewProfileForm(!showNewProfileForm);
              setConfirmDelete(false);
            }}
          >
            + Profil Baru
          </button>
          <button
            type="button"
            className="btn-remove"
            onClick={() => {
              setConfirmDelete(!confirmDelete);
              setShowNewProfileForm(false);
            }}
          >
            Hapus Profil Ini
          </button>
        </div>

        {showNewProfileForm && (
          <div style={{ marginTop: 10 }}>
            <label className="field-label">
              Nama profil baru
              <span className="hint">Contoh: Akun Skincare, Akun Gadget</span>
            </label>
            <div className="key-input-group">
              <input
                type="text"
                placeholder="Nama profil"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
              />
              <button type="button" onClick={handleCreateProfile}>Buat Profil</button>
            </div>
          </div>
        )}

        {confirmDelete && (
          <div style={{ marginTop: 10 }}>
            <p className="hint" style={{ color: "#fca5a5" }}>
              Hapus profil "{config.name}"? Jadwal Task Scheduler milik profil ini ikut dihapus dan
              tidak bisa dibatalkan.
            </p>
            <div className="key-input-group">
              <button type="button" className="btn-remove" onClick={handleDeleteProfile}>
                Ya, hapus
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)}>Batal</button>
            </div>
          </div>
        )}

        <label className="field-label" style={{ marginTop: 12 }}>
          Nama Profil
          <span className="hint">Dipakai sebagai penanda folder/jadwal, ganti sesuai akun</span>
        </label>
        <input
          type="text"
          value={config.name}
          onChange={(e) => setConfig({ ...config, name: e.target.value })}
        />
      </section>

      {/* ===== THREADS ===== */}
      <section>
        <h2>Threads API</h2>
        <label className="field-label">Threads User ID</label>
        <input
          type="text"
          value={config.threads_user_id}
          onChange={(e) => setConfig({ ...config, threads_user_id: e.target.value })}
        />

        <label className="field-label">Threads Access Token</label>
        <input
          type="password"
          value={config.threads_access_token}
          onChange={(e) => setConfig({ ...config, threads_access_token: e.target.value })}
        />
      </section>

      {/* ===== CLOUDFLARE R2 ===== */}
      <section>
        <h2>Cloudflare R2 (hosting video/gambar)</h2>
        <label className="field-label">Cloudflare Account ID</label>
        <input
          type="text"
          value={config.r2.account_id}
          onChange={(e) => setConfig({ ...config, r2: { ...config.r2, account_id: e.target.value } })}
        />

        <label className="field-label">R2 Access Key ID</label>
        <input
          type="text"
          value={config.r2.access_key_id}
          onChange={(e) => setConfig({ ...config, r2: { ...config.r2, access_key_id: e.target.value } })}
        />

        <label className="field-label">R2 Secret Access Key</label>
        <input
          type="password"
          value={config.r2.secret_access_key}
          onChange={(e) => setConfig({ ...config, r2: { ...config.r2, secret_access_key: e.target.value } })}
        />

        <label className="field-label">Nama Bucket</label>
        <input
          type="text"
          value={config.r2.bucket_name}
          onChange={(e) => setConfig({ ...config, r2: { ...config.r2, bucket_name: e.target.value } })}
        />

        <label className="field-label">Public URL Base</label>
        <input
          type="text"
          value={config.r2.public_url_base}
          onChange={(e) => setConfig({ ...config, r2: { ...config.r2, public_url_base: e.target.value } })}
        />
      </section>

      {/* ===== GEMINI ===== */}
      <section>
        <h2>Gemini API Key (untuk balasan AI)</h2>
        {config.gemini_api_keys.map((key, index) => (
          <div className="gemini-key-row" key={index}>
            <label className="field-label">Gemini API Key #{index + 1}</label>
            <div className="key-input-group">
              <input
                type="password"
                value={key}
                onChange={(e) => updateGeminiKey(index, e.target.value)}
              />
              {config.gemini_api_keys.length > 1 && (
                <button type="button" className="btn-remove" onClick={() => removeGeminiKeyField(index)}>
                  ✕
                </button>
              )}
            </div>
          </div>
        ))}
        <button type="button" className="btn-add" onClick={addGeminiKeyField}>
          + Tambah Gemini API Key
        </button>
      </section>

      {/* ===== TOGGLE AI REPLY ===== */}
      <section>
        <h2>Balasan Komentar Otomatis (AI)</h2>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={config.ai_reply_enabled}
            onChange={(e) => setConfig({ ...config, ai_reply_enabled: e.target.checked })}
          />
          <span>
            {config.ai_reply_enabled
              ? "AKTIF — sistem akan membalas komentar otomatis"
              : "NONAKTIF — komentar tidak akan dibalas otomatis"}
          </span>
        </label>

        {config.ai_reply_enabled && (
          <>
            <label className="field-label" style={{ marginTop: 16 }}>Gaya Bahasa Balasan</label>
            <ChoiceButtons
              options={STYLE_PRESET_OPTIONS}
              value={config.ai_style_preset}
              onChange={(v) => setConfig({ ...config, ai_style_preset: v })}
            />

            <label className="field-label">Panjang Balasan (maksimal kalimat)</label>
            <input
              type="number"
              min={1}
              max={5}
              value={config.ai_max_sentences}
              onChange={(e) => setConfig({ ...config, ai_max_sentences: Number(e.target.value) })}
            />

            <label className="field-label">Instruksi Tambahan</label>
            <textarea
              rows={3}
              value={config.ai_custom_instruction}
              onChange={(e) => setConfig({ ...config, ai_custom_instruction: e.target.value })}
            />
          </>
        )}
      </section>

      {/* ===== FOLDER KONTEN ===== */}
      <section>
        <h2>Folder Konten</h2>
        <label className="field-label">Folder Queue</label>
        <div className="folder-picker-row">
          <input type="text" readOnly value={config.queue_folder} placeholder="Belum dipilih" />
          <button type="button" onClick={() => pickFolder("queue_folder")}>Pilih Folder</button>
        </div>

        <label className="field-label">Folder Posted</label>
        <div className="folder-picker-row">
          <input type="text" readOnly value={config.posted_folder} placeholder="Belum dipilih" />
          <button type="button" onClick={() => pickFolder("posted_folder")}>Pilih Folder</button>
        </div>
      </section>

      {/* ===== LOKASI PROGRAM ===== */}
      <section>
        <h2>Lokasi Program</h2>

        <label className="field-label">Path node.exe</label>
        <div className="folder-picker-row">
          <input
            type="text"
            value={config.node_exe_path}
            onChange={(e) => setConfig({ ...config, node_exe_path: e.target.value })}
          />
          <button type="button" onClick={handleDetectNode}>Deteksi Otomatis</button>
        </div>

        <label className="field-label">Folder Proyek</label>
        <div className="folder-picker-row">
          <input type="text" readOnly value={config.project_folder} placeholder="Belum dipilih" />
          <button type="button" onClick={() => pickFolder("project_folder")}>Pilih Folder</button>
        </div>

        <button
          type="button"
          className="btn-save"
          style={{ marginTop: 14 }}
          onClick={handleSetupProject}
          disabled={settingUp}
        >
          {settingUp ? "Menyiapkan..." : "⚡ Setup Otomatis (folder + file + npm install)"}
        </button>

        {setupLog.length > 0 && (
          <div className="log-box">
            {setupLog.map((line, i) => (
              <div key={i} className={line.includes("GAGAL") || line.includes("ERROR") ? "log-fail" : "log-ok"}>
                {line}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ===== JADWAL ===== */}
      <section>
        <h2>Jadwal (Windows Task Scheduler)</h2>

        <label className="field-label">Jam Posting Utama (thread-poster.js)</label>
        {config.schedule.thread_poster_times.map((time, index) => (
          <div className="key-input-group" key={index} style={{ marginBottom: 6 }}>
            <input
              type="time"
              value={time}
              onChange={(e) => updateThreadPosterTime(index, e.target.value)}
            />
            {config.schedule.thread_poster_times.length > 1 && (
              <button type="button" className="btn-remove" onClick={() => removeThreadPosterTime(index)}>
                ✕
              </button>
            )}
          </div>
        ))}
        <button type="button" className="btn-add" onClick={addThreadPosterTime}>
          + Tambah Jam Posting
        </button>

        <label className="field-label" style={{ marginTop: 16 }}>Interval Reply Checker (menit)</label>
        <input
          type="number"
          min={1}
          value={config.schedule.reply_checker_interval_minutes}
          onChange={(e) =>
            setConfig({
              ...config,
              schedule: { ...config.schedule, reply_checker_interval_minutes: Number(e.target.value) },
            })
          }
        />

        <label className="field-label">Interval Comment Responder (menit)</label>
        <input
          type="number"
          min={1}
          disabled={!config.ai_reply_enabled}
          value={config.schedule.comment_responder_interval_minutes}
          onChange={(e) =>
            setConfig({
              ...config,
              schedule: { ...config.schedule, comment_responder_interval_minutes: Number(e.target.value) },
            })
          }
        />

        <label className="field-label">Refresh Token — Hari &amp; Jam</label>
        <ChoiceButtons
          options={HARI_OPTIONS}
          value={config.schedule.refresh_token_day}
          onChange={(v) =>
            setConfig({ ...config, schedule: { ...config.schedule, refresh_token_day: v } })
          }
        />
        <div className="key-input-group" style={{ marginTop: 8 }}>
          <input
            type="time"
            value={config.schedule.refresh_token_time}
            onChange={(e) =>
              setConfig({ ...config, schedule: { ...config.schedule, refresh_token_time: e.target.value } })
            }
          />
        </div>

        <button type="button" className="btn-save" style={{ marginTop: 16 }} onClick={handleApplySchedule} disabled={applying}>
          {applying ? "Menerapkan..." : "Simpan & Terapkan Jadwal ke Task Scheduler"}
        </button>

        {scheduleLog.length > 0 && (
          <div className="log-box">
            {scheduleLog.map((line, i) => (
              <div key={i} className={line.startsWith("[") && line.includes("GAGAL") ? "log-fail" : "log-ok"}>
                {line}
              </div>
            ))}
          </div>
        )}
      </section>

      <button type="button" className="btn-save" onClick={handleSave}>
        Simpan Pengaturan Saja (tanpa mengubah jadwal)
      </button>

      {status && <p className="status">{status}</p>}
    </div>
  );
}
