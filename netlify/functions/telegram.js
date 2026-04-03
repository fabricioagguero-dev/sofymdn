// netlify/functions/telegram.js
// Este archivo es el "cerebro" del bot de Telegram.
// Netlify lo ejecuta cada vez que Telegram manda un mensaje.

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CONFIGURACIÓN ──
const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT  = process.env.OWNER_CHAT_ID;   // tu chat_id de Telegram
const PRODUCTS_PATH = path.join(__dirname, '../../data/products.json');

// ── ESTADOS DE CONVERSACIÓN (en memoria, se reinicia en cada cold start) ──
// Para producción real usarías una DB, pero para este uso personal funciona perfecto.
const sessions = {};

// ── ENTRY POINT ──
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let update;
  try {
    update = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Bad request' };
  }

  const message = update.message;
  if (!message) return { statusCode: 200, body: 'ok' };

  const chatId = String(message.chat.id);
  const text   = message.text || '';

  // Solo responde a la dueña
  if (OWNER_CHAT && chatId !== String(OWNER_CHAT)) {
    await sendMessage(chatId, '⛔ Este bot es privado.');
    return { statusCode: 200, body: 'ok' };
  }

  // Inicializar sesión si no existe
  if (!sessions[chatId]) sessions[chatId] = { step: 'idle', queue: [], current: 0 };
  const session = sessions[chatId];

  // ── COMANDOS ──
  if (text === '/start' || text === '/help') {
    await sendMessage(chatId, `👗 *Hola\\! Soy el bot de Sofy MDN*\\.\n\nPodés enviarme *fotos* de las prendas y yo te voy a pedir la información para subirlas a la web automáticamente\\.\n\n📸 *Mandame una o varias fotos para empezar\\.*`, 'MarkdownV2');
    session.step = 'idle';
    return { statusCode: 200, body: 'ok' };
  }

  if (text === '/cancelar') {
    sessions[chatId] = { step: 'idle', queue: [], current: 0 };
    await sendMessage(chatId, '✅ Cancelado. Podés empezar de nuevo cuando quieras.');
    return { statusCode: 200, body: 'ok' };
  }

  // ── RECIBIR FOTO(S) ──
  if (message.photo) {
    const fileId = message.photo[message.photo.length - 1].file_id;
    session.queue.push({ fileId, imagenes: [fileId] });

    // Si hay un álbum (media_group_id), acumular
    if (message.media_group_id) {
      session.mediaGroup = message.media_group_id;
      // Esperamos un tick para acumular todas las del grupo
      await new Promise(r => setTimeout(r, 1500));
    }

    if (session.step === 'idle') {
      session.step = 'ask_album';
      // Si solo es una foto
      if (!message.media_group_id || session.queue.length === 1) {
        session.step = 'single_asking';
        session.current = 0;
        await askProductInfo(chatId, session, 0, false);
      } else {
        await sendMessage(chatId, `📸 Recibí *${session.queue.length}* foto(s)\\. ¿Son todas del mismo álbum/prenda \\(distintos colores de la misma ropa\\)?`, 'MarkdownV2', yesNoKeyboard());
        session.step = 'wait_album_answer';
      }
    }
    return { statusCode: 200, body: 'ok' };
  }

  // ── FLUJO DE RESPUESTAS ──
  switch (session.step) {

    // ── ¿Es un álbum? ──
    case 'wait_album_answer':
      if (text === '✅ Sí, mismo álbum') {
        // Todas las fotos son colores distintos de UNA SOLA prenda
        session.mode = 'album';
        session.step = 'album_nombre';
        await sendMessage(chatId, '🏷️ *¿Cuál es el nombre de la prenda?*\n\n_Ejemplo: Campera Oversize, Vestido Midi..._', 'MarkdownV2');
      } else if (text === '❌ No, son distintas') {
        session.mode = 'individual';
        session.step = 'offer_explain';
        await sendMessage(chatId,
          'Entendido\\! Ahora voy a preguntarte sobre la información de las prendas enumerándolas\\.\n¿Querés que te explique cómo lo voy a hacer así no te confundís?',
          'MarkdownV2',
          { inline_keyboard: [[{ text: '📖 Sí, explicame', callback_data: 'explain_yes' }, { text: '➡️ No, arranquemos', callback_data: 'explain_no' }]] }
        );
      }
      break;

    // ── Álbum: nombre ──
    case 'album_nombre':
      session.albumData = { nombre: text };
      session.step = 'album_tela';
      await sendMessage(chatId, `🧵 ¿De qué tela es *${text}*?`, 'MarkdownV2');
      break;

    case 'album_tela':
      session.albumData.tela = text;
      session.step = 'album_talle';
      await sendMessage(chatId, '📐 ¿Qué talle tiene? _(S, M, L, XL, Único, etc.)_', 'MarkdownV2');
      break;

    case 'album_talle':
      session.albumData.talle = text;
      session.step = 'album_precio';
      await sendMessage(chatId, '💰 ¿Cuánto cuesta? _(Solo el número, ej: 15000)_', 'MarkdownV2');
      break;

    case 'album_precio':
      if (isNaN(text.replace(/\./g, '').replace(',', '.'))) {
        await sendMessage(chatId, '⚠️ Por favor ingresá solo números, sin $. Ejemplo: 15000');
        break;
      }
      session.albumData.precio = text.replace(/\./g, '');
      session.step = 'album_tipo';
      await sendMessage(chatId, '🏷️ ¿Qué tipo de prenda es?', 'MarkdownV2',
        { inline_keyboard: [
          [{ text: '👕 Remera', callback_data: 'tipo_remera' }, { text: '👖 Pantalón', callback_data: 'tipo_pantalon' }],
          [{ text: '👗 Vestido', callback_data: 'tipo_vestido' }, { text: '🧥 Campera', callback_data: 'tipo_campera' }],
          [{ text: '🩱 Enterito', callback_data: 'tipo_enterito' }, { text: '✏️ Otro', callback_data: 'tipo_otro' }]
        ]}
      );
      break;

    case 'album_tipo':
      session.albumData.tipo = text.toLowerCase();
      await saveAlbumProduct(chatId, session);
      break;

    // ── Individual: paso a paso por imagen ──
    case 'individual_asking':
      await handleIndividualFlow(chatId, session, text);
      break;

    case 'single_asking':
      await handleIndividualFlow(chatId, session, text);
      break;

    default:
      if (session.step !== 'idle') {
        await handleIndividualFlow(chatId, session, text);
      }
      break;
  }

  // ── CALLBACKS (botones inline) ──
  if (update.callback_query) {
    const cb     = update.callback_query;
    const cbChat = String(cb.message.chat.id);
    const sess   = sessions[cbChat] || { step: 'idle', queue: [], current: 0 };
    sessions[cbChat] = sess;
    const data   = cb.data;

    await answerCallbackQuery(cb.id);

    if (data === 'explain_yes') {
      await sendMessage(cbChat,
        `📋 *Así es como funciona:*\n\n` +
        `Tenés ${sess.queue.length} fotos\\. Te voy a preguntar por cada una en orden:\n\n` +
        sess.queue.map((_, i) => `*Imagen ${i+1}:* Nombre → Tela → Talle → Precio → Tipo`).join('\n') +
        `\n\n¡Empecemos\\! 🚀`,
        'MarkdownV2'
      );
      sess.step = 'individual_asking';
      sess.current = 0;
      sess.tempData = {};
      await askProductInfo(cbChat, sess, 0, true);
    } else if (data === 'explain_no') {
      sess.step = 'individual_asking';
      sess.current = 0;
      sess.tempData = {};
      await askProductInfo(cbChat, sess, 0, true);
    } else if (data.startsWith('tipo_')) {
      const tipo = data.replace('tipo_', '');
      if (sess.step === 'album_tipo') {
        sess.albumData.tipo = tipo === 'otro' ? 'otro' : tipo;
        await saveAlbumProduct(cbChat, sess);
      } else if (sess.step === 'individual_asking' || sess.step === 'single_asking') {
        sess.tempData.tipo = tipo === 'otro' ? 'otro' : tipo;
        await finalizeSingleProduct(cbChat, sess);
      }
    }
  }

  return { statusCode: 200, body: 'ok' };
};

