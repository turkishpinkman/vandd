# VANDD — Hi-Fidelity Personal Music Server 🎵

VANDD, Spotify ve Deezer entegrasyonuna sahip, kayıpsız (Hi-Fi) ses kalitesi sunan kişisel bir müzik sunucusudur.

## Özellikler
- **Hi-Fi Akış:** Deezer ARL üzerinden FLAC kalitesinde müzik dinleme.
- **Spotify Entegrasyonu:** Spotify kitaplığınızı, çalma listelerinizi ve önerilerinizi görün.
- **YouTube Fallback:** Deezer'da bulunmayan şarkılar için otomatik YouTube (yt-dlp) geçişi.
- **Kişisel Kitaplık:** Yerel müzik klasörünüzü tarayın ve yayınlayın.
- **Docker Desteği:** Her ortamda kolay kurulum.

## Hızlı Kurulum (Local)

1. Depoyu klonlayın.
2. `npm install` ile bağımlılıkları kurun.
3. `.env.example` dosyasını `.env` olarak kopyalayın ve bilgilerinizi girin.
4. `npm start` ile başlatın.

## Bulut Yayını (Render.com)

Bu projeyi internete açmak için:
1. GitHub deponuzu [Render.com](https://render.com) adresine bağlayın.
2. Yeni bir **Web Service** oluşturun.
3. Render, depodaki `Dockerfile` ve `render.yaml` dosyalarını kullanarak kurulumu otomatik yapacaktır.
4. Ortam değişkenlerini (Environment Variables) Render panelinden eklemeyi unutmayın.

---
Geliştiren: [turkishpinkman](https://github.com/turkishpinkman)
