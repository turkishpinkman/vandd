// ═══ VANDD — Direct Deezer FLAC Download ═══
// Downloads audio directly from Deezer CDN using ARL cookie.
// No Telegram bot needed — pure API access.
// Supports: ISRC matching, Blowfish CBC decryption, ARL rotation.

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

// ═══ CONSTANTS ═══
const BF_SECRET = 'g4el58wc0zvf9na1';         // Deezer Blowfish secret
const BF_IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
const CHUNK_SIZE = 2048;

const GW_URL = 'https://www.deezer.com/ajax/gw-light.php';
const MEDIA_URL = 'https://media.deezer.com/v1/get_url';
const PUBLIC_API = 'https://api.deezer.com';

// Quality constants
const QUALITY = {
  FLAC: { id: 9, format: 'FLAC', ext: '.flac', mime: 'audio/flac' },
  MP3_320: { id: 3, format: 'MP3_320', ext: '.mp3', mime: 'audio/mpeg' },
  MP3_128: { id: 1, format: 'MP3_128', ext: '.mp3', mime: 'audio/mpeg' },
};

// Cache directory
const CACHE_DIR = path.join(os.tmpdir(), 'vandd-audio-cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ═══ SESSION STATE ═══
let apiToken = null;
let licenseToken = null;
let sessionCookies = '';
let currentArlIndex = 0;
let arlList = [];
let isInitialized = false;

/**
 * Parse ARL list from env (comma-separated or single)
 */
function _loadArls() {
  const raw = process.env.DEEZER_ARL || '';
  arlList = raw.split(',').map(a => a.trim()).filter(Boolean);
  if (arlList.length === 0) {
    console.warn('[Deezer] ⚠ DEEZER_ARL not set in .env — Deezer download disabled.');
  } else {
    console.log(`[Deezer] ${arlList.length} ARL key(s) loaded.`);
  }
}

/**
 * Initialize Deezer session with current ARL.
 */
async function init() {
  if (arlList.length === 0) _loadArls();
  if (arlList.length === 0) return false;

  return await _loginWithArl(arlList[currentArlIndex]);
}

/**
 * Login with a specific ARL cookie.
 */
async function _loginWithArl(arl) {
  try {
    sessionCookies = `arl=${arl}`;

    const userData = await _gwRequest('deezer.getUserData', {});

    if (!userData?.results?.USER?.USER_ID || userData.results.USER.USER_ID === 0) {
      console.error('[Deezer] ✗ ARL geçersiz veya süresi dolmuş.');
      return false;
    }

    apiToken = userData.results.checkForm;
    licenseToken = userData.results.USER?.OPTIONS?.license_token || null;

    const userName = userData.results.USER?.BLOG_NAME || userData.results.USER?.FIRSTNAME || 'Unknown';
    const plan = userData.results.USER?.OPTIONS?.web_lossless ? 'HiFi/FLAC' : 'Premium';

    isInitialized = true;
    console.log(`[Deezer] ✓ Giriş: ${userName} (${plan})`);
    return true;
  } catch (e) {
    console.error('[Deezer] Login hatası:', e.message);
    return false;
  }
}

/**
 * Rotate to next ARL if current one fails.
 */
async function _rotateArl() {
  if (arlList.length <= 1) return false;

  const oldIndex = currentArlIndex;
  currentArlIndex = (currentArlIndex + 1) % arlList.length;
  console.log(`[Deezer] ARL rotasyonu: ${oldIndex} → ${currentArlIndex}`);

  isInitialized = false;
  return await _loginWithArl(arlList[currentArlIndex]);
}

/**
 * Search for a track on Deezer.
 * Priority: ISRC (exact) → title+artist search.
 */
async function searchTrack(title, artist, isrc) {
  // Method 1: ISRC (most reliable)
  if (isrc) {
    try {
      const data = await _publicGet(`/track/isrc:${isrc}`);
      if (data && data.id && !data.error) {
        console.log(`[Deezer] ISRC eşleşme: ${data.artist?.name} - ${data.title} (ID: ${data.id})`);
        return {
          deezerId: data.id,
          title: data.title,
          artist: data.artist?.name || artist,
          album: data.album?.title || '',
          duration: data.duration,
        };
      }
    } catch (e) {
      console.warn(`[Deezer] ISRC arama hatası:`, e.message);
    }
  }

  // Method 2: Text search
  try {
    const query = `artist:"${artist}" track:"${title}"`;
    const data = await _publicGet(`/search?q=${encodeURIComponent(query)}&limit=5`);
    if (data?.data?.length > 0) {
      const best = data.data[0];
      console.log(`[Deezer] Metin eşleşme: ${best.artist?.name} - ${best.title} (ID: ${best.id})`);
      return {
        deezerId: best.id,
        title: best.title,
        artist: best.artist?.name || artist,
        album: best.album?.title || '',
        duration: best.duration,
      };
    }

    // Method 3: Simpler search
    const simpleQuery = `${artist} ${title}`;
    const data2 = await _publicGet(`/search?q=${encodeURIComponent(simpleQuery)}&limit=5`);
    if (data2?.data?.length > 0) {
      const best = data2.data[0];
      console.log(`[Deezer] Basit eşleşme: ${best.artist?.name} - ${best.title} (ID: ${best.id})`);
      return {
        deezerId: best.id,
        title: best.title,
        artist: best.artist?.name || artist,
        album: best.album?.title || '',
        duration: best.duration,
      };
    }
  } catch (e) {
    console.warn(`[Deezer] Arama hatası:`, e.message);
  }

  return null;
}

/**
 * Download a track from Deezer to disk.
 * Returns: { filePath, fileSize, mimeType, quality, ... } or null
 */
async function downloadTrack(deezerId, outputName) {
  if (!isInitialized) {
    const ok = await init();
    if (!ok) return null;
  }

  // 1. Get detailed track info from private API
  const trackInfo = await _gwRequest('song.getData', { SNG_ID: String(deezerId) });
  if (!trackInfo?.results?.SNG_ID) {
    throw new Error(`Track bilgisi alınamadı (ID: ${deezerId})`);
  }

  const sngData = trackInfo.results;
  const sngId = sngData.SNG_ID;

  // 2. Try quality levels: FLAC → 320 → 128
  const qualities = [QUALITY.FLAC, QUALITY.MP3_320, QUALITY.MP3_128];

  for (const quality of qualities) {
    try {
      const filePath = path.join(CACHE_DIR, `${outputName}${quality.ext}`);

      // Skip if already downloaded
      if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1024) {
        console.log(`[Deezer] Cache hit: ${filePath}`);
        return {
          filePath,
          fileSize: fs.statSync(filePath).size,
          mimeType: quality.mime,
          quality: quality.format,
          isFlac: quality.format === 'FLAC',
        };
      }

      // Get download URL via media.getUrl
      const mediaUrl = await _getMediaUrl(sngData, quality);
      if (!mediaUrl) continue;

      // Download encrypted file
      console.log(`[Deezer] İndiriliyor (${quality.format}): ${sngData.ART_NAME} - ${sngData.SNG_TITLE}...`);
      const encryptedData = await _httpDownload(mediaUrl);

      if (!encryptedData || encryptedData.length < 1024) {
        console.warn(`[Deezer] ${quality.format} indirme boş/küçük, sonraki kaliteyi deniyor...`);
        continue;
      }

      // Decrypt
      const decrypted = _decryptFile(encryptedData, sngId.toString());

      // Write to disk
      fs.writeFileSync(filePath, decrypted);
      const fileSize = fs.statSync(filePath).size;

      console.log(`[Deezer] ✓ ${sngData.ART_NAME} - ${sngData.SNG_TITLE} | ${quality.format} | ${(fileSize / 1048576).toFixed(1)}MB`);

      return {
        filePath,
        fileSize,
        mimeType: quality.mime,
        quality: quality.format,
        isFlac: quality.format === 'FLAC',
      };

    } catch (e) {
      console.warn(`[Deezer] ${quality.format} başarısız: ${e.message}`);

      // If it's an auth error, try rotating ARL
      if (e.message.includes('403') || e.message.includes('401') || e.message.includes('token')) {
        const rotated = await _rotateArl();
        if (rotated) {
          // Retry this quality with new ARL
          try {
            const retryTrackInfo = await _gwRequest('song.getData', { SNG_ID: String(deezerId) });
            if (retryTrackInfo?.results) {
              // Continue to next iteration with refreshed session
              continue;
            }
          } catch (re) {
            console.warn(`[Deezer] Retry da başarısız: ${re.message}`);
          }
        }
      }
      continue;
    }
  }

  return null; // All qualities failed
}

