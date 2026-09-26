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

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cloudinary = require('cloudinary').v2;

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

const THREADS_USER_ID = process.env.THREADS_USER_ID;
const THREADS_ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const THREADS_API_BASE = 'https://graph.threads.net/v1.0';

// Jeda antar part dalam 1 utas (milidetik). Ubah sesuai kebutuhan.
const DELAY_BETWEEN_PARTS_MS = 60 * 1000; // 60 detik

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png'];
const VIDEO_EXTS = ['.mp4'];

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(line.trim());
  fs.appendFileSync(LOG_FILE, line);
}

function randomMinutes(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
    const stat = fs.statSync(fullPath);
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

  const candidates = [];

  for (const [id, group] of Object.entries(threadGroups)) {
    candidates.push({ type: 'thread', id, group, time: group.earliestTime });
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
// 3. UPLOAD MEDIA (kalau ada) KE CLOUDINARY
// ====================================================
async function uploadMedia(mediaPath, ext) {
  const isVideo = VIDEO_EXTS.includes(ext);
  log(`Uploading media ke Cloudinary (${isVideo ? 'video' : 'image'}): ${mediaPath}`);
  const result = await cloudinary.uploader.upload(mediaPath, {
    resource_type: isVideo ? 'video' : 'image',
    folder: 'threads-autopost',
  });
  log(`Upload selesai. URL: ${result.secure_url}`);
  return { url: result.secure_url, isVideo };
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

  const res = await axios.post(`${THREADS_API_BASE}/${THREADS_USER_ID}/threads`, null, { params });
  log(`Container dibuat (${params.media_type}). ID: ${res.data.id}`);
  return res.data.id;
}

async function waitUntilFinished(containerId, maxAttempts = 20, delayMs = 10000) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await axios.get(`${THREADS_API_BASE}/${containerId}`, {
      params: { fields: 'status', access_token: THREADS_ACCESS_TOKEN },
    });
    const status = res.data.status;
    if (status === 'FINISHED') return true;
    if (status === 'ERROR') throw new Error('Threads gagal memproses media (status: ERROR)');
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('Timeout menunggu media selesai diproses');
}

async function publishContainer(containerId) {
  const res = await axios.post(`${THREADS_API_BASE}/${THREADS_USER_ID}/threads_publish`, null, {
    params: { creation_id: containerId, access_token: THREADS_ACCESS_TOKEN },
  });
  log(`Berhasil dipublish. Post ID: ${res.data.id}`);
  return res.data.id;
}

// Post 1 bagian (dipakai baik standalone maupun tiap part utas)
async function postOnePart({ text, mediaPath, mediaExt, replyToId }) {
  let mediaUrl = null;
  let isVideo = false;

  if (mediaPath) {
    const uploaded = await uploadMedia(mediaPath, mediaExt);
    mediaUrl = uploaded.url;
    isVideo = uploaded.isVideo;
  }

  const containerId = await createContainer({ text, mediaUrl, isVideo, replyToId });

  // Media butuh waktu diproses, teks biasanya instan tapi dicek juga biar aman
  if (mediaUrl) {
    await waitUntilFinished(containerId);
  }

  const postId = await publishContainer(containerId);
  return postId;
}

// ====================================================
// 5. JADWALKAN REPLY LINK AFFILIATE (kalau ada file _reply)
// ====================================================
function schedulePendingReply(postId, replyText) {
  const delayMinutes = randomMinutes(15, 50);
  const dueAt = new Date(Date.now() + delayMinutes * 60 * 1000);

  let pending = [];
  if (fs.existsSync(PENDING_REPLY_FILE)) {
    pending = JSON.parse(fs.readFileSync(PENDING_REPLY_FILE, 'utf-8'));
  }
  pending.push({ postId, replyText, dueAt: dueAt.toISOString(), done: false });
  fs.writeFileSync(PENDING_REPLY_FILE, JSON.stringify(pending, null, 2));
  log(`Reply link dijadwalkan untuk post ${postId} pada ${dueAt.toISOString()} (${delayMinutes} menit lagi)`);
}

// ====================================================
// 6. PINDAHKAN FILE-FILE YANG SUDAH DIPOSTING KE FOLDER POSTED
// ====================================================
function moveFilesToPosted(filePaths) {
  if (!fs.existsSync(POSTED_DIR)) fs.mkdirSync(POSTED_DIR, { recursive: true });
  for (const p of filePaths) {
    if (p && fs.existsSync(p)) {
      fs.renameSync(p, path.join(POSTED_DIR, path.basename(p)));
    }
  }
}

// ====================================================
// 7. PROSES: STANDALONE
// ====================================================
async function processStandalone(item) {
  const { group, id } = item;
  log(`Memproses standalone: ${id}`);

  const text = group.txtPath ? fs.readFileSync(group.txtPath, 'utf-8').trim() : '';

  const postId = await postOnePart({
    text,
    mediaPath: group.mediaPath,
    mediaExt: group.mediaExt,
  });

  const filesToMove = [group.txtPath, group.mediaPath, group.replyPath];
  moveFilesToPosted(filesToMove);

  log(`SELESAI standalone: ${id}`);
  return postId;
}

// ====================================================
// 8. PROSES: UTAS BERANTAI
// ====================================================
async function processThread(item) {
  const { group, id } = item;
  const partNumbers = Object.keys(group.parts).map(Number).sort((a, b) => a - b);
  log(`Memproses utas: ${id} (${partNumbers.length} part)`);

  let previousPostId = null;
  let lastPostId = null;
  let lastReplyPath = null;
  const allFilesUsed = [];

  for (const partNum of partNumbers) {
    const part = group.parts[partNum];
    const text = part.txtPath ? fs.readFileSync(part.txtPath, 'utf-8').trim() : '';

    log(`Posting ${id} part ${partNum}/${partNumbers.length}...`);

    const postId = await postOnePart({
      text,
      mediaPath: part.mediaPath,
      mediaExt: part.mediaExt,
      replyToId: previousPostId, // null untuk part pertama
    });

    allFilesUsed.push(part.txtPath, part.mediaPath);
    if (part.replyPath) lastReplyPath = part.replyPath;

    previousPostId = postId;
    lastPostId = postId;

    // Jeda antar part, kecuali setelah part terakhir
    if (partNum !== partNumbers[partNumbers.length - 1]) {
      log(`Menunggu ${DELAY_BETWEEN_PARTS_MS / 1000} detik sebelum part berikutnya...`);
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_PARTS_MS));
    }
  }

  allFilesUsed.push(lastReplyPath);
  moveFilesToPosted(allFilesUsed);

  log(`SELESAI utas: ${id}, total ${partNumbers.length} part terposting.`);
  return { lastPostId, lastReplyPath };
}

