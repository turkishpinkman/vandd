// ═══ VANDD — Online Music Module (YouTube Integration) ═══
// Searches YouTube and extracts direct audio stream URLs via yt-dlp.
// All streaming is proxied through the VANDD server — no ads, no YouTube UI.

const { execFile, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// yt-dlp command — use python module since it's installed via pip
const YT_DLP_CMD = 'python';
const YT_DLP_ARGS = ['-m', 'yt_dlp'];

// Cache for extracted stream URLs (they expire after ~6 hours)
const streamCache = new Map();
const CACHE_TTL = 5 * 60 * 60 * 1000; // 5 hours

function cleanCache() {
  const now = Date.now();
  for (const [key, entry] of streamCache) {
    if (now - entry.timestamp > CACHE_TTL) {
      streamCache.delete(key);
    }
  }
}
setInterval(cleanCache, 10 * 60 * 1000); // Clean every 10 min

// ═══ SEARCH ═══
// Uses yt-dlp to search YouTube and return metadata
function searchOnline(query, limit = 10) {
  return new Promise((resolve, reject) => {
    const args = [
      ...YT_DLP_ARGS,
      `ytsearch${limit}:${query}`,
      '--dump-json',
      '--flat-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--skip-download',
    ];

    let output = '';
    let errorOutput = '';

    const proc = execFile(YT_DLP_CMD, args, {
      maxBuffer: 10 * 1024 * 1024, // 10MB
      timeout: 20000,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err && !stdout) {
        console.error('yt-dlp search error:', err.message);
        return resolve([]);
      }

      try {
        // Each line is a JSON object
        const results = stdout.trim().split('\n')
          .filter(line => line.trim())
          .map(line => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          // Only include actual videos (not channels/playlists)
          .filter(item => item.id && item.id.length === 11 && item._type !== 'playlist' && item._type !== 'channel')
          .map(item => ({
            id: item.id,
            title: item.title || 'Unknown',
            artist: extractArtist(item),
            duration: item.duration || 0,
            thumbnail: getBestThumbnail(item),
            channel: item.channel || item.uploader || '',
            view_count: item.view_count || 0,
            url: `https://www.youtube.com/watch?v=${item.id}`,
            source: 'youtube',
          }));

        resolve(results);
      } catch (parseErr) {
        console.error('Parse error:', parseErr.message);
        resolve([]);
      }
    });
  });
}

// ═══ EXTRACT AUDIO STREAM URL ═══
// Gets the best quality audio-only stream URL for a given video ID
function getStreamUrl(videoId) {
  // Check cache
  const cached = streamCache.get(videoId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return Promise.resolve(cached);
  }

  return new Promise((resolve, reject) => {
    const args = [
      ...YT_DLP_ARGS,
      `https://www.youtube.com/watch?v=${videoId}`,
      '--dump-json',
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
      '--no-warnings',
      '--no-check-certificates',
      '--skip-download',
    ];

    execFile(YT_DLP_CMD, args, {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        console.error('yt-dlp extract error:', err.message);
        return reject(new Error('Failed to extract stream URL'));
      }

      try {
        const info = JSON.parse(stdout);
        const audioUrl = info.url;
        const entry = {
          url: audioUrl,
          title: info.title || 'Unknown',
          artist: extractArtist(info),
          duration: info.duration || 0,
          thumbnail: getBestThumbnail(info),
          format: info.ext || 'webm',
          acodec: info.acodec || 'unknown',
          abr: info.abr || 0,
          asr: info.asr || 0,
          channel: info.channel || info.uploader || '',
          videoId: videoId,
          timestamp: Date.now(),
        };

        streamCache.set(videoId, entry);
        resolve(entry);
      } catch (parseErr) {
        console.error('Parse error:', parseErr.message);
        reject(new Error('Failed to parse stream info'));
      }
    });
  });
}

// ═══ PROXY STREAM ═══
// Proxies the audio stream through the VANDD server
async function proxyStream(videoId, req, res) {
  try {
    const info = await getStreamUrl(videoId);
    const audioUrl = info.url;

    const parsedUrl = new URL(audioUrl);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    // Forward range header for seeking
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const proxyReq = client.get(audioUrl, { headers }, (proxyRes) => {
      // Map audio format to MIME type
      const mimeTypes = {
        'm4a': 'audio/mp4',
        'webm': 'audio/webm',
        'opus': 'audio/ogg',
        'mp3': 'audio/mpeg',
        'ogg': 'audio/ogg',
      };
      const contentType = mimeTypes[info.format] || proxyRes.headers['content-type'] || 'audio/webm';

      // Forward relevant headers
      const responseHeaders = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      };

      if (proxyRes.headers['content-length']) {
        responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
      }
      if (proxyRes.headers['content-range']) {
        responseHeaders['Content-Range'] = proxyRes.headers['content-range'];
      }

      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy stream error:', err.message);
      // URL might have expired, clear cache and retry once
      if (streamCache.has(videoId)) {
        streamCache.delete(videoId);
      }
      if (!res.headersSent) {
        res.status(502).json({ error: 'Stream unavailable' });
      }
    });

    req.on('close', () => {
      proxyReq.destroy();
    });

  } catch (err) {
    console.error('proxyStream error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to get stream' });
    }
  }
}

// ═══ THUMBNAIL PROXY ═══
// Proxies YouTube thumbnails to avoid CORS / privacy leaking
function proxyThumbnail(videoId, req, res) {
  const thumbUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  
  const proxyReq = https.get(thumbUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.status(404).send('Thumbnail not found');
    }
  });
}

// ═══ HELPERS ═══
function extractArtist(info) {
  // Try to parse "Artist - Title" format or use channel
  if (info.artist) return info.artist;
  if (info.creator) return info.creator;
  
  const title = info.title || '';
  // Common patterns: "Artist - Song Title", "Artist — Song Title"
  const separators = [' - ', ' — ', ' – ', ' | '];
  for (const sep of separators) {
    if (title.includes(sep)) {
      return title.split(sep)[0].trim();
    }
  }
  
  return info.channel || info.uploader || 'Unknown Artist';
}

function getBestThumbnail(info) {
  if (info.thumbnails && info.thumbnails.length) {
    // Get the best quality, prefer medium size to avoid huge downloads
    const sorted = info.thumbnails
      .filter(t => t.url && t.width)
      .sort((a, b) => (b.width || 0) - (a.width || 0));
    
    // Prefer something around 480px wide
    const medium = sorted.find(t => t.width >= 300 && t.width <= 640);
    return medium ? medium.url : sorted[0]?.url || null;
  }
  if (info.thumbnail) return info.thumbnail;
  if (info.id) return `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`;
  return null;
}

module.exports = { searchOnline, getStreamUrl, proxyStream, proxyThumbnail };
