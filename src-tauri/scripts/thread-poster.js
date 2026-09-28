// thread-poster.js
// Menggantikan autopost.js versi sebelumnya.
// Mendukung 2 jenis item di folder queue:
//   1. Standalone  : produk001.mp4 / .jpg / .txt (kombinasi bebas)
//   2. Utas berantai: utas001_part1.txt, utas001_part2.mp4, dst
//      (tiap part di-reply ke part sebelumnya, membentuk 1 utas)
//
// Tiap item (standalone ATAU 1 utas penuh) juga boleh punya file
// "_reply.txt" untuk balasan berisi link affiliate, dikirim belakangan
// lewat reply-checker.js (lihat pending-reply.json).
//
// PERBAIKAN DI VERSI INI:
//  1. File di R2 SELALU dihapus (try/finally), baik publish sukses maupun gagal.
//     Kalau gagal, file asli tetap aman di folder queue dan akan diupload ulang.
//  2. Utas yang gagal di tengah TIDAK diposting dobel. Tiap part yang sukses
//     langsung dipindah ke "posted" dan dicatat di thread-state.json, sehingga
//     jadwal berikutnya melanjutkan dari part yang belum terposting.
//  3. Pemindahan file & baca/tulis JSON dibuat tahan error supaya tidak
//     memicu posting ulang setelah post sudah terbit.
//  4. Item yang gagal 3 kali berturut-turut dipindah otomatis ke folder
//     "failed" supaya tidak menahan antrean. Kegagalan karena kendala
//     sistem (token/akun bermasalah, jaringan putus, rate limit, server
//     error) TIDAK dihitung, supaya antrean tidak habis masuk "failed"
//     gara-gara masalah sementara.
//  5. (BARU) Lock file: kalau run sebelumnya masih berjalan (misal utas
//     panjang), run yang baru dilewati supaya tidak terjadi posting dobel.
//  6. (BARU) Nama file di R2 dibersihkan dari simbol yang merusak URL.
//  7. (BARU) Utas yang sedang setengah jalan diprioritaskan sebelum item lain.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// Ambil dari .env (diisi otomatis oleh app Threads Automator).
// Kalau belum diisi (misal saat testing manual), pakai folder default
// "queue" dan "posted" di dalam folder proyek ini.
const QUEUE_DIR = process.env.QUEUE_FOLDER && process.env.QUEUE_FOLDER.trim() !== ''
  ? process.env.QUEUE_FOLDER
  : path.join(__dirname, 'queue');
const POSTED_DIR = process.env.POSTED_FOLDER && process.env.POSTED_FOLDER.trim() !== ''
  ? process.env.POSTED_FOLDER
  : path.join(__dirname, 'posted');
const LOG_FILE = path.join(__dirname, 'thread-poster.log');
const PENDING_REPLY_FILE = path.join(__dirname, 'pending-reply.json');
const POSTED_INDEX_FILE = path.join(__dirname, 'posted-index.json');
const THREAD_STATE_FILE = path.join(__dirname, 'thread-state.json'); // progres utas
const FAILED_ITEMS_FILE = path.join(__dirname, 'failed-items.json'); // penghitung gagal
const LOCK_FILE = path.join(__dirname, 'thread-poster.lock');
const LOCK_STALE_MS = 2 * 60 * 60 * 1000; // lock dianggap basi setelah 2 jam
// Folder untuk item bermasalah (dibuat otomatis kalau belum ada).
// Bisa diubah lewat FAILED_FOLDER di .env, default: folder "failed" di samping skrip ini.
const FAILED_DIR = process.env.FAILED_FOLDER && process.env.FAILED_FOLDER.trim() !== ''
  ? process.env.FAILED_FOLDER
  : path.join(__dirname, 'failed');
const MAX_FAILURES = 3; // gagal berapa kali berturut-turut sebelum item dilewati

const THREADS_USER_ID = process.env.THREADS_USER_ID;
const THREADS_ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const THREADS_API_BASE = 'https://graph.threads.net/v1.0';
const HTTP_TIMEOUT_MS = 60 * 1000;

// Jeda antar part dalam 1 utas (milidetik). Ubah sesuai kebutuhan.
const DELAY_BETWEEN_PARTS_MS = 60 * 1000; // 60 detik

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png'];
const VIDEO_EXTS = ['.mp4'];

