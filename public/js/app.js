// ═══ VANDD Music Player — Apple Music Style ═══

const audio = document.getElementById('audio-element');
let currentTrackId = null;
let queue = [];        // [{id, source:'local'|'youtube', videoId?}]
let queueIndex = -1;
let allTracksCache = [];
let onlineResultsCache = [];
let spotifyPlayer = null;
let currentSpotifyTrackId = null;
let isShuffle = false;
let isRepeat = false;
let isSpotifySdkActive = false;
let currentLists = {};
let isCurrentTrackLiked = false;

// ═══ SPOTIFY WEB PLAYBACK SDK ═══
window.onSpotifyWebPlaybackSDKReady = async () => {
  try {
    const res = await fetch('/api/spotify/token');
    const data = await res.json();
    const token = data.token;
    
    if (!token) {
      console.log('Spotify token bulunamadı, Web Playback SDK başlatılamıyor.');
      showSpotifyLogin();
      return;
    }

    const player = new Spotify.Player({
      name: 'VANDD Hi-Fi Player',
      getOAuthToken: cb => { cb(token); },
      volume: 0.0 // MUTE THE SPOTIFY AUDIO (Audio Hijacking)
    });

    player.addListener('initialization_error', ({ message }) => { console.error(message); });
    player.addListener('authentication_error', ({ message }) => { console.error(message); });
    player.addListener('account_error', ({ message }) => { console.error(message); });
    player.addListener('playback_error', ({ message }) => { console.error(message); });

    player.addListener('player_state_changed', state => {
      if (!state) return;
      
      const currentTrack = state.track_window.current_track;
      if (currentTrack && currentTrack.id !== currentSpotifyTrackId) {
        currentSpotifyTrackId = currentTrack.id;
        console.log(`Spotify'da yeni şarkı başladı: ${currentTrack.name} - ${currentTrack.artists[0].name}`);
        
        // Cache metadata from Spotify SDK state (includes cover art)
        const coverImg = currentTrack.album?.images?.[0]?.url || '';
        cacheSpotifyMeta(
          currentTrack.id,
          currentTrack.name,
          currentTrack.artists.map(a => a.name).join(', '),
          coverImg,
          currentTrack.album?.name || '',
          currentTrack.duration_ms / 1000
        );
        
        isSpotifySdkActive = true;
        // Tetikle Kayıpsız Oynatıcı!
        playSpotifyTrack(currentTrack.id, true);
      }
      
      // Sıradaki şarkıyı arka planda Deezer'dan önceden indir (FLAC cache)
      if (state.track_window.next_tracks && state.track_window.next_tracks.length > 0) {
        const nextTrack = state.track_window.next_tracks[0];
        // Cache next track metadata too
        const nextCover = nextTrack.album?.images?.[0]?.url || '';
        const nextIsrc = nextTrack.external_ids?.isrc || '';
        cacheSpotifyMeta(
          nextTrack.id,
          nextTrack.name,
          nextTrack.artists.map(a => a.name).join(', '),
          nextCover,
          nextTrack.album?.name || '',
          nextTrack.duration_ms / 1000,
          nextIsrc
        );
        fetch(`/api/telegram/prefetch/${nextTrack.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: nextTrack.name,
            artist: nextTrack.artists?.[0]?.name || '',
            isrc: nextIsrc
          })
        }).catch(err => console.error("Prefetch hatası:", err));
      }

      // Sync local pause/play state with Spotify
      if (state.paused && !audio.paused) {
        audio.pause();
      } else if (!state.paused && audio.paused && audio.src) {
        audio.play();
      }
    });

    player.addListener('ready', ({ device_id }) => {
      console.log('Spotify Connect Cihazı Hazır: ', device_id);
    });

    player.addListener('not_ready', ({ device_id }) => {
      console.log('Spotify Connect Cihazı Çevrimdışı: ', device_id);
    });

    player.connect();
    spotifyPlayer = player;

  } catch (e) {
    console.error('Spotify Player init error:', e);
  }
};

function showSpotifyLogin() {
  const sidebarNav = document.querySelector('.sidebar-nav');
  if (!document.getElementById('nav-spotify-login')) {
    const a = document.createElement('a');
    a.href = '/api/spotify/login';
    a.className = 'nav-item';
    a.id = 'nav-spotify-login';
    a.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" style="width:20px;height:20px;margin-right:12px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.6 14.4c-.2.3-.6.4-.9.2-2.4-1.5-5.5-1.8-9.1-1-.4.1-.7-.2-.8-.6-.1-.4.2-.7.6-.8 4-.9 7.4-.5 10.1 1.1.3.1.4.5.1.8zm1-2.2c-.2.4-.7.5-1.1.3-2.8-1.7-7-2.3-10.4-1.2-.5.1-.9-.1-1.1-.6-.1-.5.1-.9.6-1.1 3.9-1.2 8.6-.6 11.8 1.4.3.2.5.7.2 1.2zm.1-2.4c-3.3-2-8.8-2.2-12-1.2-.6.2-1.2-.1-1.4-.7-.2-.6.1-1.2.7-1.4 3.7-1.1 9.9-.9 13.7 1.4.5.3.7.9.4 1.4-.3.4-.9.6-1.4.5z"/></svg><span>Spotify İle Giriş Yap</span>`;
    // a.style.color = '#1db954';
    sidebarNav.appendChild(a);
  }
}

// ═══ NAVIGATION ═══
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    navigateTo(item.dataset.view);
  });
});

function navigateTo(view, params) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const el = document.getElementById(`view-${view}`);
  if (el) el.classList.add('active');
  const nav = document.querySelector(`[data-view="${view}"]`);
  if (nav) nav.classList.add('active');
  document.getElementById('main-content').scrollTo(0, 0);

  switch(view) {
    case 'home': loadHome(); break;
    case 'liked': loadLiked(); break;
    case 'artists': loadArtists(); break;
    case 'albums': loadAlbums(); break;
    case 'tracks': loadAllTracks(); break;
    case 'search': document.getElementById('search-input').focus(); break;
    case 'settings': loadSettings(); break;
    case 'artist-detail': loadArtistDetail(params); break;
    case 'album-detail': loadAlbumDetail(params); break;
  }
}

// ═══ API ═══
async function api(url) {
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok) {
    throw new Error(data.error || `HTTP error ${r.status}`);
  }
  return data;
}

// ═══ HELPERS ═══
function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2,'0')}`;
}
function formatDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} sa ${m} dk`;
  return `${m} dk`;
}
function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024*1024*1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes/(1024*1024)).toFixed(0)} MB`;
}

function coverUrl(albumId) { return `/api/albums/${albumId}/cover`; }
function artistImgUrl(id) { return `/api/artists/${id}/image`; }

function placeholderSVG() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>`;
}

