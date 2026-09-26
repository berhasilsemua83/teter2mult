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
  cloudinary: {
    cloud_name: string;
    api_key: string;
    api_secret: string;
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

const EMPTY_CONFIG: Profile = {
  id: "",
  name: "",
  threads_user_id: "",
  threads_access_token: "",
  cloudinary: { cloud_name: "", api_key: "", api_secret: "" },
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

export default function App() {
  const [config, setConfig] = useState<Profile>(EMPTY_CONFIG);
  const [profileList, setProfileList] = useState<ProfileSummary[]>([]);
  const [status, setStatus] = useState<string>("");
  const [scheduleLog, setScheduleLog] = useState<string[]>([]);
  const [setupLog, setSetupLog] = useState<string[]>([]);
  const [settingUp, setSettingUp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

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

  async function refreshProfileList() {
    const list = await invoke<ProfileSummary[]>("list_profiles");
    setProfileList(list);
    return list;
  }

  useEffect(() => {
    (async () => {
      try {
        await refreshProfileList();
        const active = await invoke<Profile>("get_active_profile");
        setConfig(normalizeProfile(active));
      } catch (err) {
        setStatus(`Gagal memuat profil: ${err}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSwitchProfile(id: string) {
    setLoading(true);
    try {
      const loaded = await invoke<Profile>("load_profile", { id });
      setConfig(normalizeProfile(loaded));
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
    const name = window.prompt("Nama profil baru (contoh: Akun Skincare, Akun Gadget):", "Profil Baru");
    if (name === null) return; // dibatalkan
    try {
      const created = await invoke<Profile>("create_profile", { name });
      await refreshProfileList();
      setConfig(normalizeProfile(created));
      setScheduleLog([]);
      setSetupLog([]);
      setStatus(`Profil "${created.name}" dibuat.`);
    } catch (err) {
      setStatus(`Gagal membuat profil: ${err}`);
    }
  }

  async function handleDeleteProfile() {
    if (!config.id) return;
    const confirmed = window.confirm(
      `Hapus profil "${config.name}"? Jadwal Task Scheduler milik profil ini juga akan dihapus. Tindakan ini tidak bisa dibatalkan.`
    );
    if (!confirmed) return;

    try {
      const remaining = await invoke<ProfileSummary[]>("delete_profile", { id: config.id });
      setProfileList(remaining);
      if (remaining.length > 0) {
        const loaded = await invoke<Profile>("load_profile", { id: remaining[0].id });
        setConfig(normalizeProfile(loaded));
      } else {
        // Semua profil terhapus -> minta buat baru
        const created = await invoke<Profile>("create_profile", { name: "Profil 1" });
        await refreshProfileList();
        setConfig(normalizeProfile(created));
      }
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
      await refreshProfileList(); // biar nama profil yang baru diubah ikut update di dropdown
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
      await refreshProfileList();
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
      <p className="subtitle">Pengaturan kredensial, perilaku sistem &amp; jadwal</p>

      {/* ===== PEMILIH PROFIL (MULTI AKUN) ===== */}
      <section>
        <h2>Profil Akun</h2>
        <div className="key-input-group">
          <select value={config.id} onChange={(e) => handleSwitchProfile(e.target.value)}>
            {profileList.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button type="button" onClick={handleCreateProfile}>+ Profil Baru</button>
          <button type="button" className="btn-remove" onClick={handleDeleteProfile}>
            Hapus Profil Ini
          </button>
        </div>

        <label className="field-label" style={{ marginTop: 12 }}>
          Nama Profil
          <span className="hint">
            Dipakai sebagai penanda folder/jadwal, ganti sesuai akun (misal "Akun Skincare")
          </span>
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
        <label className="field-label">
          Threads User ID
          <span className="hint">ID akun Threads kamu (dari endpoint /me)</span>
        </label>
        <input
          type="text"
          placeholder="Contoh: 17841400..."
          value={config.threads_user_id}
          onChange={(e) => setConfig({ ...config, threads_user_id: e.target.value })}
        />

        <label className="field-label">
          Threads Access Token
          <span className="hint">Long-lived token, direfresh otomatis tiap minggu</span>
        </label>
        <input
          type="password"
          placeholder="Token panjang dari Meta Developer"
          value={config.threads_access_token}
          onChange={(e) => setConfig({ ...config, threads_access_token: e.target.value })}
        />
      </section>

      {/* ===== CLOUDINARY ===== */}
      <section>
        <h2>Cloudinary (hosting video/gambar)</h2>
        <label className="field-label">
          Cloudinary Cloud Name
          <span className="hint">Dari dashboard cloudinary.com</span>
        </label>
        <input
          type="text"
          placeholder="Contoh: dxyz1234"
          value={config.cloudinary.cloud_name}
          onChange={(e) =>
            setConfig({ ...config, cloudinary: { ...config.cloudinary, cloud_name: e.target.value } })
          }
        />

        <label className="field-label">
          Cloudinary API Key
          <span className="hint">Angka di dashboard Cloudinary, bukan API Secret</span>
        </label>
        <input
          type="text"
          placeholder="Contoh: 123456789012345"
          value={config.cloudinary.api_key}
          onChange={(e) =>
            setConfig({ ...config, cloudinary: { ...config.cloudinary, api_key: e.target.value } })
          }
        />

        <label className="field-label">
          Cloudinary API Secret
          <span className="hint">Jaga kerahasiaannya, jangan dibagikan</span>
        </label>
        <input
          type="password"
          placeholder="API Secret Cloudinary"
          value={config.cloudinary.api_secret}
          onChange={(e) =>
            setConfig({ ...config, cloudinary: { ...config.cloudinary, api_secret: e.target.value } })
          }
        />
      </section>

      {/* ===== GEMINI (MULTI KEY) ===== */}
      <section>
        <h2>Gemini API Key (untuk balasan AI)</h2>
        <p className="hint">
          Bisa isi lebih dari satu — kalau key pertama kuotanya habis, sistem otomatis
          coba key berikutnya secara berurutan.
        </p>

        {config.gemini_api_keys.map((key, index) => (
          <div className="gemini-key-row" key={index}>
            <label className="field-label">
              Gemini API Key #{index + 1}
              <span className="hint">
                {index === 0 ? "Dicoba pertama kali" : `Cadangan urutan ke-${index + 1}`}
              </span>
            </label>
            <div className="key-input-group">
              <input
                type="password"
                placeholder={`Tempel Gemini API Key ke-${index + 1} di sini`}
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
            <label className="field-label" style={{ marginTop: 16 }}>
              Gaya Bahasa Balasan
              <span className="hint">Pilih template siap pakai, atau tulis sendiri</span>
            </label>
            <select
              value={config.ai_style_preset}
              onChange={(e) => setConfig({ ...config, ai_style_preset: e.target.value })}
            >
              {STYLE_PRESET_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>

            <label className="field-label">
              Panjang Balasan (maksimal jumlah kalimat)
            </label>
            <input
              type="number"
              min={1}
              max={5}
              value={config.ai_max_sentences}
              onChange={(e) => setConfig({ ...config, ai_max_sentences: Number(e.target.value) })}
            />

            <label className="field-label">
              {config.ai_style_preset === "custom"
                ? "Instruksi Gaya Bahasa (wajib diisi karena pilih Custom)"
                : "Aturan Tambahan (opsional)"}
              <span className="hint">
                {config.ai_style_preset === "custom"
                  ? "Tulis bebas gaya bahasa yang kamu mau, contoh: \"Gunakan bahasa Jawa halus, sedikit humor\""
                  : "Ditambahkan sebagai aturan ekstra di atas template yang dipilih"}
              </span>
            </label>
            <textarea
              rows={3}
              placeholder={
                config.ai_style_preset === "custom"
                  ? "Contoh: Gaya bahasa hangat seperti kakak online shop, selalu sebut 'kak' di awal kalimat..."
                  : "Contoh: selalu sebut nama brand di akhir kalimat"
              }
              value={config.ai_custom_instruction}
              onChange={(e) => setConfig({ ...config, ai_custom_instruction: e.target.value })}
            />
          </>
        )}
      </section>

      {/* ===== FOLDER KONTEN ===== */}
      <section>
        <h2>Folder Konten</h2>
        <label className="field-label">Folder Queue (stok konten baru)</label>
        <div className="folder-picker-row">
          <input type="text" readOnly value={config.queue_folder} placeholder="Belum dipilih" />
          <button type="button" onClick={() => pickFolder("queue_folder")}>Pilih Folder</button>
        </div>

        <label className="field-label">Folder Posted (arsip yang sudah tayang)</label>
        <div className="folder-picker-row">
          <input type="text" readOnly value={config.posted_folder} placeholder="Belum dipilih" />
          <button type="button" onClick={() => pickFolder("posted_folder")}>Pilih Folder</button>
        </div>
      </section>

      {/* ===== LOKASI PROGRAM ===== */}
      <section>
        <h2>Lokasi Program</h2>

        <label className="field-label">
          Path node.exe
          <span className="hint">Biasanya: C:\Program Files\nodejs\node.exe</span>
        </label>
        <div className="folder-picker-row">
          <input
            type="text"
            value={config.node_exe_path}
            placeholder="C:\Program Files\nodejs\node.exe"
            onChange={(e) => setConfig({ ...config, node_exe_path: e.target.value })}
          />
          <button type="button" onClick={handleDetectNode}>Deteksi Otomatis</button>
        </div>

        <label className="field-label">
          Folder Proyek
          <span className="hint">Folder tempat thread-poster.js dkk berada, contoh: C:\autopost-threads</span>
        </label>
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
        <p className="hint" style={{ marginTop: 6 }}>
          Klik ini di RDP/PC baru — otomatis membuat folder proyek, menulis semua
          file program, dan menjalankan "npm install". Cukup sekali per instalasi.
        </p>

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

        <label className="field-label">
          Jam Posting Utama (thread-poster.js)
          <span className="hint">Bebas tambah/hapus jam sesuai kebutuhan</span>
        </label>
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

        <label className="field-label" style={{ marginTop: 16 }}>
          Interval Reply Checker (menit)
          <span className="hint">Cek &amp; kirim reply link affiliate yang terjadwal</span>
        </label>
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

        <label className="field-label">
          Interval Comment Responder (menit)
          <span className="hint">
            Hanya berjalan kalau toggle "Balasan Komentar Otomatis (AI)" di atas AKTIF
          </span>
        </label>
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

        <label className="field-label">
          Refresh Token — Hari &amp; Jam
          <span className="hint">Cukup 1x seminggu</span>
        </label>
        <div className="key-input-group">
          <select
            value={config.schedule.refresh_token_day}
            onChange={(e) =>
              setConfig({ ...config, schedule: { ...config.schedule, refresh_token_day: e.target.value } })
            }
          >
            {HARI_OPTIONS.map((h) => (
              <option key={h.value} value={h.value}>{h.label}</option>
            ))}
          </select>
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