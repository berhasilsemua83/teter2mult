// thread-poster.js
// Mendukung Utas Berantai & Carousel (Slide)
//
// FITUR:
// 1. Standalone (1 Teks / 1 Gambar / 1 Video)
// 2. Carousel / Slide Kiri-Kanan (Kombinasi Gambar & Video, Maks 10)
// 3. Utas Berantai (Part 1, Part 2, dst saling mereply)
// 4. Otomatis menghapus file dari Cloudflare R2 setelah berhasil tayang.
//
// PERBAIKAN DI VERSI INI (dari hasil review):
//  1. isSystemError sekarang juga mengenali error dari @aws-sdk/client-s3
//     (Cloudflare R2) — sebelumnya cuma mengenali error axios/Threads.
//     Tanpa ini, kredensial R2 salah / bucket belum publik akan dihitung
//     sebagai kegagalan FILE (bisa masuk folder "failed" padahal filenya
//     baik-baik saja, masalahnya di pengaturan R2).
//  2. moveFilesToDir tidak pernah melempar error lagi (dibungkus try/catch
//     di dalam). Sebelumnya, kalau proses pindah file gagal SETELAH post
//     berhasil tayang, error itu naik dan dihitung sebagai kegagalan item —
//     padahal postingannya sudah sukses.
//  3. File "_reply" sekarang diambil dari part dengan nomor PALING BESAR
//     yang punya file reply (sebelumnya berhenti di part pertama yang
//     ketemu, karena ada "break").
//  4. waitUntilFinished dan publishContainer sekarang diberi timeout,
//     menyamakan dengan createContainer (sebelumnya tidak dibatasi,
//     berisiko menggantung tanpa batas kalau koneksi macet).
//  5. readJsonSafe sekarang mencadangkan file yang rusak ke ".bak" sebelum
//     dipakai fallback kosong, supaya data lama tidak hilang percuma kalau
//     file JSON rusak (misal proses mati saat menulis).
//  6. (Tambahan, bukan dari 5 poin di atas) checkEnv() dikembalikan: cek
//     variabel .env penting sebelum jalan, biar errornya jelas dari awal
//     kalau kredensial belum lengkap, bukan error samar di tengah proses.
//  7. (Kecil) R2_PUBLIC_URL_BASE dibersihkan dari garis miring di akhir,
//     supaya URL hasil upload tidak dobel garis miring.

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

// PERBAIKAN 7: buang garis miring di akhir supaya URL tidak dobel "//"
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

// PERBAIKAN 5: kalau file JSON rusak/tidak bisa diparse, cadangkan dulu ke
// ".bak" sebelum dianggap kosong. Supaya data lama tidak hilang percuma
// kalau nanti mau dicek manual apa yang rusak.
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
// CEK KELENGKAPAN .env (Tambahan)
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
    if (err.code !== 'EEXIST') return true; // Error izin, abaikan
    try {
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age > 2 * 60 * 60 * 1000) { // Jika file lock sudah basi (2 jam)
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
// Fitur ini otomatis mendeteksi apakah file tersebut Standalone, Utas, atau Carousel.
// Aturan: nama[_partN][_slideN][_reply].ext
function scanQueue() {
  if (!fs.existsSync(QUEUE_DIR)) throw new Error(`Folder queue tidak ditemukan: ${QUEUE_DIR}`);

  const groups = {};

  for (const fileName of fs.readdirSync(QUEUE_DIR)) {
    const fullPath = path.join(QUEUE_DIR, fileName);
    if (!fs.statSync(fullPath).isFile()) continue;

    const ext = path.extname(fileName).toLowerCase();
    let baseName = path.basename(fileName, ext); // Buang ekstensi (misal: .jpg)

    // Cek apakah ini file balasan affiliate
    let isReply = false;
    if (baseName.toLowerCase().endsWith('_reply')) {
      isReply = true;
      baseName = baseName.replace(/_reply$/i, '');
    }

    // Cek Nomor Slide (Carousel)
    let slideNum = 1;
    const slideMatch = baseName.match(/_slide(\d+)$/i);
    if (slideMatch) {
      slideNum = parseInt(slideMatch[1], 10);
      baseName = baseName.replace(/_slide\d+$/i, '');
    }

    // Cek Nomor Part (Utas Berantai)
    let partNum = 1;
    const partMatch = baseName.match(/_part(\d+)$/i);
    if (partMatch) {
      partNum = parseInt(partMatch[1], 10);
      baseName = baseName.replace(/_part\d+$/i, '');
    }

    // Buat struktur objek jika belum ada
    if (!groups[baseName]) {
      groups[baseName] = { earliestTime: fs.statSync(fullPath).birthtime, parts: {} };
    }
    if (!groups[baseName].parts[partNum]) {
      groups[baseName].parts[partNum] = { slides: [] };
    }

    const partObj = groups[baseName].parts[partNum];

    // Masukkan file ke tempat yang tepat
    if (isReply) {
      partObj.replyPath = fullPath;
    } else if (ext === '.txt') {
      partObj.txtPath = fullPath;
    } else if (IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext)) {
      partObj.slides.push({ path: fullPath, ext, num: slideNum });
    }
  }

  // Rapikan urutan slide dari terkecil ke terbesar
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

    // Prioritaskan Utas yang sudah setengah jalan
    candidates.push({ id, group, time: states[id] ? 0 : group.earliestTime });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.time - b.time);
  return candidates[0]; // Ambil antrean paling tua
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