function esc(s) { if(!s)return''; const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

function equalizerHTML() {
  return `<div class="equalizer"><span></span><span></span><span></span><span></span></div>`;
}

function searchForArtist(name) {
  navigateTo('search');
  document.getElementById('search-input').value = name;
  doSearch(name);
}

// ═══ HOME ═══
async function loadHome() {
  setGreeting();
  document.getElementById('recommended-tracks').innerHTML = '<div class="loading-spinner" style="margin:20px auto"></div>';
  document.getElementById('recent-albums').innerHTML = '<div class="loading-spinner" style="margin:20px auto"></div>';
  document.getElementById('recent-tracks').innerHTML = '<div class="loading-spinner" style="margin:20px auto"></div>';

  try {
    let seedTracks = [];
    try {
       const liked = await api('/api/spotify/liked?limit=5');
       seedTracks = liked.map(t => t.id).slice(0, 5);
    } catch(e) { console.error('Failed to get seeds'); }

    const seedParam = seedTracks.length > 0 ? `?seeds=${seedTracks.join(',')}` : '';

    const [spotifyData, recommendationsData, stats] = await Promise.all([
      api('/api/spotify/home').catch(() => ({ albums: [], tracks: [] })),
      api(`/api/spotify/recommendations${seedParam}`).catch(() => []),
      api('/api/stats').catch(() => ({ track_count: 0 }))
    ]);

    const albums = (spotifyData.albums || []).map(a => ({
      id: a.id, title: a.title, artist_name: a.artist,
      has_cover: !!a.coverUrl, custom_cover: a.coverUrl, source: 'spotify'
    }));

    const mapSpTrack = t => ({
      id: t.id, title: t.title, artist_name: t.artist,
      album_title: t.album, albumId: t.albumId, artistId: t.artistId,
      duration: t.duration, source: 'spotify', coverUrl: t.cover
    });

    renderSpotifyTrackList('recommended-tracks', (recommendationsData || []).map(mapSpTrack));
    renderAlbumGrid('recent-albums', albums);
    renderSpotifyTrackList('recent-tracks', (spotifyData.tracks || []).map(mapSpTrack));
    updateStats(stats);
  } catch (err) {
    console.error('loadHome error:', err);
    document.getElementById('recommended-tracks').innerHTML = '<div class="empty-state"><h3>Veriler yüklenemedi</h3><p>Spotify bağlantınızı kontrol edin</p></div>';
    document.getElementById('recent-albums').innerHTML = '';
    document.getElementById('recent-tracks').innerHTML = '';
  }
}

// ═══ LIKED SONGS ═══
async function loadLiked() {
  const container = document.getElementById('liked-tracks');
  container.innerHTML = '<div class="loading-spinner" style="margin:20px auto"></div>';
  const data = await api('/api/spotify/liked?limit=50').catch(() => []);
  const tracks = data.map(t => ({
    id: t.id, title: t.title, artist_name: t.artist,
    album_title: t.album, albumId: t.albumId, artistId: t.artistId,
    duration: t.duration, source: 'spotify', coverUrl: t.cover
  }));
  renderSpotifyTrackList('liked-tracks', tracks);
}

function setGreeting() {
  const h = new Date().getHours();
  let g = 'İyi akşamlar';
  if (h >= 5 && h < 12) g = 'Günaydın';
  else if (h >= 12 && h < 18) g = 'İyi günler';
  else if (h >= 18 && h < 23) g = 'İyi akşamlar';
  else g = 'İyi geceler';

  const titleEl = document.getElementById('greeting-title');
  const subEl = document.getElementById('greeting-subtitle');
  if (titleEl) titleEl.textContent = g;
  if (subEl) subEl.textContent = 'Senin için seçtiğimiz müziklere göz at.';
}

function updateStats(stats) {
  const el = document.getElementById('library-stats');
  if (!stats || !stats.track_count) {
    el.innerHTML = '<em>Kütüphane boş</em>';
    return;
  }
  el.innerHTML = `${stats.artist_count} sanatçı · ${stats.album_count} albüm · ${stats.track_count} şarkı<br>${formatDuration(stats.total_duration)} · ${formatSize(stats.total_size)}`;
}

// ═══ RENDER ALBUM GRID ═══
function renderAlbumGrid(containerId, albums) {
  const c = document.getElementById(containerId);
  if (!albums.length) {
    c.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="3"/></svg><h3>Henüz albüm yok</h3><p>Müzik klasörünüzü tarayarak başlayın</p></div>`;
    return;
  }
  c.innerHTML = albums.map(al => {
    const isSpotify = al.source === 'spotify';
    const clickAction = isSpotify ? `loadSpotifyAlbumView('${al.id}')` : `navigateTo('album-detail',${al.id})`;
    const playAction = isSpotify ? `playSpotifyAlbum('${al.id}')` : `playAlbum(${al.id})`;
    return `
    <div class="album-card" onclick="${clickAction}">
      <div class="album-cover-wrap">
        ${al.custom_cover ? `<img src="${al.custom_cover}" loading="lazy">` : al.has_cover ? `<img src="${coverUrl(al.id)}" alt="${esc(al.title)}" loading="lazy">` : `<div class="placeholder-cover">${placeholderSVG()}</div>`}
        <button class="album-play-btn" onclick="event.stopPropagation();${playAction}" title="Çal">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>
      <div class="album-card-title" title="${esc(al.title)}">${esc(al.title)}</div>
      <div class="album-card-artist">${esc(al.artist_name)}</div>
      ${al.year ? `<div class="album-card-year">${al.year}</div>` : ''}
    </div>`;
  }).join('');
}

// ═══ RENDER TRACK LIST ═══
function renderTrackList(containerId, tracks, showAlbum) {
  const c = document.getElementById(containerId);
  if (!tracks.length) {
    c.innerHTML = `<div class="empty-state"><h3>Şarkı bulunamadı</h3></div>`;
    return;
  }
  currentLists[containerId] = tracks.map(t => ({ id: t.id, source: 'local' }));
  const header = `<div class="track-list-header"><span>#</span><span>Başlık</span><span>Sanatçı</span>${showAlbum?'<span>Albüm</span>':'<span></span>'}<span style="text-align:right">Süre</span></div>`;
  c.innerHTML = header + tracks.map((t, i) => {
    const isPlaying = currentTrackId === t.id;
    const num = t.track_number || i + 1;
    return `
    <div class="track-row ${isPlaying ? 'playing' : ''}" onclick="playFromListContext('${containerId}', ${i})" data-track-id="${t.id}">
      <span class="track-num">
        ${isPlaying
          ? equalizerHTML()
          : `<span class="track-num-text">${num}</span><span class="track-play-icon"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M8 5v14l11-7z"/></svg></span>`
        }
      </span>
      <span class="track-name">${esc(t.title)}</span>
      <span class="track-artist-col">${esc(t.artist_name||'')}</span>
      ${showAlbum ? `<span class="track-album-col">${esc(t.album_title||'')}</span>` : '<span></span>'}
      <span class="track-duration">${formatTime(t.duration)}</span>
    </div>`;
  }).join('');
}

// ═══ RENDER SPOTIFY TRACK LIST ═══
function renderSpotifyTrackList(containerId, tracks) {
  const c = document.getElementById(containerId);
  if (!tracks.length) {
    c.innerHTML = `<div class="empty-state"><h3>Şarkı bulunamadı</h3></div>`;
    return;
  }
  tracks.forEach(t => cacheSpotifyMeta(t.id, t.title, t.artist_name, t.coverUrl, t.album_title, t.duration, null, t.albumId, t.artistId));
  currentLists[containerId] = tracks.map(t => ({ id: t.id, source: 'spotify' }));

  const header = `<div class="track-list-header"><span>#</span><span>Başlık</span><span>Sanatçı</span><span>Albüm</span><span style="text-align:right">Süre</span></div>`;
  c.innerHTML = header + tracks.map((t, i) => {
    const isPlaying = String(currentTrackId) === String(t.id);
    const artistClick = t.artistId ? `onclick="event.stopPropagation();loadSpotifyArtistView('${t.artistId}')"` : '';
    const albumClick = t.albumId ? `onclick="event.stopPropagation();loadSpotifyAlbumView('${t.albumId}')"` : '';
    return `
    <div class="track-row ${isPlaying ? 'playing' : ''}" onclick="playFromListContext('${containerId}', ${i})" data-track-id="${t.id}">
      <span class="track-num">
        ${isPlaying
          ? equalizerHTML()
          : `<span class="track-num-text">${i + 1}</span><span class="track-play-icon"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M8 5v14l11-7z"/></svg></span>`
        }
      </span>
      <span class="track-name"><img src="${t.coverUrl}" class="track-thumb-mini" onerror="this.style.display='none'">${esc(t.title)}</span>
      <span class="track-artist-col ${t.artistId ? 'clickable' : ''}" ${artistClick}>${esc(t.artist_name||'')}</span>
      <span class="track-album-col ${t.albumId ? 'clickable' : ''}" ${albumClick}>${esc(t.album_title||'')}</span>
      <span class="track-duration">${formatTime(t.duration)}</span>
    </div>`;
  }).join('');
}

// ═══ ARTISTS ═══
async function loadArtists() {
  const artists = await api('/api/artists');
  const c = document.getElementById('artist-grid');
  c.innerHTML = artists.map(a => `
    <div class="artist-card" onclick="navigateTo('artist-detail',${a.id})">
      <div class="artist-avatar">
        ${a.has_image ? `<img src="${artistImgUrl(a.id)}" alt="${esc(a.name)}" loading="lazy">` : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>`}
      </div>
      <div class="artist-card-name">${esc(a.name)}</div>
      <div class="artist-card-meta">${a.album_count} albüm · ${a.track_count} şarkı</div>
    </div>
  `).join('');
}

// ═══ ALBUMS ═══
async function loadAlbums() {
  const albums = await api('/api/albums');
  renderAlbumGrid('album-grid', albums);
}

// ═══ ALL TRACKS ═══
async function loadAllTracks() {
  const tracks = await api('/api/tracks');
  allTracksCache = tracks;
  renderTrackList('all-tracks', tracks, true);
}

// ═══ ARTIST DETAIL ═══
async function loadArtistDetail(id) {
  const data = await api(`/api/artists/${id}`);
  const hero = document.getElementById('artist-hero');
  hero.innerHTML = `
    <div class="detail-cover" style="border-radius:50%">
      ${data.has_image ? `<img src="${artistImgUrl(id)}">` : `<div class="placeholder-cover">${placeholderSVG()}</div>`}
    </div>
    <div class="detail-info">
      <div class="detail-type">Sanatçı</div>
      <div class="detail-title">${esc(data.name)}</div>
      <div class="detail-meta">
        <span>${data.albums.length} albüm</span>
      </div>
    </div>
  `;
  const content = document.getElementById('artist-content');
  content.innerHTML = '<div class="album-grid" id="artist-albums"></div>';
  renderAlbumGrid('artist-albums', data.albums);
}

// ═══ ALBUM DETAIL ═══
async function loadAlbumDetail(id) {
  const data = await api(`/api/albums/${id}`);
  const hero = document.getElementById('album-hero');
  const totalDur = data.tracks.reduce((s,t)=>s+(t.duration||0),0);
  const qualityInfo = data.tracks[0] ? buildQualityStr(data.tracks[0]) : '';

  hero.innerHTML = `
    <div class="detail-gradient" id="detail-gradient"></div>
    <div class="detail-cover">
      ${data.has_cover ? `<img src="${coverUrl(id)}" id="detail-cover-img">` : `<div class="placeholder-cover">${placeholderSVG()}</div>`}
    </div>
    <div class="detail-info">
      <div class="detail-type">Albüm</div>
      <div class="detail-title">${esc(data.title)}</div>
      <div class="detail-meta">
        <span class="detail-artist-link" onclick="navigateTo('artist-detail',${data.artist_id})">${esc(data.artist_name)}</span>
        ${data.year ? `<span class="detail-dot"></span><span>${data.year}</span>` : ''}
        <span class="detail-dot"></span><span>${data.tracks.length} şarkı, ${formatDuration(totalDur)}</span>
        ${qualityInfo ? `<span class="detail-dot"></span><span>${qualityInfo}</span>` : ''}
      </div>
      <div class="detail-actions">
        <button class="btn-play-all" onclick="playAlbum(${id})">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          Çal
        </button>
        <button class="btn-shuffle" onclick="shuffleAlbum(${id})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>
          Karıştır
        </button>
      </div>
    </div>
  `;

  // Extract dominant color from cover for gradient
  if (data.has_cover) {
    extractCoverColor(coverUrl(id));
  }

  const content = document.getElementById('album-content');
  content.innerHTML = '<div class="track-list" id="album-tracks"></div>';
  renderTrackList('album-tracks', data.tracks, false);
}

// ═══ COLOR EXTRACTION ═══
function extractCoverColor(src) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 8, 8);
    const data = ctx.getImageData(0, 0, 8, 8).data;

    // Sample center-ish pixels for dominant color
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Skip very dark and very bright pixels
      const brightness = data[i] + data[i+1] + data[i+2];
      if (brightness > 60 && brightness < 700) {
        r += data[i]; g += data[i+1]; b += data[i+2]; count++;
      }
    }
    if (count > 0) {
      r = Math.round(r/count); g = Math.round(g/count); b = Math.round(b/count);
    }

    const gradient = document.getElementById('detail-gradient');
    if (gradient) {
      gradient.style.setProperty('--detail-color', `rgb(${r},${g},${b})`);
      gradient.style.background = `rgb(${r},${g},${b})`;
    }
  };
  img.src = src;
}

