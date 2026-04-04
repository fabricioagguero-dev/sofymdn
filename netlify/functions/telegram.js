// =============================================================================
// BOT DE TELEGRAM — SOFY MDN
// Netlify Function | Node.js nativo
//
// VARIABLES DE ENTORNO REQUERIDAS EN NETLIFY:
//   TELEGRAM_BOT_TOKEN  → Token del bot (@BotFather)
//   OWNER_ID            → Tu chat_id de Telegram
//   GITHUB_TOKEN        → Personal Access Token de GitHub
//   GITHUB_REPO         → usuario/repositorio
//   GITHUB_FILE_PATH    → data/products.json
//   GEMINI_API_KEY      → API Key de Google Gemini (aistudio.google.com)
//
// FLUJO PRENDA ÚNICA:
//   Foto → Tela → Talle → Precio → Título → Descripción → Guardar
//
// FLUJO ÁLBUM (varias fotos = colores del mismo modelo):
//   Fotos → "¿Mismo modelo?" → Sí:
//     Gemini detecta colores de cada foto → dueña confirma/corrige
//     → Tela → Talle → Precio → Título → Descripción → Guardar todo
//
// FLUJO INDIVIDUAL (varias fotos = prendas distintas):
//   Fotos → "¿Mismo modelo?" → No:
//     Bot avisa orden (la más alta es la 1, etc.) + botón "¿No recordás?"
//     → Pregunta cada prenda por separado
// =============================================================================

"use strict";

const https = require("https");

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURACIÓN
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID     = String(process.env.OWNER_ID || "");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO;
const GITHUB_FILE  = process.env.GITHUB_FILE_PATH;
const GEMINI_KEY   = process.env.GEMINI_API_KEY;

// Tiempo de espera para acumular fotos de un media_group (ms)
const MEDIA_GROUP_WAIT = 2500;

// ─────────────────────────────────────────────────────────────────────────────
// OPCIONES DE BOTONES
// ─────────────────────────────────────────────────────────────────────────────

const TELAS = [
  "Algodón", "Modal", "Lycra", "Jean",
  "Lino",    "Saten", "Tul",   "Cuerina",
  "Polar",   "Otra",
];

const TALLES = ["XS", "S", "M", "L", "XL", "XXL", "Único"];

const PRECIOS = [
  "$5.000", "$8.000", "$10.000", "$12.000",
  "$15.000", "$18.000", "$20.000", "Otro precio",
];

// Colores sugeridos si Gemini falla o no está configurado
const COLORES_FALLBACK = [
  "Blanco", "Negro", "Gris", "Beige", "Camello",
  "Rosa",   "Rojo",  "Azul", "Verde", "Violeta",
  "Amarillo", "Naranja", "Bordo", "Celeste", "Otro",
];

// ─────────────────────────────────────────────────────────────────────────────
// SESIONES EN MEMORIA
// ─────────────────────────────────────────────────────────────────────────────

const sessions = {};

function emptySession() {
  return {
    // Estado principal del flujo
    step: "idle",
    // idle | wait_tela | wait_talle | wait_precio | wait_titulo | wait_desc
    // wait_album_answer | wait_color_confirm | wait_color_edit
    // individual_intro | wait_individual_tela | wait_individual_talle
    // wait_individual_precio | wait_individual_titulo | wait_individual_desc

    // Modo de carga
    mode: null, // "single" | "album" | "individual"

    // Fotos recibidas: [{ fileId, index, dimensions }]
    photos: [],
    mediaGroup: null,

    // Datos de la prenda (modo single/album)
    tela:       null,
    talle:      null,
    precio:     null,
    titulo:     null,
    descripcion: null,

    // Datos del álbum: colores detectados por Gemini
    // [{ fileId, colorSugerido, colorConfirmado }]
    albumColors: [],
    albumColorIdx: 0, // índice del color que estamos confirmando

    // Modo individual: índice de la prenda que estamos procesando
    individualIdx: 0,
    // Datos temporales para la prenda individual en curso
    indivData: {},
  };
}

function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = emptySession();
  return sessions[chatId];
}

function resetSession(chatId) {
  sessions[chatId] = emptySession();
}

// ─────────────────────────────────────────────────────────────────────────────
// GITHUB API
// ─────────────────────────────────────────────────────────────────────────────

