const fs = require('fs');
const path = require('path');
const { db, stmts } = require('./db');

// Supported audio formats
const SUPPORTED_FORMATS = new Set(['.flac', '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.wma', '.aiff', '.alac', '.dsf', '.dff']);

let isScanning = false;
let scanProgress = { total: 0, processed: 0, status: 'idle', currentFile: '' };

function getScanProgress() {
  return { ...scanProgress };
}

async function findAudioFiles(dir) {
  const files = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
      console.warn(`Cannot read directory: ${currentDir}`, err.message);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_FORMATS.has(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(dir);
  return files;
}

async function scanLibrary(musicDir) {
  if (isScanning) {
    return { success: false, message: 'Scan already in progress' };
  }

  // Dynamic import for ESM module
  const mm = await import('music-metadata');

  isScanning = true;
  scanProgress = { total: 0, processed: 0, status: 'scanning', currentFile: '' };

  console.log(`\n🎵 Starting library scan: ${musicDir}`);
  const startTime = Date.now();

  try {
    // Find all audio files
    scanProgress.status = 'discovering';
    const files = await findAudioFiles(musicDir);
    scanProgress.total = files.length;
    console.log(`📁 Found ${files.length} audio files`);

    if (files.length === 0) {
      scanProgress.status = 'idle';
      isScanning = false;
      return { success: true, message: 'No audio files found', stats: { total: 0 } };
    }

    scanProgress.status = 'processing';

    // Use transaction for bulk inserts
    const insertMany = db.transaction((fileList) => {
      for (const file of fileList) {
        processFileSync(file, mm);
      }
    });

    // Process in batches
    const BATCH_SIZE = 50;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      
      // Process each file to get metadata first, then batch insert
      for (const filePath of batch) {
        try {
          await processFile(filePath, mm);
        } catch (err) {
          console.warn(`⚠️  Error processing: ${path.basename(filePath)} — ${err.message}`);
        }
        scanProgress.processed++;
        scanProgress.currentFile = path.basename(filePath);
      }
    }

    // Cleanup orphaned albums and artists
    cleanupOrphans();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const stats = stmts.getStats.get();
    console.log(`✅ Scan complete in ${elapsed}s — ${stats.artist_count} artists, ${stats.album_count} albums, ${stats.track_count} tracks`);

    scanProgress.status = 'complete';
    isScanning = false;

    return {
      success: true,
      message: `Scanned ${files.length} files in ${elapsed}s`,
      stats
    };

  } catch (err) {
    console.error('❌ Scan error:', err);
    scanProgress.status = 'error';
    isScanning = false;
    return { success: false, message: err.message };
  }
}

async function processFile(filePath, mm) {
  try {
    const stat = fs.statSync(filePath);
    const metadata = await mm.parseFile(filePath);
    const { common, format } = metadata;

    const artistName = common.artist || common.albumartist || 'Unknown Artist';
    const albumTitle = common.album || 'Unknown Album';
    const title = common.title || path.basename(filePath, path.extname(filePath));
    const year = common.year || null;
    const genre = common.genre ? common.genre[0] : null;
    const trackNumber = common.track?.no || null;
    const discNumber = common.disk?.no || 1;
    const duration = format.duration || 0;
    const bitrate = format.bitrate ? Math.round(format.bitrate / 1000) : null;
    const sampleRate = format.sampleRate || null;
    const bitDepth = format.bitsPerSample || null;
    const fileFormat = path.extname(filePath).substring(1).toUpperCase();

    // Insert or get artist
    stmts.insertArtist.run(artistName);
    const artist = stmts.getArtistByName.get(artistName);

    // Insert or get album
    stmts.insertAlbum.run(albumTitle, artist.id, year, genre);
    const album = stmts.getAlbumByTitleAndArtist.get(albumTitle, artist.id);

    // Extract and save cover art if album doesn't have one
    if (album && !album.cover_blob && common.picture && common.picture.length > 0) {
      const pic = common.picture[0];
      stmts.updateAlbumCover.run(pic.data, pic.format, album.id);

      // Also set as artist image if not set
      if (!artist.image_blob) {
        stmts.updateArtistImage.run(pic.data, pic.format, artist.id);
      }
    }

    // Insert track
    stmts.insertTrack.run(
      title,
      album ? album.id : null,
      artist.id,
      trackNumber,
      discNumber,
      duration,
      filePath,
      fileFormat,
      bitrate,
      sampleRate,
      bitDepth,
      stat.size
    );

  } catch (err) {
    throw err;
  }
}

function cleanupOrphans() {
  const orphanedAlbums = stmts.getOrphanedAlbums.all();
  for (const album of orphanedAlbums) {
    stmts.deleteAlbum.run(album.id);
  }

  const orphanedArtists = stmts.getOrphanedArtists.all();
  for (const artist of orphanedArtists) {
    stmts.deleteArtist.run(artist.id);
  }
}

module.exports = { scanLibrary, getScanProgress };
