// thread-poster.js
// Mendukung Utas Berantai & Carousel (Slide)
//
// FITUR:
// 1. Standalone (1 Teks / 1 Gambar / 1 Video)
// 2. Carousel / Slide Kiri-Kanan (Kombinasi Gambar & Video, Maks 10)
// 3. Utas Berantai (Part 1, Part 2, dst saling mereply)
// 4. Otomatis menghapus file dari Cloudflare R2 setelah berhasil tayang.
//
// PERBAIKAN DI VERSI INI:
//  1. [BUGFIX] isSystemError kini memprioritaskan pengecekan 'error.code' dari 
//     Meta API. Jika Meta mengirim error validasi file (misal: code 100 karena caption 
//     kepanjangan) yang dibungkus dengan HTTP 5xx, sistem tidak akan tertipu lagi.
//     Sistem akan akurat menghitungnya sebagai kegagalan FILE dan membuangnya ke 
//     folder 'failed' setelah 3x gagal, mencegah infinite loop.
//  2. moveFilesToDir dibungkus try/catch internal agar tidak menggagalkan status post.
//  3. File "_reply" diambil dari part dengan nomor PALING BESAR.
//  4. waitUntilFinished dan publishContainer diberi timeout (HTTP_TIMEOUT_MS).
//  5. readJsonSafe mencadangkan file rusak ke ".bak" sebelum direset.
//  6. checkEnv() memastikan variabel .env lengkap sebelum bot jalan.
//  7. R2_PUBLIC_URL_BASE dibersihkan dari garis miring ganda.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// Konfigurasi Folder & File
const QUEUE_DIR = process.env.QUEUE_FOLDER || path.join(__dirname, 'queue');
const POSTED_DIR = process.env.POSTED_FOLDER || path.join(__dirname, 'posted');
const FAILED_DIR = path.join(__dirname, 'failed');

const LOG_FILE = path.join(__dirname, 'thread-poster.log');
const PENDING_REPLY_FILE = path.join(__dirname, 'pending-reply.json');
const POSTED_INDEX_FILE = path.join(__dirname, 'posted-index.json');
const THREAD_STATE_FILE = path.join(__dirname, 'thread-state.json');
const FAILED_ITEMS_FILE = path.join(__dirname, 'failed-items.json');
const LOCK_FILE = path.join(__dirname, 'thread-poster.lock');

const MAX_FAILURES = 3;
const DELAY_BETWEEN_PARTS_MS = 60 * 1000; // Jeda antar part (1 menit)
const HTTP_TIMEOUT_MS = 60 * 1000;

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png'];
const VIDEO_EXTS = ['.mp4'];

// Kredensial API
const THREADS_USER_ID = process.env.THREADS_USER_ID;
const THREADS_ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const THREADS_API_BASE = 'https://graph.threads.net/v1.0';

// Membersihkan URL agar tidak dobel "//"
const R2_PUBLIC_URL_BASE = (process.env.R2_PUBLIC_URL_BASE || '').replace(/\/$/, '');

// Inisialisasi Cloudflare R2
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ====================================================
// FUNGSI BANTUAN (HELPER)
// ====================================================
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(line.trim());
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err) {
  if (err && err.response && err.response.data) {
    return typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data);
  }
  return err && err.message ? err.message : String(err);
}

// Perlindungan jika JSON korup (backup ke .bak)
function readJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    log(`PERINGATAN: ${path.basename(file)} tidak bisa dibaca (${err.message}). Dicadangkan ke .bak`);
    try { fs.copyFileSync(file, `${file}.${Date.now()}.bak`); } catch (e) {}
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readTextSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try { return fs.readFileSync(filePath, 'utf-8').trim(); }
  catch (err) { return ''; }
}