function githubRequest(method, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.github.com",
      path:     `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      method,
      headers: {
        "Authorization": `token ${GITHUB_TOKEN}`,
        "Accept":        "application/vnd.github.v3+json",
        "User-Agent":    "SofyMDN-Bot/1.0",
        "Content-Type":  "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
      timeout: 15000,
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", d => { raw += d; });
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

async function readProducts() {
  const { status, data } = await githubRequest("GET");
  if (status === 404) return { products: [], sha: null };
  if (status !== 200 || !data?.content) throw new Error(`GitHub GET: ${status}`);

  const raw = Buffer.from(data.content, "base64").toString("utf8").trim();
  if (!raw) return { products: [], sha: data.sha };

  let products;
  try {
    products = JSON.parse(raw);
    if (!Array.isArray(products)) products = products.products || [];
  } catch { products = []; }

  return { products, sha: data.sha };
}

async function saveProducts(products, sha, message) {
  const base64 = Buffer.from(JSON.stringify(products, null, 2)).toString("base64");
  const body   = { message, content: base64, ...(sha ? { sha } : {}) };
  const { status, data } = await githubRequest("PUT", body);
  if (status !== 200 && status !== 201) {
    throw new Error(`GitHub PUT: ${status} — ${data?.message || "error"}`);
  }
  return true;
}

function generateId() {
  return `prod_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM API
// ─────────────────────────────────────────────────────────────────────────────

function callTelegram(method, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const opts = {
      hostname: "api.telegram.org",
      path:     `/bot${BOT_TOKEN}/${method}`,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 10000,
    };
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", d => { raw += d; });
      res.on("end", () => {
        try {
          const p = JSON.parse(raw);
          if (!p.ok) console.error(`[TG ${method}]`, p.description);
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

// Enviar texto plano
function sendMsg(chatId, text, extra = {}) {
  return callTelegram("sendMessage", { chat_id: chatId, text, ...extra });
}

// Enviar markdown
function sendMd(chatId, text, extra = {}) {
  return callTelegram("sendMessage", {
    chat_id: chatId, text, parse_mode: "Markdown", ...extra,
  });
}

// Enviar foto con caption
function sendPhoto(chatId, fileId, caption = "", extra = {}) {
  return callTelegram("sendPhoto", {
    chat_id: chatId, photo: fileId,
    ...(caption ? { caption } : {}),
    ...extra,
  });
}

// Enviar botones inline
function sendButtons(chatId, text, buttonRows, extra = {}) {
  const inline_keyboard = buttonRows.map(row =>
    row.map(label => ({ text: label, callback_data: label }))
  );
  return callTelegram("sendMessage", {
    chat_id: chatId, text,
    reply_markup: { inline_keyboard },
    ...extra,
  });
}

// Confirmar callback (quita el relojito del botón)
function answerCb(id, text = "") {
  return callTelegram("answerCallbackQuery", {
    callback_query_id: id,
    ...(text ? { text } : {}),
  });
}

// Obtener URL descargable de un archivo
function getFileUrl(fileId) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ file_id: fileId });
    const opts = {
      hostname: "api.telegram.org",
      path:     `/bot${BOT_TOKEN}/getFile`,
      method:   "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 10000,
    };
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", d => { raw += d; });
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

// Obtener info de dimensiones de una foto (para ordenarlas)
function getFileInfo(fileId) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ file_id: fileId });
    const opts = {
      hostname: "api.telegram.org",
      path:     `/bot${BOT_TOKEN}/getFile`,
      method:   "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 10000,
    };
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", d => { raw += d; });
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ ok: false }); }
      });
    });
    req.on("error",   () => resolve({ ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI API — Detectar color de una imagen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Descarga la imagen de Telegram y la manda a Gemini para detectar el color.
 * Devuelve un string con el/los colores detectados, o null si falla.
 */
async function detectColorWithGemini(fileId) {
  if (!GEMINI_KEY) return null;

  try {
    // 1. Obtener URL de la imagen
    const url = await getFileUrl(fileId);
    if (!url) return null;

    // 2. Descargar la imagen como buffer
    const imageBuffer = await downloadImage(url);
    if (!imageBuffer) return null;

    const base64Image = imageBuffer.toString("base64");

    // 3. Llamar a Gemini con la imagen
    const prompt = `Mirá esta foto de una prenda de ropa. 
Describí SOLO el color o colores principales de la prenda en 1-3 palabras en español.
Usá nombres de colores comunes y específicos como: blanco, negro, gris, beige, camello, rosa, fucsia, rojo, bordo, azul, celeste, marino, verde, oliva, amarillo, naranja, violeta, lila, marron, tostado, crema.
Respondé ÚNICAMENTE con el nombre del color, sin puntos ni explicaciones adicionales.
Ejemplo de respuesta: "Rosa viejo" o "Azul marino" o "Beige"`;

    const geminiBody = JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: base64Image,
            },
          },
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 20,
      },
    });

    const result = await callGemini(geminiBody);
    return result;

  } catch (e) {
    console.error("[Gemini] Error:", e.message);
    return null;
  }
}