function buildQualityStr(t) {
  const parts = [];
  if (t.format) parts.push(t.format);
  if (t.bit_depth && t.sample_rate) parts.push(`${t.bit_depth}bit/${(t.sample_rate/1000).toFixed(1)}kHz`);
  else if (t.bitrate) parts.push(`${t.bitrate}kbps`);
  return parts.join(' · ');
}

// ═══ PLAYBACK ═══
async function playTrack(id) {
  isSpotifySdkActive = false;
  // When playing a local track, clear Spotify state
  if (spotifyPlayer && currentSpotifyTrackId) {
    spotifyPlayer.pause().catch(() => {});
    currentSpotifyTrackId = null;
  }

  const track = await api(`/api/tracks/${id}`);
  currentTrackId = track.id;
  audio.src = `/api/tracks/${id}/stream`;
  audio.play();

  // Use cover from local library
  const cover = track.album_id ? coverUrl(track.album_id) : null;
  const qualityStr = buildQualityStr(track);
  updatePlayerUI(track.title, track.artist_name || '', cover, qualityStr);

  document.getElementById('player-artist').onclick = () => {
    if (track.artist_id) navigateTo('artist-detail', track.artist_id);
  };

  updatePlayingState();
  updateMediaSession(track);
  checkLikedStatus(track.id);
}

// ═══ SPOTIFY TRACK METADATA CACHE ═══
const spotifyMetaCache = {};
let playVersion = 0; // Race condition prevention

function cacheSpotifyMeta(id, title, artist, cover, album, duration, isrc, albumId, artistId) {
  spotifyMetaCache[id] = { id, title, artist, cover, album, duration, isrc, albumId: albumId || spotifyMetaCache[id]?.albumId, artistId: artistId || spotifyMetaCache[id]?.artistId };
}

