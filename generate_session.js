const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
require('dotenv').config();

const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
  console.error("Lütfen .env dosyasında TELEGRAM_API_ID ve TELEGRAM_API_HASH değerlerini doldurun.");
  process.exit(1);
}

const stringSession = new StringSession(''); // İlk başta boş başlatıyoruz

(async () => {
  console.log('Telegram oturumu oluşturuluyor...');
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('Telefon numaranızı girin (örn: +905551234567): '),
    password: async () => await input.text('Şifreniz varsa girin (yoksa boş bırakın): '),
    phoneCode: async () => await input.text('Telegramdan gelen onay kodunu girin: '),
    onError: (err) => console.log('Hata:', err),
  });

  console.log('\n--- BAŞARIYLA GİRİŞ YAPILDI! ---');
  console.log('Aşağıdaki metni kopyalayıp .env dosyanızdaki TELEGRAM_SESSION karşısına yapıştırın:\n');
  console.log(client.session.save());
  console.log('\n--------------------------------');
  process.exit(0);
})();