// ====================================================
// CEK KELENGKAPAN .env
// ====================================================
function checkEnv() {
  const required = [
    'THREADS_USER_ID', 'THREADS_ACCESS_TOKEN',
    'R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL_BASE',
    'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  ];
  const missing = required.filter((k) => !process.env[k] || process.env[k].trim() === '');
  if (missing.length > 0) {
    log(`ERROR: variabel .env belum diisi: ${missing.join(', ')}`);
    return false;
  }
  return true;
}

// ====================================================
// SISTEM LOCK (Mencegah Bot Jalan Ganda)
// ====================================================
let lockOwned = false;
function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.closeSync(fd);
    lockOwned = true;
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return true; 
    try {
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age > 2 * 60 * 60 * 1000) { 
        fs.writeFileSync(LOCK_FILE, String(Date.now()));
        lockOwned = true;
        return true;
      }
    } catch (e) {}
    return false;
  }
}

function releaseLock() {
  if (!lockOwned) return;
  try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
  lockOwned = false;
}

// ====================================================
// 1. SCAN FOLDER QUEUE & KELOMPOKKAN FILE
// ====================================================
function scanQueue() {
  if (!fs.existsSync(QUEUE_DIR)) throw new Error(`Folder queue tidak ditemukan: ${QUEUE_DIR}`);

  const groups = {};

  for (const fileName of fs.readdirSync(QUEUE_DIR)) {
    const fullPath = path.join(QUEUE_DIR, fileName);
    if (!fs.statSync(fullPath).isFile()) continue;

    const ext = path.extname(fileName).toLowerCase();
    let baseName = path.basename(fileName, ext);

    let isReply = false;
    if (baseName.toLowerCase().endsWith('_reply')) {
      isReply = true;
      baseName = baseName.replace(/_reply$/i, '');
    }

    let slideNum = 1;
    const slideMatch = baseName.match(/_slide(\d+)$/i);
    if (slideMatch) {
      slideNum = parseInt(slideMatch[1], 10);
      baseName = baseName.replace(/_slide\d+$/i, '');
    }

    let partNum = 1;
    const partMatch = baseName.match(/_part(\d+)$/i);
    if (partMatch) {
      partNum = parseInt(partMatch[1], 10);
      baseName = baseName.replace(/_part\d+$/i, '');
    }

    if (!groups[baseName]) {
      groups[baseName] = { earliestTime: fs.statSync(fullPath).birthtime, parts: {} };
    }
    if (!groups[baseName].parts[partNum]) {
      groups[baseName].parts[partNum] = { slides: [] };
    }

    const partObj = groups[baseName].parts[partNum];

    if (isReply) {
      partObj.replyPath = fullPath;
    } else if (ext === '.txt') {
      partObj.txtPath = fullPath;
    } else if (IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext)) {
      partObj.slides.push({ path: fullPath, ext, num: slideNum });
    }
  }

  for (const g of Object.values(groups)) {
    for (const p of Object.values(g.parts)) {
      p.slides.sort((a, b) => a.num - b.num);
    }
  }

  return groups;
}

function getNextItem() {
  const groups = scanQueue();
  const states = readJsonSafe(THREAD_STATE_FILE, {});
  const candidates = [];

  for (const [id, group] of Object.entries(groups)) {
    const hasPostablePart = Object.values(group.parts).some(p => p.txtPath || p.slides.length > 0);
    if (!hasPostablePart && !states[id]) continue;
    candidates.push({ id, group, time: states[id] ? 0 : group.earliestTime });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.time - b.time);
  return candidates[0]; 
}

// ====================================================
// 2. SISTEM CLOUDFLARE R2
// ====================================================
async function uploadMedia(mediaPath, ext) {
  const isVideo = VIDEO_EXTS.includes(ext);
  const safeName = path.basename(mediaPath).replace(/[^a-zA-Z0-9._-]/g, '_');
  const objectKey = `threads-auto/${Date.now()}-${safeName}`;

  log(`Upload ke R2: ${path.basename(mediaPath)}...`);
  await r2Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: objectKey,
    Body: fs.readFileSync(mediaPath),
    ContentType: isVideo ? 'video/mp4' : (ext === '.png' ? 'image/png' : 'image/jpeg'),
  }));

  return { url: `${R2_PUBLIC_URL_BASE}/${objectKey}`, objectKey };
}