async function playSpotifyTrack(trackId, fromSdk = false) {
  if (!fromSdk) {
    isSpotifySdkActive = false;
    if (spotifyPlayer) {
      spotifyPlayer.pause().catch(() => {});
    }
  }

  // ─── Race condition: cancel any previous pending play ───
  const myVersion = ++playVersion;

  // Abort previous audio load immediately
  audio.pause();
  audio.removeAttribute('src');
  audio.load(); // Force browser to release the old connection

  // 1. Show metadata from cache INSTANTLY (no wait)
  let meta = spotifyMetaCache[trackId];

  if (meta) {
    updatePlayerUI(meta.title, meta.artist, meta.cover, 'Yükleniyor...');
  } else {
    updatePlayerUI('Yükleniyor...', 'Kayıpsız kalite hazırlanıyor', null, '⏳');
  }

  try {
    // 2. If we don't have metadata yet, fetch it from Spotify API
    if (!meta) {
      const fetched = await fetch(`/api/spotify/track/${trackId}`).then(r => r.json()).catch(() => null);
      if (myVersion !== playVersion) return; // Stale — user switched track
      if (fetched && fetched.title) {
        meta = {
          title: fetched.title,
          artist: fetched.artist,
          cover: fetched.cover,
          album: fetched.album,
          duration: fetched.duration,
          isrc: fetched.isrc
        };
        cacheSpotifyMeta(trackId, meta.title, meta.artist, meta.cover, meta.album, meta.duration, meta.isrc);
        updatePlayerUI(meta.title, meta.artist, meta.cover, 'Yükleniyor...');
      }
    }

    // 3. Build stream URL with metadata query params (for yt-dlp fallback & ISRC for Deezer)
    const params = new URLSearchParams();
    if (meta?.title) params.set('title', meta.title);
    if (meta?.artist) params.set('artist', meta.artist);
    if (meta?.isrc) params.set('isrc', meta.isrc);
    const streamUrl = `/api/telegram/stream/${trackId}?${params.toString()}`;

    // 4. Start stream — wait for canplay event
    if (myVersion !== playVersion) return; // Stale check

    audio.src = streamUrl;

    const playResult = await new Promise((resolve, reject) => {
      const onCanPlay = () => {
        cleanup();
        // Detect source from response headers
        resolve('ready');
      };
      const onError = () => {
        cleanup();
        reject(new Error('Ses dosyası yüklenemedi'));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Zaman aşımı (30s)'));
      }, 35000);

      function cleanup() {
        audio.removeEventListener('canplay', onCanPlay);
        audio.removeEventListener('error', onError);
        clearTimeout(timeout);
      }

      audio.addEventListener('canplay', onCanPlay);
      audio.addEventListener('error', onError);
    });

    // 5. Final stale check before playing
    if (myVersion !== playVersion) return;

    await audio.play();

    // 6. Detect audio source from cached info (no extra download)
    let qualityBadge = 'LOSSLESS';
    try {
      const checkRes = await fetch(`/api/telegram/check/${trackId}?${params.toString()}`);
      const checkData = await checkRes.json();
      if (checkData.source === 'youtube') {
        qualityBadge = 'STANDARD';
      } else if (checkData.quality === 'FLAC') {
        qualityBadge = 'LOSSLESS';
      } else if (checkData.quality === 'MP3_320') {
        qualityBadge = 'HIGH QUALITY';
      } else if (checkData.source === 'deezer') {
        qualityBadge = 'LOSSLESS';
      }
    } catch (e) { /* use default badge */ }

    // 7. Update UI with final state
    if (myVersion !== playVersion) return;

    if (meta) {
      updatePlayerUI(meta.title, meta.artist, meta.cover, qualityBadge);
    } else {
      // Minimal fallback
      const qb = document.getElementById('player-quality');
      qb.textContent = qualityBadge;
      qb.style.display = '';
    }

    // 8. Update state
    currentTrackId = trackId;
    currentSpotifyTrackId = trackId;
    const sourceType = qualityBadge.includes('FLAC') ? 'deezer-flac' : 'youtube';
    
    // Update the queue item if it exists, otherwise if we are from Spotify SDK (phone app control), we can just set it as a single item
    if (queue[queueIndex] && queue[queueIndex].id === trackId) {
        queue[queueIndex].source = sourceType;
    } else if (fromSdk) {
        queue = [{ id: trackId, source: sourceType, title: meta?.title || '', artist: meta?.artist || '' }];
        queueIndex = 0;
    }
    
    updatePlayingState();
    checkLikedStatus(trackId);

    // Set player-artist click handler for Spotify tracks
    if (meta) {
      document.getElementById('player-artist').onclick = () => {
        if (meta.artistId) {
          loadSpotifyArtistView(meta.artistId);
        } else if (meta.artist) {
          searchForArtist(meta.artist);
        }
      };
    }

    // 9. MediaSession (OS lock screen)
    if (meta) {
      updateMediaSession({
        title: meta.title,
        artist_name: meta.artist,
        album_title: meta.album || '',
        spotifyCover: meta.cover
      });
    }

  } catch (err) {
    if (myVersion !== playVersion) return; // Another track took over — no error
    console.error('Stream hatası:', err.message);
    updatePlayerUI(meta?.title || 'Hata', 'Bağlantı başarısız — tekrar dene', meta?.cover || null, '❌');
  }
}

// Helper: Update the player bar UI in one place
function updatePlayerUI(title, artist, coverUrl, qualityText) {
  document.getElementById('player-title').textContent = title;
  document.getElementById('player-artist').textContent = artist;

  const coverEl = document.getElementById('player-cover');
  if (coverUrl) {
    coverEl.innerHTML = `<img src="${coverUrl}" alt="">`;
  } else if (!coverEl.querySelector('img')) {
    coverEl.innerHTML = placeholderSVG();
  }

  const qb = document.getElementById('player-quality');
  if (qualityText) {
    qb.textContent = qualityText;
    qb.style.display = '';
    // Apply CSS class based on source
    qb.className = 'player-quality-badge';
    if (qualityText.includes('LOSSLESS')) {
      qb.classList.add('deezer-flac');
    } else if (qualityText.includes('HIGH QUALITY')) {
      qb.classList.add('deezer-320');
    } else if (qualityText.includes('STANDARD')) {
      qb.classList.add('youtube');
    } else if (qualityText.includes('Yükleniyor') || qualityText.includes('⏳')) {
      qb.classList.add('loading');
    } else if (qualityText.includes('HI-FI')) {
      qb.classList.add('deezer-flac');
    }
  } else {
    qb.style.display = 'none';
  }
}

async function playAlbum(albumId) {
  const data = await api(`/api/albums/${albumId}`);
  if (data.tracks && data.tracks.length) {
    if (spotifyPlayer && isSpotifySdkActive) spotifyPlayer.pause().catch(()=>{});
    queue = data.tracks.map(t => ({ id: t.id, source: 'local' }));
    queueIndex = 0;
    playTrack(queue[0].id);
    renderQueue();
  }
}

async function shuffleAlbum(albumId) {
  const data = await api(`/api/albums/${albumId}`);
  if (data.tracks && data.tracks.length) {
    if (spotifyPlayer && isSpotifySdkActive) spotifyPlayer.pause().catch(()=>{});
    queue = data.tracks.map(t => ({ id: t.id, source: 'local' }));
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    queueIndex = 0;
    playTrack(queue[0].id);
    renderQueue();
  }
}

function playFromListContext(listId, index) {
  if (spotifyPlayer && currentSpotifyTrackId && isSpotifySdkActive) {
    spotifyPlayer.pause().catch(()=>{});
  }
  queue = [...currentLists[listId]];
  queueIndex = index;
  const item = queue[queueIndex];
  if (item.source === 'local') playTrack(item.id);
  else playSpotifyTrack(item.id, false);
  renderQueue();
}

function playFromList(trackIds, index) {
  if (spotifyPlayer && currentSpotifyTrackId && isSpotifySdkActive) {
    spotifyPlayer.pause().catch(()=>{});
  }
  queue = trackIds.map(id => ({ id, source: 'local' }));
  queueIndex = index;
  playTrack(queue[index].id);
  renderQueue();
}