// ====== KONFIGURASI CLOUDFLARE R2 (pengganti Cloudinary) ======
// R2 kompatibel dengan S3 API, jadi dipanggil pakai library @aws-sdk/client-s3
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL_BASE = (process.env.R2_PUBLIC_URL_BASE || '').replace(/\/$/, '');

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ====================================================
// HELPER UMUM
// ====================================================
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(line.trim());
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    // jangan sampai gagal nulis log menghentikan proses
  }
}

function randomMinutes(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Pesan error yang lebih informatif untuk error axios (isi balasan API ikut dicatat)
function errMsg(err) {
  if (err && err.response) {
    let body = '';
    try {
      body = typeof err.response.data === 'string'
        ? err.response.data
        : JSON.stringify(err.response.data);
    } catch (e) {
      body = '';
    }
    return `${err.message} | ${body}`;
  }
  return err && err.message ? err.message : String(err);
}

// Baca file JSON dengan aman. Kalau rusak, file lama dicadangkan (.bak)
// supaya datanya tidak hilang tertimpa, lalu pakai nilai fallback.
function readJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    log(`PERINGATAN: ${path.basename(file)} tidak bisa dibaca (${err.message}). Dicadangkan ke .bak`);
    try {
      fs.copyFileSync(file, `${file}.${Date.now()}.bak`);
    } catch (e) {
      // abaikan
    }
    return fallback;
  }
}

// Tulis JSON secara atomik (tulis ke file sementara dulu, lalu rename)
// supaya tidak setengah tertulis kalau proses mati mendadak.
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readTextSafe(filePath) {
  if (!filePath) return '';
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch (err) {
    log(`PERINGATAN: gagal membaca ${filePath}: ${err.message}`);
    return '';
  }
}

// ====================================================
// LOCK: cegah dua proses thread-poster berjalan bersamaan (BARU)
// ====================================================
// Tiap jam posting adalah task terpisah di Task Scheduler. Kalau utas panjang
// masih berjalan saat jam berikutnya tiba, tanpa lock dua proses akan memilih
// item yang sama dan memposting dobel.
let lockOwned = false;

function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx'); // gagal kalau file sudah ada
    fs.writeSync(fd, String(Date.now()));
    fs.closeSync(fd);
    lockOwned = true;
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') {
      // Error lain (misal izin folder): jangan blokir posting, tapi catat.
      log(`PERINGATAN: lock file tidak bisa dibuat (${err.message}), lanjut tanpa lock.`);
      return true;
    }
    try {
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age > LOCK_STALE_MS) {
        log('Lock lama ditemukan (proses sebelumnya kemungkinan mati), diambil alih.');
        fs.writeFileSync(LOCK_FILE, String(Date.now()));
        lockOwned = true;
        return true;
      }
    } catch (e) {
      // lock hilang / tidak terbaca, anggap masih dipakai proses lain
    }
    return false;
  }
}

function releaseLock() {
  if (!lockOwned) return;
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (e) {
    // abaikan
  }
  lockOwned = false;
}