// PERBAIKAN 4: tambah timeout, sebelumnya request ini tidak dibatasi waktu.
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
    await sleep(10000); // Tunggu 10 detik sebelum cek lagi
  }
  throw new Error('Timeout menunggu media selesai diproses');
}

// PERBAIKAN 4: tambah timeout, sebelumnya request ini tidak dibatasi waktu.
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
  let uploadedKeys = []; // Simpan data R2 untuk dihapus nanti

  try {
    // KONDISI 1: Hanya Teks
    if (slides.length === 0) {
      log(`Membuat container (TEKS SAJA)...`);
      const cid = await createContainer({ text, media_type: 'TEXT', replyToId });
      return await publishContainer(cid);
    }

    // KONDISI 2: Single Media (1 Gambar/Video)
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

    // KONDISI 3: Carousel (Banyak Gambar/Video Slide)
    if (slides.length > 10) throw new Error("Instagram/Threads membatasi maksimal 10 slide per post.");

    log(`Membuat container (CAROUSEL - ${slides.length} SLIDE)...`);
    let childrenIds = [];

    // Upload dan buat container anak untuk tiap slide
    for (const s of slides) {
      const uploaded = await uploadMedia(s.path, s.ext);
      uploadedKeys.push(uploaded.objectKey);

      const media_type = VIDEO_EXTS.includes(s.ext) ? 'VIDEO' : 'IMAGE';
      const childId = await createContainer({ media_type, mediaUrl: uploaded.url, isCarouselItem: true });

      await waitUntilFinished(childId);
      childrenIds.push(childId);
    }

    // Buat container induk (Carousel) yang mengikat anak-anaknya
    const cid = await createContainer({ text, media_type: 'CAROUSEL', children: childrenIds.join(','), replyToId });
    return await publishContainer(cid);

  } finally {
    // BERHASIL ATAU GAGAL, file di R2 WAJIB dihapus agar kuota tidak penuh
    for (const key of uploadedKeys) {
      await deleteFromR2(key);
    }
  }
}

// ====================================================
// 5. PROSES UTAMA (MENANGANI ITEM)
// ====================================================
// PERBAIKAN 2: dibungkus try/catch internal, TIDAK PERNAH melempar error.
// Kalau gagal memindah file setelah post sudah tayang, itu cuma dicatat
// sebagai peringatan di log — tidak boleh membuat item dianggap gagal
// (nanti malah terposting ulang padahal sudah sukses tayang).
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
      // Fallback jika beda partisi drive
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

  // Baca progres jika ini adalah kelanjutan Utas
  const state = readJsonSafe(THREAD_STATE_FILE, {})[id] || { lastPostId: null, doneParts: [], captions: {} };
  const partNumbers = Object.keys(group.parts).map(Number).sort((a, b) => a - b);

  // PERBAIKAN 3: cari file reply dari part dengan nomor PALING BESAR yang
  // punya file reply (sebelumnya "break" di part pertama yang ketemu,
  // jadi kalau ada beberapa file _reply, yang dipakai malah yang paling awal).
  let replyPath = null;
  for (const n of partNumbers) {
    if (group.parts[n].replyPath) replyPath = group.parts[n].replyPath;
  }
  // Dibaca sekarang, sebelum file dipindah oleh proses posting di bawah.
  const replyText = readTextSafe(replyPath);

  let previousPostId = state.lastPostId;
  let lastPostId = state.lastPostId;

  // Proses setiap Part
  for (const n of partNumbers) {
    const part = group.parts[n];

    // Rapikan file part yang sudah sukses sebelumnya
    if (state.doneParts.includes(n)) {
      moveFilesToDir(POSTED_DIR, [part.txtPath, ...part.slides.map(s => s.path)]);
      continue;
    }

    if (!part.txtPath && part.slides.length === 0) continue;

    const text = readTextSafe(part.txtPath);
    log(`Memposting [${id}] part ${n}...`);

    // Posting Part ini
    const postId = await postOnePart({ text, slides: part.slides, replyToId: previousPostId });

    previousPostId = postId;
    lastPostId = postId;

    // Simpan Progres Utas
    state.lastPostId = postId;
    state.doneParts.push(n);
    state.captions[String(n)] = text;

    const allStates = readJsonSafe(THREAD_STATE_FILE, {});
    allStates[id] = state;
    writeJsonAtomic(THREAD_STATE_FILE, allStates);

    // Pindah file ke folder Posted (tidak akan melempar error, lihat PERBAIKAN 2)
    moveFilesToDir(POSTED_DIR, [part.txtPath, ...part.slides.map(s => s.path)]);

    // Jeda antar part (kecuali part terakhir)
    if (n !== partNumbers[partNumbers.length - 1]) {
      log(`Menunggu ${DELAY_BETWEEN_PARTS_MS / 1000} detik sebelum part selanjutnya...`);
      await sleep(DELAY_BETWEEN_PARTS_MS);
    }
  }

  if (!lastPostId) throw new Error(`Tidak ada konten valid untuk diposting dari ${id}`);

  // Semua sukses! Bersihkan file Reply dan State Utas
  moveFilesToDir(POSTED_DIR, partNumbers.map(n => group.parts[n].replyPath).filter(Boolean));

  const allStatesFinal = readJsonSafe(THREAD_STATE_FILE, {});
  delete allStatesFinal[id];
  writeJsonAtomic(THREAD_STATE_FILE, allStatesFinal);

  const fullCaption = Object.values(state.captions).join(' | ');
  log(`[SUKSES] ${id} terposting. Post ID Akhir: ${lastPostId}`);

  return { postId: lastPostId, captionText: fullCaption, isJualan: !!replyPath, replyText };
}

