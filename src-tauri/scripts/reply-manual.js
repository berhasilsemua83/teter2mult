// reply-manual.js
// Kirim SATU reply ke post Threads tertentu yang sudah tayang.
// Cara pakai: node reply-manual.js <POST_ID> "<teks balasan>"
// Contoh   : node reply-manual.js 18125568880763963 "Ini balasan test saya"

require('dotenv').config();
const axios = require('axios');

const THREADS_USER_ID = process.env.THREADS_USER_ID;
const THREADS_ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const THREADS_API_BASE = 'https://graph.threads.net/v1.0';

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
  const postId = process.argv[2];
  const text = process.argv[3];

  if (!postId || !text) {
    console.log('Cara pakai: node reply-manual.js <POST_ID> "<teks balasan>"');
    process.exit(1);
  }

  try {
    console.log(`Membuat reply ke post ${postId}...`);
    const containerId = await createTextReplyContainer(text, postId);
    console.log(`Container reply dibuat: ${containerId}`);

    const newPostId = await publishContainer(containerId);
    console.log(`BERHASIL. Reply sudah tayang dengan Post ID: ${newPostId}`);
  } catch (err) {
    const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
    console.log(`GAGAL: ${errMsg}`);
  }
}

main();