function playNext() {
  if (isSpotifySdkActive && spotifyPlayer) {
    spotifyPlayer.nextTrack();
  } else {
    if (isShuffle && queue.length > 1) {
      let nextIndex;
      do {
        nextIndex = Math.floor(Math.random() * queue.length);
      } while (nextIndex === queueIndex && queue.length > 1);
      queueIndex = nextIndex;
      const item = queue[queueIndex];
      if (item.source === 'local') playTrack(item.id);
      else playSpotifyTrack(item.id, false);
      renderQueue();
    } else if (queueIndex < queue.length - 1) {
      queueIndex++;
      const item = queue[queueIndex];
      if (item.source === 'local') playTrack(item.id);
      else playSpotifyTrack(item.id, false);
      renderQueue();
    } else if (isRepeat && queue.length > 0) {
      queueIndex = 0;
      const item = queue[queueIndex];
      if (item.source === 'local') playTrack(item.id);
      else playSpotifyTrack(item.id, false);
      renderQueue();
    }
  }
}

function playPrev() {
  if (isSpotifySdkActive && spotifyPlayer) {
    spotifyPlayer.previousTrack();
  } else {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
    } else if (queueIndex > 0) {
      queueIndex--;
      const item = queue[queueIndex];
      if (item.source === 'local') playTrack(item.id);
      else playSpotifyTrack(item.id, false);
      renderQueue();
    } else if (isRepeat && queue.length > 0) {
      queueIndex = queue.length - 1;
      const item = queue[queueIndex];
      if (item.source === 'local') playTrack(item.id);
      else playSpotifyTrack(item.id, false);
      renderQueue();
    }
  }
}

function togglePlay() {
  if (isSpotifySdkActive && spotifyPlayer) {
    spotifyPlayer.togglePlay();
  } else {
    if (!audio.src) return;
    if (audio.paused) audio.play();
    else audio.pause();
  }
}

function updatePlayingState() {
  document.querySelectorAll('.track-row').forEach(r => {
    const isPlaying = String(r.dataset.trackId) === String(currentTrackId);
    r.classList.toggle('playing', isPlaying);
    const numEl = r.querySelector('.track-num');
    if (numEl) {
      if (isPlaying) {
        numEl.innerHTML = equalizerHTML();
      } else {
        const num = numEl.textContent.trim() || '';
        if (!numEl.querySelector('.track-num-text')) {
          // Restore number display
          const existing = r.querySelector('.track-num-text');
          if (!existing) {
            const trackIndex = Array.from(r.parentElement.querySelectorAll('.track-row')).indexOf(r);
            numEl.innerHTML = `<span class="track-num-text">${trackIndex + 1}</span><span class="track-play-icon"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M8 5v14l11-7z"/></svg></span>`;
          }
        }
      }
    }
  });
}

// ═══ AUDIO EVENTS ═══
audio.addEventListener('play', () => {
  document.querySelector('.icon-play').classList.add('hidden');
  document.querySelector('.icon-pause').classList.remove('hidden');
});

audio.addEventListener('pause', () => {
  document.querySelector('.icon-play').classList.remove('hidden');
  document.querySelector('.icon-pause').classList.add('hidden');
});

audio.addEventListener('timeupdate', () => {
  if (audio.duration) {
    const pct = (audio.currentTime / audio.duration) * 100;
    document.getElementById('progress-fill').style.width = pct + '%';
    const handle = document.getElementById('progress-handle');
    if (handle) handle.style.left = pct + '%';
    document.getElementById('time-current').textContent = formatTime(audio.currentTime);
    document.getElementById('time-total').textContent = formatTime(audio.duration);
  }
});

audio.addEventListener('ended', playNext);

// ═══ PLAYER CONTROLS ═══
document.getElementById('btn-play').addEventListener('click', togglePlay);
document.getElementById('btn-next').addEventListener('click', playNext);
document.getElementById('btn-prev').addEventListener('click', playPrev);
document.getElementById('btn-shuffle-toggle').addEventListener('click', () => {
  isShuffle = !isShuffle;
  document.getElementById('btn-shuffle-toggle').classList.toggle('active', isShuffle);
});
document.getElementById('btn-repeat-toggle').addEventListener('click', () => {
  isRepeat = !isRepeat;
  document.getElementById('btn-repeat-toggle').classList.toggle('active', isRepeat);
});

// Progress seek with drag
const progressBar = document.getElementById('progress-bar');
let isDragging = false;

progressBar.addEventListener('mousedown', e => { isDragging = true; seekTo(e); });
document.addEventListener('mousemove', e => { if (isDragging) seekTo(e); });
document.addEventListener('mouseup', () => { isDragging = false; });

function seekTo(e) {
  if (!audio.duration) return;
  const rect = progressBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.currentTime = pct * audio.duration;
}

// Volume with drag
const volumeBar = document.getElementById('volume-bar');
let isDraggingVol = false;

volumeBar.addEventListener('mousedown', e => { isDraggingVol = true; setVol(e); });
document.addEventListener('mousemove', e => { if (isDraggingVol) setVol(e); });
document.addEventListener('mouseup', () => { isDraggingVol = false; });

function setVol(e) {
  const rect = volumeBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.volume = pct;
  document.getElementById('volume-fill').style.width = (pct * 100) + '%';
}

audio.volume = 0.8;

// Mute toggle
document.getElementById('btn-volume').addEventListener('click', () => {
  audio.muted = !audio.muted;
  document.getElementById('volume-fill').style.width = audio.muted ? '0%' : (audio.volume * 100) + '%';
});

// ═══ QUEUE ═══
document.getElementById('btn-queue').addEventListener('click', () => {
  document.getElementById('queue-panel').classList.toggle('hidden');
});
document.getElementById('queue-close').addEventListener('click', () => {
  document.getElementById('queue-panel').classList.add('hidden');
});

async function renderQueue() {
  const list = document.getElementById('queue-list');
  if (!queue.length) {
    list.innerHTML = '<div class="empty-state"><p>Sıra boş</p></div>';
    return;
  }
  
  window.playQueueItem = function(i) {
    queueIndex = i;
    const item = queue[queueIndex];
    if (item.source === 'local') playTrack(item.id);
    else playSpotifyTrack(item.id, false);
    renderQueue();
  };

  const trackPromises = queue.map(async item => {
    if (item.source === 'local') {
      try {
        return await api(`/api/tracks/${item.id}`);
      } catch (e) {
        return { title: 'Bilinmiyor', artist_name: '', format: '' };
      }
    } else {
      return {
        title: item.title || 'Online Şarkı',
        artist_name: item.artist || '',
        format: (item.source && item.source.includes('flac')) ? 'FLAC' : 'STREAM'
      };
    }
  });

  const tracks = await Promise.all(trackPromises);
  list.innerHTML = tracks.map((t, i) => {
    const item = queue[i];
    const onclick = `playQueueItem(${i})`;
    const isLossless = (t.format === 'FLAC' || t.format === 'ALAC' || t.format === 'WAV');
    const badgeHtml = (t.format) 
      ? `<span class="hifi-badge">${isLossless ? 'LOSSLESS' : t.format}</span>`
      : '';
    return `
    <div class="queue-item ${i === queueIndex ? 'active' : ''}" onclick="${onclick}">
      <span class="queue-item-num">${i === queueIndex ? equalizerHTML() : (i + 1)}</span>
      <div class="queue-item-info">
        <div class="queue-item-title">${esc(t.title)}${badgeHtml}</div>
        <div class="queue-item-artist">${esc(t.artist_name || t.artist || '')}</div>
      </div>
    </div>`;
  }).join('');
}

// ═══ SEARCH ═══
let searchTimeout;