// ── PREGUNTAR INFO DE UN PRODUCTO INDIVIDUAL ──
async function askProductInfo(chatId, session, index, numbered) {
  const prefix = numbered ? `*Imagen ${index + 1}:*\n` : '';
  session.tempData = {};
  session.tempStep = 'nombre';
  await sendMessage(chatId, `${prefix}🏷️ ¿Cuál es el nombre de esta prenda?\n\n_Ejemplo: Remera básica, Pantalón cargo..._`, 'MarkdownV2');
}

// ── MANEJAR FLUJO INDIVIDUAL ──
async function handleIndividualFlow(chatId, session, text) {
  if (!session.tempData) session.tempData = {};
  if (!session.tempStep)  session.tempStep = 'nombre';
  const numbered = session.mode === 'individual';
  const idx      = session.current;

  switch (session.tempStep) {
    case 'nombre':
      session.tempData.nombre = text;
      session.tempStep = 'tela';
      await sendMessage(chatId, `🧵 ¿De qué tela es *${escMd(text)}*?`, 'MarkdownV2');
      break;

    case 'tela':
      session.tempData.tela = text;
      session.tempStep = 'talle';
      await sendMessage(chatId, '📐 ¿Qué talle tiene? _(S, M, L, XL, Único, etc.)_', 'MarkdownV2');
      break;

    case 'talle':
      session.tempData.talle = text;
      session.tempStep = 'precio';
      await sendMessage(chatId, '💰 ¿Cuánto cuesta? _(Solo el número, ej: 15000)_', 'MarkdownV2');
      break;

    case 'precio':
      if (isNaN(text.replace(/\./g, '').replace(',', '.'))) {
        await sendMessage(chatId, '⚠️ Por favor ingresá solo números, sin $. Ejemplo: 15000');
        return;
      }
      session.tempData.precio = text.replace(/\./g, '');
      session.tempStep = 'tipo';
      await sendMessage(chatId, '🏷️ ¿Qué tipo de prenda es?', 'MarkdownV2',
        { inline_keyboard: [
          [{ text: '👕 Remera', callback_data: 'tipo_remera' }, { text: '👖 Pantalón', callback_data: 'tipo_pantalon' }],
          [{ text: '👗 Vestido', callback_data: 'tipo_vestido' }, { text: '🧥 Campera', callback_data: 'tipo_campera' }],
          [{ text: '🩱 Enterito', callback_data: 'tipo_enterito' }, { text: '✏️ Otro', callback_data: 'tipo_otro' }]
        ]}
      );
      break;
  }
}