async function deleteFromR2(objectKey) {
  if (!objectKey) return;
  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: objectKey }));
    log(`[OK] File dihapus dari R2: ${objectKey}`);
  } catch (err) {
    log(`[Peringatan] Gagal menghapus R2 (diabaikan): ${errMsg(err)}`);
  }
}

// ====================================================
// 3. THREADS API
// ====================================================
async function createContainer({ text, media_type, mediaUrl, isCarouselItem, children, replyToId }) {
  const params = { access_token: THREADS_ACCESS_TOKEN, media_type };

  if (text) params.text = text;
  if (isCarouselItem) params.is_carousel_item = true;
  if (children) params.children = children;
  if (replyToId) params.reply_to_id = replyToId;

  if (mediaUrl) {
    if (media_type === 'VIDEO') params.video_url = mediaUrl;
    else params.image_url = mediaUrl;
  }

  const res = await axios.post(`${THREADS_API_BASE}/${THREADS_USER_ID}/threads`, null, {
    params, timeout: HTTP_TIMEOUT_MS
  });
  return res.data.id;
}

async function waitUntilFinished(containerId) {
  for (let i = 0; i < 30; i++) {
    const res = await axios.get(`${THREADS_API_BASE}/${containerId}`, {
      params: { fields: 'status,error_message', access_token: THREADS_ACCESS_TOKEN },
      timeout: HTTP_TIMEOUT_MS,
    });

    if (res.data.status === 'FINISHED') return true;
    if (res.data.status === 'ERROR') {
      throw new Error(`Threads gagal memproses media: ${res.data.error_message || ''}`);
    }

    log(`Menunggu media siap (Status: ${res.data.status})...`);
    await sleep(10000); 
  }
  throw new Error('Timeout menunggu media selesai diproses');
}

async function publishContainer(containerId) {
  const res = await axios.post(`${THREADS_API_BASE}/${THREADS_USER_ID}/threads_publish`, null, {
    params: { creation_id: containerId, access_token: THREADS_ACCESS_TOKEN },
    timeout: HTTP_TIMEOUT_MS,
  });
  return res.data.id;
}

// ====================================================
// 4. LOGIKA POSTING (TEKS, SINGLE, CAROUSEL)
// ====================================================
async function postOnePart({ text, slides, replyToId }) {
  let uploadedKeys = []; 

  try {
    if (slides.length === 0) {
      log(`Membuat container (TEKS SAJA)...`);
      const cid = await createContainer({ text, media_type: 'TEXT', replyToId });
      return await publishContainer(cid);
    }

    if (slides.length === 1) {
      log(`Membuat container (SINGLE MEDIA)...`);
      const s = slides[0];
      const uploaded = await uploadMedia(s.path, s.ext);
      uploadedKeys.push(uploaded.objectKey);

      const media_type = VIDEO_EXTS.includes(s.ext) ? 'VIDEO' : 'IMAGE';
      const cid = await createContainer({ text, media_type, mediaUrl: uploaded.url, replyToId });

      await waitUntilFinished(cid);
      return await publishContainer(cid);
    }

    if (slides.length > 10) throw new Error("Instagram/Threads membatasi maksimal 10 slide per post.");

    log(`Membuat container (CAROUSEL - ${slides.length} SLIDE)...`);
    let childrenIds = [];

    for (const s of slides) {
      const uploaded = await uploadMedia(s.path, s.ext);
      uploadedKeys.push(uploaded.objectKey);

      const media_type = VIDEO_EXTS.includes(s.ext) ? 'VIDEO' : 'IMAGE';
      const childId = await createContainer({ media_type, mediaUrl: uploaded.url, isCarouselItem: true });

      await waitUntilFinished(childId);
      childrenIds.push(childId);
    }

    const cid = await createContainer({ text, media_type: 'CAROUSEL', children: childrenIds.join(','), replyToId });
    return await publishContainer(cid);

  } finally {
    for (const key of uploadedKeys) {
      await deleteFromR2(key);
    }
  }
}