document.getElementById('search-input').addEventListener('input', e => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => doSearch(e.target.value), 300);
});
document.getElementById('header-search-input').addEventListener('input', e => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    navigateTo('search');
    const searchInput = document.getElementById('search-input');
    searchInput.value = e.target.value;
    doSearch(e.target.value);
  }, 300);
});

// ═══ NAVIGATION ARROWS ═══
document.getElementById('nav-back').addEventListener('click', () => window.history.back());
document.getElementById('nav-forward').addEventListener('click', () => window.history.forward());

async function doSearch(q) {
  const container = document.getElementById('search-results');
  if (!q.trim()) { container.innerHTML = ''; return; }

  // Show loading
  container.innerHTML = '<div class="search-loading"><div class="loading-spinner"></div><span>Aranıyor...</span></div>';

  // Search both local and online in parallel
  const [localResults, onlineResults] = await Promise.all([
    api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => []),
    api(`/api/spotify/search?q=${encodeURIComponent(q)}&limit=20`).catch(() => [])
  ]);

  onlineResultsCache = onlineResults;
  let html = '';

  // === TOP RESULT (best local match or first online) ===
  const localTracks = localResults.filter(r => r.type === 'track');
  const localArtists = localResults.filter(r => r.type === 'artist');
  const localAlbums = localResults.filter(r => r.type === 'album');

  // === ARTISTS ===
  const allArtists = [...localArtists, ...(onlineResults.artists || [])];
  if (allArtists.length) {
    html += `<div class="search-category"><h3 class="section-title">Sanatçılar</h3><div class="artist-grid">`;
    html += allArtists.map(a => {
      const isOnline = a.source === 'spotify';
      const img = isOnline ? (a.image ? `<img src="${a.image}" alt="${esc(a.name)}" loading="lazy">` : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>`) : 
                  (a.has_image ? `<img src="${artistImgUrl(a.id)}" alt="${esc(a.name)}" loading="lazy">` : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>`);
      const clickAction = isOnline ? `loadSpotifyArtistView('${a.id}')` : `navigateTo('artist-detail',${a.id})`;
      return `
      <div class="artist-card" onclick="${clickAction}">
        <div class="artist-avatar">${img}</div>
        <div class="artist-card-name">${esc(a.name)}</div>
      </div>`;
    }).join('');
    html += '</div></div>';
  }

  // === ALBUMS ===
  const allAlbums = [...localAlbums, ...(onlineResults.albums || [])];
  if (allAlbums.length) {
    html += `<div class="search-category"><h3 class="section-title">Albümler</h3><div class="album-grid">`;
    html += allAlbums.map(al => {
      const isOnline = al.source === 'spotify';
      const img = isOnline ? (al.coverUrl ? `<img src="${al.coverUrl}" alt="${esc(al.title)}" loading="lazy">` : `<div class="placeholder-cover">${placeholderSVG()}</div>`) :
                  (al.has_cover ? `<img src="${coverUrl(al.id)}" alt="${esc(al.name)}" loading="lazy">` : `<div class="placeholder-cover">${placeholderSVG()}</div>`);
      const title = isOnline ? al.title : al.name;
      const artist = isOnline ? al.artist : (al.artist_name || '');
      const clickAction = isOnline ? `loadSpotifyAlbumView('${al.id}')` : `navigateTo('album-detail',${al.id})`;
      const playAction = isOnline ? `playSpotifyAlbumTracks('${al.id}')` : `playAlbum(${al.id})`;
      return `
      <div class="album-card" onclick="${clickAction}">
        <div class="album-cover-wrap">
          ${img}
          <button class="album-play-btn" onclick="event.stopPropagation();${playAction}"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
        </div>
        <div class="album-card-title">${esc(title)}</div>
        <div class="album-card-artist">${esc(artist)}</div>
      </div>`;
    }).join('');
    html += '</div></div>';
  }

  // === SONGS ===
  html += `<div class="search-category"><h3 class="section-title">Şarkılar</h3>`;
  
  const unifiedTracks = [];
  for (const t of localTracks) {
    unifiedTracks.push({
      title: t.name || t.title,
      artist: t.artist_name || '',
      artistId: t.artist_id,
      albumTitle: t.album_title || '',
      albumId: t.album_id,
      duration: t.duration,
      source: 'local',
      localId: t.id,
      format: t.format
    });
  }

  const onlineTracks = onlineResults.tracks || [];
  for (const t of onlineTracks) {
    const isDuplicate = localTracks.some(lt => (lt.name || lt.title || '').toLowerCase() === (t.title || '').toLowerCase());
    if (!isDuplicate) {
      unifiedTracks.push({
        title: t.title,
        artist: t.artist || '',
        duration: t.duration,
        source: 'spotify',
        spotifyId: t.id,
        thumb: t.cover,
        albumTitle: t.album,
        artistId: t.artistId,
        albumId: t.albumId
      });
    }
  }

  if (unifiedTracks.length) {
    currentLists['search'] = unifiedTracks.map(t => ({
      id: t.source === 'local' ? t.localId : t.spotifyId,
      source: t.source
    }));
    
    html += `<div class="track-list-header"><span>#</span><span>Başlık</span><span>Sanatçı</span><span>Albüm</span><span style="text-align:right">Süre</span></div>`;
    html += unifiedTracks.map((t, i) => {
      if (t.source === 'local') {
        const isLossless = (t.format === 'FLAC' || t.format === 'ALAC' || t.format === 'WAV');
        const badge = isLossless ? 'LOSSLESS' : t.format;
        const artistClick = t.artistId ? `onclick="event.stopPropagation();navigateTo('artist-detail',${t.artistId})"` : '';
        const albumClick = t.albumId ? `onclick="event.stopPropagation();navigateTo('album-detail',${t.albumId})"` : '';
        return `
        <div class="track-row" onclick="playFromListContext('search', ${i})">
          <span class="track-num">${i + 1}</span>
          <span class="track-name">
            <div class="online-thumb" style="width:40px;height:40px;margin-right:12px;">
              ${t.albumId ? `<img src="${coverUrl(t.albumId)}" alt="" loading="lazy">` : `<span class="hifi-icon">♪</span>`}
            </div>
            <div class="track-meta-mini">
              <div class="track-title-text">${esc(t.title)} <span class="hifi-badge">${esc(badge)}</span></div>
              <div class="track-artist-sub">${esc(t.artist)}</div>
            </div>
          </span>
          <span class="track-artist-col ${t.artistId ? 'clickable' : ''}" ${artistClick}>${esc(t.artist)}</span>
          <span class="track-album-col ${t.albumId ? 'clickable' : ''}" ${albumClick}>${esc(t.albumTitle || '')}</span>
          <span class="track-duration">${formatTime(t.duration)}</span>
        </div>`;
      } else {
        cacheSpotifyMeta(t.spotifyId, t.title, t.artist, t.thumb, t.albumTitle, t.duration, null, t.albumId, t.artistId);
        const artistClick = t.artistId ? `onclick="event.stopPropagation();loadSpotifyArtistView('${t.artistId}')"` : '';
        const albumClick = t.albumId ? `onclick="event.stopPropagation();loadSpotifyAlbumView('${t.albumId}')"` : '';
        return `
        <div class="track-row online-track" onclick="playFromListContext('search', ${i})">
          <span class="track-num">${i + 1}</span>
          <span class="track-name">
            <div class="online-thumb" style="width:40px;height:40px;margin-right:12px;">
               ${t.thumb ? `<img src="${t.thumb}" alt="" loading="lazy">` : `<span class="hifi-icon">♪</span>`}
            </div>
            <div class="track-meta-mini">
              <div class="track-title-text">${esc(t.title)}</div>
              <div class="track-artist-sub">${esc(t.artist)}</div>
            </div>
          </span>
          <span class="track-artist-col ${t.artistId ? 'clickable' : ''}" ${artistClick}>${esc(t.artist)}</span>
          <span class="track-album-col ${t.albumId ? 'clickable' : ''}" ${albumClick}>${esc(t.albumTitle || '')}</span>
          <span class="track-duration">${formatTime(t.duration)}</span>
        </div>`;
      }
    }).join('');
  } else {
    html += '<div class="empty-state"><h3>Sonuç bulunamadı</h3></div>';
  }
  html += '</div>';

  container.innerHTML = html;
}

