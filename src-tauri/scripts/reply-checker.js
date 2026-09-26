// reply-checker.js
// Dijalankan terpisah (Task Scheduler tiap 5 menit).
// Membaca pending-reply.json, dan mengirim reply yang sudah waktunya
// (berisi teks tambahan + link affiliate) ke post utama terkait.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const PENDING_REPLY_FILE = path.join(__dirname, 'pending-reply.json');
const LOG_FILE = path.join(__dirname, 'reply-checker.log');

const THREADS_USER_ID = process.env.THREADS_USER_ID;
const THREADS_ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const THREADS_API_BASE = 'https://graph.threads.net/v1.0';

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(line.trim());
  fs.appendFileSync(LOG_FILE, line);
}

async function createTextReplyContainer(text, replyToId) {
  const res = await axios.post(`${THREADS_API_BASE}/${THREADS_USER_ID}/threads`, null, {
    params: {
      media_type: 'TEXT',
      text,
      reply_to_id: replyToId,
      access_token: THREADS_ACCESS_TOKEN,
    },
  });
  return res.data.id;
}

async function publishContainer(containerId) {
  const res = await axios.post(`${THREADS_API_BASE}/${THREADS_USER_ID}/threads_publish`, null, {
    params: { creation_id: containerId, access_token: THREADS_ACCESS_TOKEN },
  });
  return res.data.id;
}

async function main() {
  if (!fs.existsSync(PENDING_REPLY_FILE)) {
    log('Tidak ada file pending-reply.json. Tidak ada yang perlu dicek.');
    return;
  }

  let pending = JSON.parse(fs.readFileSync(PENDING_REPLY_FILE, 'utf-8'));
  const now = new Date();
  let changed = false;

  for (const item of pending) {
    if (item.done) continue;

    const dueAt = new Date(item.dueAt);
    if (now < dueAt) continue; // belum waktunya

    log(`Waktunya reply ke post ${item.postId}...`);

    try {
      const containerId = await createTextReplyContainer(item.replyText, item.postId);
      // Reply teks biasanya langsung FINISHED, tapi tetap aman kalau publish langsung dicoba
      await publishContainer(containerId);
      item.done = true;
      changed = true;
      log(`Reply berhasil dikirim ke post ${item.postId}.`);
    } catch (err) {
      log(`GAGAL reply ke post ${item.postId}: ${err.message}. Akan dicoba lagi run berikutnya.`);
    }
  }

  // Buang entri yang sudah selesai supaya file tidak menumpuk terus
  const remaining = pending.filter((item) => !item.done);
  if (changed || remaining.length !== pending.length) {
    fs.writeFileSync(PENDING_REPLY_FILE, JSON.stringify(remaining, null, 2));
  }

  if (remaining.length === 0) {
    log('Semua reply sudah terkirim, tidak ada yang menunggu.');
  }
}

main();