// ═══ MEDIA URL ═══

async function _getMediaUrl(sngData, quality) {
  if (!licenseToken || !sngData.TRACK_TOKEN) {
    // Fallback to legacy URL
    return _buildLegacyUrl(sngData, quality.id);
  }

  try {
    const body = {
      license_token: licenseToken,
      media: [{
        type: 'FULL',
        formats: [{ cipher: 'BF_CBC_STRIPE', format: quality.format }]
      }],
      track_tokens: [sngData.TRACK_TOKEN]
    };

    const data = await _postJson(MEDIA_URL, body);

    if (data?.data?.[0]?.media?.[0]?.sources?.[0]?.url) {
      return data.data[0].media[0].sources[0].url;
    }

    // Check for errors (e.g., quality not available)
    if (data?.data?.[0]?.errors) {
      const errCode = data.data[0].errors[0]?.code;
      console.warn(`[Deezer] media.getUrl hata: ${errCode}`);
      return null;
    }
  } catch (e) {
    console.warn(`[Deezer] media.getUrl exception: ${e.message}`);
  }

  // Fallback to legacy URL construction
  return _buildLegacyUrl(sngData, quality.id);
}

function _buildLegacyUrl(sngData, qualityId) {
  const md5 = sngData.MD5_ORIGIN;
  if (!md5) return null;

  const sngId = sngData.SNG_ID;
  const mediaVersion = sngData.MEDIA_VERSION;

  // Build path: md5¤qualityId¤sngId¤mediaVersion
  const step1 = [md5, qualityId, sngId, mediaVersion].join('\xa4');
  const step1Hash = crypto.createHash('md5').update(step1, 'binary').digest('hex');
  let step2 = step1Hash + '\xa4' + step1 + '\xa4';

  // Pad to multiple of 16
  while (step2.length % 16 !== 0) step2 += ' ';

  // AES ECB encrypt
  const aesKey = Buffer.from('jo6aey6haid2Teih', 'ascii');
  const cipher = crypto.createCipheriv('aes-128-ecb', aesKey, null);
  cipher.setAutoPadding(false);
  const encrypted = cipher.update(step2, 'binary', 'hex') + cipher.final('hex');

  return `https://e-cdns-proxy-${md5[0]}.dzcdn.net/mobile/1/${encrypted}`;
}