// ====================================================
// 0. STATE PROGRES UTAS
// ====================================================
// Bentuk: { "utas001": { lastPostId, doneParts: [1,2], captions: {"1":"..","2":".."} } }
function loadThreadStates() {
  const data = readJsonSafe(THREAD_STATE_FILE, {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function saveThreadStates(states) {
  writeJsonAtomic(THREAD_STATE_FILE, states);
}

function getThreadState(threadId) {
  const s = loadThreadStates()[threadId];
  return {
    lastPostId: s && s.lastPostId ? s.lastPostId : null,
    doneParts: s && Array.isArray(s.doneParts) ? s.doneParts : [],
    captions: s && s.captions && typeof s.captions === 'object' ? s.captions : {},
  };
}

function setThreadState(threadId, state) {
  const states = loadThreadStates();
  states[threadId] = state;
  saveThreadStates(states);
}

function clearThreadState(threadId) {
  const states = loadThreadStates();
  if (states[threadId]) {
    delete states[threadId];
    saveThreadStates(states);
  }
}

// ====================================================
// 1. BACA & KELOMPOKKAN ISI FOLDER QUEUE
// ====================================================
function scanQueue() {
  if (!fs.existsSync(QUEUE_DIR)) {
    throw new Error(`Folder queue tidak ditemukan: ${QUEUE_DIR}`);
  }

  const allFiles = fs.readdirSync(QUEUE_DIR);
  const threadGroups = {}; // { "utas001": { parts: { 1: {...}, 2: {...} }, earliestTime } }
  const standaloneGroups = {}; // { "produk001": { txt, media, replyTxt, earliestTime } }

  const threadPattern = /^(utas\d+)_part(\d+)(_reply)?\.(txt|mp4|jpg|jpeg|png)$/i;

  for (const fileName of allFiles) {
    const fullPath = path.join(QUEUE_DIR, fileName);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (e) {
      continue; // file hilang/terkunci saat discan, lewati
    }
    if (!stat.isFile()) continue;

    const threadMatch = fileName.match(threadPattern);

    if (threadMatch) {
      const [, threadId, partNumStr, isReply, ext] = threadMatch;
      const partNum = parseInt(partNumStr, 10);

      if (!threadGroups[threadId]) threadGroups[threadId] = { parts: {}, earliestTime: stat.birthtime };
      if (!threadGroups[threadId].parts[partNum]) threadGroups[threadId].parts[partNum] = {};

      if (isReply) {
        threadGroups[threadId].parts[partNum].replyPath = fullPath;
      } else if (ext.toLowerCase() === 'txt') {
        threadGroups[threadId].parts[partNum].txtPath = fullPath;
      } else {
        threadGroups[threadId].parts[partNum].mediaPath = fullPath;
        threadGroups[threadId].parts[partNum].mediaExt = '.' + ext.toLowerCase();
      }

      if (stat.birthtime < threadGroups[threadId].earliestTime) {
        threadGroups[threadId].earliestTime = stat.birthtime;
      }
    } else {
      // Standalone: kelompokkan berdasarkan nama file tanpa extension,
      // dan tanpa akhiran "_reply"
      const ext = path.extname(fileName).toLowerCase();
      const isReply = fileName.toLowerCase().endsWith(`_reply${ext}`);
      const baseName = isReply
        ? path.basename(fileName, ext).replace(/_reply$/i, '')
        : path.basename(fileName, ext);

      if (!standaloneGroups[baseName]) {
        standaloneGroups[baseName] = { earliestTime: stat.birthtime };
      }
      if (stat.birthtime < standaloneGroups[baseName].earliestTime) {
        standaloneGroups[baseName].earliestTime = stat.birthtime;
      }

      if (isReply) {
        standaloneGroups[baseName].replyPath = fullPath;
      } else if (ext === '.txt') {
        standaloneGroups[baseName].txtPath = fullPath;
      } else if ([...IMAGE_EXTS, ...VIDEO_EXTS].includes(ext)) {
        standaloneGroups[baseName].mediaPath = fullPath;
        standaloneGroups[baseName].mediaExt = ext;
      }
    }
  }

  return { threadGroups, standaloneGroups };
}

// ====================================================
// 2. TENTUKAN ITEM BERIKUTNYA (FIFO lintas standalone & thread)
// ====================================================
function getNextItem() {
  const { threadGroups, standaloneGroups } = scanQueue();
  const states = loadThreadStates();

  const candidates = [];

  for (const [id, group] of Object.entries(threadGroups)) {
    // Utas dianggap layak diproses kalau masih ada part yang bisa diposting,
    // ATAU ada progres tersimpan (artinya tinggal menyelesaikan/merapikan).
    const hasPostablePart = Object.values(group.parts).some((p) => p.txtPath || p.mediaPath);
    if (!hasPostablePart && !states[id]) continue;
    // Utas yang sudah setengah jalan diprioritaskan (waktu "paling lama")
    // supaya diselesaikan dulu sebelum item lain, tidak menggantung.
    candidates.push({
      type: 'thread',
      id,
      group,
      time: states[id] ? new Date(0) : group.earliestTime,
    });
  }
  for (const [id, group] of Object.entries(standaloneGroups)) {
    // butuh minimal txt ATAU media
    if (!group.txtPath && !group.mediaPath) continue;
    candidates.push({ type: 'standalone', id, group, time: group.earliestTime });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.time - b.time);
  return candidates[0];
}

// ====================================================
// 3. UPLOAD MEDIA (kalau ada) KE CLOUDFLARE R2
// ====================================================
async function uploadMedia(mediaPath, ext) {
  const isVideo = VIDEO_EXTS.includes(ext);
  log(`Uploading media ke Cloudflare R2 (${isVideo ? 'video' : 'image'}): ${mediaPath}`);

  const fileBuffer = fs.readFileSync(mediaPath);
  // Nama file dibersihkan dari simbol yang bisa merusak URL (spasi, #, ?, dll)
  // dan diberi timestamp supaya unik antar upload.
  const safeName = path.basename(mediaPath).replace(/[^a-zA-Z0-9._-]/g, '_');
  const objectKey = `threads-autopost/${Date.now()}-${safeName}`;
  const contentType = isVideo ? 'video/mp4' : (ext === '.png' ? 'image/png' : 'image/jpeg');

  await r2Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: objectKey,
    Body: fileBuffer,
    ContentType: contentType,
  }));

  const publicUrl = `${R2_PUBLIC_URL_BASE}/${objectKey}`;
  log(`Upload selesai. URL: ${publicUrl}`);
  return { url: publicUrl, isVideo, objectKey };
}

