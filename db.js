const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'akona.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    image_blob BLOB,
    image_mime TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist_id INTEGER NOT NULL,
    year INTEGER,
    genre TEXT,
    cover_blob BLOB,
    cover_mime TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE,
    UNIQUE(title, artist_id)
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    album_id INTEGER,
    artist_id INTEGER,
    track_number INTEGER,
    disc_number INTEGER DEFAULT 1,
    duration REAL,
    file_path TEXT NOT NULL UNIQUE,
    format TEXT,
    bitrate INTEGER,
    sample_rate INTEGER,
    bit_depth INTEGER,
    file_size INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE SET NULL,
    FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
  CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_filepath ON tracks(file_path);
`);

// Prepared statements
const stmts = {
  // Artists
  insertArtist: db.prepare('INSERT OR IGNORE INTO artists (name) VALUES (?)'),
  getArtistByName: db.prepare('SELECT * FROM artists WHERE name = ?'),
  getArtistById: db.prepare('SELECT * FROM artists WHERE id = ?'),
  getAllArtists: db.prepare(`
    SELECT a.*, COUNT(DISTINCT al.id) as album_count, COUNT(DISTINCT t.id) as track_count
    FROM artists a
    LEFT JOIN albums al ON al.artist_id = a.id
    LEFT JOIN tracks t ON t.artist_id = a.id
    GROUP BY a.id
    ORDER BY a.name COLLATE NOCASE
  `),
  updateArtistImage: db.prepare('UPDATE artists SET image_blob = ?, image_mime = ? WHERE id = ?'),

  // Albums
  insertAlbum: db.prepare('INSERT OR IGNORE INTO albums (title, artist_id, year, genre) VALUES (?, ?, ?, ?)'),
  getAlbumByTitleAndArtist: db.prepare('SELECT * FROM albums WHERE title = ? AND artist_id = ?'),
  getAlbumById: db.prepare('SELECT al.*, a.name as artist_name FROM albums al JOIN artists a ON a.id = al.artist_id WHERE al.id = ?'),
  getAllAlbums: db.prepare(`
    SELECT al.*, a.name as artist_name, COUNT(t.id) as track_count,
           SUM(t.duration) as total_duration
    FROM albums al
    JOIN artists a ON a.id = al.artist_id
    LEFT JOIN tracks t ON t.album_id = al.id
    GROUP BY al.id
    ORDER BY al.year DESC, al.title COLLATE NOCASE
  `),
  getAlbumsByArtist: db.prepare(`
    SELECT al.*, a.name as artist_name, COUNT(t.id) as track_count,
           SUM(t.duration) as total_duration
    FROM albums al
    JOIN artists a ON a.id = al.artist_id
    LEFT JOIN tracks t ON t.album_id = al.id
    WHERE al.artist_id = ?
    GROUP BY al.id
    ORDER BY al.year DESC
  `),
  updateAlbumCover: db.prepare('UPDATE albums SET cover_blob = ?, cover_mime = ? WHERE id = ?'),

  // Tracks
  insertTrack: db.prepare(`
    INSERT OR REPLACE INTO tracks (title, album_id, artist_id, track_number, disc_number, duration, file_path, format, bitrate, sample_rate, bit_depth, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getTrackById: db.prepare(`
    SELECT t.*, al.title as album_title, a.name as artist_name, al.id as album_id
    FROM tracks t
    LEFT JOIN albums al ON al.id = t.album_id
    LEFT JOIN artists a ON a.id = t.artist_id
    WHERE t.id = ?
  `),
  getTracksByAlbum: db.prepare(`
    SELECT t.*, a.name as artist_name
    FROM tracks t
    LEFT JOIN artists a ON a.id = t.artist_id
    WHERE t.album_id = ?
    ORDER BY t.disc_number, t.track_number
  `),
  getAllTracks: db.prepare(`
    SELECT t.*, al.title as album_title, a.name as artist_name
    FROM tracks t
    LEFT JOIN albums al ON al.id = t.album_id
    LEFT JOIN artists a ON a.id = t.artist_id
    ORDER BY a.name COLLATE NOCASE, al.year DESC, t.disc_number, t.track_number
  `),
  getTrackByPath: db.prepare('SELECT * FROM tracks WHERE file_path = ?'),
  deleteTrackByPath: db.prepare('DELETE FROM tracks WHERE file_path = ?'),

  // Search
  search: db.prepare(`
    SELECT 'track' as type, t.id, t.title as name, a.name as artist_name, al.title as album_title, t.album_id, t.format
    FROM tracks t
    LEFT JOIN artists a ON a.id = t.artist_id
    LEFT JOIN albums al ON al.id = t.album_id
    WHERE t.title LIKE ?
    UNION ALL
    SELECT 'album' as type, al.id, al.title as name, a.name as artist_name, NULL as album_title, al.id as album_id, NULL as format
    FROM albums al
    JOIN artists a ON a.id = al.artist_id
    WHERE al.title LIKE ?
    UNION ALL
    SELECT 'artist' as type, a.id, a.name as name, NULL as artist_name, NULL as album_title, NULL as album_id, NULL as format
    FROM artists a
    WHERE a.name LIKE ?
    LIMIT 50
  `),

  // Stats
  getStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM artists) as artist_count,
      (SELECT COUNT(*) FROM albums) as album_count,
      (SELECT COUNT(*) FROM tracks) as track_count,
      (SELECT SUM(duration) FROM tracks) as total_duration,
      (SELECT SUM(file_size) FROM tracks) as total_size
  `),

  // Cleanup
  getOrphanedAlbums: db.prepare('SELECT id FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)'),
  getOrphanedArtists: db.prepare('SELECT id FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL) AND id NOT IN (SELECT DISTINCT artist_id FROM albums)'),
  deleteAlbum: db.prepare('DELETE FROM albums WHERE id = ?'),
  deleteArtist: db.prepare('DELETE FROM artists WHERE id = ?'),

  // Recently added
  getRecentAlbums: db.prepare(`
    SELECT al.*, a.name as artist_name, COUNT(t.id) as track_count
    FROM albums al
    JOIN artists a ON a.id = al.artist_id
    LEFT JOIN tracks t ON t.album_id = al.id
    GROUP BY al.id
    ORDER BY al.created_at DESC
    LIMIT ?
  `),

  getRecentTracks: db.prepare(`
    SELECT t.*, al.title as album_title, a.name as artist_name
    FROM tracks t
    LEFT JOIN albums al ON al.id = t.album_id
    LEFT JOIN artists a ON a.id = t.artist_id
    ORDER BY t.created_at DESC
    LIMIT ?
  `),
};

module.exports = { db, stmts };