// ═══ SCAN ═══
document.getElementById('btn-scan').addEventListener('click', async () => {
  const btn = document.getElementById('btn-scan');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Taranıyor...';
  document.getElementById('scan-progress').classList.remove('hidden');

  await fetch('/api/scan', { method: 'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
  pollScanProgress();
});

async function pollScanProgress() {
  const prog = await api('/api/scan/progress');
  const fill = document.querySelector('.scan-progress-fill');
  const text = document.querySelector('.scan-progress-text');

  if (prog.total > 0) {
    fill.style.width = ((prog.processed / prog.total) * 100) + '%';
    text.textContent = `${prog.processed}/${prog.total} — ${prog.currentFile}`;
  }

  if (prog.status === 'complete' || prog.status === 'idle' || prog.status === 'error') {
    document.getElementById('btn-scan').disabled = false;
    document.getElementById('btn-scan').querySelector('span').textContent = 'Kütüphaneyi Tara';
    setTimeout(() => document.getElementById('scan-progress').classList.add('hidden'), 2000);
    loadHome();
    const stats = await api('/api/stats');
    updateStats(stats);
  } else {
    setTimeout(pollScanProgress, 500);
  }
}

// ═══ MEDIA SESSION ═══
function updateMediaSession(track) {
  if ('mediaSession' in navigator) {
    // Support both local tracks (album_id) and Spotify tracks (spotifyCover URL)
    let artwork = [];
    if (track.spotifyCover) {
      artwork = [{ src: track.spotifyCover, sizes: '512x512', type: 'image/jpeg' }];
    } else if (track.album_id) {
      artwork = [{ src: coverUrl(track.album_id), sizes: '512x512', type: 'image/jpeg' }];
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist_name || '',
      album: track.album_title || '',
      artwork: artwork
    });
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
    navigator.mediaSession.setActionHandler('nexttrack', playNext);
  }
}

// ═══ KEYBOARD ═══
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'ArrowRight' && e.ctrlKey) playNext();
  if (e.code === 'ArrowLeft' && e.ctrlKey) playPrev();
});

// ═══ LIKE BUTTON ═══
document.getElementById('btn-like').addEventListener('click', toggleLike);

async function checkLikedStatus(trackId) {
  if (!trackId) return;
  try {
    const res = await fetch(`/api/spotify/check-liked?ids=${trackId}`);
    const data = await res.json();
    isCurrentTrackLiked = Array.isArray(data) && data[0] === true;
  } catch (e) { isCurrentTrackLiked = false; }
  updateLikeButton();
}

function updateLikeButton() {
  const btn = document.getElementById('btn-like');
  if (!btn) return;
  btn.classList.toggle('liked', isCurrentTrackLiked);
}

async function toggleLike() {
  if (!currentTrackId) return;
  const btn = document.getElementById('btn-like');
  try {
    if (isCurrentTrackLiked) {
      await fetch(`/api/spotify/unlike/${currentTrackId}`, { method: 'DELETE' });
      isCurrentTrackLiked = false;
    } else {
      await fetch(`/api/spotify/like/${currentTrackId}`, { method: 'PUT' });
      isCurrentTrackLiked = true;
      btn.classList.add('pop');
      setTimeout(() => btn.classList.remove('pop'), 400);
    }
    updateLikeButton();
  } catch (e) { console.error('Like toggle failed:', e); }
}

// ═══ SPOTIFY ALBUM VIEW ═══
async function loadSpotifyAlbumView(albumId) {
  // Switch to album-detail view
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-album-detail').classList.add('active');
  document.getElementById('main-content').scrollTo(0, 0);

  const hero = document.getElementById('album-hero');
  const content = document.getElementById('album-content');
  hero.innerHTML = '<div class="loading-spinner" style="margin:40px auto"></div>';
  content.innerHTML = '';

  try {
    const data = await api(`/api/spotify/album/${albumId}`);
    const totalDur = data.tracks.reduce((s,t) => s + (t.duration||0), 0);

    hero.innerHTML = `
      <div class="detail-gradient" id="detail-gradient"></div>
      <div class="detail-cover">
        ${data.cover ? `<img src="${data.cover}" id="detail-cover-img">` : `<div class="placeholder-cover">${placeholderSVG()}</div>`}
      </div>
      <div class="detail-info">
        <div class="detail-type">Albüm</div>
        <div class="detail-title">${esc(data.title)}</div>
        <div class="detail-meta">
          <span class="detail-artist-link" onclick="loadSpotifyArtistView('${data.artistId}')">${esc(data.artist)}</span>
          ${data.year ? `<span class="detail-dot"></span><span>${data.year}</span>` : ''}
          <span class="detail-dot"></span><span>${data.tracks.length} şarkı, ${formatDuration(totalDur)}</span>
        </div>
        <div class="detail-actions">
          <button class="btn-play-all" onclick="playSpotifyAlbumTracks('${albumId}')">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Çal
          </button>
        </div>
      </div>`;

    // Color extraction from Spotify cover
    if (data.cover) extractCoverColor(data.cover);

    // Cache and render tracks
    const tracks = data.tracks.map(t => ({
      id: t.id, title: t.title, artist_name: t.artist,
      album_title: data.title, albumId: data.id, artistId: t.artistId,
      duration: t.duration, source: 'spotify', coverUrl: data.cover
    }));
    content.innerHTML = '<div class="track-list" id="spotify-album-tracks"></div>';
    renderSpotifyTrackList('spotify-album-tracks', tracks);
  } catch (err) {
    console.error('Spotify album load error:', err);
    hero.innerHTML = '<div class="empty-state"><h3>Albüm yüklenemedi</h3></div>';
  }
}