// Hapus file dari R2 setelah selesai dipakai, biar tidak numpuk storage.
// Tidak pernah melempar error (kegagalan hapus tidak boleh menggagalkan posting).
async function deleteFromR2(objectKey) {
  if (!objectKey) return;
  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: objectKey }));
    log(`File dihapus dari R2: ${objectKey}`);
  } catch (err) {
    log(`GAGAL menghapus dari R2 (tidak fatal, dilanjutkan): ${errMsg(err)}`);
  }
}

// ====================================================
// 4. THREADS API: BUAT CONTAINER, TUNGGU, PUBLISH
// ====================================================
async function createContainer({ text, mediaUrl, isVideo, replyToId }) {
  const params = { access_token: THREADS_ACCESS_TOKEN };

  if (mediaUrl) {
    params.media_type = isVideo ? 'VIDEO' : 'IMAGE';
    if (isVideo) params.video_url = mediaUrl;
    else params.image_url = mediaUrl;
  } else {
    params.media_type = 'TEXT';
  }

  if (text) params.text = text;
  if (replyToId) params.reply_to_id = replyToId;

  const res = await axios.post(`${THREADS_API_BASE}/${THREADS_USER_ID}/threads`, null, {
    params,
    timeout: HTTP_TIMEOUT_MS,
  });
  log(`Container dibuat (${params.media_type}). ID: ${res.data.id}`);
  return res.data.id;
}

async function waitUntilFinished(containerId, maxAttempts = 30, delayMs = 10000) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await axios.get(`${THREADS_API_BASE}/${containerId}`, {
      params: { fields: 'status,error_message', access_token: THREADS_ACCESS_TOKEN },
      timeout: HTTP_TIMEOUT_MS,
    });
    const status = res.data.status;
    if (status === 'FINISHED') return true;
    if (status === 'ERROR') {
      throw new Error(`Threads gagal memproses media (status: ERROR) ${res.data.error_message || ''}`.trim());
    }
    if (status === 'EXPIRED') {
      throw new Error('Container media kedaluwarsa (status: EXPIRED)');
    }
    await sleep(delayMs);
  }
  throw new Error('Timeout menunggu media selesai diproses');
}

async function publishContainer(containerId) {
  const res = await axios.post(`${THREADS_API_BASE}/${THREADS_USER_ID}/threads_publish`, null, {
    params: { creation_id: containerId, access_token: THREADS_ACCESS_TOKEN },
    timeout: HTTP_TIMEOUT_MS,
  });
  log(`Berhasil dipublish. Post ID: ${res.data.id}`);
  return res.data.id;
}