async function finalizeSingleProduct(chatId, session) {
  const idx     = session.current;
  const imgItem = session.queue[idx];
  const data    = session.tempData;

  // Obtener URL pública de la foto desde Telegram
  const fileUrl = await getFileUrl(imgItem.fileId);

  const product = {
    id:       `prod_${Date.now()}_${idx}`,
    nombre:   data.nombre,
    tela:     data.tela,
    talle:    data.talle,
    precio:   data.precio,
    tipo:     data.tipo,
    imagenes: [fileUrl],
    fechaAgregado: new Date().toISOString()
  };

  await appendProduct(product);

  await sendMessage(chatId,
    `✅ *¡${escMd(data.nombre)} guardada\\!*\n` +
    `🧵 Tela: ${escMd(data.tela)}\n` +
    `📐 Talle: ${escMd(data.talle)}\n` +
    `💰 Precio: \\$${Number(data.precio).toLocaleString('es-AR')}\n` +
    `🏷️ Tipo: ${escMd(data.tipo)}`,
    'MarkdownV2'
  );

  session.current++;

  if (session.current < session.queue.length) {
    session.tempData = {};
    session.tempStep = 'nombre';
    await askProductInfo(chatId, session, session.current, session.mode === 'individual');
  } else {
    sessions[chatId] = { step: 'idle', queue: [], current: 0 };
    await sendMessage(chatId,
      `🎉 *¡Listo\\! Se subieron ${session.current} prenda(s) a la web\\.*\n\nYa están visibles en tu tienda\\. ¡A vender\\! 🛍️`,
      'MarkdownV2'
    );
  }
}

async function saveAlbumProduct(chatId, session) {
  const data = session.albumData;
  const fileUrls = await Promise.all(session.queue.map(q => getFileUrl(q.fileId)));

  const product = {
    id:       `prod_${Date.now()}`,
    nombre:   data.nombre,
    tela:     data.tela,
    talle:    data.talle,
    precio:   data.precio,
    tipo:     data.tipo,
    imagenes: fileUrls,
    fechaAgregado: new Date().toISOString()
  };

  await appendProduct(product);

  sessions[chatId] = { step: 'idle', queue: [], current: 0 };
  await sendMessage(chatId,
    `✅ *¡${escMd(data.nombre)} guardada con ${fileUrls.length} color(es)\\!*\n` +
    `🧵 Tela: ${escMd(data.tela)}\n📐 Talle: ${escMd(data.talle)}\n💰 Precio: \\$${Number(data.precio).toLocaleString('es-AR')}\n\n` +
    `🎉 ¡Ya está visible en tu web\\!`,
    'MarkdownV2'
  );
}

// ── GUARDAR PRODUCTO EN JSON ──
async function appendProduct(product) {
  let db = { products: [] };
  try {
    const raw = fs.readFileSync(PRODUCTS_PATH, 'utf8');
    db = JSON.parse(raw);
  } catch {}
  db.products.push(product);
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(db, null, 2), 'utf8');
}

// ── OBTENER URL PÚBLICA DE FOTO DE TELEGRAM ──
async function getFileUrl(fileId) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/getFile?file_id=${fileId}`,
      method: 'GET'
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const filePath = data.result.file_path;
          resolve(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
        } catch {
          resolve('');
        }
      });
    });
    req.on('error', () => resolve(''));
    req.end();
  });
}

// ── TELEGRAM API HELPERS ──
async function sendMessage(chatId, text, parseMode = '', replyMarkup = null) {
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    ...(parseMode    ? { parse_mode: parseMode }       : {}),
    ...(replyMarkup  ? { reply_markup: replyMarkup }   : {})
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

async function answerCallbackQuery(callbackQueryId) {
  const body = JSON.stringify({ callback_query_id: callbackQueryId });
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/answerCallbackQuery`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

function yesNoKeyboard() {
  return { keyboard: [['✅ Sí, mismo álbum', '❌ No, son distintas']], one_time_keyboard: true, resize_keyboard: true };
}

// Escapar caracteres especiales para MarkdownV2
function escMd(str) {
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, c => '\\' + c);
}