// ═══ SPOTIFY ARTIST VIEW ═══
async function loadSpotifyArtistView(artistId) {
  // Switch to artist-detail view
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-artist-detail').classList.add('active');
  document.getElementById('main-content').scrollTo(0, 0);

  const hero = document.getElementById('artist-hero');
  const content = document.getElementById('artist-content');
  hero.innerHTML = '<div class="loading-spinner" style="margin:40px auto"></div>';
  content.innerHTML = '';

  try {
    const data = await api(`/api/spotify/artist/${artistId}`);
    
    hero.innerHTML = `
      <div class="detail-gradient" id="detail-gradient-artist"></div>
      <div class="detail-cover" style="border-radius: 50%;">
        ${data.image ? `<img src="${data.image}" id="detail-cover-img" style="border-radius: 50%;">` : `<div class="placeholder-cover" style="border-radius: 50%;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg></div>`}
      </div>
      <div class="detail-info">
        <div class="detail-type">Sanatçı</div>
        <div class="detail-title" style="font-size: 3rem;">${esc(data.name)}</div>
        <div class="detail-meta">
          <span>${data.followers ? data.followers.toLocaleString() + ' Takipçi' : ''}</span>
        </div>
        <div class="detail-actions">
          <button class="btn-play-all" onclick="playSpotifyArtistTopTracks('${artistId}')">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Karışık Çal
          </button>
        </div>
      </div>`;

    if (data.image) extractCoverColor(data.image, 'detail-gradient-artist');

    let html = '';
    
    // Top Tracks
    if (data.topTracks && data.topTracks.length > 0) {
      data.topTracks.forEach(t => cacheSpotifyMeta(t.id, t.title, t.artist, t.cover, t.album, t.duration, null, t.albumId, t.artistId));
      html += `<div class="search-category"><h3 class="section-title">Popüler Şarkılar</h3><div class="track-list" id="spotify-artist-top-tracks"></div></div>`;
    }

    // Albums
    if (data.albums && data.albums.length > 0) {
      html += `<div class="search-category"><h3 class="section-title">Diskografi</h3><div class="album-grid">`;
      html += data.albums.map(al => `
        <div class="album-card" onclick="loadSpotifyAlbumView('${al.id}')">
          <div class="album-cover-wrap">
            ${al.coverUrl ? `<img src="${al.coverUrl}" alt="${esc(al.title)}" loading="lazy">` : `<div class="placeholder-cover">${placeholderSVG()}</div>`}
            <button class="album-play-btn" onclick="event.stopPropagation();playSpotifyAlbumTracks('${al.id}')"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
          </div>
          <div class="album-card-title">${esc(al.title)}</div>
          <div class="album-card-artist">${al.year || ''}</div>
        </div>`).join('');
      html += `</div></div>`;
    }

    content.innerHTML = html;

    if (data.topTracks && data.topTracks.length > 0) {
      const tracks = data.topTracks.map(t => ({
        id: t.id, title: t.title, artist_name: t.artist,
        album_title: t.album, albumId: t.albumId, artistId: t.artistId,
        duration: t.duration, source: 'spotify', coverUrl: t.cover
      }));
      renderSpotifyTrackList('spotify-artist-top-tracks', tracks);
    }

  } catch (err) {
    console.error('Spotify artist load error:', err);
    hero.innerHTML = '<div class="empty-state"><h3>Sanatçı yüklenemedi</h3></div>';
  }
}

async function playSpotifyArtistTopTracks(artistId) {
  try {
    const data = await api(`/api/spotify/artist/${artistId}`);
    if (!data.topTracks?.length) return;
    
    // shuffle
    let tracks = data.topTracks;
    for (let i = tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
    }
    
    queue = tracks.map(t => ({ id: t.id, source: 'spotify', title: t.title, artist: t.artist }));
    queueIndex = 0;
    playSpotifyTrack(queue[0].id, false);
    renderQueue();
  } catch (err) { console.error('Spotify artist play error:', err); }
}

async function playSpotifyAlbum(albumId) {
  try {
    const data = await api(`/api/spotify/album/${albumId}`);
    if (!data.tracks?.length) return;
    data.tracks.forEach(t => cacheSpotifyMeta(t.id, t.title, t.artist, data.cover, data.title, t.duration, null, data.id, t.artistId));
    queue = data.tracks.map(t => ({ id: t.id, source: 'spotify', title: t.title, artist: t.artist }));
    queueIndex = 0;
    playSpotifyTrack(queue[0].id, false);
    renderQueue();
  } catch (err) { console.error('Spotify album play error:', err); }
}

function playSpotifyAlbumTracks(albumId) { playSpotifyAlbum(albumId); }

// ═══ SETTINGS & ACCOUNT ═══
async function loadSettings() {
  const stats = await api('/api/stats').catch(() => null);
  const musicDirEl = document.getElementById('settings-music-dir');
  const libraryStatsEl = document.getElementById('settings-library-stats');
  
  if (stats) {
    musicDirEl.textContent = stats.music_dir || 'Bilinmiyor';
    libraryStatsEl.innerHTML = `${stats.track_count} şarkı · ${stats.album_count} albüm · ${stats.artist_count} sanatçı<br>${formatSize(stats.total_size)}`;
  }

  // Spotify Status
  try {
    const tokenData = await api('/api/spotify/token');
    const spotifyCard = document.getElementById('spotify-settings-card');
    const statusTitle = document.getElementById('spotify-status-title');
    const statusDesc = document.getElementById('spotify-status-desc');
    const connectBtn = document.getElementById('btn-spotify-connect');
    const disconnectBtn = document.getElementById('btn-spotify-disconnect');

    if (tokenData.token) {
      spotifyCard.classList.add('connected');
      statusTitle.textContent = 'Spotify Bağlı';
      statusDesc.textContent = 'Premium hesabınız başarıyla bağlandı. Tüm özellikler aktif.';
      connectBtn.classList.add('hidden');
      disconnectBtn.classList.remove('hidden');
    } else {
      spotifyCard.classList.remove('connected');
      statusTitle.textContent = 'Bağlı Değil';
      statusDesc.textContent = 'Müzik önerileri ve çalma listeleri için Spotify hesabınızı bağlayın.';
      connectBtn.classList.remove('hidden');
      disconnectBtn.classList.add('hidden');
    }
  } catch (e) { console.error('Spotify status check failed'); }

  // Deezer ARL
  try {
     const arlData = await api('/api/deezer/arl');
     if (arlData.arl) {
       document.getElementById('input-deezer-arl').value = arlData.arl;
     }
  } catch(e) {}
}

const arlInput = document.getElementById('input-deezer-arl');
if (arlInput) {
  arlInput.addEventListener('focus', () => {
    if (arlInput.value.includes('•')) arlInput.value = '';
  });
}

document.querySelector('.user-btn').addEventListener('click', () => navigateTo('settings'));

document.getElementById('btn-save-arl').addEventListener('click', async () => {
  const arl = document.getElementById('input-deezer-arl').value;
  if (!arl || arl.includes('•')) return; // Don't save empty or masked ARL
  
  const btn = document.getElementById('btn-save-arl');
  const originalText = btn.textContent;
  btn.textContent = 'Kaydediliyor...';
  
  try {
    const res = await fetch('/api/deezer/arl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arl })
    });
    if (res.ok) {
      btn.textContent = 'Kaydedildi! ✓';
      btn.style.background = '#1db954';
      setTimeout(() => {
        btn.textContent = originalText;
        btn.style.background = '';
      }, 2000);
    } else {
      throw new Error('Save failed');
    }
  } catch (err) {
    btn.textContent = 'Hata!';
    btn.style.background = '#fc3c44';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.background = '';
    }, 2000);
  }
});

document.getElementById('btn-refresh-arl').addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh-arl');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<div class="loading-spinner mini"></div> Güncelleniyor...';
  
  try {
    const res = await fetch('/api/deezer/refresh-arl', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      btn.innerHTML = 'Güncellendi! ✓';
      loadSettings();
    } else {
      btn.innerHTML = 'Çalışan ARL bulunamadı';
    }
  } catch (e) {
    btn.innerHTML = 'Hata oluştu';
  }
  
  setTimeout(() => {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }, 3000);
});

document.getElementById('btn-full-scan').addEventListener('click', () => {
  document.getElementById('btn-scan').click(); // Reuse existing scan logic
  navigateTo('home');
});

document.getElementById('btn-spotify-disconnect').addEventListener('click', async () => {
  if (confirm('Spotify bağlantısını kesmek istediğinize emin misiniz?')) {
    await fetch('/api/spotify/logout', { method: 'POST' });
    location.reload();
  }
});

// ═══ TOP BAR SCROLL EFFECT ═══
const mainContent = document.getElementById('main-content');
const topBar = document.getElementById('top-bar');

if (mainContent && topBar) {
  mainContent.addEventListener('scroll', () => {
    if (mainContent.scrollTop > 20) {
      topBar.classList.add('scrolled');
    } else {
      topBar.classList.remove('scrolled');
    }
  });
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ═══ INIT ═══
navigateTo('home');