// ====================================================
// 5. PROSES UTAMA (MENANGANI ITEM)
// ====================================================
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
      try {
        fs.copyFileSync(p, dest);
        fs.unlinkSync(p);
      } catch (err2) {
        log(`PERINGATAN: gagal memindahkan ${p} ke ${destDir}: ${err2.message}`);
      }
    }
  }
}

async function processItem(item) {
  const { id, group } = item;
  const state = readJsonSafe(THREAD_STATE_FILE, {})[id] || { lastPostId: null, doneParts: [], captions: {} };
  const partNumbers = Object.keys(group.parts).map(Number).sort((a, b) => a - b);

  let replyPath = null;
  for (const n of partNumbers) {
    if (group.parts[n].replyPath) replyPath = group.parts[n].replyPath;
  }
  const replyText = readTextSafe(replyPath);

  let previousPostId = state.lastPostId;
  let lastPostId = state.lastPostId;

  for (const n of partNumbers) {
    const part = group.parts[n];

    if (state.doneParts.includes(n)) {
      moveFilesToDir(POSTED_DIR, [part.txtPath, ...part.slides.map(s => s.path)]);
      continue;
    }

    if (!part.txtPath && part.slides.length === 0) continue;

    const text = readTextSafe(part.txtPath);
    log(`Memposting [${id}] part ${n}...`);

    const postId = await postOnePart({ text, slides: part.slides, replyToId: previousPostId });

    previousPostId = postId;
    lastPostId = postId;

    state.lastPostId = postId;
    state.doneParts.push(n);
    state.captions[String(n)] = text;

    const allStates = readJsonSafe(THREAD_STATE_FILE, {});
    allStates[id] = state;
    writeJsonAtomic(THREAD_STATE_FILE, allStates);

    moveFilesToDir(POSTED_DIR, [part.txtPath, ...part.slides.map(s => s.path)]);

    if (n !== partNumbers[partNumbers.length - 1]) {
      log(`Menunggu ${DELAY_BETWEEN_PARTS_MS / 1000} detik sebelum part selanjutnya...`);
      await sleep(DELAY_BETWEEN_PARTS_MS);
    }
  }

  if (!lastPostId) throw new Error(`Tidak ada konten valid untuk diposting dari ${id}`);

  moveFilesToDir(POSTED_DIR, partNumbers.map(n => group.parts[n].replyPath).filter(Boolean));

  const allStatesFinal = readJsonSafe(THREAD_STATE_FILE, {});
  delete allStatesFinal[id];
  writeJsonAtomic(THREAD_STATE_FILE, allStatesFinal);

  const fullCaption = Object.values(state.captions).join(' | ');
  log(`[SUKSES] ${id} terposting. Post ID Akhir: ${lastPostId}`);

  return { postId: lastPostId, captionText: fullCaption, isJualan: !!replyPath, replyText };
}

// ====================================================
// 6. MAIN & ERROR HANDLING (REVISI BUGFIX HTTP 5xx)
// ====================================================
const NETWORK_ERROR_CODES = [
  'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND',
  'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH',
];
const SYSTEM_API_CODES = [190, 102, 4, 17, 32, 613]; 
const SYSTEM_AWS_NAMES = [
  'CredentialsProviderError', 'InvalidAccessKeyId', 'SignatureDoesNotMatch',
  'AccessDenied', 'NoSuchBucket', 'TimeoutError',
];

