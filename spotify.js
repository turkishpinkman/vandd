require('dotenv').config();
const SpotifyWebApi = require('spotify-web-api-node');

const redirectUri = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:3000/api/spotify/callback';

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: redirectUri
});

let tokenExpirationEpoch = 0;
let userAccessToken = null;
let userRefreshToken = null;
let userTokenExpirationEpoch = 0;
let retryAfter = 0; // Epoch time when we can retry

const CACHE_TTL = 300; // 5 minutes cache
const cache = {
  home: { data: null, timestamp: 0 },
  recommendations: new Map(), // key: seedTracks string
  search: new Map(), // key: query string
};

function isRateLimited() {
  const now = new Date().getTime() / 1000;
  return now < retryAfter;
}

function handleSpotifyError(e, context) {
  if (e.statusCode === 429) {
    const waitSeconds = parseInt(e.headers['retry-after']) || 60;
    retryAfter = (new Date().getTime() / 1000) + waitSeconds;
    console.warn(`[Spotify] Rate limited in ${context}. Retry after ${waitSeconds}s`);
  }
  return e;
}

function getLoginUrl() {
  const scopes = [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-library-read',
    'user-library-modify',
    'user-top-read',
    'user-read-recently-played'
  ];
  return spotifyApi.createAuthorizeURL(scopes, 'vandd-state');
}

async function handleCallback(code) {
  const data = await spotifyApi.authorizationCodeGrant(code);
  userAccessToken = data.body['access_token'];
  userRefreshToken = data.body['refresh_token'];
  userTokenExpirationEpoch = (new Date().getTime() / 1000) + data.body['expires_in'];
  spotifyApi.setAccessToken(userAccessToken);
  spotifyApi.setRefreshToken(userRefreshToken);
  return userAccessToken;
}

async function getUserToken() {
  if (!userAccessToken) return null;
  const now = new Date().getTime() / 1000;
  if (now >= userTokenExpirationEpoch - 60) {
    try {
      const data = await spotifyApi.refreshAccessToken();
      userAccessToken = data.body['access_token'];
      userTokenExpirationEpoch = now + data.body['expires_in'];
      spotifyApi.setAccessToken(userAccessToken);
    } catch(e) {
      console.error('Error refreshing token', e);
      return null;
    }
  }
  return userAccessToken;
}

async function authenticate() {
  if (isRateLimited()) {
    throw new Error(`Spotify rate limited. Try again later.`);
  }
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    throw new Error('Spotify Client ID ve Secret .env dosyasında bulunamadı.');
  }
  if (userAccessToken) {
    await getUserToken();
    return;
  }
  const now = new Date().getTime() / 1000;
  if (now >= tokenExpirationEpoch - 60) {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body['access_token']);
    tokenExpirationEpoch = now + data.body['expires_in'];
  }
}

// ── Shared track mapper ──
function mapTrack(track) {
  return {
    id: track.id,
    title: track.name,
    artist: track.artists.map(a => a.name).join(', '),
    artistId: track.artists[0]?.id || null,
    album: track.album?.name || '',
    albumId: track.album?.id || null,
    cover: track.album?.images?.[0]?.url,
    duration: track.duration_ms / 1000,
    isrc: track.external_ids?.isrc || null,
    source: 'spotify'
  };
}

async function searchSpotify(query, limit = 10) {
  const cacheKey = `${query}_${limit}`;
  const now = new Date().getTime() / 1000;
  if (cache.search.has(cacheKey)) {
    const cached = cache.search.get(cacheKey);
    if (now - cached.timestamp < CACHE_TTL) return cached.data;
  }

  await authenticate();
  try {
    const data = await spotifyApi.search(query, ['track', 'artist', 'album'], { limit });
    const result = {
      tracks: (data.body.tracks?.items || []).map(mapTrack),
      artists: (data.body.artists?.items || []).map(item => ({
        id: item.id,
        name: item.name,
        imageUrl: item.images[0]?.url,
        type: 'artist'
      })),
      albums: (data.body.albums?.items || []).map(item => ({
        id: item.id,
        title: item.name,
        artist: item.artists.map(a => a.name).join(', '),
        coverUrl: item.images[0]?.url,
        type: 'album'
      }))
    };
    cache.search.set(cacheKey, { data: result, timestamp: now });
    return result;
  } catch (e) {
    handleSpotifyError(e, 'Search');
    throw e;
  }
}