// Post 1 bagian (dipakai baik standalone maupun tiap part utas)
// File di R2 dihapus lewat "finally", jadi tetap terhapus walaupun
// createContainer / waitUntilFinished / publishContainer gagal.
// Kalau gagal, file asli masih ada di folder queue dan akan diupload ulang
// saat dicoba lagi di jadwal berikutnya.
async function postOnePart({ text, mediaPath, mediaExt, replyToId }) {
  let mediaUrl = null;
  let isVideo = false;
  let objectKey = null;

  if (mediaPath) {
    const uploaded = await uploadMedia(mediaPath, mediaExt);
    mediaUrl = uploaded.url;
    isVideo = uploaded.isVideo;
    objectKey = uploaded.objectKey;
  }

  try {
    const containerId = await createContainer({ text, mediaUrl, isVideo, replyToId });

    // Media butuh waktu diproses, teks biasanya instan
    if (mediaUrl) {
      await waitUntilFinished(containerId);
    }

    const postId = await publishContainer(containerId);
    return postId;
  } finally {
    // Sampai di sini Threads sudah selesai mengambil file-nya (sukses),
    // atau proses gagal dan file akan diupload ulang saat retry.
    // Dua-duanya aman untuk menghapus file sementara di R2.
    if (objectKey) {
      await deleteFromR2(objectKey);
    }
  }
}

// ====================================================
// 5. JADWALKAN REPLY LINK AFFILIATE (kalau ada file _reply)
// ====================================================
function schedulePendingReply(postId, replyText) {
  const delayMinutes = randomMinutes(15, 50);
  const dueAt = new Date(Date.now() + delayMinutes * 60 * 1000);

  let pending = readJsonSafe(PENDING_REPLY_FILE, []);
  if (!Array.isArray(pending)) pending = [];
  pending.push({ postId, replyText, dueAt: dueAt.toISOString(), done: false });
  writeJsonAtomic(PENDING_REPLY_FILE, pending);
  log(`Reply link dijadwalkan untuk post ${postId} pada ${dueAt.toISOString()} (${delayMinutes} menit lagi)`);
}

// ====================================================
// 6. PINDAHKAN FILE-FILE YANG SUDAH DIPOSTING KE FOLDER POSTED
// ====================================================
// Tidak pernah melempar error: kalau gagal memindah SETELAH post terbit,
// error tidak boleh membuat item dianggap gagal (nanti malah terposting ulang).
function moveFilesToDir(destDir, filePaths) {
  try {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  } catch (err) {
    log(`PERINGATAN: gagal membuat folder ${destDir}: ${err.message}`);
    return;
  }

  for (const p of filePaths) {
    if (!p || !fs.existsSync(p)) continue;
    const dest = path.join(destDir, path.basename(p));
    try {
      fs.renameSync(p, dest);
    } catch (err) {
      // Fallback: salin lalu hapus (misal beda drive)
      try {
        fs.copyFileSync(p, dest);
        fs.unlinkSync(p);
      } catch (err2) {
        log(`PERINGATAN: gagal memindahkan ${p} ke ${destDir}: ${err2.message}`);
      }
    }
  }
}

function moveFilesToPosted(filePaths) {
  moveFilesToDir(POSTED_DIR, filePaths);
}

// ====================================================
// 7. PROSES: STANDALONE
// ====================================================
async function processStandalone(item) {
  const { group, id } = item;
  log(`Memproses standalone: ${id}`);

  const text = readTextSafe(group.txtPath);

  const postId = await postOnePart({
    text,
    mediaPath: group.mediaPath,
    mediaExt: group.mediaExt,
  });

  // Post sudah terbit. Setelah ini tidak boleh ada yang melempar error.
  moveFilesToPosted([group.txtPath, group.mediaPath, group.replyPath]);

  log(`SELESAI standalone: ${id}`);
  return postId;
}

