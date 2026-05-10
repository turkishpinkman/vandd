// ═══ VANDD — Audio Stream Engine ═══
// Primary:  Deezer direct (FLAC via ARL cookie — no bot needed)
// Fallback: YouTube via yt-dlp
//
// Architecture: Download to disk → serve with Range support → perfect seeking.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const deezer = require('./deezer');
require('dotenv').config();

const YT_DLP_CMD = 'python';
const YT_DLP_ARGS = ['-m', 'yt_dlp'];

// Cache directory (shared with deezer.js)
const CACHE_DIR = path.join(os.tmpdir(), 'vandd-audio-cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ═══ TRACK INFO CACHE ═══
// spotifyTrackId → { source, filePath, fileSize, mimeType, title, artist, isFlac, timestamp }
const mediaCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;

// ═══ REQUEST DEDUP ═══
const pendingRequests = new Map();



// ═══ INIT ═══

async function initDeezer() {
  try {
    const ready = await deezer.init();
    if (ready) {
      console.log('[Engine] ✓ Deezer Direct modu aktif.');
    } else {
      console.log('[Engine] ⚠ Deezer ARL yok/geçersiz — sadece YouTube kullanılacak.');
    }
  } catch (e) {
    console.warn('[Engine] Deezer init hatası:', e.message);
  }
}

// Auto-init on module load
initDeezer();

/**
 * Get or download track audio file.
 * Returns: { source, filePath, fileSize, mimeType, title, artist, isFlac }
 */
async function getTrackMedia(spotifyTrackId, trackTitle, trackArtist, isrc) {
  // Check cache
  const cached = mediaCache.get(spotifyTrackId);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    if (fs.existsSync(cached.filePath)) {
      console.log(`[Engine] Cache hit (${cached.source}): ${cached.title}`);
      return cached;
    } else {
      console.log(`[Engine] Cache dosyası kayıp, yeniden indiriliyor...`);
      mediaCache.delete(spotifyTrackId);
    }
  }

  // Dedup
  if (pendingRequests.has(spotifyTrackId)) {
    return pendingRequests.get(spotifyTrackId);
  }

  const promise = _resolveTrack(spotifyTrackId, trackTitle, trackArtist, isrc);
  pendingRequests.set(spotifyTrackId, promise);

  try {
    return await promise;
  } finally {
    pendingRequests.delete(spotifyTrackId);
  }
}

/**
 * Resolution chain: Deezer direct → YouTube fallback
 */
async function _resolveTrack(spotifyTrackId, trackTitle, trackArtist, isrc) {
  // ─── ATTEMPT 1: Deezer Direct (FLAC via ARL) ───
  if (deezer.isAvailable()) {
    try {
      const result = await _downloadFromDeezer(spotifyTrackId, trackTitle, trackArtist, isrc);
      if (result) return result;
      console.log(`[Engine] Deezer'da bulunamadı veya indirilemedi, YouTube'a geçiliyor...`);
    } catch (e) {
      console.warn(`[Engine] Deezer hatası (${e.message}), YouTube'a geçiliyor...`);
    }
  }

  // ─── ATTEMPT 2: YouTube via yt-dlp ───
  console.log(`[Engine] YouTube fallback: ${trackArtist} - ${trackTitle}`);
  try {
    const result = await _downloadFromYouTube(spotifyTrackId, trackTitle, trackArtist);
    if (result) return result;
  } catch (e) {
    console.warn(`[Engine] YouTube da başarısız: ${e.message}`);
  }

  throw new Error('Ne Deezer ne YouTube\'da bulunamadı');
}

/**
 * Download from Deezer directly (no bot, no Telegram).
 */
async function _downloadFromDeezer(spotifyTrackId, title, artist, isrc) {
  // 1. Search on Deezer
  const searchResult = await deezer.searchTrack(title, artist, isrc);
  if (!searchResult) {
    console.log(`[Deezer] ✗ Şarkı bulunamadı: ${artist} - ${title}`);
    return null;
  }

  // 2. Download (auto quality fallback: FLAC → 320 → 128)
  const dlResult = await deezer.downloadTrack(searchResult.deezerId, spotifyTrackId);
  if (!dlResult) {
    console.log(`[Deezer] ✗ İndirme başarısız: ${searchResult.title}`);
    return null;
  }

  // 3. Cache result
  const mediaInfo = {
    source: 'deezer',
    filePath: dlResult.filePath,
    fileSize: dlResult.fileSize,
    mimeType: dlResult.mimeType,
    title: searchResult.title || title,
    artist: searchResult.artist || artist,
    isFlac: dlResult.isFlac,
    quality: dlResult.quality,
    timestamp: Date.now(),
  };

  mediaCache.set(spotifyTrackId, mediaInfo);
  return mediaInfo;
}

/**
 * YouTube fallback — download to disk via yt-dlp.
 */
