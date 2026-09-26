// comment-responder.js
// Cek komentar baru di post-post terakhir (posted-index.json), lalu balas:
//   - Post JUALAN     -> cocokkan kata kunci (trigger-rules.json), jawaban fix
//   - Post NON-JUALAN -> kirim ke Gemini API, AI generate balasan sesuai konteks
// Komentar yang sudah pernah dibalas (replied-comments.json) tidak dibalas ulang.
// Komentar pendek/emoji-doang otomatis di-skip (tidak dianggap perlu jawaban).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const THREADS_USER_ID = process.env.THREADS_USER_ID;
const THREADS_ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const THREADS_API_BASE = 'https://graph.threads.net/v1.0';

// Bisa isi lebih dari 1 key Gemini, dipisah koma di .env:
// GEMINI_API_KEYS=key1,key2,key3
const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

const POSTED_INDEX_FILE = path.join(__dirname, 'posted-index.json');
const REPLIED_COMMENTS_FILE = path.join(__dirname, 'replied-comments.json');
const TRIGGER_RULES_FILE = path.join(__dirname, 'trigger-rules.json');
const AI_STYLE_FILE = path.join(__dirname, 'ai-style.json');
const LOG_FILE = path.join(__dirname, 'comment-responder.log');

// Template gaya bahasa siap pakai. "custom" tidak pakai template ini,
// murni pakai custom_instruction dari ai-style.json.
const STYLE_TEMPLATES = {
  ramah_sopan:
    'Gaya bahasa: ramah, sopan, formal ringan (seperti admin brand yang menjaga kesan profesional tapi tetap hangat, bukan kaku). Jangan gunakan bahasa gaul atau singkatan tidak baku.',
  santai_gaul:
    'Gaya bahasa: santai dan akrab, seperti ngobrol dengan teman dekat. Boleh pakai kata sehari-hari (gak, aja, banget) tapi tetap sopan.',
  lucu_receh:
    'Gaya bahasa: lucu, receh, banyak candaan ringan, boleh sesekali pakai emoji, tapi tetap nyambung dengan konteks komentar.',
};

// Hanya proses post yang tayang dalam N jam terakhir
const POST_MAX_AGE_HOURS = 48;

// Komentar lebih pendek dari ini (dan tanpa huruf sama sekali, misal cuma emoji)
// akan di-skip, dianggap tidak perlu dijawab.
const MIN_COMMENT_LENGTH = 4;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(line.trim());
  fs.appendFileSync(LOG_FILE, line);
}

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ====================================================
// 1. AMBIL POST-POST YANG MASIH RELEVAN DICEK (belum terlalu lama)
// ====================================================
function getRecentPosts() {
  const index = loadJson(POSTED_INDEX_FILE, []);
  const cutoff = Date.now() - POST_MAX_AGE_HOURS * 60 * 60 * 1000;
  return index.filter((entry) => new Date(entry.postedAt).getTime() >= cutoff);
}

// ====================================================
// 2. AMBIL KOMENTAR DARI SATU POST
// ====================================================
async function fetchComments(postId) {
  const res = await axios.get(`${THREADS_API_BASE}/${postId}/replies`, {
    params: {
      fields: 'id,text,username',
      access_token: THREADS_ACCESS_TOKEN,
    },
  });
  return res.data.data || [];
}

// ====================================================
// 3. FILTER: komentar yang layak dijawab
// ====================================================
function isWorthReplying(commentText) {
  if (!commentText) return false;
  const trimmed = commentText.trim();
  if (trimmed.length < MIN_COMMENT_LENGTH) return false;
  // Kalau tidak ada satu pun huruf (cuma emoji/simbol/angka), skip
  if (!/[a-zA-Z]/.test(trimmed)) return false;
  return true;
}

// ====================================================
// 4. LOGIC UNTUK POST JUALAN: cocokkan trigger keyword
// ====================================================
function matchTriggerRule(commentText) {
  const rulesConfig = loadJson(TRIGGER_RULES_FILE, { rules: [], fallback_reply: null });
  const lowerText = commentText.toLowerCase();

  for (const rule of rulesConfig.rules) {
    const matched = rule.keywords.some((kw) => lowerText.includes(kw.toLowerCase()));
    if (matched) return rule.reply;
  }

  return rulesConfig.fallback_reply || null; // null = tidak dibalas
}