// ====================================================
// 8. PROSES: UTAS BERANTAI
// ====================================================
// Progres tiap part disimpan ke thread-state.json dan file part yang sukses
// langsung dipindah ke "posted". Kalau utas gagal di tengah, jadwal berikutnya
// MELANJUTKAN dari part yang belum terposting (reply-nya tetap nyambung ke
// part terakhir yang sudah terbit), bukan mengulang dari part 1.
async function processThread(item) {
  const { group, id } = item;
  const allPartNumbers = Object.keys(group.parts).map(Number).sort((a, b) => a - b);

  const state = getThreadState(id);

  // Rapikan: kalau ada part yang sudah tercatat sukses tapi file-nya masih
  // di queue (proses sempat mati sebelum sempat memindah), pindahkan sekarang.
  for (const n of allPartNumbers) {
    if (state.doneParts.includes(n)) {
      const p = group.parts[n];
      moveFilesToPosted([p.txtPath, p.mediaPath]);
    }
  }

  // Part yang perlu diposting: punya teks/media dan belum tercatat sukses
  const pendingParts = allPartNumbers.filter((n) => {
    const p = group.parts[n];
    return (p.txtPath || p.mediaPath) && !state.doneParts.includes(n);
  });

  // File _reply: ambil dari part dengan nomor tertinggi yang punya _reply
  let replyPath = null;
  for (const n of allPartNumbers) {
    if (group.parts[n].replyPath) replyPath = group.parts[n].replyPath;
  }
  // Baca isinya SEKARANG (sebelum file dipindah) supaya tidak bergantung
  // pada lokasi file nanti.
  const replyText = readTextSafe(replyPath);

  const totalParts = pendingParts.length + state.doneParts.length;
  if (state.doneParts.length > 0) {
    log(`Melanjutkan utas ${id}: ${state.doneParts.length} part sudah terbit, sisa ${pendingParts.length} part.`);
  } else {
    log(`Memproses utas: ${id} (${pendingParts.length} part)`);
  }

  let previousPostId = state.lastPostId; // null kalau utas baru
  let lastPostId = state.lastPostId;

  let postedThisRun = 0;
  try {
    for (let i = 0; i < pendingParts.length; i++) {
      const partNum = pendingParts[i];
      const part = group.parts[partNum];
      const text = readTextSafe(part.txtPath);

      log(`Posting ${id} part ${partNum} (${state.doneParts.length + 1}/${totalParts})...`);

      // Kalau ini gagal, error naik ke main; progres part sebelumnya sudah aman tersimpan.
      const postId = await postOnePart({
        text,
        mediaPath: part.mediaPath,
        mediaExt: part.mediaExt,
        replyToId: previousPostId, // null untuk part pertama
      });

      previousPostId = postId;
      lastPostId = postId;
      postedThisRun++;

      // Simpan progres DULU (paling penting), baru pindahkan file.
      state.lastPostId = postId;
      state.doneParts.push(partNum);
      state.captions[String(partNum)] = text;
      try {
        setThreadState(id, state);
      } catch (err) {
        // Kalau progres gagal tersimpan, lanjutkan saja (utas tetap tersambung
        // di run ini), tapi catat peringatan.
        log(`PERINGATAN: gagal menyimpan progres utas ${id}: ${err.message}`);
      }
      moveFilesToPosted([part.txtPath, part.mediaPath]);

      // Jeda antar part, kecuali setelah part terakhir
      if (i < pendingParts.length - 1) {
        log(`Menunggu ${DELAY_BETWEEN_PARTS_MS / 1000} detik sebelum part berikutnya...`);
        await sleep(DELAY_BETWEEN_PARTS_MS);
      }
    }
  } catch (err) {
    // Tandai kalau run ini sempat menerbitkan part (berarti ada kemajuan,
    // bukan macet di tempat yang sama).
    if (err && typeof err === 'object') err.madeProgress = postedThisRun > 0;
    throw err;
  }

  if (!lastPostId) {
    throw new Error(`Utas ${id} tidak punya part yang bisa diposting`);
  }

  // Semua part terbit. Rapikan file reply dan hapus progres.
  moveFilesToPosted([replyPath]);
  // Pindahkan juga sisa file _reply dari part lain kalau ada
  for (const n of allPartNumbers) {
    const rp = group.parts[n].replyPath;
    if (rp && rp !== replyPath) moveFilesToPosted([rp]);
  }

  const captionText = Object.keys(state.captions)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => state.captions[String(n)] || '')
    .join(' | ');

  try {
    clearThreadState(id);
  } catch (err) {
    log(`PERINGATAN: gagal menghapus progres utas ${id}: ${err.message}`);
  }

  log(`SELESAI utas: ${id}, total ${totalParts} part terposting.`);
  return { lastPostId, hasReply: !!replyPath, replyText, captionText };
}

