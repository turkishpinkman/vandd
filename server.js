const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { db, stmts } = require('./db');
const { scanLibrary, getScanProgress } = require('./scanner');
const { searchOnline, getStreamUrl, proxyStream, proxyThumbnail } = require('./online');
const spotify = require('./spotify');
const downloader = require('./downloader');
const telegram = require('./telegram');
const { updateArls } = require('./arl-updater');

const app = express();
const PORT = process.env.PORT || 3000;

// Default music directory — change this or set MUSIC_DIR env variable
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(require('os').homedir(), 'Music');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API ROUTES ────────────────────────────────────────────────────────────────

// Stats
app.get('/api/stats', (req, res) => {
  const stats = stmts.getStats.get();
  stats.music_dir = MUSIC_DIR;
  res.json(stats);
});

// Deezer ARL
app.get('/api/deezer/arl', (req, res) => {
  const arl = process.env.DEEZER_ARL || '';
  const maskedArl = arl ? arl.substring(0, 4) + '•'.repeat(20) + arl.substring(arl.length - 4) : '';
  res.json({ arl: maskedArl });
});

app.post('/api/deezer/arl', (req, res) => {
  const { arl } = req.body;
  if (!arl) return res.status(400).json({ error: 'ARL required' });
  
  // Update .env file
  const envPath = path.join(__dirname, '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }

  if (envContent.includes('DEEZER_ARL=')) {
    envContent = envContent.replace(/DEEZER_ARL=.*/, `DEEZER_ARL=${arl}`);
  } else {
    envContent += `\nDEEZER_ARL=${arl}\n`;
  }
  
  fs.writeFileSync(envPath, envContent);
  process.env.DEEZER_ARL = arl;
  res.json({ success: true });
});

app.post('/api/deezer/refresh-arl', async (req, res) => {
  try {
    const success = await updateArls();
    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Spotify Logout
app.post('/api/spotify/logout', (req, res) => {
  spotify.logout();
  res.json({ success: true });
});

// ─── ARTISTS ───────────────────────────────────────────────────────────────────

app.get('/api/artists', (req, res) => {
  const artists = stmts.getAllArtists.all();
  // Don't send blobs in list
  res.json(artists.map(a => ({ ...a, image_blob: undefined, has_image: !!a.image_blob })));
});

app.get('/api/artists/:id', (req, res) => {
  const artist = stmts.getArtistById.get(req.params.id);
  if (!artist) return res.status(404).json({ error: 'Artist not found' });

  const albums = stmts.getAlbumsByArtist.all(artist.id);
  res.json({
    ...artist,
    image_blob: undefined,
    has_image: !!artist.image_blob,
    albums: albums.map(al => ({ ...al, cover_blob: undefined, has_cover: !!al.cover_blob }))
  });
});

app.get('/api/artists/:id/image', (req, res) => {
  const artist = stmts.getArtistById.get(req.params.id);
  if (!artist || !artist.image_blob) {
    return res.status(404).send('No image');
  }
  res.set('Content-Type', artist.image_mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(artist.image_blob);
});

// ─── ALBUMS ────────────────────────────────────────────────────────────────────

app.get('/api/albums', (req, res) => {
  const albums = stmts.getAllAlbums.all();
  res.json(albums.map(al => ({ ...al, cover_blob: undefined, has_cover: !!al.cover_blob })));
});

app.get('/api/albums/recent', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const albums = stmts.getRecentAlbums.all(limit);
  res.json(albums.map(al => ({ ...al, cover_blob: undefined, has_cover: !!al.cover_blob })));
});

app.get('/api/albums/:id', (req, res) => {
  const album = stmts.getAlbumById.get(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album not found' });

  const tracks = stmts.getTracksByAlbum.all(album.id);
  res.json({
    ...album,
    cover_blob: undefined,
    has_cover: !!album.cover_blob,
    tracks
  });
});

app.get('/api/albums/:id/cover', (req, res) => {
  const album = stmts.getAlbumById.get(req.params.id);
  if (!album || !album.cover_blob) {
    return res.status(404).send('No cover');
  }
  res.set('Content-Type', album.cover_mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(album.cover_blob);
});

// ─── TRACKS ────────────────────────────────────────────────────────────────────

app.get('/api/tracks', (req, res) => {
  const tracks = stmts.getAllTracks.all();
  res.json(tracks);
});

app.get('/api/tracks/recent', (req, res) => {
  const limit = parseInt(req.query.limit) || 30;
  const tracks = stmts.getRecentTracks.all(limit);
  res.json(tracks);
});

app.get('/api/tracks/:id', (req, res) => {
  const track = stmts.getTrackById.get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  res.json(track);
});

app.get('/api/tracks/:id/stream', (req, res) => {
  const track = stmts.getTrackById.get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });

  const filePath = track.file_path;
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  // MIME types
  const mimeTypes = {
    'FLAC': 'audio/flac',
    'MP3': 'audio/mpeg',
    'WAV': 'audio/wav',
    'M4A': 'audio/mp4',
    'AAC': 'audio/aac',
    'OGG': 'audio/ogg',
    'AIFF': 'audio/aiff',
    'WMA': 'audio/x-ms-wma',
  };
  const contentType = mimeTypes[track.format] || 'audio/flac';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;

    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ─── SEARCH ────────────────────────────────────────────────────────────────────

app.get('/api/search', (req, res) => {
  const q = req.query.q;
  if (!q || q.trim().length < 1) {
    return res.json([]);
  }
  const like = `%${q.trim()}%`;
  const results = stmts.search.all(like, like, like);
  res.json(results);
});

// ─── SCAN ──────────────────────────────────────────────────────────────────────

app.post('/api/scan', async (req, res) => {
  const dir = req.body.directory || MUSIC_DIR;
  
  if (!fs.existsSync(dir)) {
    return res.status(400).json({ error: `Directory not found: ${dir}` });
  }

  // Start scan in background
  res.json({ message: 'Scan started', directory: dir });
  
  try {
    await scanLibrary(dir);
  } catch (err) {
    console.error('Scan failed:', err);
  }
});

app.get('/api/scan/progress', (req, res) => {
  res.json(getScanProgress());
});

// ─── SPOTIFY & DOWNLOADER INTEGRATION ──────────────────────────────────────────────

// Spotify OAuth Flow
app.get('/api/spotify/login', (req, res) => {
  res.redirect(spotify.getLoginUrl());
});

app.get('/api/spotify/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided');
  try {
    await spotify.handleCallback(code);
    res.redirect('/');
  } catch (err) {
    console.error('Spotify Callback Error:', err);
    res.status(500).send('Authentication failed');
  }
});

app.get('/api/spotify/token', async (req, res) => {
  const token = await spotify.getUserToken();
  res.json({ token });
});

// Anasayfa şarkıları Spotify'dan
app.get('/api/spotify/home', async (req, res) => {
  try {
    const data = await spotify.getSpotifyHome();
    res.json(data);
  } catch (err) {
    console.error('Spotify Home Hatası:', err.message);
    res.status(500).json({ error: 'Spotify anasayfa verisi alınamadı' });
  }
});

// Arama Spotify'dan
app.get('/api/spotify/search', async (req, res) => {
  const q = req.query.q;
  const limit = parseInt(req.query.limit) || 10;
  if (!q || q.trim().length < 2) return res.json({ tracks: [], artists: [], albums: [] });
  try {
    const results = await spotify.searchSpotify(q.trim(), limit);
    res.json(results);
  } catch (err) {
    console.error('Spotify Arama Hatası:', err.message);
    res.json({ tracks: [], artists: [], albums: [] });
  }
});

app.get('/api/spotify/artist/:id', async (req, res) => {
  try {
    const data = await spotify.getSpotifyArtist(req.params.id);
    res.json(data);
  } catch (err) {
    console.error('Spotify Artist Hatası:', err.message);
    res.status(500).json({ error: 'Sanatçı alınamadı' });
  }
});

app.get('/api/spotify/liked', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  try {
    const results = await spotify.getSpotifyLikedTracks(limit);
    res.json(results);
  } catch (err) {
    const errMsg = err.body && err.body.error ? err.body.error.message : err.message;
    console.error('Spotify Beğenilenler Hatası:', errMsg);
    res.status(500).json({ error: 'Beğenilen şarkılar alınamadı: ' + errMsg });
  }
});

app.get('/api/spotify/recommendations', async (req, res) => {
  const seedTracks = req.query.seeds ? req.query.seeds.split(',') : [];
  const limit = parseInt(req.query.limit) || 20;
  try {
    const results = await spotify.getSpotifyRecommendations(seedTracks, limit);
    res.json(results);
  } catch (err) {
    console.error('Spotify Öneriler Hatası:', err.message);
    res.status(500).json({ error: 'Öneriler alınamadı' });
  }
});

// ─── SPOTIFY ALBUM DETAIL ─────────────────────────────────────────────────────
app.get('/api/spotify/album/:id', async (req, res) => {
  try {
    const album = await spotify.getSpotifyAlbum(req.params.id);
    res.json(album);
  } catch (err) {
    console.error('Spotify album hatası:', err.message);
    res.status(500).json({ error: 'Albüm bilgisi alınamadı' });
  }
});

// ─── LIKE / UNLIKE / CHECK ────────────────────────────────────────────────────
app.put('/api/spotify/like/:trackId', async (req, res) => {
  try {
    await spotify.saveTrack(req.params.trackId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Like hatası:', err.message);
    res.status(500).json({ error: 'Beğenme başarısız' });
  }
});

app.delete('/api/spotify/unlike/:trackId', async (req, res) => {
  try {
    await spotify.removeTrack(req.params.trackId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Unlike hatası:', err.message);
    res.status(500).json({ error: 'Beğeni kaldırma başarısız' });
  }
});

app.get('/api/spotify/check-liked', async (req, res) => {
  const ids = req.query.ids ? req.query.ids.split(',') : [];
  if (ids.length === 0) return res.json([]);
  try {
    const result = await spotify.checkSavedTracks(ids);
    res.json(result);
  } catch (err) {
    console.error('Check liked hatası:', err.message);
    res.json(ids.map(() => false));
  }
});

// ─── SPOTIFY TRACK METADATA ───────────────────────────────────────────────────
app.get('/api/spotify/track/:id', async (req, res) => {
  try {
    const track = await spotify.getSpotifyTrack(req.params.id);
    res.json(track);
  } catch (err) {
    console.error('Spotify track hatası:', err.message);
    res.status(500).json({ error: 'Şarkı bilgisi alınamadı' });
  }
});

const activeDownloads = new Map();

// Spotify şarkısını "Müzikler" klasörüne indir ve kütüphaneye ekle
app.post('/api/downloader/download', async (req, res) => {
  const { trackId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'Track ID gerekli' });

  if (activeDownloads.has(trackId)) {
    try {
      const localTrackId = await activeDownloads.get(trackId);
      return res.json({ success: true, localTrackId });
    } catch (err) {
      return res.status(500).json({ error: 'İndirme başarısız oldu' });
    }
  }

  const downloadPromise = (async () => {
    // 1. Şarkı bilgilerini al
    const track = await spotify.getSpotifyTrack(trackId);
    
    // Check if we already have it locally
    const q = `%${track.title}%`;
    const localResults = stmts.search.all(q, q, q);
    
    let existingTrack = localResults.find(r => r.type === 'track' && r.artist_name && track.artist && r.artist_name.toLowerCase() === track.artist.toLowerCase());
    if (!existingTrack) {
      existingTrack = localResults.find(r => r.type === 'track' && r.name && r.name.toLowerCase() === track.title.toLowerCase());
    }
    
    if (existingTrack) {
        return existingTrack.id;
    }

    // 2. Yüksek kalitede indir (lucida / streamrip / yt-dlp)
    await downloader.downloadTrackToLibrary(track.title, track.artist, MUSIC_DIR);
    
    // 3. Kütüphaneyi tara ki yeni şarkı DB'ye eklensin
    await scanLibrary(MUSIC_DIR);
    
    // 4. İndirilen şarkıyı veritabanında bul
    const localResultsAfter = stmts.search.all(q, q, q);
    let downloadedTrack = localResultsAfter.find(r => r.type === 'track' && r.artist_name && track.artist && r.artist_name.toLowerCase() === track.artist.toLowerCase());
    
    if (downloadedTrack) {
      return downloadedTrack.id;
    } else {
      // Eğer exact match bulunamadıysa en üsttekini verelim
      const firstTrack = localResultsAfter.find(r => r.type === 'track');
      if (firstTrack) {
         return firstTrack.id;
      } else {
         throw new Error('İndirildi ama veritabanında bulunamadı');
      }
    }
  })();

  activeDownloads.set(trackId, downloadPromise);

  try {
    const localTrackId = await downloadPromise;
    activeDownloads.delete(trackId);
    res.json({ success: true, localTrackId });
  } catch (err) {
    activeDownloads.delete(trackId);
    console.error('İndirme hatası:', err);
    res.status(500).json({ error: 'İndirme başarısız oldu' });
  }
});

// ─── AUDIO STREAM (Deezer Direct FLAC → YouTube fallback) ───────────────────

app.get('/api/telegram/stream/:trackId', async (req, res) => {
  const { trackId } = req.params;
  const { title, artist, isrc } = req.query;
  try {
    // If no ISRC provided, try to get it from Spotify
    let trackIsrc = isrc || '';
    if (!trackIsrc) {
      try {
        const spotifyTrack = await spotify.getSpotifyTrack(trackId);
        trackIsrc = spotifyTrack.isrc || '';
      } catch (e) { /* ignore — will search by text */ }
    }
    await telegram.streamTrack(null, req, res, trackId, title || '', artist || '', trackIsrc);
  } catch (err) {
    console.error('Stream hatası:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream başlatılamadı', source: 'none' });
    }
  }
});

// Prefetch: sıradaki şarkıyı arka planda hazırla
app.post('/api/telegram/prefetch/:trackId', async (req, res) => {
  const { trackId } = req.params;
  const { title, artist, isrc } = req.body || {};
  // Get ISRC if not provided
  let trackIsrc = isrc || '';
  if (!trackIsrc) {
    try {
      const spotifyTrack = await spotify.getSpotifyTrack(trackId);
      trackIsrc = spotifyTrack.isrc || '';
    } catch (e) { /* ignore */ }
  }
  telegram.prefetchTrack(trackId, title || '', artist || '', trackIsrc);
  res.json({ ok: true });
});

// Check: pre-verify availability without streaming (returns source info)
app.get('/api/telegram/check/:trackId', async (req, res) => {
  const { trackId } = req.params;
  const { title, artist, isrc } = req.query;
  try {
    let trackIsrc = isrc || '';
    if (!trackIsrc) {
      try {
        const spotifyTrack = await spotify.getSpotifyTrack(trackId);
        trackIsrc = spotifyTrack.isrc || '';
      } catch (e) { /* ignore */ }
    }
    const info = await telegram.getTrackMedia(trackId, title || '', artist || '', trackIsrc);
    res.json({
      available: true,
      source: info.source,
      isFlac: !!info.isFlac,
      quality: info.quality || (info.isFlac ? 'FLAC' : 'MP3_320'),
      title: info.title,
      artist: info.artist,
    });
  } catch (err) {
    res.json({ available: false, source: 'none', error: err.message });
  }
});

// ─── SPA FALLBACK ──────────────────────────────────────────────────────────────

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════════╗
  ║                                               ║
  ║        🎵  VANDD Music Server  🎵             ║
  ║                                               ║
  ║   Running at: http://localhost:${PORT}           ║
  ║   Music Dir:  ${MUSIC_DIR.substring(0, 30).padEnd(30)}  ║
  ║                                               ║
  ╚═══════════════════════════════════════════════╝
  `);

  // Auto-scan on startup if library is empty
  const stats = stmts.getStats.get();
  if (stats.track_count === 0 && fs.existsSync(MUSIC_DIR)) {
    console.log('📂 Empty library detected. Starting initial scan...');
    scanLibrary(MUSIC_DIR).catch(err => console.error('Auto-scan error:', err));
  }

  // ARL Updater'ı çalıştır ve periyodik olarak zamanla (ör: 12 saatte bir)
  console.log('🔄 ARL Updater başlatılıyor...');
  updateArls().catch(err => console.error('[ARL Updater] Hata:', err.message));
  
  // 12 saatte bir çalıştır (12 * 60 * 60 * 1000 = 43200000 ms)
  setInterval(() => {
    updateArls().catch(err => console.error('[ARL Updater] Hata:', err.message));
  }, 43200000);
});
