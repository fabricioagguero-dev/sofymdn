// =============================================================================
// 🤖 BOT DE TELEGRAM — SOFY MDN
// =============================================================================
//
// VARIABLES DE ENTORNO (configurar en Netlify):
//   TELEGRAM_BOT_TOKEN   → Token del bot (@BotFather)
//   OWNER_ID             → Tu chat_id de Telegram
//   GITHUB_TOKEN         → Personal Access Token de GitHub
//   GITHUB_REPO          → usuario/repositorio  (ej: fabricioaguero-dev/sofymdn)
//   GITHUB_FILE_PATH     → data/products.json
//   GITHUB_LOG_PATH      → data/log.json        (se crea automáticamente)
//   GEMINI_API_KEY       → API Key de Google Gemini
//
// COMANDOS DISPONIBLES:
//   /start      → Bienvenida y menú
//   /ayuda      → Guía completa
//   /listar     → Ver todos los productos
//   /buscar     → Buscar productos por texto
//   /stats      → Estadísticas del catálogo
//   /editar     → Editar un producto existente
//   /eliminar   → Eliminar un producto
//   /stock      → Cambiar estado de stock de una prenda
//   /precios    → Actualizar precios en masa (por tipo o todos)
//   /historial  → Ver los últimos cambios registrados
//   /cancelar   → Cancelar la operación actual
//
// FLUJO DE CARGA:
//   Foto → Tela → Talles (checkboxes) → Precio → Título → Descripción → GitHub
//   Varias fotos → ¿Mismo modelo? →
//     Sí: Gemini detecta color de cada foto → datos del modelo → GitHub
//     No: pregunta cada prenda por separado con opción de reenviar foto
//
// =============================================================================

"use strict";

const https = require("https");

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 1 — CONFIGURACIÓN
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID     = String(process.env.OWNER_ID || "");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO;
const GITHUB_FILE  = process.env.GITHUB_FILE_PATH  || "data/products.json";
const GITHUB_LOG   = process.env.GITHUB_LOG_PATH   || "data/log.json";
const GEMINI_KEY   = process.env.GEMINI_API_KEY;

// Tiempo de espera para acumular fotos de un media_group (ms)
const MEDIA_WAIT = 2500;

// Opciones de botones
const TELAS   = ["Algodón","Modal","Lycra","Jean","Lino","Saten","Tul","Cuerina","Polar","Otra"];
const TALLES  = ["XS","S","M","L","XL","XXL","Único"];
const PRECIOS = ["$5.000","$8.000","$10.000","$12.000","$15.000","$18.000","$20.000","✏️ Otro"];
const TIPOS   = ["remera","pantalon","vestido","campera","enterito","accesorio","otro"];
const COLORES = [
  "Blanco","Negro","Gris","Beige","Camello","Crema","Tostado","Marrón",
  "Rosa","Fucsia","Rojo","Bordo","Naranja","Amarillo",
  "Verde","Oliva","Celeste","Azul","Marino","Violeta","Lila","Otro",
];

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 2 — SESIONES EN MEMORIA
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️  Netlify puede "enfriar" la función si no recibe tráfico.
//     Si el estado se pierde, la dueña puede usar /cancelar para reiniciar.

const sessions = {};

function newSession() {
  return {
    // Estado principal del flujo
    step: "idle",
    // idle | wait_tela | wait_talles | wait_precio | wait_titulo | wait_desc
    // wait_album_answer | wait_color_confirm | wait_color_edit | wait_color_pick
    // individual_intro | wait_indiv_tela | wait_indiv_talles
    // wait_indiv_precio | wait_indiv_titulo | wait_indiv_desc
    // wait_buscar | wait_eliminar_id | confirm_eliminar
    // wait_editar_id | wait_editar_campo | wait_editar_valor
    // wait_stock_id | wait_precios_tipo | wait_precios_pct
    // wait_historial

    mode: null,         // "single" | "album" | "individual"
    photos: [],         // [{ fileId, width, height }]
    mediaGroup: null,

    // Datos de la prenda en carga
    tela: null,
    talles: [],         // talles seleccionados via checkboxes
    precio: null,
    titulo: null,
    descripcion: null,

    // Álbum
    albumColors: [],    // [{ fileId, color }]
    colorIdx: 0,

    // Individual
    indivIdx: 0,
    indivData: {},
    indivTalles: [],

    // Edición
    editId: null,
    editCampo: null,
    editTalles: [],

    // Eliminación
    deleteId: null,

    // Stock
    stockId: null,

    // Precios masivos
    preciosTipo: null,  // tipo a actualizar o "todos"
  };
}

const getSession   = id => { if (!sessions[id]) sessions[id] = newSession(); return sessions[id]; };
const resetSession = id => { sessions[id] = newSession(); };

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 3 — GITHUB API
// ─────────────────────────────────────────────────────────────────────────────