// ====================================================
// 6. MAIN & ERROR HANDLING
// ====================================================
// PERBAIKAN 1: sebelumnya cuma mengenali bentuk error axios/Threads
// (err.response.status, err.code, err.name generik). Sekarang juga
// mengenali bentuk error dari @aws-sdk/client-s3 (Cloudflare R2):
//   - err.$metadata.httpStatusCode  -> status HTTP asli dari AWS SDK v3
//   - err.name                     -> nama exception, misal "AccessDenied",
//                                      "InvalidAccessKeyId",
//                                      "SignatureDoesNotMatch",
//                                      "CredentialsProviderError",
//                                      "NoSuchBucket"
// Tanpa ini, kredensial/bucket R2 yang salah akan dihitung sebagai
// kegagalan FILE, bukan kegagalan sistem.
const NETWORK_ERROR_CODES = [
  'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND',
  'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH',
];
const SYSTEM_API_CODES = [190, 102, 4, 17, 32, 613]; // token/sesi bermasalah & rate limit Graph API
const SYSTEM_AWS_NAMES = [
  'CredentialsProviderError', 'InvalidAccessKeyId', 'SignatureDoesNotMatch',
  'AccessDenied', 'NoSuchBucket', 'TimeoutError',
];

function isSystemError(err) {
  if (!err) return false;

  const status = err.response && err.response.status;
  if (status === 401 || status === 403 || status === 429 || status >= 500) return true;

  const apiCode = err.response && err.response.data && err.response.data.error
    && err.response.data.error.code;
  if (SYSTEM_API_CODES.includes(apiCode)) return true;

  if (!err.response && err.code && NETWORK_ERROR_CODES.includes(err.code)) return true;

  // Bentuk error khas AWS SDK v3 (dipakai @aws-sdk/client-s3 untuk R2)
  const awsStatus = err.$metadata && err.$metadata.httpStatusCode;
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

      // 1. Catat ke Dashboard UI (posted-index.json)
      let index = readJsonSafe(POSTED_INDEX_FILE, []);
      if (!Array.isArray(index)) index = [];
      index.push({
        postId: result.postId,
        type: result.isJualan ? 'jualan' : 'nonjualan',
        captionText: result.captionText,
        postedAt: new Date().toISOString()
      });
      writeJsonAtomic(POSTED_INDEX_FILE, index);

      // 2. Jadwalkan Reply Link Affiliate
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

      // 3. Bersihkan hitungan gagal (kalau ada)
      const fails = readJsonSafe(FAILED_ITEMS_FILE, {});
      if (fails[item.id]) { delete fails[item.id]; writeJsonAtomic(FAILED_ITEMS_FILE, fails); }

    } catch (err) {
      log(`[GAGAL] memproses ${item.id}: ${errMsg(err)}`);

      // Jika masalah jaringan/kuota/kredensial R2, jangan salahkan file-nya
      if (isSystemError(err)) {
        log('Kendala server/jaringan/kredensial (bukan salah file). File aman, akan dicoba lagi di jadwal berikutnya.');
        return;
      }

      // Jika salah file-nya (format rusak dll), hitung kegagalan
      const fails = readJsonSafe(FAILED_ITEMS_FILE, {});
      fails[item.id] = { count: (fails[item.id]?.count || 0) + 1, err: errMsg(err).slice(0, 500) };
      writeJsonAtomic(FAILED_ITEMS_FILE, fails);

      if (fails[item.id].count >= MAX_FAILURES) {
        // Pindah ke folder failed
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