// ====================================================
// 9. CATAT POST YANG TAYANG KE posted-index.json
//    (dipakai comment-responder.js buat tau jenis post & captionnya)
// ====================================================
function recordPostedIndex({ postId, type, captionText }) {
  let index = readJsonSafe(POSTED_INDEX_FILE, []);
  if (!Array.isArray(index)) index = [];
  index.push({
    postId,
    type, // 'jualan' atau 'nonjualan'
    captionText: captionText || '',
    postedAt: new Date().toISOString(),
  });
  writeJsonAtomic(POSTED_INDEX_FILE, index);
  log(`Dicatat ke posted-index.json: ${postId} (${type})`);
}

// Pencatatan setelah post terbit: kalau gagal, cukup dicatat di log.
// Post sudah terbit, jadi TIDAK boleh dianggap gagal (nanti terposting ulang).
function afterPostBookkeeping({ postId, isJualan, captionText, replyText }) {
  try {
    recordPostedIndex({ postId, type: isJualan ? 'jualan' : 'nonjualan', captionText });
  } catch (err) {
    log(`PERINGATAN: gagal mencatat posted-index untuk ${postId}: ${err.message}`);
  }

  if (isJualan) {
    if (!replyText) {
      log(`PERINGATAN: post ${postId} bertipe jualan tapi isi _reply kosong/tidak terbaca, reply tidak dijadwalkan.`);
      return;
    }
    try {
      schedulePendingReply(postId, replyText);
    } catch (err) {
      log(`PERINGATAN: gagal menjadwalkan reply untuk ${postId}: ${err.message}`);
    }
  }
}

// ====================================================
// 10. PENGHITUNG GAGAL & FOLDER "failed"
// ====================================================
const NETWORK_ERROR_CODES = [
  'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND',
  'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH',
];
const SYSTEM_API_CODES = [190, 102, 4, 17, 32, 613]; // token/sesi bermasalah & rate limit Graph API
const SYSTEM_AWS_NAMES = [
  'CredentialsProviderError', 'InvalidAccessKeyId', 'SignatureDoesNotMatch',
  'AccessDenied', 'NoSuchBucket', 'TimeoutError',
];

// Kegagalan yang BUKAN salah item (token/akun, jaringan, rate limit, server error,
// kredensial/bucket R2). Ini tidak dihitung, karena masalahnya sementara atau
// ada di pengaturan, bukan di file itu. Kalau dihitung, semua item di antrean
// bisa ikut terlempar ke "failed" hanya karena token habis atau internet putus.
function isSystemError(err) {
  if (!err) return false;

  const status = err.response && err.response.status;
  if (status === 401 || status === 403 || status === 429 || status >= 500) return true;

  const apiCode = err.response && err.response.data && err.response.data.error
    && err.response.data.error.code;
  if (SYSTEM_API_CODES.includes(apiCode)) return true;

  if (!err.response && err.code && NETWORK_ERROR_CODES.includes(err.code)) return true;

  const awsStatus = err.$metadata && err.$metadata.httpStatusCode;
  if (awsStatus === 401 || awsStatus === 403 || awsStatus >= 500) return true;
  if (err.name && SYSTEM_AWS_NAMES.includes(err.name)) return true;

  return false;
}

// Catat 1 kegagalan untuk item ini, kembalikan total hitungan sekarang.
function recordFailure(key, err) {
  try {
    const all = readJsonSafe(FAILED_ITEMS_FILE, {});
    const data = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    const count = (data[key] && data[key].count ? data[key].count : 0) + 1;
    data[key] = {
      count,
      lastError: errMsg(err).slice(0, 500),
      lastAt: new Date().toISOString(),
    };
    writeJsonAtomic(FAILED_ITEMS_FILE, data);
    return count;
  } catch (e) {
    log(`PERINGATAN: gagal menyimpan failed-items.json: ${e.message}`);
    return 0; // 0 = jangan sampai salah memindahkan item kalau penghitung rusak
  }
}

function clearFailure(key) {
  try {
    const all = readJsonSafe(FAILED_ITEMS_FILE, {});
    if (all && typeof all === 'object' && all[key]) {
      delete all[key];
      writeJsonAtomic(FAILED_ITEMS_FILE, all);
    }
  } catch (e) {
    log(`PERINGATAN: gagal mereset penghitung gagal ${key}: ${e.message}`);
  }
}

// Kumpulkan semua file item yang MASIH ada di folder queue
function collectItemFiles(item) {
  const g = item.group;
  if (item.type === 'standalone') {
    return [g.txtPath, g.mediaPath, g.replyPath];
  }
  const files = [];
  for (const p of Object.values(g.parts)) {
    files.push(p.txtPath, p.mediaPath, p.replyPath);
  }
  return files;
}

