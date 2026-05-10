const fs = require('fs');
const path = require('path');
const deezer = require('./deezer');

// Bilinen Telegram kanalları (web preview üzerinden okunabilir olanlar)
const CHANNELS = [
  'deezerarls',
  'deemix_arl',
  'Deezer_ARLs',
  'arl_deezer'
];

async function updateArls() {
  console.log('[ARL Updater] Açık kaynaklı Telegram kanallarında güncel ARL aranıyor...');
  let foundArls = new Set();

  // 1. Telegram kanallarını tara
  for (const channel of CHANNELS) {
    try {
      const res = await fetch(`https://t.me/s/${channel}`);
      const html = await res.text();
      // ARL kodları tam olarak 192 karakterli küçük harf+rakam hex stringleridir.
      const matches = html.match(/[a-f0-9]{192}/g);
      if (matches) {
        matches.forEach(m => foundArls.add(m));
      }
    } catch (err) {
      console.error(`[ARL Updater] ${channel} kanalı okunamadı:`, err.message);
    }
  }

  const arlArray = [...foundArls].reverse(); // En yenileri (en alttakileri) önce dene
  console.log(`[ARL Updater] Toplam ${arlArray.length} adet potansiyel ARL bulundu. Test ediliyor...`);

  const workingArls = [];

  // 2. Bulunan ARL'leri test et
  for (const arl of arlArray) {
    try {
      const user = await deezer.testArl(arl);
      if (user && user.USER_ID) {
        console.log(`[ARL Updater] ✅ ÇALIŞAN ARL BULUNDU! (Hesap ID: ${user.USER_ID})`);
        workingArls.push(arl);
        // Çok fazla tarayıp API'yi yormamak için 2-3 tane çalışan bulmak yeterli
        if (workingArls.length >= 3) break;
      }
    } catch (e) {
      // Geçersiz ARL, yoksay
    }
  }

  // 3. Çalışan ARL bulunduysa .env dosyasını güncelle
  if (workingArls.length > 0) {
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const newArlString = workingArls.join(',');

    if (envContent.includes('DEEZER_ARL=')) {
      envContent = envContent.replace(/DEEZER_ARL=.*/, `DEEZER_ARL=${newArlString}`);
    } else {
      envContent += `\nDEEZER_ARL=${newArlString}\n`;
    }

    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log(`[ARL Updater] 🎉 .env dosyası güncellendi. Yeni ARL'ler kaydedildi.`);
    
    // Deezer modülüne yeni ARL'leri bildir
    deezer.setArls(workingArls);
    return true;
  } else {
    console.log('[ARL Updater] ❌ Taranan tüm ARL kodları patlamış. Çalışan bulunamadı.');
    return false;
  }
}

module.exports = { updateArls };