// ═══ DECRYPTION ═══

/**
 * Decrypt a Deezer audio file (BF-CBC-STRIPE).
 * Every 3rd chunk of 2048 bytes is Blowfish CBC encrypted.
 */
function _decryptFile(data, sngId) {
  const bfKey = _getBfKey(sngId);
  const output = Buffer.alloc(data.length);
  let chunkIndex = 0;

  for (let pos = 0; pos < data.length; pos += CHUNK_SIZE) {
    const end = Math.min(pos + CHUNK_SIZE, data.length);
    const chunk = data.slice(pos, end);

    if (chunkIndex % 3 === 0 && chunk.length === CHUNK_SIZE) {
      // Decrypt this chunk with Blowfish CBC
      const decipher = crypto.createDecipheriv('bf-cbc', Buffer.from(bfKey, 'binary'), BF_IV);
      decipher.setAutoPadding(false);
      const decrypted = Buffer.concat([decipher.update(chunk), decipher.final()]);
      decrypted.copy(output, pos);
    } else {
      // Copy unencrypted chunk
      chunk.copy(output, pos);
    }

    chunkIndex++;
  }

  return output;
}

/**
 * Generate Blowfish key from track ID.
 */
function _getBfKey(sngId) {
  const md5Id = crypto.createHash('md5').update(sngId, 'ascii').digest('hex');
  let key = '';
  for (let i = 0; i < 16; i++) {
    key += String.fromCharCode(
      md5Id.charCodeAt(i) ^ md5Id.charCodeAt(i + 16) ^ BF_SECRET.charCodeAt(i)
    );
  }
  return key;
}

// ═══ HTTP HELPERS ═══

/**
 * Deezer private API (gw-light.php) request.
 */
function _gwRequest(method, params = {}) {
  const token = apiToken || '';
  const url = `${GW_URL}?method=${method}&input=3&api_version=1.0&api_token=${token}`;

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(params);

    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Cookie': sessionCookies,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.deezer.com',
        'Referer': 'https://www.deezer.com/',
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          // Capture set-cookie for session maintenance
          if (res.headers['set-cookie']) {
            const sid = res.headers['set-cookie'].find(c => c.startsWith('sid='));
            if (sid) {
              sessionCookies += '; ' + sid.split(';')[0];
            }
          }
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse hatası: ${body.substring(0, 100)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GW timeout')); });
    req.write(postData);
    req.end();
  });
}

/**
 * Deezer public API (GET).
 */
function _publicGet(endpoint) {
  const url = `${PUBLIC_API}${endpoint}`;

  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Public API parse error')); }
      });
    }).on('error', reject);
  });
}

/**
 * POST JSON to a URL.
 */
function _postJson(url, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(data);

    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('POST JSON parse error')); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('POST timeout')); });
    req.write(postData);
    req.end();
  });
}

/**
 * Download binary data from URL.
 */
function _httpDownload(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;

    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': '*/*',
      },
      timeout: 60000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        return _httpDownload(res.headers.location).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

// ═══ EXPORTS ═══

function setArls(arlStringOrArray) {
  if (Array.isArray(arlStringOrArray)) {
    arlList = arlStringOrArray;
  } else if (typeof arlStringOrArray === 'string') {
    arlList = arlStringOrArray.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (arlList.length > 0) {
    currentArlIndex = 0;
    isInitialized = false; // Force re-init on next use
    console.log(`[Deezer] ARL listesi güncellendi (${arlList.length} adet). Yeni ARL ile deneniyor...`);
    // Attempt init in background
    init().catch(e => {});
  }
}

async function testArl(arl) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request({
      hostname: 'www.deezer.com',
      path: '/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `arl=${arl}`,
        'User-Agent': 'Mozilla/5.0'
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          if (d?.results?.USER?.USER_ID && d.results.USER.USER_ID !== 0) {
            resolve({ USER_ID: d.results.USER.USER_ID });
          } else {
            reject(new Error('Invalid'));
          }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write('{}');
    req.end();
  });
}

module.exports = {
  init,
  searchTrack,
  downloadTrack,
  setArls,
  testArl,
  isAvailable: () => arlList.length > 0 || isInitialized,
  getCacheDir: () => CACHE_DIR,
};