async function getSpotifyHome() {
  const now = new Date().getTime() / 1000;
  if (cache.home.data && (now - cache.home.timestamp < CACHE_TTL)) {
    return cache.home.data;
  }

  await authenticate();
  let albums = [];
  let tracks = [];

  try {
    const newReleases = await spotifyApi.getNewReleases({ limit: 12 });
    albums = (newReleases.body.albums?.items || []).map(album => ({
      id: album.id,
      title: album.name,
      artist: album.artists.map(a => a.name).join(', '),
      coverUrl: album.images[0]?.url,
      source: 'spotify'
    }));
  } catch (e) {
    handleSpotifyError(e, 'Home New Releases');
    console.warn('[Spotify Home] New releases failed:', e.statusCode || e.message);
  }

  try {
    const featured = await spotifyApi.getFeaturedPlaylists({ limit: 5 });
    const playlists = featured.body.playlists?.items || [];
    if (playlists.length > 0) {
      const plTracks = await spotifyApi.getPlaylistTracks(playlists[0].id, { limit: 20 });
      tracks = (plTracks.body.items || []).filter(item => item.track).map(item => mapTrack(item.track));
    }
  } catch (e) {
    handleSpotifyError(e, 'Home Featured Playlists');
    console.warn('[Spotify Home] Featured playlists failed:', e.statusCode || e.message);
  }

  if (tracks.length === 0 && userAccessToken) {
    try {
      const topTracks = await spotifyApi.getMyTopTracks({ limit: 20, time_range: 'short_term' });
      tracks = (topTracks.body.items || []).map(mapTrack);
    } catch (e) {
      handleSpotifyError(e, 'Home Top Tracks');
      console.warn('[Spotify Home] Top tracks failed:', e.statusCode || e.message);
    }
  }

  if (albums.length === 0 && userAccessToken) {
    try {
      const savedAlbums = await spotifyApi.getMySavedAlbums({ limit: 12 });
      albums = (savedAlbums.body.items || []).map(item => ({
        id: item.album.id,
        title: item.album.name,
        artist: item.album.artists.map(a => a.name).join(', '),
        coverUrl: item.album.images[0]?.url,
        source: 'spotify'
      }));
    } catch (e) {
      handleSpotifyError(e, 'Home Saved Albums');
      console.warn('[Spotify Home] Saved albums failed:', e.statusCode || e.message);
    }
  }

  const result = { albums, tracks };
  if (albums.length > 0 || tracks.length > 0) {
    cache.home.data = result;
    cache.home.timestamp = now;
  }
  return result;
}

async function getSpotifyTrack(id) {
  await authenticate();
  const data = await spotifyApi.getTrack(id);
  return mapTrack(data.body);
}

async function getSpotifyLikedTracks(limit = 50) {
  if (!userAccessToken) return [];
  try {
    await authenticate();
    const data = await spotifyApi.getMySavedTracks({ limit });
    return data.body.items.map(item => mapTrack(item.track));
  } catch (e) {
    handleSpotifyError(e, 'Liked Tracks');
    console.warn('[Spotify] Liked tracks failed:', e.message);
    return [];
  }
}