function quarantineItem(item, key) {
  moveFilesToDir(FAILED_DIR, collectItemFiles(item));
  clearFailure(key);
  log(`ITEM DILEWATI: ${item.id} gagal ${MAX_FAILURES}x berturut-turut. File dipindah ke folder failed: ${FAILED_DIR}`);
  if (item.type === 'thread') {
    log(`Catatan: part ${item.id} yang sudah terbit tetap tercatat di thread-state.json. Kalau file dikembalikan ke queue, utas dilanjutkan dari part yang belum terbit.`);
  }
}

// ====================================================
// MAIN
// ====================================================
function checkEnv() {
  const required = [
    'THREADS_USER_ID',
    'THREADS_ACCESS_TOKEN',
    'R2_ACCOUNT_ID',
    'R2_BUCKET_NAME',
    'R2_PUBLIC_URL_BASE',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ];
  const missing = required.filter((k) => !process.env[k] || process.env[k].trim() === '');
  if (missing.length > 0) {
    log(`ERROR: variabel .env belum diisi: ${missing.join(', ')}`);
    return false;
  }
  return true;
}

async function run() {
  log('=== Menjalankan thread-poster ===');

  if (!checkEnv()) return;

  let item;
  try {
    item = getNextItem();
  } catch (err) {
    log(`ERROR saat membaca queue: ${err.message}`);
    return;
  }

  if (!item) {
    log('Tidak ada item di folder queue. Selesai.');
    return;
  }

  try {
    if (item.type === 'standalone') {
      // Baca teks caption & reply SEBELUM file dipindah
      const captionText = readTextSafe(item.group.txtPath);
      const isJualan = !!item.group.replyPath;
      const replyText = isJualan ? readTextSafe(item.group.replyPath) : '';

      const postId = await processStandalone(item);

      afterPostBookkeeping({ postId, isJualan, captionText, replyText });
      clearFailure(`${item.type}:${item.id}`);
    } else {
      const { lastPostId, hasReply, replyText, captionText } = await processThread(item);

      // Catat post terakhir utas ke index (dengan gabungan caption semua part sebagai konteks)
      afterPostBookkeeping({
        postId: lastPostId,
        isJualan: hasReply,
        captionText,
        replyText,
      });
      clearFailure(`${item.type}:${item.id}`);
    }
  } catch (err) {
    const key = `${item.type}:${item.id}`;
    log(`GAGAL memproses ${item.id}: ${errMsg(err)}`);

    // Kendala sistem (token, jaringan, rate limit, server, kredensial R2):
    // bukan salah item, jadi tidak dihitung. Dicoba lagi di jadwal berikutnya.
    if (isSystemError(err)) {
      log('Kendala sistem/jaringan/akun (bukan salah item), TIDAK dihitung sebagai kegagalan item. Dicoba lagi di jadwal berikutnya.');
      return;
    }

    // Utas yang sempat menerbitkan part di run ini berarti ada kemajuan,
    // jadi hitungan gagalnya dimulai lagi dari awal.
    if (err && err.madeProgress) clearFailure(key);

    const count = recordFailure(key, err);
    if (count >= MAX_FAILURES) {
      quarantineItem(item, key);
    } else {
      if (item.type === 'thread') {
        log('Part yang sudah terbit tercatat di thread-state.json; jadwal berikutnya melanjutkan dari part yang belum terposting.');
      } else {
        log('File dibiarkan di folder queue, akan dicoba lagi di jadwal berikutnya.');
      }
      if (count > 0) log(`Kegagalan ke-${count} dari ${MAX_FAILURES} untuk ${item.id}.`);
    }
  }
}

// Pembungkus: pastikan hanya satu proses yang berjalan pada satu waktu,
// dan lock selalu dilepas walaupun terjadi error.
async function main() {
  if (!acquireLock()) {
    log('Proses thread-poster lain masih berjalan, run ini dilewati.');
    return;
  }
  try {
    await run();
  } finally {
    releaseLock();
  }
}

main().catch((err) => {
  log(`ERROR tak terduga: ${errMsg(err)}`);
  process.exitCode = 1;
});