// Petición genérica a la GitHub Contents API
function ghReq(method, filePath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.github.com",
      path:     `/repos/${GITHUB_REPO}/contents/${filePath}`,
      method,
      headers: {
        "Authorization": `token ${GITHUB_TOKEN}`,
        "Accept":        "application/vnd.github.v3+json",
        "User-Agent":    "SofyMDN-Bot/2.0",
        "Content-Type":  "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
      timeout: 15000,
    }, res => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("GitHub timeout")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Leer el JSON de productos desde GitHub
async function readDB() {
  const { status, data } = await ghReq("GET", GITHUB_FILE);
  if (status === 404) return { products: [], sha: null };
  if (status !== 200 || !data?.content) throw new Error(`GitHub GET ${status}`);

  const raw = Buffer.from(data.content, "base64").toString("utf8").trim();
  if (!raw) return { products: [], sha: data.sha };

  let products;
  try {
    products = JSON.parse(raw);
    if (!Array.isArray(products)) products = products.products || [];
  } catch { products = []; }

  return { products, sha: data.sha };
}

// Guardar el JSON de productos en GitHub
async function writeDB(products, sha, msg) {
  const content = Buffer.from(JSON.stringify(products, null, 2)).toString("base64");
  const { status, data } = await ghReq("PUT", GITHUB_FILE, {
    message: msg, content, ...(sha ? { sha } : {}),
  });
  if (status !== 200 && status !== 201) {
    throw new Error(`GitHub PUT ${status}: ${data?.message || "error"}`);
  }
  return true;
}

// Leer el log de cambios desde GitHub
async function readLog() {
  const { status, data } = await ghReq("GET", GITHUB_LOG);
  if (status === 404) return { entries: [], sha: null };
  if (status !== 200 || !data?.content) return { entries: [], sha: null };

  const raw = Buffer.from(data.content, "base64").toString("utf8").trim();
  if (!raw) return { entries: [], sha: data.sha };

  try {
    const parsed = JSON.parse(raw);
    return { entries: Array.isArray(parsed) ? parsed : (parsed.entries || []), sha: data.sha };
  } catch { return { entries: [], sha: data.sha }; }
}

// Escribir una entrada nueva en el log de cambios
async function writeLog(entries, sha, msg) {
  const content = Buffer.from(JSON.stringify(entries, null, 2)).toString("base64");
  await ghReq("PUT", GITHUB_LOG, {
    message: msg, content, ...(sha ? { sha } : {}),
  });
}

// Registrar un cambio en el historial (no bloquea el flujo principal si falla)
async function logChange(accion, detalle) {
  try {
    const { entries, sha } = await readLog();
    entries.unshift({
      fecha:  new Date().toISOString(),
      accion,
      detalle,
    });
    // Mantener máximo 100 entradas en el log
    const trimmed = entries.slice(0, 100);
    await writeLog(trimmed, sha, `Log: ${accion}`);
  } catch (e) {
    // El log es informativo, no rompemos el flujo si falla
    console.error("[log]", e.message);
  }
}

// Helpers
const genId = () => `prod_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 4 — TELEGRAM API
// ─────────────────────────────────────────────────────────────────────────────

// Petición genérica a la API de Telegram
function tg(method, payload) {
  return new Promise(resolve => {
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: "api.telegram.org",
      path:     `/bot${BOT_TOKEN}/${method}`,
      method:   "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout:  10000,
    }, res => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => {
        try {
          const p = JSON.parse(raw);
          if (!p.ok) console.error(`[TG:${method}]`, p.description);
          resolve(p);
        } catch { resolve({ ok: false }); }
      });
    });
    req.on("error",   () => resolve({ ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
    req.write(body);
    req.end();
  });
}

// Enviar mensaje de texto plano
const sendMsg   = (chatId, text, extra = {}) =>
  tg("sendMessage", { chat_id: chatId, text, ...extra });

// Enviar mensaje con Markdown
const sendMd    = (chatId, text, extra = {}) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", ...extra });

// Reenviar una foto al chat
const sendPhoto = (chatId, photo, caption = "") =>
  tg("sendPhoto", { chat_id: chatId, photo, ...(caption ? { caption } : {}) });

// Confirmar un callback query (quita el indicador de carga del botón)
const answerCb  = id => tg("answerCallbackQuery", { callback_query_id: id });

// Enviar botones inline donde el texto del botón == su callback_data
function sendBtns(chatId, text, rows, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId, text,
    reply_markup: { inline_keyboard: rows.map(r => r.map(l => ({ text: l, callback_data: l }))) },
    ...extra,
  });
}

// Enviar botones inline con texto y datos separados: rows = [[{text, data}]]
function sendBtnsCustom(chatId, text, rows, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId, text,
    reply_markup: { inline_keyboard: rows.map(r => r.map(b => ({ text: b.text, callback_data: b.data }))) },
    ...extra,
  });
}

// Obtener la URL descargable de un archivo de Telegram
function getFileUrl(fileId) {
  return new Promise(resolve => {
    const body = JSON.stringify({ file_id: fileId });
    const req  = https.request({
      hostname: "api.telegram.org",
      path:     `/bot${BOT_TOKEN}/getFile`,
      method:   "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout:  10000,
    }, res => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => {
        try {
          const p = JSON.parse(raw);
          resolve(p.ok && p.result?.file_path
            ? `https://api.telegram.org/file/bot${BOT_TOKEN}/${p.result.file_path}`
            : "");
        } catch { resolve(""); }
      });
    });
    req.on("error",   () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 5 — GEMINI API (detección de color)
// ─────────────────────────────────────────────────────────────────────────────

// Detecta el color principal de una prenda usando Gemini 1.5 Flash.
// Usa la URL directa de Telegram (file_uri) para evitar problemas de descarga.
async function detectColor(fileId) {
  if (!GEMINI_KEY) return null;

  try {
    const url = await getFileUrl(fileId);
    if (!url) return null;

    const body = JSON.stringify({
      contents: [{
        parts: [
          {
            text: "Sos un experto en moda. Mirá esta prenda y respondé ÚNICAMENTE con el color principal en español, en 1-3 palabras. Solo el color, sin puntos ni explicaciones. Ejemplos válidos: Negro, Blanco, Rojo, Rosa, Azul marino, Verde oliva, Beige, Camello."
          },
          {
            file_data: { mime_type: "image/jpeg", file_uri: url }
          }
        ]
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 10 },
    });

    return await new Promise(resolve => {
      const req = https.request({
        hostname: "generativelanguage.googleapis.com",
        path:     `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
        method:   "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout:  20000,
      }, res => {
        let raw = "";
        res.on("data", d => raw += d);
        res.on("end", () => {
          try {
            const d = JSON.parse(raw);
            console.log("[Gemini]", JSON.stringify(d).substring(0, 150));
            const t = d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            resolve(t ? t.replace(/[".]/g, "").trim() : null);
          } catch { resolve(null); }
        });
      });
      req.on("error",   () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });

  } catch (e) {
    console.error("[Gemini]", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 6 — HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Parsear precio desde texto (acepta $15.000, 15000, 15,000, etc.)
const parsePrice = t => {
  const n = parseFloat(String(t).replace(/[$\s.]/g,"").replace(",","."));
  return (!isNaN(n) && n > 0) ? Math.round(n) : null;
};

// Formatear precio como $15.000
const fmtPrice = n => `$${Number(n || 0).toLocaleString("es-AR")}`;

// Formatear fecha ISO a formato legible en Argentina
const fmtDate = iso => {
  try {
    return new Date(iso).toLocaleString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
};

// Emoji según tipo de prenda
const tipoEmoji = t => ({
  remera:"👕", pantalon:"👖", vestido:"👗", campera:"🧥",
  enterito:"🩱", accesorio:"🧣",
})[t] || "🏷️";

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 7 — TECLADOS (KEYBOARDS)
// ─────────────────────────────────────────────────────────────────────────────

// Preguntar tela
const askTela = (chatId, prefix = "") =>
  sendBtns(chatId, `${prefix}🧵 *¿De qué tela es?*`,
    [TELAS.slice(0,5), TELAS.slice(5)], { parse_mode: "Markdown" });

// Preguntar precio
const askPrecio = (chatId, prefix = "") =>
  sendBtns(chatId, `${prefix}💰 *¿Cuánto cuesta?* Elegí o escribí el número:`,
    [PRECIOS.slice(0,4), PRECIOS.slice(4)], { parse_mode: "Markdown" });

// Preguntar título
const askTitulo = (chatId, prefix = "") =>
  sendMsg(chatId, `${prefix}🏷️ ¿Cuál es el nombre de esta prenda?\n_Ej: Remera oversize, Vestido floral..._`,
    { parse_mode: "Markdown" });

// Preguntar descripción
const askDesc = chatId =>
  sendBtns(chatId, "📄 ¿Querés agregar una descripción?", [["✏️ Sí, agregar","⏭️ No, saltar"]]);

// Teclado de talles con checkboxes (muestra ✅ en los seleccionados)
function buildTallesRows(selected = []) {
  const half = Math.ceil(TALLES.length / 2);
  const rows = [
    TALLES.slice(0, half).map(t => ({
      text: selected.includes(t) ? `✅ ${t}` : t,
      data: `talle__${t}`,
    })),
    TALLES.slice(half).map(t => ({
      text: selected.includes(t) ? `✅ ${t}` : t,
      data: `talle__${t}`,
    })),
    [{
      text: selected.length
        ? `✔️ Confirmar: ${selected.join(", ")}`
        : "— Seleccioná al menos uno —",
      data: selected.length ? "talles__ok" : "talles__none",
    }],
  ];
  return rows;
}

const sendTallesKb = (chatId, selected = [], prefix = "") =>
  sendBtnsCustom(chatId,
    `${prefix}📐 *Seleccioná los talles disponibles*\n_Podés elegir varios. Tocá para activar/desactivar._`,
    buildTallesRows(selected),
    { parse_mode: "Markdown" }
  );

// Picker de colores para cuando Gemini falla
async function sendColorPicker(chatId) {
  const rows = [];
  for (let i = 0; i < COLORES.length; i += 3) rows.push(COLORES.slice(i, i+3));
  await sendBtns(chatId, "Elegí el color o escribilo:", rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 8 — FLUJO: RECIBIR FOTOS
// ─────────────────────────────────────────────────────────────────────────────

async function handlePhoto(chatId, session, message) {
  if (session.step !== "idle") {
    await sendMsg(chatId, "⚠️ Ya estoy procesando algo. Usá /cancelar para reiniciar.");
    return;
  }

  const photo  = message.photo;
  const fileId = photo[photo.length - 1].file_id;
  const width  = photo[photo.length - 1].width  || 0;
  const height = photo[photo.length - 1].height || 0;
  const mgId   = message.media_group_id;

  session.photos.push({ fileId, width, height });

  // Foto suelta
  if (!mgId) {
    session.mode = "single";
    session.step = "wait_tela";
    await sendMsg(chatId, "📸 ¡Foto recibida! Vamos a cargar esta prenda.");
    await askTela(chatId);
    return;
  }

  // Grupo de fotos: acumular y esperar
  if (session.mediaGroup !== mgId) {
    session.mediaGroup = mgId;
    session.step       = "accumulating";
    await sendMsg(chatId, "📸 Recibiendo fotos...");
    await new Promise(r => setTimeout(r, MEDIA_WAIT));

    // Ordenar de mayor a menor altura (la más vertical = foto 1)
    session.photos.sort((a, b) => b.height - a.height);

    await sendBtns(
      chatId,
      `📸 Recibí *${session.photos.length} fotos*.\n\n¿Son del mismo modelo en distintos colores, o son prendas distintas?`,
      [["🎨 Mismo modelo, distintos colores"], ["📦 Son prendas distintas"]],
      { parse_mode: "Markdown" }
    );
    session.step = "wait_album_answer";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 9 — FLUJO: ÁLBUM (mismo modelo, distintos colores)
// ─────────────────────────────────────────────────────────────────────────────

async function startAlbum(chatId, session) {
  session.albumColors = session.photos.map(p => ({ fileId: p.fileId, color: null }));
  session.colorIdx    = 0;
  await processNextColor(chatId, session);
}

async function processNextColor(chatId, session) {
  const idx   = session.colorIdx;
  const total = session.albumColors.length;
  const item  = session.albumColors[idx];

  await sendPhoto(chatId, item.fileId, `📷 Foto ${idx+1} de ${total}`);
  await sendMsg(chatId, "🔍 Detectando color con IA...");

  const color = await detectColor(item.fileId);

  if (color) {
    await sendBtnsCustom(chatId,
      `🎨 *Foto ${idx+1} de ${total}*\n\nDetecté el color: *${color}*\n\n¿Es correcto?`,
      [
        [{ text: `✅ Sí, es ${color}`, data: `colorok__${color}` }],
        [{ text: "✏️ No, quiero corregirlo", data: "color_edit" }],
      ],
      { parse_mode: "Markdown" }
    );
    session.step = "wait_color_confirm";
  } else {
    await sendMsg(chatId,
      `🎨 *Foto ${idx+1} de ${total}* — ¿De qué color es?`,
      { parse_mode: "Markdown" });
    await sendColorPicker(chatId);
    session.step = "wait_color_pick";
  }
}

async function confirmColor(chatId, session, color) {
  session.albumColors[session.colorIdx].color = color;
  session.colorIdx++;

  if (session.colorIdx < session.albumColors.length) {
    await processNextColor(chatId, session);
  } else {
    const resumen = session.albumColors.map((c,i) => `Foto ${i+1}: *${c.color}*`).join("\n");
    await sendMd(chatId, `✅ *Colores confirmados:*\n${resumen}\n\nAhora los datos del modelo.`);
    session.step = "wait_tela";
    await askTela(chatId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 10 — FLUJO: INDIVIDUAL (prendas distintas)
// ─────────────────────────────────────────────────────────────────────────────

async function startIndividual(chatId, session) {
  const count = session.photos.length;
  const desc  = session.photos.map((p, i) => {
    const forma = p.height > p.width * 1.2 ? "📱 vertical"
                : p.width  > p.height * 1.2 ? "🖼️ horizontal"
                : "⬛ cuadrada";
    return `• *Foto ${i+1}:* ${forma}`;
  }).join("\n");

  const reenviarBtns = session.photos.map((_, i) =>
    [{ text: `🔁 Ver foto ${i+1}`, data: `reenviar__${i}` }]
  );
  reenviarBtns.push([{ text: "▶️ Arrancar", data: "individual__start" }]);

  await sendBtnsCustom(chatId,
    `📦 *${count} prendas distintas*\n\nLas ordené así (la más alta primero):\n${desc}\n\n¿Querés ver alguna antes de empezar?`,
    reenviarBtns, { parse_mode: "Markdown" }
  );
  session.step = "individual_intro";
}

async function startIndivProduct(chatId, session) {
  const idx   = session.indivIdx;
  const total = session.photos.length;
  session.indivData   = {};
  session.indivTalles = [];

  await sendPhoto(chatId, session.photos[idx].fileId, `📦 Prenda ${idx+1} de ${total}`);
  session.step = "wait_indiv_tela";
  await askTela(chatId, `*Prenda ${idx+1} de ${total}* — `);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 11 — GUARDAR PRODUCTOS EN GITHUB
// ─────────────────────────────────────────────────────────────────────────────

async function saveProduct(chatId, session) {
  await sendMsg(chatId, "⏳ Guardando en GitHub...");
  try {
    const { products, sha } = await readDB();
    let producto;

    if (session.mode === "album") {
      // Álbum: una prenda con múltiples imágenes (una por color)
      const urls = await Promise.all(session.albumColors.map(c => getFileUrl(c.fileId)));
      const imagenes = urls.filter(Boolean);
      const colores  = session.albumColors.map(c => c.color);

      producto = {
        id: genId(), nombre: session.titulo, tela: session.tela,
        talles: session.talles, precio: session.precio,
        descripcion: session.descripcion || "", tipo: "otro",
        imagenes, colores, enStock: true, activo: true,
        fechaAgregado: new Date().toISOString(),
      };

      await sendMd(chatId,
        `✅ *¡${producto.nombre} subida con ${imagenes.length} colores!*\n` +
        `🎨 ${colores.join(", ")}\n🧵 ${producto.tela}\n` +
        `📐 ${producto.talles.join(", ")}\n💰 ${fmtPrice(producto.precio)}\n\n_¡Ya está en la web!_ 🎉`
      );

    } else {
      // Prenda única
      const url = await getFileUrl(session.photos[0].fileId);
      producto = {
        id: genId(), nombre: session.titulo, tela: session.tela,
        talles: session.talles, precio: session.precio,
        descripcion: session.descripcion || "", tipo: "otro",
        imagenes: url ? [url] : [], colores: [],
        enStock: true, activo: true,
        fechaAgregado: new Date().toISOString(),
      };

      await sendMd(chatId,
        `✅ *¡${producto.nombre} subida!*\n` +
        `🧵 ${producto.tela}\n📐 ${producto.talles.join(", ")}\n` +
        `💰 ${fmtPrice(producto.precio)}\n\n_¡Ya está en la web!_ 🎉`
      );
    }

    products.unshift(producto);
    await writeDB(products, sha, `Agregar: ${producto.nombre}`);
    await logChange("AGREGAR", `${producto.nombre} | ${fmtPrice(producto.precio)} | Talles: ${producto.talles.join(",")}`);
    resetSession(chatId);

  } catch (err) {
    console.error("[save]", err.message);
    await sendMsg(chatId, `❌ Error al guardar: ${err.message}\n\nUsá /cancelar y probá de nuevo.`);
    resetSession(chatId);
  }
}

async function saveIndivProduct(chatId, session) {
  await sendMsg(chatId, "⏳ Guardando...");
  try {
    const { products, sha } = await readDB();
    const d   = session.indivData;
    const url = await getFileUrl(session.photos[session.indivIdx].fileId);

    const producto = {
      id: genId(), nombre: d.titulo, tela: d.tela,
      talles: session.indivTalles, precio: d.precio,
      descripcion: d.descripcion || "", tipo: "otro",
      imagenes: url ? [url] : [], colores: [],
      enStock: true, activo: true,
      fechaAgregado: new Date().toISOString(),
    };

    products.unshift(producto);
    await writeDB(products, sha, `Agregar: ${producto.nombre}`);
    await logChange("AGREGAR", `${producto.nombre} | ${fmtPrice(producto.precio)}`);
    await sendMd(chatId, `✅ *${producto.nombre}* guardada. 🎉`);

    session.indivIdx++;
    if (session.indivIdx < session.photos.length) {
      await new Promise(r => setTimeout(r, 500));
      await startIndivProduct(chatId, session);
    } else {
      resetSession(chatId);
      await sendMd(chatId, `🎊 *¡Listo! ${session.photos.length} prendas subidas a la web.*`);
    }
  } catch (err) {
    console.error("[saveIndiv]", err.message);
    await sendMsg(chatId, `❌ Error: ${err.message}`);
    resetSession(chatId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 12 — COMANDO: /listar
// ─────────────────────────────────────────────────────────────────────────────

async function handleListar(chatId) {
  try {
    const { products } = await readDB();
    if (!products.length) {
      await sendMsg(chatId, "📭 El catálogo está vacío. Mandame una foto para empezar.");
      return;
    }

    await sendMd(chatId, `📋 *Catálogo — ${products.length} producto(s):*`);

    for (let i = 0; i < products.length; i += 6) {
      const lines = products.slice(i, i+6).map((p, j) => {
        const talles  = Array.isArray(p.talles) ? p.talles.join("/") : (p.talle || "—");
        const colores = p.colores?.length ? ` | 🎨 ${p.colores.join(", ")}` : "";
        const stock   = p.enStock === false ? " ❌ Sin stock" : "";
        return `${i+j+1}. ${tipoEmoji(p.tipo)} *${p.nombre}*${stock} — ${fmtPrice(p.precio)}\n   ${p.tela} | ${talles}${colores}\n   \`${p.id}\``;
      });
      await sendMd(chatId, lines.join("\n\n"));
      if (i + 6 < products.length) await new Promise(r => setTimeout(r, 400));
    }
  } catch (err) {
    await sendMsg(chatId, `❌ Error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 13 — COMANDO: /buscar
// ─────────────────────────────────────────────────────────────────────────────

async function handleBuscar(chatId, session) {
  session.step = "wait_buscar";
  await sendMsg(chatId, "🔍 ¿Qué querés buscar? Escribí el nombre, tela o color:");
}

async function doBuscar(chatId, session, query) {
  try {
    const { products } = await readDB();
    const q        = query.toLowerCase().trim();
    const results  = products.filter(p =>
      p.nombre?.toLowerCase().includes(q) ||
      p.tela?.toLowerCase().includes(q)   ||
      p.colores?.some(c => c.toLowerCase().includes(q)) ||
      p.tipo?.toLowerCase().includes(q)
    );

    if (!results.length) {
      await sendMsg(chatId, `🔍 No encontré nada para "*${query}*". Probá con otro término.`, { parse_mode: "Markdown" });
    } else {
      await sendMd(chatId, `🔍 *${results.length} resultado(s) para "${query}":*`);
      const lines = results.slice(0, 10).map((p, i) => {
        const talles = Array.isArray(p.talles) ? p.talles.join("/") : (p.talle || "—");
        return `${i+1}. ${tipoEmoji(p.tipo)} *${p.nombre}* — ${fmtPrice(p.precio)}\n   ${p.tela} | ${talles}\n   \`${p.id}\``;
      });
      await sendMd(chatId, lines.join("\n\n"));
      if (results.length > 10) await sendMsg(chatId, `_...y ${results.length - 10} más._`, { parse_mode: "Markdown" });
    }
  } catch (err) {
    await sendMsg(chatId, `❌ Error: ${err.message}`);
  }
  resetSession(chatId);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 14 — COMANDO: /stats
// ─────────────────────────────────────────────────────────────────────────────

async function handleStats(chatId) {
  try {
    const { products } = await readDB();

    if (!products.length) {
      await sendMsg(chatId, "📊 El catálogo está vacío, no hay estadísticas todavía.");
      return;
    }

    const total      = products.length;
    const conStock   = products.filter(p => p.enStock !== false).length;
    const sinStock   = total - conStock;
    const precios    = products.map(p => Number(p.precio || 0)).filter(p => p > 0);
    const maxPrecio  = Math.max(...precios);
    const minPrecio  = Math.min(...precios);
    const avgPrecio  = Math.round(precios.reduce((a, b) => a + b, 0) / precios.length);
    const valorTotal = precios.reduce((a, b) => a + b, 0);

    // Contar por tipo
    const porTipo = {};
    products.forEach(p => {
      const t = p.tipo || "otro";
      porTipo[t] = (porTipo[t] || 0) + 1;
    });
    const tipoLines = Object.entries(porTipo)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `  ${tipoEmoji(t)} ${t}: ${n}`)
      .join("\n");

    // Contar colores más usados
    const colorCount = {};
    products.forEach(p => {
      (p.colores || []).forEach(c => {
        colorCount[c] = (colorCount[c] || 0) + 1;
      });
    });
    const topColores = Object.entries(colorCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c, n]) => `${c} (${n})`)
      .join(", ");

    // Última prenda agregada
    const ultima = products[0];

    const msg = [
      `📊 *Estadísticas del catálogo*`,
      ``,
      `📦 Total de prendas: *${total}*`,
      `✅ En stock: *${conStock}* | ❌ Sin stock: *${sinStock}*`,
      ``,
      `💰 *Precios:*`,
      `  Más caro: ${fmtPrice(maxPrecio)}`,
      `  Más barato: ${fmtPrice(minPrecio)}`,
      `  Promedio: ${fmtPrice(avgPrecio)}`,
      `  Valor total del catálogo: ${fmtPrice(valorTotal)}`,
      ``,
      `🏷️ *Por tipo:*`,
      tipoLines,
      topColores ? `\n🎨 *Colores más usados:* ${topColores}` : "",
      ``,
      `🕐 *Última prenda agregada:*`,
      `  ${ultima.nombre} — ${fmtPrice(ultima.precio)}`,
      `  ${fmtDate(ultima.fechaAgregado)}`,
    ].filter(l => l !== undefined).join("\n");

    await sendMd(chatId, msg);

  } catch (err) {
    await sendMsg(chatId, `❌ Error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 15 — COMANDO: /eliminar
// ─────────────────────────────────────────────────────────────────────────────

async function handleEliminarStart(chatId, session) {
  try {
    const { products } = await readDB();
    if (!products.length) { await sendMsg(chatId, "📭 No hay productos para eliminar."); return; }

    session.step = "wait_eliminar_id";
    const list = products.slice(0, 15).map((p, i) =>
      `${i+1}. \`${p.id}\` — *${p.nombre}* (${fmtPrice(p.precio)})`
    ).join("\n");
    const extra = products.length > 15 ? `\n_...y ${products.length - 15} más. Usá /listar para ver todos._` : "";

    await sendMd(chatId,
      `🗑️ *Eliminar producto*\n\nEnviame el ID del producto:\n\n${list}${extra}\n\n_El ID empieza con \`prod\_\`_`
    );
  } catch (err) {
    await sendMsg(chatId, `❌ Error: ${err.message}`);
  }
}

