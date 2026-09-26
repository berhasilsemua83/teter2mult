// refresh-token.js
// Refresh long-lived access token Threads supaya tidak expired.
// Dijalankan terjadwal (disarankan tiap minggu) lewat Task Scheduler.
// Setelah refresh berhasil, token baru otomatis ditulis ulang ke file .env

const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const ENV_PATH = path.join(__dirname, '.env');
const LOG_FILE = path.join(__dirname, 'refresh-token.log');

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(line.trim());
  fs.appendFileSync(LOG_FILE, line);
}

// Ganti nilai THREADS_ACCESS_TOKEN di file .env dengan token baru
function updateEnvToken(newToken) {
  let envContent = fs.readFileSync(ENV_PATH, 'utf-8');

  if (envContent.match(/^THREADS_ACCESS_TOKEN=.*/m)) {
    envContent = envContent.replace(
      /^THREADS_ACCESS_TOKEN=.*/m,
      `THREADS_ACCESS_TOKEN=${newToken}`
    );
  } else {
    envContent += `\nTHREADS_ACCESS_TOKEN=${newToken}\n`;
  }

  fs.writeFileSync(ENV_PATH, envContent);
  log('File .env berhasil diupdate dengan token baru.');
}

async function main() {
  log('=== Menjalankan refresh token ===');

  const currentToken = process.env.THREADS_ACCESS_TOKEN;

  if (!currentToken) {
    log('ERROR: THREADS_ACCESS_TOKEN tidak ditemukan di .env');
    return;
  }

  try {
    const res = await axios.get('https://graph.threads.net/refresh_access_token', {
      params: {
        grant_type: 'th_refresh_token',
        access_token: currentToken,
      },
    });

    const newToken = res.data.access_token;
    const expiresIn = res.data.expires_in; // dalam detik

    if (!newToken) {
      throw new Error('Response tidak berisi access_token baru');
    }

    updateEnvToken(newToken);

    const expiresInDays = Math.round(expiresIn / 86400);
    log(`Token berhasil di-refresh. Berlaku ${expiresInDays} hari ke depan.`);
  } catch (err) {
    const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
    log(`GAGAL refresh token: ${errMsg}`);
    log('Token lama tetap dipakai. Cek manual jika token sudah mendekati expired.');
  }
}

main();