async function getSpotifyRecommendations(seedTracks = [], limit = 20) {
  const cacheKey = seedTracks.sort().join(',') + `_l${limit}`;
  const now = new Date().getTime() / 1000;
  const cached = cache.recommendations.get(cacheKey);
  if (cached && (now - cached.timestamp < CACHE_TTL)) {
    return cached.data;
  }

  await authenticate();

  // Try recommendations API
  try {
    let options = { limit };
    if (seedTracks.length === 0) {
      options.seed_genres = ['pop', 'dance'];
    } else {
      options.seed_tracks = seedTracks.slice(0, 5);
    }
    const data = await spotifyApi.getRecommendations(options);
    if (data.body.tracks && data.body.tracks.length > 0) {
      const result = data.body.tracks.map(mapTrack);
      cache.recommendations.set(cacheKey, { data: result, timestamp: now });
      return result;
    }
  } catch (e) {
    handleSpotifyError(e, 'Recommendations API');
    console.warn('[Spotify] Recommendations API failed, trying fallback:', e.message);
  }

  // Fallback 1: User's top tracks
  if (userAccessToken) {
    try {
      const topTracks = await spotifyApi.getMyTopTracks({ limit, time_range: 'medium_term' });
      if (topTracks.body.items?.length > 0) return topTracks.body.items.map(mapTrack);
    } catch (e) {
      console.warn('[Spotify] Top tracks fallback failed:', e.message);
    }
  }

  // Fallback 2: Recently played
  if (userAccessToken) {
    try {
      const recent = await spotifyApi.getMyRecentlyPlayedTracks({ limit });
      if (recent.body.items?.length > 0) return recent.body.items.map(item => mapTrack(item.track));
    } catch (e) {
      console.warn('[Spotify] Recently played fallback failed:', e.message);
    }
  }

  return [];
}

// ── Spotify Album Detail ──
async function getSpotifyAlbum(albumId) {
  await authenticate();
  const data = await spotifyApi.getAlbum(albumId);
  const album = data.body;
  return {
    id: album.id,
    title: album.name,
    artist: album.artists.map(a => a.name).join(', '),
    artistId: album.artists[0]?.id || null,
    cover: album.images[0]?.url,
    year: album.release_date?.substring(0, 4),
    total_tracks: album.total_tracks,
    tracks: album.tracks.items.map(t => ({
      id: t.id,
      title: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      artistId: t.artists[0]?.id || null,
      albumId: album.id,
      album: album.name,
      cover: album.images[0]?.url,
      duration: t.duration_ms / 1000,
      track_number: t.track_number,
      source: 'spotify'
    }))
  };
}

// ── Spotify Artist Detail ──
async function getSpotifyArtist(artistId) {
  await authenticate();
  const [artistData, topTracksData, albumsData] = await Promise.all([
    spotifyApi.getArtist(artistId).catch(() => null),
    spotifyApi.getArtistTopTracks(artistId, 'US').catch(() => null),
    spotifyApi.getArtistAlbums(artistId, { include_groups: 'album,single', limit: 10 }).catch(() => null)
  ]);

  if (!artistData || !artistData.body) throw new Error('Artist not found');

  const artist = artistData.body;
  const topTracks = topTracksData && topTracksData.body && topTracksData.body.tracks ? topTracksData.body.tracks.map(mapTrack) : [];
  const albums = albumsData && albumsData.body && albumsData.body.items ? albumsData.body.items.map(album => ({
    id: album.id,
    title: album.name,
    artist: album.artists.map(a => a.name).join(', '),
    coverUrl: album.images[0]?.url,
    year: album.release_date?.substring(0, 4),
    source: 'spotify'
  })) : [];

  return {
    id: artist.id,
    name: artist.name,
    image: artist.images[0]?.url,
    followers: artist.followers?.total,
    topTracks: topTracks,
    albums: albums
  };
}

// ── Like / Unlike / Check ──
async function saveTrack(trackId) {
  if (!userAccessToken) throw new Error('Not authenticated');
  await authenticate();
  await spotifyApi.addToMySavedTracks([trackId]);
}

async function removeTrack(trackId) {
  if (!userAccessToken) throw new Error('Not authenticated');
  await authenticate();
  await spotifyApi.removeFromMySavedTracks([trackId]);
}

async function checkSavedTracks(trackIds) {
  if (!userAccessToken) return trackIds.map(() => false);
  await authenticate();
  const data = await spotifyApi.containsMySavedTracks(trackIds);
  return data.body;
}

function logout() {
  userAccessToken = null;
  userRefreshToken = null;
  userTokenExpirationEpoch = 0;
  spotifyApi.setAccessToken(null);
  spotifyApi.setRefreshToken(null);
}

module.exports = {
  searchSpotify,
  getSpotifyHome,
  getSpotifyTrack,
  getSpotifyLikedTracks,
  getSpotifyRecommendations,
  getSpotifyAlbum,
  saveTrack,
  removeTrack,
  checkSavedTracks,
  getSpotifyArtist,
  getLoginUrl,
  handleCallback,
  getUserToken,
  logout
};