async function handleEliminarId(chatId, session, id) {
  try {
    const { products } = await readDB();
    const p = products.find(x => x.id === id.trim());

    if (!p) {
      await sendMsg(chatId, `⚠️ No encontré ningún producto con el ID: \`${id}\`\n\nUsá /listar para ver los IDs disponibles.`, { parse_mode: "Markdown" });
      return;
    }

    session.deleteId = p.id;
    session.step     = "confirm_eliminar";

    await sendBtnsCustom(chatId,
      `⚠️ *¿Confirmas que querés eliminar esta prenda?*\n\n${tipoEmoji(p.tipo)} *${p.nombre}*\n💰 ${fmtPrice(p.precio)} | 📐 ${Array.isArray(p.talles) ? p.talles.join(", ") : (p.talle || "—")}\n\n_Esta acción no se puede deshacer._`,
      [[{ text: "🗑️ Sí, eliminar", data: "eliminar__confirm" }, { text: "❌ Cancelar", data: "eliminar__cancel" }]],
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await sendMsg(chatId, `❌ Error: ${err.message}`);
    resetSession(chatId);
  }
}

async function doEliminar(chatId, session) {
  try {
    const { products, sha } = await readDB();
    const id  = session.deleteId;
    const p   = products.find(x => x.id === id);
    const upd = products.filter(x => x.id !== id);

    await writeDB(upd, sha, `Eliminar: ${p?.nombre || id}`);
    await logChange("ELIMINAR", `${p?.nombre || id} | ${fmtPrice(p?.precio)}`);
    await sendMd(chatId, `✅ *${p?.nombre || id}* eliminada del catálogo.`);
    resetSession(chatId);
  } catch (err) {
    await sendMsg(chatId, `❌ Error: ${err.message}`);
    resetSession(chatId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 16 — COMANDO: /editar
// ─────────────────────────────────────────────────────────────────────────────

async function handleEditarStart(chatId, session) {
  try {
    const { products } = await readDB();
    if (!products.length) { await sendMsg(chatId, "📭 No hay productos para editar."); return; }

    session.step = "wait_editar_id";
    const list = products.slice(0, 15).map((p, i) =>
      `${i+1}. \`${p.id}\` — *${p.nombre}*`
    ).join("\n");

    await sendMd(chatId, `✏️ *Editar producto*\n\nEnviame el ID del producto:\n\n${list}`);
  } catch (err) {
    await sendMsg(chatId, `❌ Error: ${err.message}`);
  }
}

async function handleEditarId(chatId, session, id) {
  try {
    const { products } = await readDB();
    const p = products.find(x => x.id === id.trim());

    if (!p) {
      await sendMsg(chatId, `⚠️ No encontré el ID: \`${id}\``, { parse_mode: "Markdown" });
      return;
    }

    session.editId   = p.id;
    session.step     = "wait_editar_campo";
    const talles     = Array.isArray(p.talles) ? p.talles.join(", ") : (p.talle || "—");

    await sendBtnsCustom(chatId,
      `✏️ *Editando: ${p.nombre}*\n\n🧵 Tela: ${p.tela}\n📐 Talles: ${talles}\n💰 Precio: ${fmtPrice(p.precio)}\n📄 Desc: ${p.descripcion || "—"}\n\n¿Qué querés cambiar?`,
      [
        [{ text: "🏷️ Nombre",      data: "editcampo__nombre"      }, { text: "🧵 Tela",    data: "editcampo__tela"    }],
        [{ text: "📐 Talles",      data: "editcampo__talles"      }, { text: "💰 Precio",  data: "editcampo__precio"  }],
        [{ text: "📄 Descripción", data: "editcampo__descripcion" }, { text: "🏷️ Tipo",    data: "editcampo__tipo"    }],
        [{ text: "❌ Cancelar",    data: "editcampo__cancelar"    }],
      ],
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await sendMsg(chatId, `❌ Error: ${err.message}`);
    resetSession(chatId);
  }
}

async function doEditar(chatId, session, nuevoValor) {
  try {
    const { products, sha } = await readDB();
    const idx = products.findIndex(x => x.id === session.editId);
    if (idx === -1) { await sendMsg(chatId, "❌ Producto no encontrado."); resetSession(chatId); return; }

    const p     = products[idx];
    const campo = session.editCampo;
    let   prev  = p[campo];

    if (campo === "precio") {
      const price = parsePrice(nuevoValor);
      if (!price) { await sendMsg(chatId, "⚠️ Precio inválido."); return; }
      p.precio = price;
      nuevoValor = fmtPrice(price);
    } else if (campo === "talles") {
      // nuevoValor ya viene seteado como array desde el flujo de talles
      p.talles = session.editTalles;
      nuevoValor = session.editTalles.join(", ");
      prev       = Array.isArray(prev) ? prev.join(", ") : prev;
    } else {
      p[campo] = nuevoValor.trim();
    }

    products[idx] = p;
    await writeDB(products, sha, `Editar ${campo}: ${p.nombre}`);
    await logChange("EDITAR", `${p.nombre} | ${campo}: "${prev}" → "${nuevoValor}"`);
    await sendMd(chatId, `✅ *${p.nombre}* actualizada.\n${campo}: *${nuevoValor}*`);
    resetSession(chatId);

  } catch (err) {
    await sendMsg(chatId, `❌ Error: ${err.message}`);
    resetSession(chatId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 17 — COMANDO: /stock
// ─────────────────────────────────────────────────────────────────────────────

async function handleStockStart(chatId, session) {
  try {
    const { products } = await readDB();
    if (!products.length) { await sendMsg(chatId, "📭 No hay productos."); return; }

    session.step = "wait_stock_id";
    const list = products.slice(0, 15).map((p, i) => {
      const st = p.enStock === false ? "❌" : "✅";
      return `${i+1}. ${st} \`${p.id}\` — *${p.nombre}*`;
    }).join("\n");

    await sendMd(chatId, `📦 *Cambiar stock*\n\n✅ = en stock | ❌ = sin stock\n\n${list}\n\nEnviame el ID para cambiar su estado:`);
  } catch (err) {
    await sendMsg(chatId, `❌ Error: ${err.message}`);
  }
}

async function doToggleStock(chatId, session, id) {
  try {
    const { products, sha } = await readDB();
    const idx = products.findIndex(x => x.id === id.trim());

    if (idx === -1) {
      await sendMsg(chatId, `⚠️ No encontré el ID: \`${id}\``, { parse_mode: "Markdown" });
      return;
    }

    const p        = products[idx];
    p.enStock      = p.enStock === false ? true : false;
    products[idx]  = p;

    await writeDB(products, sha, `Stock: ${p.nombre} → ${p.enStock ? "con stock" : "sin stock"}`);
    await logChange("STOCK", `${p.nombre} → ${p.enStock ? "✅ con stock" : "❌ sin stock"}`);
    await sendMd(chatId,
      `${p.enStock ? "✅" : "❌"} *${p.nombre}* marcada como *${p.enStock ? "con stock" : "sin stock"}*.`
    );
    resetSession(chatId);

  } catch (err) {
    await sendMsg(chatId, `❌ Error: ${err.message}`);
    resetSession(chatId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 18 — COMANDO: /precios (actualización masiva)
// ─────────────────────────────────────────────────────────────────────────────

async function handlePreciosStart(chatId, session) {
  session.step = "wait_precios_tipo";

  const tiposBtns = TIPOS.map(t => [{ text: `${tipoEmoji(t)} ${t}`, data: `preciotipo__${t}` }]);
  tiposBtns.push([{ text: "🔄 Todos los productos", data: "preciotipo__todos" }]);
  tiposBtns.push([{ text: "❌ Cancelar", data: "preciotipo__cancelar" }]);

  await sendBtnsCustom(chatId,
    `💰 *Actualizar precios en masa*\n\n¿A qué categoría querés aplicar el cambio?`,
    tiposBtns, { parse_mode: "Markdown" }
  );
}

async function doUpdatePrecios(chatId, session, pctText) {
  const pct = parseFloat(pctText.replace(",", ".").replace("%", "").trim());

  if (isNaN(pct) || pct === 0 || pct < -90 || pct > 500) {
    await sendMsg(chatId, "⚠️ Porcentaje inválido. Ej: 10 (para subir 10%) o -15 (para bajar 15%).\nRango permitido: -90% a 500%.");
    return;
  }

  try {
    const { products, sha } = await readDB();
    const tipo    = session.preciosTipo;
    let   updated = 0;

    products.forEach((p, i) => {
      if (tipo === "todos" || p.tipo === tipo) {
        const nuevo       = Math.round(Number(p.precio || 0) * (1 + pct / 100));
        products[i].precio = nuevo;
        updated++;
      }
    });

    await writeDB(products, sha, `Precios ${pct > 0 ? "+" : ""}${pct}% en ${tipo}`);
    await logChange("PRECIOS", `${pct > 0 ? "+" : ""}${pct}% en ${updated} prendas (tipo: ${tipo})`);
    await sendMd(chatId,
      `✅ *Precios actualizados*\n\n${pct > 0 ? "📈" : "📉"} ${pct > 0 ? "+" : ""}${pct}% aplicado a *${updated}* prenda(s) (${tipo}).`
    );
    resetSession(chatId);

  } catch (err) {
    await sendMsg(chatId, `❌ Error: ${err.message}`);
    resetSession(chatId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 19 — COMANDO: /historial
// ─────────────────────────────────────────────────────────────────────────────

async function handleHistorial(chatId) {
  try {
    const { entries } = await readLog();

    if (!entries.length) {
      await sendMsg(chatId, "📋 No hay cambios registrados todavía.");
      return;
    }

    const lines = entries.slice(0, 15).map((e, i) => {
      const emoji = { AGREGAR:"➕", ELIMINAR:"🗑️", EDITAR:"✏️", STOCK:"📦", PRECIOS:"💰" }[e.accion] || "•";
      return `${i+1}. ${emoji} *${e.accion}* — ${fmtDate(e.fecha)}\n   _${e.detalle}_`;
    });

    await sendMd(chatId, `📋 *Historial de cambios (últimos ${lines.length}):*\n\n${lines.join("\n\n")}`);

  } catch (err) {
    await sendMsg(chatId, `❌ Error al leer el historial: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 20 — ROUTER DE TEXTO
// ─────────────────────────────────────────────────────────────────────────────

async function handleText(chatId, session, text) {

  // ── Comandos (siempre tienen prioridad) ────────────────────────────────────

  if (text === "/start") {
    resetSession(chatId);
    await sendMd(chatId,
      `🛍️ *¡Hola Sofy! Soy tu bot de catálogo.*\n\n` +
      `Mandame una foto para subir una prenda, o usá un comando:\n\n` +
      `📸 *Foto* → Subir prenda\n` +
      `*/listar* → Ver todos los productos\n` +
      `*/buscar* → Buscar por nombre/tela/color\n` +
      `*/stats* → Estadísticas del catálogo\n` +
      `*/editar* → Editar un producto\n` +
      `*/eliminar* → Eliminar un producto\n` +
      `*/stock* → Cambiar estado de stock\n` +
      `*/precios* → Actualizar precios en masa\n` +
      `*/historial* → Ver últimos cambios\n` +
      `*/cancelar* → Cancelar operación actual`
    );
    return;
  }

  if (text === "/cancelar") {
    resetSession(chatId);
    await sendMsg(chatId, "❌ Cancelado. Cuando quieras, mandame una foto o usá un comando.");
    return;
  }

  if (text === "/ayuda") {
    await sendMd(chatId,
      `📖 *Guía de uso:*\n\n` +
      `📸 *1 foto* → Tela → Talles (checkboxes) → Precio → Título → Descripción\n\n` +
      `📸📸 *Varias fotos juntas* →\n` +
      `  🎨 Mismo modelo → Gemini detecta el color de cada foto automáticamente\n` +
      `  📦 Prendas distintas → Pregunto cada una por separado\n\n` +
      `Para los talles podés activar varios con checkboxes.\n\n` +
      `*/stats* muestra precios, cantidades, colores más usados y más.\n` +
      `*/historial* registra todos los cambios con fecha.\n` +
      `*/precios* sube o baja precios en % para una categoría o todos.\n\n` +
      `/cancelar en cualquier momento para reiniciar.`
    );
    return;
  }

  if (text === "/listar")   { await handleListar(chatId); return; }
  if (text === "/stats")    { await handleStats(chatId);  return; }
  if (text === "/historial") { await handleHistorial(chatId); return; }
  if (text === "/buscar")   { await handleBuscar(chatId, session); return; }
  if (text === "/eliminar") { await handleEliminarStart(chatId, session); return; }
  if (text === "/editar")   { await handleEditarStart(chatId, session);   return; }
  if (text === "/stock")    { await handleStockStart(chatId, session);    return; }
  if (text === "/precios")  { await handlePreciosStart(chatId, session);  return; }

  // ── Flujos según el step activo ────────────────────────────────────────────

  // Búsqueda
  if (session.step === "wait_buscar") {
    await doBuscar(chatId, session, text);
    return;
  }

  // Eliminar: recibir ID
  if (session.step === "wait_eliminar_id") {
    await handleEliminarId(chatId, session, text);
    return;
  }

  // Editar: recibir ID
  if (session.step === "wait_editar_id") {
    await handleEditarId(chatId, session, text);
    return;
  }

  // Editar: recibir nuevo valor (texto libre)
  if (session.step === "wait_editar_valor" && session.editCampo !== "talles") {
    await doEditar(chatId, session, text);
    return;
  }

  // Stock: recibir ID
  if (session.step === "wait_stock_id") {
    await doToggleStock(chatId, session, text);
    return;
  }

  // Precios: recibir porcentaje
  if (session.step === "wait_precios_pct") {
    await doUpdatePrecios(chatId, session, text);
    return;
  }

  // Precio escrito como texto (en lugar de usar el botón)
  if (session.step === "wait_precio") {
    const price = parsePrice(text);
    if (!price) { await sendMsg(chatId, "⚠️ Precio inválido. Ej: 15000 o $15.000"); return; }
    session.precio = price;
    session.step   = "wait_titulo";
    await askTitulo(chatId);
    return;
  }

  if (session.step === "wait_indiv_precio") {
    const price = parsePrice(text);
    if (!price) { await sendMsg(chatId, "⚠️ Precio inválido."); return; }
    session.indivData.precio = price;
    session.step             = "wait_indiv_titulo";
    await askTitulo(chatId, `*Prenda ${session.indivIdx+1}* — `);
    return;
  }

  // Título
  if (session.step === "wait_titulo") {
    if (!text || text.trim().length < 2) { await sendMsg(chatId, "⚠️ Nombre muy corto."); return; }
    session.titulo = text.trim();
    session.step   = "wait_desc";
    await askDesc(chatId);
    return;
  }

  if (session.step === "wait_indiv_titulo") {
    if (!text || text.trim().length < 2) { await sendMsg(chatId, "⚠️ Nombre muy corto."); return; }
    session.indivData.titulo = text.trim();
    session.step             = "wait_indiv_desc";
    await askDesc(chatId);
    return;
  }

  // Descripción como texto
  if (session.step === "wait_desc") {
    session.descripcion = text.trim();
    await saveProduct(chatId, session);
    return;
  }

  if (session.step === "wait_indiv_desc") {
    session.indivData.descripcion = text.trim();
    await saveIndivProduct(chatId, session);
    return;
  }

  // Color escrito a mano
  if (session.step === "wait_color_pick" || session.step === "wait_color_edit") {
    if (!text || text.trim().length < 2) { await sendMsg(chatId, "⚠️ Escribí el nombre del color."); return; }
    await confirmColor(chatId, session, text.trim());
    return;
  }

  // Sin contexto
  if (session.step === "idle") {
    await sendMsg(chatId, "👋 Mandame una foto para subir una prenda, o usá /start para ver los comandos.");
    return;
  }

  await sendMsg(chatId, "No entendí eso. Usá /cancelar para reiniciar.");
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 21 — ROUTER DE CALLBACKS
// ─────────────────────────────────────────────────────────────────────────────

async function handleCallback(chatId, session, cbId, data) {
  await answerCb(cbId);

  // ── Álbum o individual ────────────────────────────────────────────────────
  if (data === "🎨 Mismo modelo, distintos colores") {
    session.mode = "album";
    await startAlbum(chatId, session);
    return;
  }
  if (data === "📦 Son prendas distintas") {
    session.mode = "individual";
    await startIndividual(chatId, session);
    return;
  }

  // ── Reenviar foto (modo individual) ───────────────────────────────────────
  if (data.startsWith("reenviar__")) {
    const idx = parseInt(data.split("__")[1], 10);
    if (session.photos[idx]) await sendPhoto(chatId, session.photos[idx].fileId, `📷 Foto ${idx+1}`);
    return;
  }

  // ── Arrancar modo individual ───────────────────────────────────────────────
  if (data === "individual__start") {
    await startIndivProduct(chatId, session);
    return;
  }

  // ── Color detectado por Gemini ─────────────────────────────────────────────
  if (data.startsWith("colorok__")) {
    await confirmColor(chatId, session, data.replace("colorok__", ""));
    return;
  }
  if (data === "color_edit") {
    session.step = "wait_color_edit";
    await sendMsg(chatId, "¿Cuál es el color correcto? Elegí o escribilo:");
    await sendColorPicker(chatId);
    return;
  }
  if ((session.step === "wait_color_pick" || session.step === "wait_color_edit") && COLORES.includes(data)) {
    await confirmColor(chatId, session, data);
    return;
  }

  // ── Tela ───────────────────────────────────────────────────────────────────
  if (TELAS.includes(data)) {
    if (session.step === "wait_tela") {
      session.tela = data; session.step = "wait_talles";
      await sendTallesKb(chatId, session.talles);
    } else if (session.step === "wait_indiv_tela") {
      session.indivData.tela = data; session.step = "wait_indiv_talles";
      await sendTallesKb(chatId, session.indivTalles, `*Prenda ${session.indivIdx+1}* — `);
    } else if (session.step === "wait_editar_valor" && session.editCampo === "tela") {
      await doEditar(chatId, session, data);
    }
    return;
  }

  // ── Talles: toggle checkbox ────────────────────────────────────────────────
  if (data.startsWith("talle__")) {
    const talle = data.replace("talle__", "");

    if (session.step === "wait_talles") {
      const idx = session.talles.indexOf(talle);
      if (idx >= 0) session.talles.splice(idx, 1); else session.talles.push(talle);
      await sendTallesKb(chatId, session.talles);

    } else if (session.step === "wait_indiv_talles") {
      const idx = session.indivTalles.indexOf(talle);
      if (idx >= 0) session.indivTalles.splice(idx, 1); else session.indivTalles.push(talle);
      await sendTallesKb(chatId, session.indivTalles, `*Prenda ${session.indivIdx+1}* — `);

    } else if (session.step === "wait_editar_valor" && session.editCampo === "talles") {
      const idx = session.editTalles.indexOf(talle);
      if (idx >= 0) session.editTalles.splice(idx, 1); else session.editTalles.push(talle);
      // Mostrar teclado actualizado
      await sendBtnsCustom(chatId,
        `📐 *Editando talles* — Seleccioná los nuevos talles:`,
        buildTallesRows(session.editTalles),
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  // ── Confirmar talles ───────────────────────────────────────────────────────
  if (data === "talles__ok") {
    if (session.step === "wait_talles") {
      if (!session.talles.length) { await sendMsg(chatId, "⚠️ Seleccioná al menos un talle."); return; }
      session.step = "wait_precio";
      await askPrecio(chatId);
    } else if (session.step === "wait_indiv_talles") {
      if (!session.indivTalles.length) { await sendMsg(chatId, "⚠️ Seleccioná al menos un talle."); return; }
      session.step = "wait_indiv_precio";
      await askPrecio(chatId, `*Prenda ${session.indivIdx+1}* — `);
    } else if (session.step === "wait_editar_valor" && session.editCampo === "talles") {
      if (!session.editTalles.length) { await sendMsg(chatId, "⚠️ Seleccioná al menos un talle."); return; }
      await doEditar(chatId, session, session.editTalles.join(", "));
    }
    return;
  }
  if (data === "talles__none") {
    await sendMsg(chatId, "⚠️ Tocá al menos un talle antes de confirmar.");
    return;
  }

  // ── Precio ─────────────────────────────────────────────────────────────────
  if (PRECIOS.includes(data)) {
    if (data === "✏️ Otro") { await sendMsg(chatId, "💰 Escribí el precio (ej: 15000):"); return; }
    const price = parsePrice(data);
    if (!price) return;

    if (session.step === "wait_precio") {
      session.precio = price; session.step = "wait_titulo"; await askTitulo(chatId);
    } else if (session.step === "wait_indiv_precio") {
      session.indivData.precio = price; session.step = "wait_indiv_titulo";
      await askTitulo(chatId, `*Prenda ${session.indivIdx+1}* — `);
    } else if (session.step === "wait_editar_valor" && session.editCampo === "precio") {
      await doEditar(chatId, session, String(price));
    }
    return;
  }

  // ── Descripción ────────────────────────────────────────────────────────────
  if (data === "⏭️ No, saltar") {
    if (session.step === "wait_desc") {
      session.descripcion = ""; await saveProduct(chatId, session);
    } else if (session.step === "wait_indiv_desc") {
      session.indivData.descripcion = ""; await saveIndivProduct(chatId, session);
    }
    return;
  }
  if (data === "✏️ Sí, agregar") {
    await sendMsg(chatId, "📄 Escribí la descripción:");
    return;
  }

  // ── Eliminar: confirmar/cancelar ───────────────────────────────────────────
  if (data === "eliminar__confirm") { await doEliminar(chatId, session); return; }
  if (data === "eliminar__cancel")  { resetSession(chatId); await sendMsg(chatId, "❌ Eliminación cancelada."); return; }

  // ── Editar: elegir campo ───────────────────────────────────────────────────
  if (data.startsWith("editcampo__")) {
    const campo = data.replace("editcampo__", "");
    if (campo === "cancelar") { resetSession(chatId); await sendMsg(chatId, "❌ Edición cancelada."); return; }

    session.editCampo = campo;
    session.editTalles = [];
    session.step = "wait_editar_valor";

    const prompts = {
      nombre:      "📝 Escribí el nuevo nombre:",
      tela:        "🧵 Elegí la nueva tela:",
      precio:      "💰 Escribí el nuevo precio (ej: 15000):",
      descripcion: "📄 Escribí la nueva descripción (o enviá un punto para borrarla):",
    };

    if (campo === "tela") {
      await sendBtns(chatId, prompts.tela, [TELAS.slice(0,5), TELAS.slice(5)]);
    } else if (campo === "talles") {
      await sendBtnsCustom(chatId,
        `📐 *Seleccioná los nuevos talles:*`,
        buildTallesRows([]),
        { parse_mode: "Markdown" }
      );
    } else if (campo === "precio") {
      await sendBtns(chatId, prompts.precio, [PRECIOS.slice(0,4), PRECIOS.slice(4)]);
    } else if (campo === "tipo") {
      await sendBtns(chatId, "🏷️ Elegí el nuevo tipo:",
        [TIPOS.slice(0,4), TIPOS.slice(4)]
      );
    } else {
      await sendMsg(chatId, prompts[campo] || `Escribí el nuevo valor para ${campo}:`);
    }
    return;
  }

  // ── Editar: tipo ───────────────────────────────────────────────────────────
  if (session.step === "wait_editar_valor" && session.editCampo === "tipo" && TIPOS.includes(data)) {
    await doEditar(chatId, session, data);
    return;
  }

  // ── Precios masivos: elegir tipo ───────────────────────────────────────────
  if (data.startsWith("preciotipo__")) {
    const tipo = data.replace("preciotipo__", "");
    if (tipo === "cancelar") { resetSession(chatId); await sendMsg(chatId, "❌ Cancelado."); return; }
    session.preciosTipo = tipo;
    session.step        = "wait_precios_pct";
    await sendMsg(chatId,
      `💰 ¿En qué porcentaje querés cambiar los precios de *${tipo}*?\n\nEjemplos:\n• Subir 10% → escribí: 10\n• Bajar 15% → escribí: -15`,
      { parse_mode: "Markdown" }
    );
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECCIÓN 22 — ENTRY POINT (Netlify Function Handler)
// ─────────────────────────────────────────────────────────────────────────────

exports.handler = async event => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, body: "Method Not Allowed" };
  if (!BOT_TOKEN) { console.error("TELEGRAM_BOT_TOKEN no configurado"); return { statusCode: 500, body: "Token missing" }; }

  let update;
  try { update = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: "Bad request" }; }

  console.log(`[${update.update_id}]`, update.message ? `msg:"${update.message.text || "foto"}"` : update.callback_query ? `cb:"${update.callback_query.data}"` : "?");

  try {

    // Callback query (botón presionado)
    if (update.callback_query) {
      const cb     = update.callback_query;
      const chatId = String(cb.message.chat.id);
      if (OWNER_ID && chatId !== OWNER_ID) { await answerCb(cb.id); return { statusCode: 200, body: "ok" }; }
      await handleCallback(chatId, getSession(chatId), cb.id, cb.data);
      return { statusCode: 200, body: "ok" };
    }

    // Mensaje
    if (update.message) {
      const msg    = update.message;
      const chatId = String(msg.chat.id);

      if (OWNER_ID && chatId !== OWNER_ID) {
        await sendMsg(chatId, "⛔ Este bot es privado. Solo puede usarlo la dueña de Sofy MDN.");
        return { statusCode: 200, body: "ok" };
      }

      const session = getSession(chatId);

      if (msg.photo)    { await handlePhoto(chatId, session, msg); return { statusCode: 200, body: "ok" }; }
      if (msg.text)     { await handleText(chatId, session, msg.text.trim()); return { statusCode: 200, body: "ok" }; }
      if (msg.document) { await sendMsg(chatId, "📎 Enviame la foto directamente, no como archivo adjunto."); return { statusCode: 200, body: "ok" }; }
    }

  } catch (err) {
    console.error("[Handler]", err.message, err.stack);
    if (OWNER_ID) {
      try { await sendMsg(OWNER_ID, `⚠️ Error en el bot: ${err.message}\n\nUsá /cancelar y probá de nuevo.`); } catch {}
    }
  }

  // Siempre responder 200 (Telegram reintenta si recibe otro código)
  return { statusCode: 200, headers, body: "ok" };
};
