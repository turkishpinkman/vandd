const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Bu modül Spotify'dan gelen şarkıları yüksek kalitede indirmek için kullanılır.
 * Kullanıcı "lucida.to" vb. bir sistem (veya streamrip, qobuz-dl, tidal-dl gibi CLI araçları)
 * kullanmak istediğinde, entegrasyon buradan yapılır.
 * 
 * Varsayılan olarak örnek bir komut bırakılmıştır. Eğer lucida.to'nun bir CLI'si varsa, 
 * veya `yt-dlp` ile müzik indirilecekse, komut ona göre düzenlenir.
 */

async function downloadTrackToLibrary(trackName, artistName, musicDir) {
  return new Promise((resolve, reject) => {
    // Şarkı arama sorgusu
    const query = `${artistName} - ${trackName}`;
    
    // Klasör yapısını ayarla: Music/Sanatçı/Şarkı... 
    // veya sadece basitçe MUSIC_DIR içine atıp scanner'a taratabiliriz.
    
    // *** DOWNLOADER KOMUTU (DEĞİŞTİREBİLİRSİNİZ) ***
    // Örnek 1: Streamrip (Qobuz/Tidal downloader) -> `rip search --download "${query}"`
    // Örnek 2: yt-dlp (YouTube Music'ten yüksek kalite) -> `yt-dlp "ytsearch1:${query}" -x --audio-format flac --audio-quality 0 -o "${musicDir}/%(artist)s - %(title)s.%(ext)s"`
    
    // Demo olarak yt-dlp ile yüksek kaliteli m4a/flac indirme komutu:
    const command = `yt-dlp "ytsearch1:${query}" -x --audio-format flac --audio-quality 0 -o "${path.join(musicDir, '%(artist)s - %(title)s.%(ext)s')}"`;
    
    console.log(`[Downloader] Şarkı indiriliyor: ${query}`);
    console.log(`[Downloader] Komut: ${command}`);

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`[Downloader] İndirme hatası: ${error.message}`);
        return reject(error);
      }
      console.log(`[Downloader] İndirme tamamlandı: ${query}`);
      resolve(true);
    });
  });
}

module.exports = {
  downloadTrackToLibrary
};