// ====================================================
// 5. LOGIC UNTUK POST NON-JUALAN: tanya Gemini, dengan rotasi API key
// ====================================================
async function generateAiReply(postCaption, commentText) {
  const styleConfig = loadJson(AI_STYLE_FILE, {
    style_preset: 'ramah_sopan',
    max_sentences: 2,
    custom_instruction: '',
  });

  const maxSentences = styleConfig.max_sentences || 2;

  // Kalau preset "custom", pakai TEKS BEBAS dari custom_instruction sepenuhnya.
  // Kalau bukan custom, pakai template siap pakai, dan custom_instruction
  // (kalau diisi) ditambahkan sebagai aturan EKSTRA di atasnya.
  let styleText;
  if (styleConfig.style_preset === 'custom') {
    styleText = styleConfig.custom_instruction || 'Gaya bahasa bebas, sopan dan relevan.';
  } else {
    const template = STYLE_TEMPLATES[styleConfig.style_preset] || STYLE_TEMPLATES.ramah_sopan;
    styleText = styleConfig.custom_instruction
      ? `${template}\nAturan tambahan: ${styleConfig.custom_instruction}`
      : template;
  }

  const prompt = `Ini adalah postingan Threads saya:
---
${postCaption}
---

Ini komentar yang masuk dari pembaca:
---
${commentText}
---

Balas komentar ini dalam Bahasa Indonesia, maksimal ${maxSentences} kalimat.
${styleText}
Sesuaikan isi balasan dengan konteks postingan di atas.
Jangan gunakan tanda kutip di jawabanmu.
Jangan promosi produk apa pun di balasan ini.`;

  for (let i = 0; i < GEMINI_API_KEYS.length; i++) {
    const apiKey = GEMINI_API_KEYS[i];
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
        }
      );

      const replyText = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (replyText) return replyText;
      throw new Error('Response Gemini kosong');
    } catch (err) {
      const isQuotaError =
        err.response?.status === 429 || err.response?.status === 403;
      log(
        `Key Gemini #${i + 1} gagal (${isQuotaError ? 'kuota habis' : err.message}), coba key berikutnya...`
      );
      if (i === GEMINI_API_KEYS.length - 1) {
        throw new Error('Semua Gemini API key gagal/kuota habis');
      }
    }
  }
  return null;
}

// ====================================================
// 6. KIRIM REPLY KE THREADS
// ====================================================
async function sendReply(text, replyToId) {
  const containerRes = await axios.post(`${THREADS_API_BASE}/${THREADS_USER_ID}/threads`, null, {
    params: {
      media_type: 'TEXT',
      text,
      reply_to_id: replyToId,
      access_token: THREADS_ACCESS_TOKEN,
    },
  });

  const publishRes = await axios.post(
    `${THREADS_API_BASE}/${THREADS_USER_ID}/threads_publish`,
    null,
    { params: { creation_id: containerRes.data.id, access_token: THREADS_ACCESS_TOKEN } }
  );

  return publishRes.data.id;
}

// ====================================================
// MAIN
// ====================================================
async function main() {
  log('=== Menjalankan comment-responder ===');

  const repliedComments = loadJson(REPLIED_COMMENTS_FILE, []);
  const repliedSet = new Set(repliedComments);

  const recentPosts = getRecentPosts();
  if (recentPosts.length === 0) {
    log('Tidak ada post dalam rentang waktu yang dicek. Selesai.');
    return;
  }

  let newlyReplied = [];

  for (const post of recentPosts) {
    let comments;
    try {
      comments = await fetchComments(post.postId);
    } catch (err) {
      log(`GAGAL ambil komentar post ${post.postId}: ${err.message}`);
      continue;
    }

    for (const comment of comments) {
      if (repliedSet.has(comment.id)) continue; // sudah pernah dibalas
      if (!isWorthReplying(comment.text)) continue; // terlalu pendek/emoji doang

      log(`Komentar baru di post ${post.postId} (${post.type}): "${comment.text}"`);

      let replyText = null;

      try {
        if (post.type === 'jualan') {
          replyText = matchTriggerRule(comment.text);
          if (!replyText) {
            log('Tidak cocok trigger manapun, di-skip (post jualan).');
            continue;
          }
        } else {
          replyText = await generateAiReply(post.captionText, comment.text);
          if (!replyText) {
            log('AI tidak menghasilkan balasan, di-skip.');
            continue;
          }
        }

        await sendReply(replyText, comment.id);
        log(`Berhasil balas komentar ${comment.id}: "${replyText}"`);
        newlyReplied.push(comment.id);
      } catch (err) {
        const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
        log(`GAGAL balas komentar ${comment.id}: ${errMsg}`);
      }
    }
  }

  if (newlyReplied.length > 0) {
    saveJson(REPLIED_COMMENTS_FILE, [...repliedComments, ...newlyReplied]);
    log(`Selesai. ${newlyReplied.length} komentar baru dibalas.`);
  } else {
    log('Selesai. Tidak ada komentar baru yang perlu dibalas.');
  }
}

main();