async function _downloadFromYouTube(spotifyTrackId, title, artist) {
  const query = `${artist || ''} ${title || ''}`.trim();
  if (!query) throw new Error('Arama sorgusu boş');

  const filePath = path.join(CACHE_DIR, `${spotifyTrackId}_yt.m4a`);

  // Check if already downloaded
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1024) {
    const fileSize = fs.statSync(filePath).size;
    const mediaInfo = {
      source: 'youtube',
      filePath,
      fileSize,
      mimeType: 'audio/mp4',
      title: title || 'Unknown',
      artist: artist || 'Unknown',
      isFlac: false,
      quality: 'YOUTUBE',
      timestamp: Date.now(),
    };
    mediaCache.set(spotifyTrackId, mediaInfo);
    console.log(`[YouTube] Cache hit: ${filePath}`);
    return mediaInfo;
  }

  return new Promise((resolve, reject) => {
    const args = [
      ...YT_DLP_ARGS,
      `ytsearch1:${query}`,
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
      '-o', filePath,
      '--no-warnings',
      '--no-check-certificates',
      '--no-playlist',
      '--print-json',
    ];

    console.log(`[YouTube] İndiriliyor: ${query}...`);

    execFile(YT_DLP_CMD, args, {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 60000,
      windowsHide: true,
    }, (err, stdout) => {
      if (err) {
        return reject(new Error('yt-dlp başarısız: ' + err.message));
      }

      try {
        const lines = stdout.trim().split('\n');
        const info = JSON.parse(lines[lines.length - 1]);

        // Find actual file (extension may vary)
        const actualPath = [filePath, filePath.replace('.m4a', '.webm'), filePath.replace('.m4a', '.opus')]
          .find(p => fs.existsSync(p)) || filePath;

        if (!fs.existsSync(actualPath)) {
          return reject(new Error('İndirilen dosya bulunamadı'));
        }

        const fileSize = fs.statSync(actualPath).size;
        const ext = path.extname(actualPath).slice(1);
        const mimeTypes = { m4a: 'audio/mp4', webm: 'audio/webm', opus: 'audio/ogg', mp3: 'audio/mpeg' };

        const mediaInfo = {
          source: 'youtube',
          filePath: actualPath,
          fileSize,
          mimeType: mimeTypes[ext] || 'audio/mp4',
          title: title || info.title || 'Unknown',
          artist: artist || info.channel || 'Unknown',
          isFlac: false,
          quality: 'YOUTUBE',
          abr: info.abr || 0,
          timestamp: Date.now(),
        };

        mediaCache.set(spotifyTrackId, mediaInfo);
        console.log(`[YouTube] ✓ ${mediaInfo.artist} - ${mediaInfo.title} | ${ext} ${info.abr || '?'}kbps | ${(fileSize / 1048576).toFixed(1)}MB`);
        resolve(mediaInfo);
      } catch (e) {
        reject(new Error('yt-dlp JSON parse hatası'));
      }
    });
  });
}

/**
 * Stream a track. Downloads if needed, then serves from disk.
 */
async function streamTrack(query, req, res, spotifyTrackId, trackTitle, trackArtist, isrc) {
  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const mediaInfo = await getTrackMedia(spotifyTrackId, trackTitle, trackArtist, isrc);

    if (aborted) return;

    // ─── SERVE FROM DISK (perfect Range/seeking) ───
    _serveFile(mediaInfo, req, res);

  } catch (err) {
    console.error('[Engine] Hata:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message, source: 'none' });
    }
  }
}

/**
 * Serve audio file from disk with full HTTP Range support.
 */
function _serveFile(mediaInfo, req, res) {
  const { filePath, fileSize, mimeType, source } = mediaInfo;
  const sourceHeader = mediaInfo.isFlac ? 'deezer-flac' : (source === 'deezer' ? 'deezer' : 'youtube');

  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
      'X-Audio-Source': sourceHeader,
      'Cache-Control': 'public, max-age=3600',
    });

    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
    stream.on('error', (e) => {
      console.error('[Engine] File read hatası:', e.message);
      if (!res.writableEnded) res.end();
    });
  } else {
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'X-Audio-Source': sourceHeader,
      'Cache-Control': 'public, max-age=3600',
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', (e) => {
      console.error('[Engine] File read hatası:', e.message);
      if (!res.writableEnded) res.end();
    });
  }
}

/**
 * Pre-fetch a track (download to disk in background).
 */
async function prefetchTrack(spotifyTrackId, trackTitle, trackArtist, isrc) {
  try {
    await getTrackMedia(spotifyTrackId, trackTitle, trackArtist, isrc);
  } catch (e) {
    console.warn(`[Engine] Prefetch failed: ${e.message}`);
  }
}

module.exports = {
  streamTrack,
  prefetchTrack,
  getTrackMedia,
};