// ====================================================
// 9. CATAT POST YANG TAYANG KE posted-index.json
//    (dipakai comment-responder.js buat tau jenis post & captionnya)
// ====================================================
const POSTED_INDEX_FILE = path.join(__dirname, 'posted-index.json');

function recordPostedIndex({ postId, type, captionText }) {
  let index = [];
  if (fs.existsSync(POSTED_INDEX_FILE)) {
    index = JSON.parse(fs.readFileSync(POSTED_INDEX_FILE, 'utf-8'));
  }
  index.push({
    postId,
    type, // 'jualan' atau 'nonjualan'
    captionText: captionText || '',
    postedAt: new Date().toISOString(),
  });
  fs.writeFileSync(POSTED_INDEX_FILE, JSON.stringify(index, null, 2));
  log(`Dicatat ke posted-index.json: ${postId} (${type})`);
}

// ====================================================
// MAIN
// ====================================================
async function main() {
  log('=== Menjalankan thread-poster ===');

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
      const captionText = item.group.txtPath
        ? fs.readFileSync(item.group.txtPath, 'utf-8').trim()
        : '';
      const postId = await processStandalone(item);
      const isJualan = !!item.group.replyPath;
      recordPostedIndex({ postId, type: isJualan ? 'jualan' : 'nonjualan', captionText });

      if (isJualan) {
        const replyText = fs.readFileSync(
          path.join(POSTED_DIR, path.basename(item.group.replyPath)),
          'utf-8'
        ).trim();
        schedulePendingReply(postId, replyText);
      }
    } else {
      const partNumbers = Object.keys(item.group.parts).map(Number).sort((a, b) => a - b);
      const captionTexts = partNumbers.map((n) => {
        const p = item.group.parts[n];
        return p.txtPath ? fs.readFileSync(p.txtPath, 'utf-8').trim() : '';
      });

      const { lastPostId, lastReplyPath } = await processThread(item);
      const isJualan = !!lastReplyPath;

      // Catat SEMUA part ke index (komentar bisa muncul di part manapun),
      // pakai gabungan caption sebagai konteks tiap entry
      recordPostedIndex({
        postId: lastPostId,
        type: isJualan ? 'jualan' : 'nonjualan',
        captionText: captionTexts.join(' | '),
      });

      if (isJualan) {
        const replyText = fs.readFileSync(
          path.join(POSTED_DIR, path.basename(lastReplyPath)),
          'utf-8'
        ).trim();
        schedulePendingReply(lastPostId, replyText);
      }
    }
  } catch (err) {
    log(`GAGAL memproses ${item.id}: ${err.message}`);
    log('File dibiarkan di folder queue, akan dicoba lagi di jadwal berikutnya.');
  }
}

main();