function downloadImage(url) {
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error",   () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.setTimeout(15000);
  });
}

function callGemini(body) {
  return new Promise((resolve) => {
    const opts = {
      hostname: "generativelanguage.googleapis.com",
      path:     `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 20000,
    };
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", d => { raw += d; });
      res.on("end", () => {
        try {
          const data  = JSON.parse(raw);
          const text  = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          resolve(text || null);
        } catch { resolve(null); }
      });
    });
    req.on("error",   () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS DE PRECIO
// ─────────────────────────────────────────────────────────────────────────────

function parsePrice(text) {
  const cleaned = String(text).replace(/[$\s]/g, "").replace(/\./g, "").replace(",", ".");
  const num     = parseFloat(cleaned);
  return (!isNaN(num) && num > 0) ? Math.round(num) : null;
}

function formatPrice(num) {
  return `$${Number(num || 0).toLocaleString("es-AR")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// FLUJO: RECIBIR FOTOS
// ─────────────────────────────────────────────────────────────────────────────

async function handlePhoto(chatId, session, message) {
  // Ignorar si ya hay un flujo activo
  if (session.step !== "idle") {
    await sendMsg(chatId, "⚠️ Ya estoy procesando algo. Usá /cancelar para reiniciar.");
    return;
  }

  // Foto con mejor resolución disponible
  const photo  = message.photo;
  const fileId = photo[photo.length - 1].file_id;
  // Dimensiones de esta versión
  const width  = photo[photo.length - 1].width  || 0;
  const height = photo[photo.length - 1].height || 0;
  const mgId   = message.media_group_id;

  session.photos.push({ fileId, width, height, index: session.photos.length });

  // ── Foto suelta (sin álbum) ──────────────────────────────────────────────
  if (!mgId) {
    session.mode   = "single";
    session.step   = "wait_tela";
    await sendMsg(chatId, "📸 ¡Foto recibida!");
    await askTela(chatId);
    return;
  }

  // ── Parte de un álbum ────────────────────────────────────────────────────
  if (session.mediaGroup !== mgId) {
    session.mediaGroup = mgId;
    session.step       = "accumulating";
    await sendMsg(chatId, "📸 Recibiendo fotos...");

    // Esperar a que lleguen todas
    await new Promise(r => setTimeout(r, MEDIA_GROUP_WAIT));

    const count = session.photos.length;

    // Ordenar por altura descendente (la más larga primero = foto 1)
    // Esto da una referencia visual clara a la dueña
    session.photos.sort((a, b) => b.height - a.height);
    // Reasignar índices según el nuevo orden
    session.photos.forEach((p, i) => { p.index = i + 1; });

    await sendButtons(
      chatId,
      `📸 Recibí *${count} foto(s)*.\n\n¿Son todas del mismo modelo en distintos colores, o son prendas distintas?`,
      [
        ["🎨 Mismo modelo — distintos colores"],
        ["📦 Son prendas distintas"],
      ],
      { parse_mode: "Markdown" }
    );
    session.step = "wait_album_answer";
  }
  // Si ya estamos acumulando, la foto se agregó arriba
}

// ─────────────────────────────────────────────────────────────────────────────
// FLUJO ÁLBUM — Detección de colores con Gemini
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inicia el proceso de confirmación de colores.
 * Para cada foto, Gemini sugiere un color y la dueña confirma o corrige.
 */
async function startColorDetection(chatId, session) {
  session.step          = "wait_color_confirm";
  session.albumColorIdx = 0;
  session.albumColors   = session.photos.map(p => ({
    fileId:          p.fileId,
    index:           p.index,
    colorSugerido:   null,
    colorConfirmado: null,
  }));

  await sendMsg(chatId, "🎨 Perfecto! Voy a analizar los colores de cada foto con IA. Un momento...");
  await processNextColor(chatId, session);
}

/**
 * Procesa la foto actual del álbum:
 * 1. Manda la foto a Gemini para detectar el color
 * 2. Muestra la foto + el color sugerido con botones para confirmar/editar
 */
async function processNextColor(chatId, session) {
  const idx    = session.albumColorIdx;
  const item   = session.albumColors[idx];
  const total  = session.albumColors.length;

  // Reenviar la foto para que la dueña la vea
  await sendPhoto(chatId, item.fileId, `📷 Foto ${idx + 1} de ${total}`);

  // Detectar color con Gemini
  await sendMsg(chatId, "🔍 Analizando color...");
  const colorDetectado = await detectColorWithGemini(item.fileId);
  item.colorSugerido   = colorDetectado || "No detectado";

  if (colorDetectado) {
    // Gemini detectó un color — pedir confirmación
    await sendButtons(
      chatId,
      `🎨 *Foto ${idx + 1} de ${total}*\n\nGemini detectó: *${colorDetectado}*\n\n¿Es correcto?`,
      [
        [`✅ Sí, es ${colorDetectado}`],
        ["✏️ No, quiero corregirlo"],
      ],
      { parse_mode: "Markdown" }
    );
    session.step = "wait_color_confirm";
  } else {
    // Gemini falló — mostrar lista de colores para elegir
    await sendMsg(chatId, `🎨 *Foto ${idx + 1} de ${total}*\n\n¿De qué color es esta prenda?`, { parse_mode: "Markdown" });
    await showColorPicker(chatId);
    session.step = "wait_color_pick";
  }
}

/**
 * Muestra el selector de colores con botones inline.
 */
async function showColorPicker(chatId) {
  // Organizar en filas de 3
  const rows = [];
  for (let i = 0; i < COLORES_FALLBACK.length; i += 3) {
    rows.push(COLORES_FALLBACK.slice(i, i + 3));
  }
  await sendButtons(chatId, "Elegí el color:", rows);
}

/**
 * Avanza al siguiente color o termina si ya procesamos todos.
 */
async function advanceColorOrFinish(chatId, session) {
  session.albumColorIdx++;

  if (session.albumColorIdx < session.albumColors.length) {
    // Hay más fotos por colorear
    await processNextColor(chatId, session);
  } else {
    // Terminamos con los colores — mostrar resumen y seguir con tela
    const resumen = session.albumColors
      .map(c => `Foto ${c.index}: *${c.colorConfirmado}*`)
      .join("\n");

    await sendMd(
      chatId,
      `✅ *Colores confirmados:*\n${resumen}\n\nAhora necesito los datos de la prenda.`
    );

    session.step = "wait_tela";
    await askTela(chatId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FLUJO INDIVIDUAL — Prendas distintas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Muestra el intro del modo individual explicando el orden de las fotos.
 */
async function showIndividualIntro(chatId, session) {
  const count = session.photos.length;

  // Construir descripción del orden basada en dimensiones
  const descripcionFotos = session.photos.map((p, i) => {
    const aspecto = p.height > p.width
      ? "📱 más alta que ancha"
      : p.width > p.height
      ? "📸 más ancha que alta"
      : "⬛ cuadrada";
    return `*Foto ${i + 1}:* ${aspecto}`;
  }).join("\n");

  await sendMd(
    chatId,
    `📦 *Modo prendas individuales — ${count} fotos*\n\n` +
    `Para que sepas cuál es cuál, las ordené así (la más alta primero):\n\n` +
    `${descripcionFotos}\n\n` +
    `¿Querés que te reenvíe alguna para recordarla?`,
    {
      reply_markup: {
        inline_keyboard: [
          ...session.photos.map((_, i) => [
            { text: `🔁 Ver foto ${i + 1}`, callback_data: `reenviar__${i}` },
          ]),
          [{ text: "▶️ Arrancar sin ver", callback_data: "individual__start" }],
        ],
      },
    }
  );
  session.step = "individual_intro";
}

/**
 * Inicia las preguntas para la prenda individual actual.
 */
async function startIndividualProduct(chatId, session) {
  const idx   = session.individualIdx;
  const total = session.photos.length;

  session.indivData = {};
  session.step      = "wait_individual_tela";

  // Reenviar la foto de esta prenda
  await sendPhoto(
    chatId,
    session.photos[idx].fileId,
    `📦 Prenda ${idx + 1} de ${total}`
  );

  await askTela(chatId, `🧵 *Prenda ${idx + 1} de ${total}* — ¿De qué tela es?`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PREGUNTAS COMUNES
// ─────────────────────────────────────────────────────────────────────────────

async function askTela(chatId, texto = "🧵 *¿De qué tela es la prenda?*") {
  const rows = [];
  for (let i = 0; i < TELAS.length; i += 5) rows.push(TELAS.slice(i, i + 5));
  await sendButtons(chatId, texto, rows, { parse_mode: "Markdown" });
}

async function askTalle(chatId, texto = "📐 *¿Qué talle tiene?*") {
  const rows = [TALLES.slice(0, 4), TALLES.slice(4)];
  await sendButtons(chatId, texto, rows, { parse_mode: "Markdown" });
}

async function askPrecio(chatId, texto = "💰 *¿Cuánto cuesta?*\nElegí o escribí el número:") {
  const rows = [PRECIOS.slice(0, 4), PRECIOS.slice(4)];
  await sendButtons(chatId, texto, rows, { parse_mode: "Markdown" });
}

async function askTitulo(chatId, texto = "🏷️ *¿Cuál es el nombre de esta prenda?*\n_Ej: Remera oversize, Vestido floral..._") {
  await sendMsg(chatId, texto, { parse_mode: "Markdown" });
}

async function askDesc(chatId) {
  await sendButtons(
    chatId,
    "📄 *¿Querés agregar una descripción?*",
    [["✏️ Sí, agregar descripción", "⏭️ No, saltar"]],
    { parse_mode: "Markdown" }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GUARDAR PRODUCTO(S)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Guarda una prenda simple o un álbum de colores en GitHub.
 */
async function saveProduct(chatId, session) {
  await sendMsg(chatId, "⏳ Guardando en GitHub...");

  try {
    const { products, sha } = await readProducts();

    if (session.mode === "album") {
      // ── ÁLBUM: guardar UNA prenda con múltiples imágenes (una por color) ──
      const imagenes = await Promise.all(
        session.albumColors.map(async c => ({
          url:   await getFileUrl(c.fileId),
          color: c.colorConfirmado,
        }))
      );

      const producto = {
        id:           generateId(),
        nombre:       session.titulo,
        tela:         session.tela,
        talle:        session.talle,
        precio:       session.precio,
        descripcion:  session.descripcion || "",
        tipo:         "otro",
        // Cada imagen tiene su URL y el color asociado
        imagenes:     imagenes.filter(i => i.url).map(i => i.url),
        colores:      imagenes.filter(i => i.url).map(i => i.color),
        activo:       true,
        fechaAgregado: new Date().toISOString(),
      };

      products.unshift(producto);
      await saveProducts(products, sha, `Agregar álbum: ${producto.nombre}`);

      const coloresList = producto.colores.join(", ");
      await sendMd(
        chatId,
        `✅ *¡${producto.nombre} subida con ${producto.imagenes.length} colores!*\n\n` +
        `🎨 Colores: ${coloresList}\n` +
        `🧵 Tela: ${producto.tela}\n` +
        `📐 Talle: ${producto.talle}\n` +
        `💰 Precio: ${formatPrice(producto.precio)}\n\n` +
        `_¡Ya está visible en la web!_ 🎉`
      );

    } else {
      // ── PRENDA ÚNICA ──────────────────────────────────────────────────────
      const url = await getFileUrl(session.photos[0].fileId);

      const producto = {
        id:           generateId(),
        nombre:       session.titulo,
        tela:         session.tela,
        talle:        session.talle,
        precio:       session.precio,
        descripcion:  session.descripcion || "",
        tipo:         "otro",
        imagenes:     url ? [url] : [],
        colores:      [],
        activo:       true,
        fechaAgregado: new Date().toISOString(),
      };

      products.unshift(producto);
      await saveProducts(products, sha, `Agregar prenda: ${producto.nombre}`);

      await sendMd(
        chatId,
        `✅ *¡${producto.nombre} subida!*\n\n` +
        `🧵 Tela: ${producto.tela}\n` +
        `📐 Talle: ${producto.talle}\n` +
        `💰 Precio: ${formatPrice(producto.precio)}\n\n` +
        `_¡Ya está visible en la web!_ 🎉`
      );
    }

    resetSession(chatId);

  } catch (err) {
    console.error("[saveProduct]", err.message);
    await sendMsg(chatId, `❌ Error al guardar: ${err.message}\n\nUsá /cancelar y probá de nuevo.`);
    resetSession(chatId);
  }
}

/**
 * Guarda la prenda individual actual y avanza a la siguiente (o termina).
 */
async function saveIndividualProduct(chatId, session) {
  await sendMsg(chatId, "⏳ Guardando...");

  try {
    const { products, sha } = await readProducts();
    const idx  = session.individualIdx;
    const d    = session.indivData;
    const url  = await getFileUrl(session.photos[idx].fileId);

    const producto = {
      id:           generateId(),
      nombre:       d.titulo,
      tela:         d.tela,
      talle:        d.talle,
      precio:       d.precio,
      descripcion:  d.descripcion || "",
      tipo:         "otro",
      imagenes:     url ? [url] : [],
      colores:      [],
      activo:       true,
      fechaAgregado: new Date().toISOString(),
    };

    products.unshift(producto);
    await saveProducts(products, sha, `Agregar prenda: ${producto.nombre}`);

    await sendMd(chatId, `✅ *${producto.nombre}* guardada. 🎉`);

    // Avanzar a la siguiente
    session.individualIdx++;

    if (session.individualIdx < session.photos.length) {
      await new Promise(r => setTimeout(r, 600));
      await startIndividualProduct(chatId, session);
    } else {
      const total = session.photos.length;
      resetSession(chatId);
      await sendMd(chatId, `🎊 *¡Listo! ${total} prenda(s) subidas a la web.*`);
    }

  } catch (err) {
    console.error("[saveIndividual]", err.message);
    await sendMsg(chatId, `❌ Error: ${err.message}`);
    resetSession(chatId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTAR PRODUCTOS
// ─────────────────────────────────────────────────────────────────────────────

async function handleListar(chatId) {
  try {
    const { products } = await readProducts();
    if (!products.length) {
      await sendMsg(chatId, "📭 El catálogo está vacío. Mandame una foto para agregar el primero.");
      return;
    }
    await sendMd(chatId, `📋 *Catálogo — ${products.length} producto(s):*`);

    const PAGE = 6;
    for (let i = 0; i < products.length; i += PAGE) {
      const lines = products.slice(i, i + PAGE).map((p, j) => {
        const num    = i + j + 1;
        const price  = formatPrice(p.precio);
        const colores = p.colores?.length ? ` | 🎨 ${p.colores.join(", ")}` : "";
        return `${num}. *${p.nombre}* — ${price}\n   ${p.tela} | ${p.talle}${colores}\n   \`${p.id}\``;
      });
      await sendMd(chatId, lines.join("\n\n"));
      if (i + PAGE < products.length) await new Promise(r => setTimeout(r, 400));
    }
  } catch (err) {
    await sendMsg(chatId, `❌ Error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTER DE TEXTO
// ─────────────────────────────────────────────────────────────────────────────

async function handleText(chatId, session, text) {

  // ── COMANDOS ──────────────────────────────────────────────────────────────

  if (text === "/start") {
    resetSession(chatId);
    await sendMd(chatId,
      `🛍️ *¡Hola Sofy! Soy tu bot de catálogo.*\n\n` +
      `Mandame una foto para subir una prenda.\n\n` +
      `*Comandos:*\n/listar — Ver productos\n/cancelar — Cancelar operación\n/ayuda — Ayuda`
    );
    return;
  }

  if (text === "/cancelar") {
    resetSession(chatId);
    await sendMsg(chatId, "❌ Cancelado. Mandame una foto cuando quieras empezar.");
    return;
  }

  if (text === "/listar") {
    await handleListar(chatId);
    return;
  }

  if (text === "/ayuda") {
    await sendMd(chatId,
      `📖 *Guía rápida:*\n\n` +
      `📸 *1 foto* → Te pregunto tela, talle, precio y título\n\n` +
      `📸📸 *Varias fotos juntas* →\n` +
      `  • *Mismo modelo* = colores distintos → Gemini detecta los colores automáticamente\n` +
      `  • *Prendas distintas* → Te pregunto cada una por separado\n\n` +
      `🔁 En el modo prendas distintas podés pedir que te reenvíe cualquier foto si no la recordás.\n\n` +
      `/cancelar para reiniciar en cualquier momento.`
    );
    return;
  }

  // ── FLUJOS DE PRECIO (puede llegar como texto) ────────────────────────────

  if (session.step === "wait_precio") {
    const price = parsePrice(text);
    if (!price) {
      await sendMsg(chatId, "⚠️ Precio inválido. Ingresá solo el número. Ej: 15000");
      return;
    }
    session.precio = price;
    session.step   = "wait_titulo";
    await askTitulo(chatId);
    return;
  }

  if (session.step === "wait_individual_precio") {
    const price = parsePrice(text);
    if (!price) {
      await sendMsg(chatId, "⚠️ Precio inválido. Ingresá solo el número.");
      return;
    }
    session.indivData.precio = price;
    session.step             = "wait_individual_titulo";
    await askTitulo(chatId, `🏷️ *Prenda ${session.individualIdx + 1}* — ¿Nombre?`);
    return;
  }

  // ── TÍTULO ────────────────────────────────────────────────────────────────

  if (session.step === "wait_titulo") {
    if (!text || text.trim().length < 2) {
      await sendMsg(chatId, "⚠️ El nombre es muy corto. Ingresá al menos 2 caracteres.");
      return;
    }
    session.titulo = text.trim();
    session.step   = "wait_desc";
    await askDesc(chatId);
    return;
  }

  if (session.step === "wait_individual_titulo") {
    if (!text || text.trim().length < 2) {
      await sendMsg(chatId, "⚠️ El nombre es muy corto.");
      return;
    }
    session.indivData.titulo = text.trim();
    session.step             = "wait_individual_desc";
    await askDesc(chatId);
    return;
  }

  // ── DESCRIPCIÓN (si escribe texto en lugar de usar el botón) ─────────────

  if (session.step === "wait_desc") {
    session.descripcion = text.trim();
    await saveProduct(chatId, session);
    return;
  }

  if (session.step === "wait_individual_desc") {
    session.indivData.descripcion = text.trim();
    await saveIndividualProduct(chatId, session);
    return;
  }

  // ── COLOR MANUAL (si escribe en lugar de usar el botón) ──────────────────

  if (session.step === "wait_color_pick" || session.step === "wait_color_edit") {
    if (!text || text.trim().length < 2) {
      await sendMsg(chatId, "⚠️ Escribí el nombre del color.");
      return;
    }
    const idx = session.albumColorIdx;
    session.albumColors[idx].colorConfirmado = text.trim();
    await advanceColorOrFinish(chatId, session);
    return;
  }

  // ── IDLE / FALLBACK ───────────────────────────────────────────────────────

  if (session.step === "idle") {
    await sendMsg(chatId, "👋 Mandame una foto para subir una prenda, o usá /ayuda.");
    return;
  }

  await sendMsg(chatId, "No entendí eso. Usá /cancelar para reiniciar.");
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTER DE CALLBACKS (botones presionados)
// ─────────────────────────────────────────────────────────────────────────────

async function handleCallback(chatId, session, cbId, data) {
  await answerCb(cbId);

  // ── Respuesta: ¿mismo modelo? ─────────────────────────────────────────────
  if (session.step === "wait_album_answer") {
    if (data === "🎨 Mismo modelo — distintos colores") {
      session.mode = "album";
      await startColorDetection(chatId, session);
    } else if (data === "📦 Son prendas distintas") {
      session.mode = "individual";
      await showIndividualIntro(chatId, session);
    }
    return;
  }

  // ── Reenviar foto del modo individual ────────────────────────────────────
  if (data.startsWith("reenviar__")) {
    const idx = parseInt(data.split("__")[1], 10);
    if (session.photos[idx]) {
      await sendPhoto(chatId, session.photos[idx].fileId, `📷 Esta es la foto ${idx + 1}`);
    }
    return;
  }

  // ── Arrancar modo individual ──────────────────────────────────────────────
  if (data === "individual__start") {
    await startIndividualProduct(chatId, session);
    return;
  }

  // ── Confirmar color detectado por Gemini ──────────────────────────────────
  if (session.step === "wait_color_confirm") {
    const idx = session.albumColorIdx;

    if (data.startsWith("✅ Sí")) {
      // Confirmar el color sugerido
      session.albumColors[idx].colorConfirmado = session.albumColors[idx].colorSugerido;
      await advanceColorOrFinish(chatId, session);
    } else if (data === "✏️ No, quiero corregirlo") {
      // Mostrar selector de colores para corregir
      session.step = "wait_color_edit";
      await sendMsg(chatId, "¿Cuál es el color correcto? Elegí o escribilo:");
      await showColorPicker(chatId);
    }
    return;
  }

  // ── Elegir color del picker ───────────────────────────────────────────────
  if (session.step === "wait_color_pick" || session.step === "wait_color_edit") {
    if (COLORES_FALLBACK.includes(data)) {
      const idx = session.albumColorIdx;
      session.albumColors[idx].colorConfirmado = data;
      await advanceColorOrFinish(chatId, session);
    }
    return;
  }

  // ── Tela (single o álbum) ─────────────────────────────────────────────────
  if (session.step === "wait_tela" && TELAS.includes(data)) {
    session.tela = data;
    session.step = "wait_talle";
    await askTalle(chatId);
    return;
  }

  // ── Talla (single o álbum) ────────────────────────────────────────────────
  if (session.step === "wait_talle" && TALLES.includes(data)) {
    session.talle = data;
    session.step  = "wait_precio";
    await askPrecio(chatId);
    return;
  }

  // ── Precio (single o álbum) ───────────────────────────────────────────────
  if (session.step === "wait_precio") {
    if (data === "Otro precio") {
      await sendMsg(chatId, "💰 Escribí el precio (solo el número, ej: 15000):");
      return;
    }
    const price = parsePrice(data);
    if (price) {
      session.precio = price;
      session.step   = "wait_titulo";
      await askTitulo(chatId);
    }
    return;
  }

  // ── Descripción (single o álbum) ──────────────────────────────────────────
  if (session.step === "wait_desc") {
    if (data === "⏭️ No, saltar") {
      session.descripcion = "";
      await saveProduct(chatId, session);
    } else if (data === "✏️ Sí, agregar descripción") {
      await sendMsg(chatId, "📄 Escribí la descripción:");
    }
    return;
  }

  // ── Individual: tela ──────────────────────────────────────────────────────
  if (session.step === "wait_individual_tela" && TELAS.includes(data)) {
    session.indivData.tela = data;
    session.step           = "wait_individual_talle";
    await askTalle(chatId, `📐 *Prenda ${session.individualIdx + 1}* — ¿Qué talle tiene?`);
    return;
  }

  // ── Individual: talle ─────────────────────────────────────────────────────
  if (session.step === "wait_individual_talle" && TALLES.includes(data)) {
    session.indivData.talle = data;
    session.step            = "wait_individual_precio";
    await askPrecio(chatId, `💰 *Prenda ${session.individualIdx + 1}* — ¿Cuánto cuesta?`);
    return;
  }

  // ── Individual: precio ────────────────────────────────────────────────────
  if (session.step === "wait_individual_precio") {
    if (data === "Otro precio") {
      await sendMsg(chatId, "💰 Escribí el precio:");
      return;
    }
    const price = parsePrice(data);
    if (price) {
      session.indivData.precio = price;
      session.step             = "wait_individual_titulo";
      await askTitulo(chatId, `🏷️ *Prenda ${session.individualIdx + 1}* — ¿Nombre?`);
    }
    return;
  }

  // ── Individual: descripción ───────────────────────────────────────────────
  if (session.step === "wait_individual_desc") {
    if (data === "⏭️ No, saltar") {
      session.indivData.descripcion = "";
      await saveIndividualProduct(chatId, session);
    } else if (data === "✏️ Sí, agregar descripción") {
      await sendMsg(chatId, "📄 Escribí la descripción:");
    }
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: "Method Not Allowed" };

  if (!BOT_TOKEN) {
    console.error("CRÍTICO: TELEGRAM_BOT_TOKEN no configurado");
    return { statusCode: 500, body: "Bot token missing" };
  }

  let update;
  try {
    update = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Bad request" };
  }

  console.log(`[Update ${update.update_id}]`, update.message ? "msg" : update.callback_query ? "cb" : "other");

  try {

    // ── CALLBACK ────────────────────────────────────────────────────────────
    if (update.callback_query) {
      const cb     = update.callback_query;
      const chatId = String(cb.message.chat.id);
      if (OWNER_ID && chatId !== OWNER_ID) { await answerCb(cb.id); return { statusCode: 200, body: "ok" }; }
      await handleCallback(chatId, getSession(chatId), cb.id, cb.data);
      return { statusCode: 200, body: "ok" };
    }

    // ── MENSAJE ──────────────────────────────────────────────────────────────
    if (update.message) {
      const msg    = update.message;
      const chatId = String(msg.chat.id);

      if (OWNER_ID && chatId !== OWNER_ID) {
        await sendMsg(chatId, "⛔ Este bot es privado.");
        return { statusCode: 200, body: "ok" };
      }

      const session = getSession(chatId);

      if (msg.photo)    { await handlePhoto(chatId, session, msg);              return { statusCode: 200, body: "ok" }; }
      if (msg.text)     { await handleText(chatId, session, msg.text.trim());   return { statusCode: 200, body: "ok" }; }
      if (msg.document) { await sendMsg(chatId, "📎 Enviame la foto directamente, no como archivo adjunto."); return { statusCode: 200, body: "ok" }; }
    }

  } catch (err) {
    console.error("[Handler]", err.message, err.stack);
    if (OWNER_ID) {
      try { await sendMsg(OWNER_ID, `⚠️ Error en el bot: ${err.message}\n\nUsá /cancelar y probá de nuevo.`); } catch { /* ignorar */ }
    }
  }

  return { statusCode: 200, headers, body: "ok" };
};
