#!/usr/bin/env node
// setup-webhook.js
// Corré este script UNA VEZ después de deployar en Netlify para conectar
// el bot de Telegram con tu función serverless.
//
// Uso:
//   node setup-webhook.js <BOT_TOKEN> <NETLIFY_URL>
//
// Ejemplo:
//   node setup-webhook.js 123456:ABC-DEF https://sofy-mdn.netlify.app

const https = require('https');

const [,, BOT_TOKEN, NETLIFY_URL] = process.argv;

if (!BOT_TOKEN || !NETLIFY_URL) {
  console.error('❌ Uso: node setup-webhook.js <BOT_TOKEN> <NETLIFY_URL>');
  process.exit(1);
}

const webhookUrl = `${NETLIFY_URL.replace(/\/$/, '')}/.netlify/functions/telegram`;

const body = JSON.stringify({ url: webhookUrl });

const options = {
  hostname: 'api.telegram.org',
  path: `/bot${BOT_TOKEN}/setWebhook`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  }
};

console.log(`\n🔗 Configurando webhook en:\n   ${webhookUrl}\n`);

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const result = JSON.parse(data);
    if (result.ok) {
      console.log('✅ ¡Webhook configurado exitosamente!');
      console.log(`   ${result.description}`);
    } else {
      console.error('❌ Error:', result.description);
    }
  });
});

req.on('error', (e) => console.error('❌ Error de conexión:', e.message));
req.write(body);
req.end();