function isSystemError(err) {
  if (!err) return false;

  // 1. PRIORITAS UTAMA: Cek spesifik Error Code dari Meta API
  const metaError = err.response?.data?.error;
  if (metaError && metaError.code) {
    // Jika ada kode dari Meta, HANYA anggap error sistem jika kodenya ada di daftar SYSTEM_API_CODES.
    // (Contoh: kode 100 tidak ada di daftar ini, maka akan return FALSE / dihitung sebagai salah file).
    return SYSTEM_API_CODES.includes(metaError.code);
  }

  // 2. Cek error koneksi / Node.js
  if (!err.response && err.code && NETWORK_ERROR_CODES.includes(err.code)) return true;

  // 3. Cek HTTP Status biasa (hanya jika bukan format API Meta)
  const status = err.response?.status;
  if (status === 401 || status === 403 || status === 429 || status >= 500) return true;

  // 4. Cek Error spesifik dari AWS R2 SDK
  const awsStatus = err.$metadata?.httpStatusCode;
  if (awsStatus === 401 || awsStatus === 403 || awsStatus >= 500) return true;
  if (err.name && SYSTEM_AWS_NAMES.includes(err.name)) return true;

  return false;
}

async function main() {
  log('=== Menjalankan thread-poster ===');

  if (!checkEnv()) return;

  if (!acquireLock()) {
    log('Proses bot sebelumnya masih berjalan. Run ini dilewati.');
    return;
  }

  try {
    let item;
    try {
      item = getNextItem();
    } catch (err) {
      log(`ERROR saat membaca queue: ${errMsg(err)}`);
      return;
    }

    if (!item) {
      log('Tidak ada item di folder queue. Selesai.');
      return;
    }

    try {
      const result = await processItem(item);

      let index = readJsonSafe(POSTED_INDEX_FILE, []);
      if (!Array.isArray(index)) index = [];
      index.push({
        postId: result.postId,
        type: result.isJualan ? 'jualan' : 'nonjualan',
        captionText: result.captionText,
        postedAt: new Date().toISOString()
      });
      writeJsonAtomic(POSTED_INDEX_FILE, index);

      if (result.isJualan && result.replyText) {
        let pending = readJsonSafe(PENDING_REPLY_FILE, []);
        if (!Array.isArray(pending)) pending = [];
        const delayMins = Math.floor(Math.random() * (50 - 15 + 1)) + 15;
        pending.push({
          postId: result.postId,
          replyText: result.replyText,
          dueAt: new Date(Date.now() + delayMins * 60000).toISOString(),
          done: false
        });
        writeJsonAtomic(PENDING_REPLY_FILE, pending);
        log(`Reply affiliate dijadwalkan ${delayMins} menit dari sekarang.`);
      }

      const fails = readJsonSafe(FAILED_ITEMS_FILE, {});
      if (fails[item.id]) { delete fails[item.id]; writeJsonAtomic(FAILED_ITEMS_FILE, fails); }

    } catch (err) {
      log(`[GAGAL] memproses ${item.id}: ${errMsg(err)}`);

      // Evaluasi error menggunakan isSystemError yang baru diperbaiki
      if (isSystemError(err)) {
        log('Kendala server/jaringan/kredensial (bukan salah file). File aman, akan dicoba lagi di jadwal berikutnya.');
        return;
      }

      // Hitung kegagalan karena ini salah file (misal teks > 500 huruf)
      const fails = readJsonSafe(FAILED_ITEMS_FILE, {});
      fails[item.id] = { count: (fails[item.id]?.count || 0) + 1, err: errMsg(err).slice(0, 500) };
      writeJsonAtomic(FAILED_ITEMS_FILE, fails);

      if (fails[item.id].count >= MAX_FAILURES) {
        let allFiles = [];
        for (const p of Object.values(item.group.parts)) {
          allFiles.push(p.txtPath, p.replyPath, ...p.slides.map(s => s.path));
        }
        moveFilesToDir(FAILED_DIR, allFiles);
        log(`[DIPINDAHKAN] ${item.id} gagal ${MAX_FAILURES}x berturut-turut. Dipindah ke folder failed.`);
      } else {
        log(`Kegagalan ke-${fails[item.id].count} dari ${MAX_FAILURES} untuk ${item.id}.`);
      }
    }
  } finally {
    releaseLock();
  }
}

main().catch((err) => {
  log(`ERROR tak terduga: ${errMsg(err)}`);
  process.exitCode = 1;
});
