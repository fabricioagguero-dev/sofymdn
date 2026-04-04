// =============================================================================
// 🤖 BOT DE SOFY MDN — Gestión de Catálogo
// =============================================================================
// Archivo: netlify/functions/telegram.js
//
// DESCRIPCIÓN:
//   Bot de Telegram para que la dueña de Sofy MDN pueda subir prendas
//   a la página web enviando fotos con información estructurada.
//
// VARIABLES DE ENTORNO REQUERIDAS (configurar en Netlify):
//   - TELEGRAM_BOT_TOKEN  → Token del bot dado por @BotFather
//   - OWNER_ID            → Tu chat_id de Telegram (número)
//
// FLUJOS PRINCIPALES:
//   1. /start             → Bienvenida y menú principal
//   2. /subir             → Subir una o varias prendas
//   3. /listar            → Ver todos los productos activos
//   4. /eliminar          → Eliminar un producto por ID
//   5. /ayuda             → Guía completa de uso
//   6. /estado            → Ver estado actual del bot y sesión
//   Foto directa          → Inicia flujo de carga de prenda
//
// ARQUITECTURA:
//   - Netlify Serverless Function (Node.js)
//   - Webhook de Telegram → Netlify Function
//   - Base de datos: data/products.json (archivo JSON en el repo)
//   - Estado de sesión: objeto en memoria (resetea en cold starts)
//
// NOTAS IMPORTANTES:
//   - Las funciones serverless son stateless: el estado en memoria
//     puede perderse entre llamadas. Si eso ocurre, usar /cancelar.
//   - Telegram reintenta si no recibe HTTP 200, por eso siempre
//     respondemos 200 aunque haya errores internos.
// =============================================================================

"use strict";

const https = require("https");
const fs    = require("fs");
const path  = require("path");

// =============================================================================
// ── SECCIÓN 1: CONFIGURACIÓN
// =============================================================================

/** Token del bot — viene de las variables de entorno de Netlify */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

/** Chat ID de la dueña — solo ella puede usar el bot */
const OWNER_ID  = String(process.env.OWNER_ID || "");

/** Ruta al archivo JSON que actúa como base de datos */
const DB_PATH   = path.join(__dirname, "../../data/products.json");

/** Tipos de prenda disponibles para el menú de selección */
const TIPOS_PRENDA = [
  { label: "👕 Remera",    value: "remera"    },
  { label: "👖 Pantalón",  value: "pantalon"  },
  { label: "👗 Vestido",   value: "vestido"   },
  { label: "🧥 Campera",   value: "campera"   },
  { label: "🩱 Enterito",  value: "enterito"  },
  { label: "🧣 Accesorio", value: "accesorio" },
  { label: "🩲 Lencería",  value: "lenceria"  },
  { label: "✏️ Otro",      value: "otro"      },
];

/** Talles disponibles como botones */
const TALLES = ["XS", "S", "M", "L", "XL", "XXL", "Único", "Varios"];

/** Tiempo máximo para acumular fotos de un media_group (ms) */
const MEDIA_GROUP_TIMEOUT = 2500;

// =============================================================================
// ── SECCIÓN 2: ESTADO DE SESIONES EN MEMORIA
// =============================================================================
//
// ⚠️ IMPORTANTE SOBRE SERVERLESS:
//   Este objeto vive en RAM. En Netlify Free, las funciones se "enfrían"
//   (se destruyen) si no reciben tráfico por ~10 minutos. Cuando la
//   función se recrea, el estado se pierde.
//
//   SOLUCIÓN PARA LA DUEÑA: Si el bot "se olvida" de lo que estaban haciendo,
//   mandar /cancelar y comenzar de nuevo.
//
// ESTRUCTURA DE UNA SESIÓN:
// {
//   step:           string,   // Estado actual del flujo
//   mode:           string,   // 'single' | 'album' | 'individual'
//   queue:          Array,    // Cola de fotos { fileId, mediaGroupId }
//   current:        number,   // Índice de prenda actual en proceso
//   tempData:       Object,   // Datos temporales de la prenda en carga
//   tempStep:       string,   // Sub-paso dentro del flujo de datos
//   albumData:      Object,   // Datos para modo álbum
//   mediaGroupId:   string,   // ID del grupo de medios actual
//   pendingDeleteId: string,  // ID de producto pendiente de eliminar
// }
// =============================================================================

/** Objeto global de sesiones indexado por chatId */
const sessions = {};

/**
 * Obtiene la sesión de un chat. Si no existe, la crea.
 * @param {string} chatId
 * @returns {Object}
 */
function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = createEmptySession();
  }
  return sessions[chatId];
}

/**
 * Crea una sesión vacía con todos los campos inicializados.
 * @returns {Object}
 */
function createEmptySession() {
  return {
    step:            "idle",
    mode:            null,
    queue:           [],
    current:         0,
    tempData:        {},
    tempStep:        null,
    albumData:       {},
    mediaGroupId:    null,
    pendingDeleteId: null,
  };
}

/**
 * Resetea la sesión de un chat al estado inicial.
 * Llamar al terminar un flujo o al cancelar.
 * @param {string} chatId
 */
function resetSession(chatId) {
  sessions[chatId] = createEmptySession();
}

// =============================================================================
// ── SECCIÓN 3: BASE DE DATOS
// =============================================================================
//
// Usamos un archivo JSON como base de datos simple.
// En Netlify Free no podemos usar bases de datos externas sin plan de pago,
// así que el JSON se guarda junto con los archivos del proyecto.
//
// LIMITACIÓN: En Netlify, el filesystem es de solo lectura en producción.
// Para persistencia real, necesitarías un servicio externo como Supabase.
// Para este uso (catálogo pequeño), funciona cargando el JSON inicial.
// =============================================================================

/**
 * Lee todos los productos del archivo JSON.
 * Si el archivo no existe o está corrupto, devuelve lista vacía.
 * @returns {{ products: Array }}
 */
function readDB() {
  try {
    const raw    = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.products)) parsed.products = [];
    return parsed;
  } catch (err) {
    console.warn("[DB] No se pudo leer products.json:", err.message);
    return { products: [] };
  }
}

/**
 * Guarda todos los productos en el archivo JSON.
 * @param {{ products: Array }} db
 * @returns {boolean} true si se guardó correctamente
 */
function writeDB(db) {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("[DB] Error al guardar products.json:", err.message);
    return false;
  }
}

/**
 * Agrega un producto nuevo a la base de datos.
 * @param {Object} product
 * @returns {boolean}
 */
function addProduct(product) {
  const db = readDB();
  db.products.unshift(product); // Agregar al inicio (más nuevo primero)
  return writeDB(db);
}

/**
 * Elimina un producto por ID.
 * @param {string} productId
 * @returns {{ success: boolean, product: Object|null }}
 */
function removeProduct(productId) {
  const db      = readDB();
  const before  = db.products.length;
  const found   = db.products.find(p => p.id === productId) || null;
  db.products   = db.products.filter(p => p.id !== productId);
  const success = db.products.length < before;
  if (success) writeDB(db);
  return { success, product: found };
}

/**
 * Obtiene todos los productos.
 * @returns {Array}
 */
function getProducts() {
  return readDB().products || [];
}

/**
 * Genera un ID único para un producto nuevo.
 * Formato: prod_TIMESTAMP_RAND5
 * @returns {string}
 */
function generateProductId() {
  const ts   = Date.now();
  const rand = Math.random().toString(36).substring(2, 7);
  return `prod_${ts}_${rand}`;
}

// =============================================================================
// ── SECCIÓN 4: UTILIDADES DE TEXTO Y FORMATO
// =============================================================================

/**
 * Escapa caracteres especiales para el formato MarkdownV2 de Telegram.
 *
 * MarkdownV2 requiere escapar: _ * [ ] ( ) ~ ` > # + - = | { } . ! \
 * Si no se escapan, el mensaje falla con "Bad Request: can't parse entities".
 *
 * @param {string|number} str
 * @returns {string}
 */
function esc(str) {
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, c => `\\${c}`);
}

/**
 * Formatea un número como precio en pesos argentinos.
 * Ejemplo: 15000 → "$15.000"
 * @param {number|string} amount
 * @returns {string}
 */
function formatPrice(amount) {
  return `$${Number(amount || 0).toLocaleString("es-AR")}`;
}

/**
 * Devuelve el emoji correspondiente a un tipo de prenda.
 * @param {string} tipo
 * @returns {string}
 */
function getEmojiForTipo(tipo) {
  const emojis = {
    remera:    "👕",
    pantalon:  "👖",
    vestido:   "👗",
    campera:   "🧥",
    enterito:  "🩱",
    accesorio: "🧣",
    lenceria:  "🩲",
    otro:      "🏷️",
  };
  return emojis[tipo] || "🏷️";
}

/**
 * Trunca un string a una longitud máxima, agregando "…" si fue cortado.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text = "", max = 40) {
  const str = String(text);
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/**
 * Parsea un texto de precio ingresado por la dueña.
 * Acepta: 15000, 15.000, 15,000, $15000, etc.
 * @param {string} text
 * @returns {number|null} Precio o null si no es válido
 */
function parsePrice(text) {
  // Quitar $, espacios, y puntos usados como separadores de miles
  const cleaned = text.replace(/[$\s]/g, "").replace(/\./g, "").replace(",", ".");
  const price   = parseFloat(cleaned);
  if (isNaN(price) || price <= 0 || price > 9999999) return null;
  return Math.round(price);
}

/**
 * Formatea una fecha ISO como string legible en español.
 * @param {string} isoDate
 * @returns {string}
 */
function formatDate(isoDate) {
  try {
    return new Date(isoDate).toLocaleDateString("es-AR", {
      day: "2-digit", month: "2-digit", year: "numeric",
    });
  } catch {
    return "—";
  }
}

// =============================================================================
// ── SECCIÓN 5: API DE TELEGRAM — FUNCIONES BASE
// =============================================================================
//
// Todas las llamadas a la API de Telegram pasan por callTelegram().
// Esto centraliza el manejo de errores y facilita el debugging.
// =============================================================================

/**
 * Realiza una petición HTTPS a la API de Telegram.
 *
 * @param {string} method   - Nombre del método (sendMessage, getFile, etc.)
 * @param {Object} payload  - Cuerpo del request
 * @returns {Promise<Object>} Respuesta de Telegram
 */
function callTelegram(method, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);

    const options = {
      hostname: "api.telegram.org",
      path:     `/bot${BOT_TOKEN}/${method}`,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 10000, // 10 segundos de timeout
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            // Loguear error de Telegram sin crashear
            console.error(`[API] ${method} falló:`, parsed.description, "| Payload:", JSON.stringify(payload).substring(0, 200));
          }
          resolve(parsed);
        } catch (e) {
          console.error(`[API] Error parseando respuesta de ${method}:`, e.message);
          resolve({ ok: false, description: "Parse error" });
        }
      });
    });

    req.on("timeout", () => {
      console.error(`[API] Timeout en ${method}`);
      req.destroy();
      resolve({ ok: false, description: "Timeout" });
    });

    req.on("error", (e) => {
      console.error(`[API] Error de red en ${method}:`, e.message);
      resolve({ ok: false, description: e.message });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Envía un mensaje de texto a un chat.
 *
 * @param {string|number} chatId
 * @param {string}        text
 * @param {string}        [parseMode] - "MarkdownV2" | "HTML" | ""
 * @param {Object}        [extra]     - Campos adicionales del request
 * @returns {Promise<Object>}
 */
async function sendMsg(chatId, text, parseMode = "", extra = {}) {
  // Validar que el texto no esté vacío
  if (!text || !text.trim()) {
    console.warn("[sendMsg] Texto vacío, omitiendo");
    return { ok: false };
  }

  const payload = {
    chat_id: chatId,
    text:    text.substring(0, 4096), // Límite de Telegram: 4096 chars
    ...(parseMode ? { parse_mode: parseMode } : {}),
    ...extra,
  };

  return callTelegram("sendMessage", payload);
}

/**
 * Shorthand para enviar mensaje con formato MarkdownV2.
 * Úsalo para mensajes con negritas, cursivas, código, etc.
 *
 * @param {string|number} chatId
 * @param {string}        text    - Texto con formato MarkdownV2 (caracteres especiales escapados)
 * @param {Object}        [extra]
 */
async function sendMd(chatId, text, extra = {}) {
  return sendMsg(chatId, text, "MarkdownV2", extra);
}

/**
 * Shorthand para enviar mensaje de texto plano (sin formato).
 * Úsalo para mensajes simples sin caracteres especiales.
 *
 * @param {string|number} chatId
 * @param {string}        text
 * @param {Object}        [extra]
 */
async function sendPlain(chatId, text, extra = {}) {
  return sendMsg(chatId, text, "", extra);
}

/**
 * Responde a un callback query para quitar el indicador de carga del botón.
 * SIEMPRE hay que llamar esto cuando se procesa un callback.
 *
 * @param {string} callbackQueryId
 * @param {string} [text] - Notificación emergente (opcional)
 */
async function answerCallback(callbackQueryId, text = "") {
  return callTelegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text, show_alert: false } : {}),
  });
}

/**
 * Obtiene la URL pública descargable de un archivo enviado al bot.
 * Las fotos de Telegram tienen un file_id que se convierte en URL temporal.
 *
 * NOTA: Las URLs de Telegram expiran después de un tiempo.
 * Para persistencia, las imágenes deberían subirse a un CDN externo.
 *
 * @param {string} fileId
 * @returns {Promise<string>} URL o string vacío si falla
 */
async function getFileUrl(fileId) {
  try {
    const res = await callTelegram("getFile", { file_id: fileId });

    if (res.ok && res.result && res.result.file_path) {
      const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${res.result.file_path}`;
      console.log("[getFileUrl] OK:", url.substring(0, 60) + "...");
      return url;
    }

    console.error("[getFileUrl] Sin file_path en respuesta:", JSON.stringify(res));
    return "";
  } catch (e) {
    console.error("[getFileUrl] Error:", e.message);
    return "";
  }
}

// =============================================================================
// ── SECCIÓN 6: TECLADOS (KEYBOARDS)
// =============================================================================
//
// Telegram ofrece dos tipos de teclados:
//
// 1. Reply Keyboard (keyboard): Reemplaza el teclado táctil del teléfono.
//    Útil para opciones simples de texto.
//    Siempre usar con resize_keyboard: true para que se ajuste al tamaño.
//
// 2. Inline Keyboard (inline_keyboard): Botones debajo de un mensaje específico.
//    Responden via callback_query en lugar de mensajes de texto.
//    Mejor para selecciones complejas o acciones sobre un mensaje particular.
// =============================================================================

/** Teclado de "Sí / No" simple */
const KB_YES_NO = {
  keyboard: [["✅ Sí", "❌ No"]],
  one_time_keyboard: true,
  resize_keyboard:   true,
};

/** Teclado para la pregunta de álbum (colores vs prendas distintas) */
const KB_ALBUM_QUESTION = {
  keyboard: [
    ["🎨 Sí, mismo modelo — distintos colores"],
    ["📦 No, son prendas distintas"],
  ],
  one_time_keyboard: true,
  resize_keyboard:   true,
};

/** Teclado para permitir cancelar en cualquier momento */
const KB_WITH_CANCEL = {
  keyboard: [["❌ Cancelar operación"]],
  resize_keyboard: true,
};

/** Elimina cualquier teclado personalizado (vuelve al teclado normal) */
const KB_REMOVE = { remove_keyboard: true };

/**
 * Genera el teclado inline con todos los tipos de prenda.
 * Organizado en filas de 2 columnas.
 * @returns {Object}
 */
function makeTiposKeyboard() {
  const rows = [];
  for (let i = 0; i < TIPOS_PRENDA.length; i += 2) {
    const row = [
      { text: TIPOS_PRENDA[i].label, callback_data: `tipo__${TIPOS_PRENDA[i].value}` },
    ];
    if (TIPOS_PRENDA[i + 1]) {
      row.push({
        text: TIPOS_PRENDA[i + 1].label,
        callback_data: `tipo__${TIPOS_PRENDA[i + 1].value}`,
      });
    }
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

/**
 * Genera el teclado inline con los talles disponibles.
 * Organizado en filas de 4 columnas.
 * @returns {Object}
 */
function makeTallesKeyboard() {
  const rows = [];
  for (let i = 0; i < TALLES.length; i += 4) {
    rows.push(
      TALLES.slice(i, i + 4).map(t => ({
        text:          t,
        callback_data: `talle__${t}`,
      }))
    );
  }
  return { inline_keyboard: rows };
}

/**
 * Genera teclado inline de confirmación con dos opciones.
 * @param {string} confirmData  - callback_data para confirmar
 * @param {string} cancelData   - callback_data para cancelar
 * @param {string} [confirmText]
 * @param {string} [cancelText]
 * @returns {Object}
 */
function makeConfirmKeyboard(
  confirmData,
  cancelData,
  confirmText = "✅ Confirmar",
  cancelText  = "❌ Cancelar"
) {
  return {
    inline_keyboard: [[
      { text: confirmText, callback_data: confirmData },
      { text: cancelText,  callback_data: cancelData  },
    ]],
  };
}

/**
 * Genera el teclado de edición para el resumen de una prenda.
 * Permite volver atrás y editar cualquier campo antes de confirmar.
 * @returns {Object}
 */
function makeEditKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✅ Confirmar y subir a la web", callback_data: "confirm__yes" }],
      [
        { text: "✏️ Nombre",       callback_data: "edit__nombre"      },
        { text: "🏷️ Tipo",         callback_data: "edit__tipo"        },
      ],
      [
        { text: "🧵 Tela",         callback_data: "edit__tela"        },
        { text: "📐 Talle",        callback_data: "edit__talle"       },
      ],
      [
        { text: "💰 Precio",       callback_data: "edit__precio"      },
        { text: "📄 Descripción",  callback_data: "edit__descripcion" },
      ],
      [{ text: "❌ Descartar prenda", callback_data: "confirm__no" }],
    ],
  };
}

// =============================================================================
// ── SECCIÓN 7: MENSAJES PREDEFINIDOS
// =============================================================================

/** Mensaje de bienvenida — se muestra al usar /start */
const MSG_BIENVENIDA = [
  "🛍️ *¡Hola Sofy\\! Bienvenida a tu bot de catálogo*",
  "",
  "Soy tu asistente para gestionar los productos de *Sofy MDN*\\.",
  "Podés enviarme fotos de prendas y te ayudo a subirlas a la web\\.",
  "",
  "━━━━━━━━━━━━━━━━━━━━━",
  "*📋 COMANDOS DISPONIBLES*",
  "━━━━━━━━━━━━━━━━━━━━━",
  "/subir \\— Subir prenda\\(s\\) al catálogo",
  "/listar \\— Ver todos los productos",
  "/eliminar \\— Eliminar un producto",
  "/estado \\— Ver estado del bot",
  "/ayuda \\— Guía detallada de uso",
  "/cancelar \\— Cancelar lo que estés haciendo",
  "",
  "💡 *Tip rápido:* También podés mandarme una foto",
  "directamente sin comandos para empezar a cargar una prenda\\.",
].join("\n");

/** Mensaje de ayuda extendida */
const MSG_AYUDA_COMPLETA = [
  "📖 *GUÍA COMPLETA DE USO*",
  "",
  "━━━━━━━━━━━━━━━━━━━━━",
  "📸 *SUBIR UNA SOLA PRENDA*",
  "━━━━━━━━━━━━━━━━━━━━━",
  "1\\. Mandame la foto de la prenda",
  "2\\. Te pregunto: Nombre → Tipo → Tela → Talle → Precio → Descripción",
  "3\\. Te muestro un resumen para confirmar",
  "4\\. Si todo está bien, la subo a la web automáticamente",
  "",
  "━━━━━━━━━━━━━━━━━━━━━",
  "🎨 *SUBIR VARIOS COLORES DEL MISMO MODELO*",
  "━━━━━━━━━━━━━━━━━━━━━",
  "Si la misma prenda viene en varios colores:",
  "1\\. Enviá todas las fotos *juntas* \\(seleccionalas todas y mandalas\\)",
  "2\\. Te pregunto si son del mismo modelo",
  "3\\. Respondé *Sí, mismo modelo*",
  "4\\. Solo te pregunto los datos UNA VEZ",
  "5\\. Las fotos quedan como galería de colores en la web",
  "",
  "━━━━━━━━━━━━━━━━━━━━━",
  "📦 *SUBIR VARIAS PRENDAS DISTINTAS*",
  "━━━━━━━━━━━━━━━━━━━━━",
  "Si son prendas distintas:",
  "1\\. Podés mandarlas juntas o separadas",
  "2\\. Si mandás varias juntas, respondé *No, son distintas*",
  "3\\. Te pregunto los datos para cada una por separado",
  "4\\. Las numera: Prenda 1, Prenda 2, etc\\.",
  "",
  "━━━━━━━━━━━━━━━━━━━━━",
  "🗑️ *ELIMINAR UN PRODUCTO*",
  "━━━━━━━━━━━━━━━━━━━━━",
  "1\\. Usá /eliminar",
  "2\\. Te muestro la lista con IDs",
  "3\\. Enviame el ID \\(empieza con prod\\_\\)",
  "4\\. Confirmás con el botón",
  "",
  "━━━━━━━━━━━━━━━━━━━━━",
  "⚠️ *PROBLEMAS COMUNES*",
  "━━━━━━━━━━━━━━━━━━━━━",
  "• *El bot no responde:* Usá /cancelar y empezá de nuevo",
  "• *Se olvidó lo que estaba haciendo:* Es normal en bots serverless,",
  "  usá /cancelar y repetí el proceso",
  "• *Error al guardar:* Contactá al desarrollador",
].join("\n");

// =============================================================================
// ── SECCIÓN 8: FLUJO DE CARGA DE PRODUCTOS
// =============================================================================

/**
 * Inicia el flujo de preguntas para una prenda.
 * Limpia los datos temporales y pide el nombre.
 *
 * @param {string|number} chatId
 * @param {Object}        session
 * @param {number}        index     - Posición en la cola
 * @param {boolean}       numbered  - Si mostrar "Prenda N de M"
 */
async function iniciarPreguntasPrenda(chatId, session, index, numbered = false) {
  // Limpiar datos temporales
  session.tempData = {};
  session.tempStep = "nombre";

  // Construir prefijo según el modo
  const total  = session.queue.length;
  const prefix = numbered
    ? `*📦 Prenda ${index + 1} de ${total}*\n\n`
    : "";

  await sendMd(
    chatId,
    `${prefix}📝 *¿Cuál es el nombre de esta prenda?*\n\n_Ejemplos: Remera básica oversize, Vestido floral midi, Campera de cuerina negra..._`,
    { reply_markup: KB_WITH_CANCEL }
  );
}

/**
 * Procesa las respuestas de texto dentro del flujo de carga de una prenda.
 * Es una máquina de estados basada en session.tempStep.
 *
 * ESTADOS POSIBLES DE tempStep:
 *   nombre       → Esperando el nombre de la prenda
 *   tipo         → Esperando selección de tipo (botones inline)
 *   tela         → Esperando el tipo de tela
 *   talle        → Esperando el talle (botones o texto)
 *   precio       → Esperando el precio
 *   descripcion  → Esperando descripción (opcional)
 *   confirmar    → Mostrando resumen (se procesa vía callbacks)
 *
 * @param {string|number} chatId
 * @param {Object}        session
 * @param {string}        text    - Texto enviado por la dueña
 */
async function procesarRespuestaPrenda(chatId, session, text) {
  const numbered = session.mode === "individual";

  // ── NOMBRE ──────────────────────────────────────────────────────────────────
  if (session.tempStep === "nombre") {
    if (!text || text.trim().length < 2) {
      await sendPlain(chatId, "⚠️ El nombre es muy corto. Necesito al menos 2 caracteres.\nEjemplo: Remera básica");
      return;
    }
    if (text.trim().length > 100) {
      await sendPlain(chatId, "⚠️ El nombre es demasiado largo. Máximo 100 caracteres.");
      return;
    }

    session.tempData.nombre = text.trim();
    session.tempStep        = "tipo";

    await sendMd(
      chatId,
      `✅ Nombre guardado: *${esc(session.tempData.nombre)}*\n\n🏷️ *¿Qué tipo de prenda es?*\n_Elegí una opción:_`,
      { reply_markup: makeTiposKeyboard() }
    );
    return;
  }

  // ── TIPO (se maneja principalmente por callback, pero por si escribe texto) ──
  if (session.tempStep === "tipo") {
    await sendPlain(chatId, "👆 Por favor usá los botones de arriba para seleccionar el tipo de prenda.");
    return;
  }

  // ── TELA ─────────────────────────────────────────────────────────────────────
  if (session.tempStep === "tela") {
    if (!text || text.trim().length < 2) {
      await sendPlain(chatId, "⚠️ Por favor ingresá el tipo de tela.\nEjemplos: Algodón, Modal, Lycra, Jean, Lino...");
      return;
    }

    session.tempData.tela = text.trim();
    session.tempStep      = "talle";

    await sendMd(
      chatId,
      `✅ Tela: *${esc(session.tempData.tela)}*\n\n📐 *¿Qué talle tiene?*\n_Elegí un talle o escribilo:_`,
      { reply_markup: makeTallesKeyboard() }
    );
    return;
  }

  // ── TALLE (puede venir por texto si no usa el botón) ─────────────────────────
  if (session.tempStep === "talle") {
    if (!text || text.trim().length < 1) {
      await sendPlain(chatId, "⚠️ Por favor ingresá el talle.");
      return;
    }

    session.tempData.talle = text.trim().toUpperCase();
    session.tempStep       = "precio";

    await sendMd(
      chatId,
      `✅ Talle: *${esc(session.tempData.talle)}*\n\n💰 *¿Cuánto cuesta?*\n_Solo el número, sin $\\. Ejemplos: 15000, 8500, 22000_`,
      { reply_markup: KB_WITH_CANCEL }
    );
    return;
  }

  // ── PRECIO ────────────────────────────────────────────────────────────────────
  if (session.tempStep === "precio") {
    const price = parsePrice(text);

    if (price === null) {
      await sendPlain(
        chatId,
        "⚠️ El precio no es válido. Ingresá solo el número sin símbolos.\n✅ Ejemplos válidos: 15000 / 15.000 / $15000\n❌ No válido: \"15k\" o \"quince mil\""
      );
      return;
    }

    session.tempData.precio = price;
    session.tempStep        = "descripcion";

    await sendMd(
      chatId,
      `✅ Precio: *${esc(formatPrice(price))}*\n\n📄 *¿Agregás una descripción?* \\(opcional\\)\n_Puede incluir detalles del material, cómo combinarla, características especiales, etc\\._\n_Si no querés descripción, enviá un punto: \\._`,
      { reply_markup: KB_WITH_CANCEL }
    );
    return;
  }

  // ── DESCRIPCIÓN ───────────────────────────────────────────────────────────────
  if (session.tempStep === "descripcion") {
    // Un punto significa "sin descripción"
    session.tempData.descripcion = (text.trim() === ".") ? "" : text.trim().substring(0, 500);
    session.tempStep             = "confirmar";

    // Mostrar resumen para confirmar
    await mostrarResumen(chatId, session, numbered);
    return;
  }

  // ── CONFIRMAR (no debería llegar texto en este paso, se usa botón) ────────────
  if (session.tempStep === "confirmar") {
    await sendPlain(chatId, "👆 Por favor usá los botones del mensaje de arriba para confirmar o editar.");
    return;
  }
}

/**
 * Muestra el resumen completo de una prenda con opciones de editar o confirmar.
 *
 * @param {string|number} chatId
 * @param {Object}        session
 * @param {boolean}       numbered - Si es modo individual con numeración
 */
async function mostrarResumen(chatId, session, numbered = false) {
  const d     = session.tempData;
  const idx   = session.current;
  const total = session.queue.length;

  // Prefijo de numeración
  const prefix = numbered ? `*Prenda ${idx + 1} de ${total}*\n` : "";

  // Emoji del tipo
  const tipoEmoji = getEmojiForTipo(d.tipo);
  const tipoLabel = TIPOS_PRENDA.find(t => t.value === d.tipo)?.label || d.tipo || "—";

  const resumenText = [
    `${prefix}`,
    `📋 *Revisá los datos antes de subir:*`,
    ``,
    `📝 *Nombre:* ${esc(d.nombre || "—")}`,
    `${tipoEmoji} *Tipo:* ${esc(tipoLabel)}`,
    `🧵 *Tela:* ${esc(d.tela || "—")}`,
    `📐 *Talle:* ${esc(d.talle || "—")}`,
    `💰 *Precio:* ${esc(formatPrice(d.precio))}`,
    d.descripcion
      ? `📄 *Descripción:* ${esc(truncate(d.descripcion, 120))}`
      : `📄 *Sin descripción*`,
    ``,
    `_¿Los datos son correctos?_`,
  ].join("\n").trim();

  await sendMd(chatId, resumenText, { reply_markup: makeEditKeyboard() });
}

// =============================================================================
// ── SECCIÓN 9: GUARDAR PRODUCTO
// =============================================================================

/**
 * Finaliza y guarda una prenda en la base de datos.
 * Obtiene las URLs de las imágenes de Telegram y construye el objeto producto.
 * Luego avanza al siguiente en la cola o termina el flujo.
 *
 * @param {string|number} chatId
 * @param {Object}        session
 */
async function guardarProducto(chatId, session) {
  const idx  = session.current;
  const item = session.queue[idx];
  const d    = session.tempData;

  // Notificar que se está procesando
  await sendPlain(chatId, "⏳ Subiendo prenda a la web, un momento...");

  // ── Obtener URLs de imágenes ──────────────────────────────────────────────
  let imageUrls = [];

  if (session.mode === "album") {
    // Modo álbum: todas las fotos del queue son colores del mismo modelo
    console.log(`[guardar] Modo álbum: obteniendo ${session.queue.length} imágenes`);

    const urlPromises = session.queue.map(async (q, i) => {
      const url = await getFileUrl(q.fileId);
      console.log(`[guardar] Imagen ${i + 1}: ${url ? "OK" : "FALLÓ"}`);
      return url;
    });

    imageUrls = (await Promise.all(urlPromises)).filter(Boolean);

  } else {
    // Modo single/individual: solo la foto de este índice
    console.log(`[guardar] Modo ${session.mode}: obteniendo imagen ${idx}`);
    const url = await getFileUrl(item.fileId);
    if (url) {
      imageUrls = [url];
    }
  }

  // Verificar que tengamos al menos una imagen
  if (imageUrls.length === 0) {
    await sendPlain(
      chatId,
      "❌ No pude obtener la URL de la foto. Esto puede pasar si la imagen tardó mucho.\n\nIntentá enviar la foto de nuevo."
    );
    resetSession(chatId);
    return;
  }

  // ── Construir el objeto producto ──────────────────────────────────────────
  const producto = {
    id:           generateProductId(),
    nombre:       d.nombre    || "Sin nombre",
    tipo:         d.tipo      || "otro",
    tela:         d.tela      || "",
    talle:        d.talle     || "",
    precio:       d.precio    || 0,
    descripcion:  d.descripcion || "",
    imagenes:     imageUrls,
    activo:       true,
    fechaAgregado: new Date().toISOString(),
  };

  // ── Guardar en la base de datos ───────────────────────────────────────────
  const guardado = addProduct(producto);

  if (!guardado) {
    await sendPlain(
      chatId,
      "❌ Error al guardar en la base de datos.\n\nVerificá que el archivo products.json sea accesible. Si el problema persiste, contactá al desarrollador."
    );
    resetSession(chatId);
    return;
  }

  // ── Mensaje de éxito ──────────────────────────────────────────────────────
  const exitoMsg = [
    `✅ *¡${esc(producto.nombre)} subida exitosamente\\!*`,
    ``,
    `🆔 ID: \`${producto.id}\``,
    `${getEmojiForTipo(producto.tipo)} Tipo: ${esc(producto.tipo)}`,
    `🧵 Tela: ${esc(producto.tela)}`,
    `📐 Talle: ${esc(producto.talle)}`,
    `💰 Precio: ${esc(formatPrice(producto.precio))}`,
    `🖼️ Fotos: ${imageUrls.length}`,
    ``,
    `_¡Ya está visible en la web\\!_ 🎉`,
  ].join("\n");

  await sendMd(chatId, exitoMsg, { reply_markup: KB_REMOVE });

  // ── Determinar si hay más prendas en la cola ──────────────────────────────

  // En modo álbum: siempre termina después de esta prenda
  if (session.mode === "album") {
    resetSession(chatId);
    await sendMd(
      chatId,
      `🎊 *¡Álbum completo\\!*\n${imageUrls.length} foto\\(s\\) subidas como colores de *${esc(d.nombre)}*\\.\n\nUsá /subir para cargar más prendas\\.`
    );
    return;
  }

  // En modos single/individual: avanzar al siguiente
  session.current++;
  const quedan = session.queue.length - session.current;

  if (quedan > 0) {
    // Hay más prendas por procesar
    await sendMd(
      chatId,
      `✨ *Quedan ${quedan} prenda\\(s\\) más\\.*`
    );
    // Pequeña pausa para no saturar el chat
    await new Promise(r => setTimeout(r, 800));
    await iniciarPreguntasPrenda(chatId, session, session.current, session.mode === "individual");

  } else {
    // Terminamos con todas
    const totalSubidas = session.queue.length;
    resetSession(chatId);
    await sendMd(
      chatId,
      `🎊 *¡Listo\\! ${totalSubidas} prenda\\(s\\) subida\\(s\\) a la web\\.*\n\nUsá /listar para ver el catálogo actualizado\\.`,
      { reply_markup: KB_REMOVE }
    );
  }
}

// =============================================================================
// ── SECCIÓN 10: MANEJO DE FOTOS
// =============================================================================

/**
 * Procesa las fotos recibidas por la dueña.
 *
 * Telegram Media Groups:
 * Cuando el usuario envía varias fotos "juntas" (seleccionándolas todas en el
 * selector de fotos), Telegram las envía como mensajes separados con el mismo
 * `media_group_id`. No hay forma de saber cuántas fotos faltan, así que
 * esperamos un tiempo fijo y luego procesamos lo acumulado.
 *
 * @param {string|number} chatId
 * @param {Object}        session
 * @param {Object}        message - Mensaje de Telegram
 */
async function procesarFoto(chatId, session, message) {
  // Siempre tomar la foto de mayor resolución (la última en el array)
  const photo  = message.photo;
  const fileId = photo[photo.length - 1].file_id;
  const mgId   = message.media_group_id; // undefined si es foto suelta

  console.log(`[foto] Recibida. mediaGroupId: ${mgId || "ninguno"}, queue actual: ${session.queue.length}`);

  // ── CASO 1: Foto suelta (sin media_group_id) ──────────────────────────────
  if (!mgId) {
    // Si ya estábamos en medio de un flujo, puede ser que llegó tarde
    if (session.step !== "idle") {
      await sendPlain(
        chatId,
        "⚠️ Estoy en medio de un proceso. Usá /cancelar si querés empezar de nuevo con esta foto."
      );
      return;
    }

    session.queue.push({ fileId, mediaGroupId: null });
    session.mode    = "single";
    session.step    = "asking_product";
    session.current = 0;

    await sendMd(chatId, "📸 *¡Foto recibida\\!* Vamos a cargar esta prenda\\.");
    await new Promise(r => setTimeout(r, 400));
    await iniciarPreguntasPrenda(chatId, session, 0, false);
    return;
  }

  // ── CASO 2: Parte de un grupo de fotos ───────────────────────────────────

  // Si ya estábamos procesando OTRO grupo, ignorar (no debería pasar)
  if (session.step !== "idle" && session.mediaGroupId !== mgId) {
    console.warn("[foto] Foto de grupo diferente al actual, ignorando");
    return;
  }

  // Agregar foto a la cola
  session.queue.push({ fileId, mediaGroupId: mgId });

  // Si es la primera foto de este grupo
  if (session.mediaGroupId !== mgId) {
    session.mediaGroupId = mgId;
    session.step         = "accumulating";

    console.log(`[foto] Primera foto del grupo ${mgId}, esperando ${MEDIA_GROUP_TIMEOUT}ms...`);

    // Avisar que estamos recibiendo
    await sendPlain(chatId, "📸 Recibiendo fotos...");

    // Esperar a que lleguen todas las del grupo
    await new Promise(r => setTimeout(r, MEDIA_GROUP_TIMEOUT));

    // Ya acumulamos todas las fotos disponibles
    const count = session.queue.length;
    console.log(`[foto] Grupo completo: ${count} fotos acumuladas`);

    // Preguntar si es álbum o prendas distintas
    await sendMd(
      chatId,
      `📸 *¡Recibí ${count} foto\\(s\\)\\!*\n\n¿Son todas del mismo modelo en distintos colores, o son prendas distintas?`,
      { reply_markup: KB_ALBUM_QUESTION }
    );
    session.step = "wait_album_answer";
  }
  // Si ya estamos en "accumulating", simplemente se agregó arriba
}

// =============================================================================
// ── SECCIÓN 11: LISTAR PRODUCTOS
// =============================================================================

/**
 * Muestra todos los productos del catálogo de forma paginada.
 * @param {string|number} chatId
 */
async function listarProductos(chatId) {
  const products = getProducts();

  if (products.length === 0) {
    await sendMd(
      chatId,
      "📭 *El catálogo está vacío\\.* Todavía no hay productos cargados\\.\n\nMandame una foto para empezar\\."
    );
    return;
  }

  // Header
  await sendMd(
    chatId,
    `📋 *Catálogo Sofy MDN — ${products.length} producto\\(s\\)*`
  );

  // Mostrar en grupos de 6 para no saturar
  const PAGE = 6;
  for (let i = 0; i < products.length; i += PAGE) {
    const chunk = products.slice(i, i + PAGE);

    const lines = chunk.map((p, j) => {
      const num     = i + j + 1;
      const emoji   = getEmojiForTipo(p.tipo);
      const fotos   = (p.imagenes || []).length;
      const fecha   = formatDate(p.fechaAgregado);

      return [
        `${num}\\. ${emoji} *${esc(p.nombre)}*`,
        `   💰 ${esc(formatPrice(p.precio))} \\| 📐 ${esc(p.talle)} \\| 🖼️ ${fotos} foto\\(s\\)`,
        `   📅 ${esc(fecha)}`,
        `   🆔 \`${p.id}\``,
      ].join("\n");
    });

    await sendMd(chatId, lines.join("\n\n"));

    // Pausa entre páginas
    if (i + PAGE < products.length) {
      await new Promise(r => setTimeout(r, 600));
    }
  }

  await sendMd(
    chatId,
    `\n_Para eliminar una prenda, usá /eliminar y proporcioná su ID\\._`
  );
}

// =============================================================================
// ── SECCIÓN 12: ELIMINAR PRODUCTO
// =============================================================================

/**
 * Inicia el flujo de eliminación mostrando la lista de productos.
 * @param {string|number} chatId
 * @param {Object}        session
 */
async function iniciarEliminacion(chatId, session) {
  const products = getProducts();

  if (products.length === 0) {
    await sendMd(chatId, "📭 *No hay productos para eliminar\\.*");
    return;
  }

  session.step = "wait_delete_id";

  // Lista compacta (máx 15 para no saturar)
  const maxShow = 15;
  const shown   = products.slice(0, maxShow);
  const extra   = products.length > maxShow ? `\n_\\.\\.\\. y ${products.length - maxShow} más\\. Usá /listar para ver todos\\._` : "";

  const list = shown.map((p, i) => {
    const emoji = getEmojiForTipo(p.tipo);
    return `${i + 1}\\. ${emoji} \`${p.id}\`\n   *${esc(truncate(p.nombre, 30))}* \\— ${esc(formatPrice(p.precio))}`;
  }).join("\n\n");

  await sendMd(
    chatId,
    `🗑️ *Eliminar producto*\n\nEnviame el *ID* del producto que querés eliminar:\n\n${list}${extra}\n\n_El ID empieza con \`prod\\_\`_`,
    { reply_markup: KB_WITH_CANCEL }
  );
}

/**
 * Procesa el ID de producto para eliminar.
 * Pide confirmación antes de borrar.
 *
 * @param {string|number} chatId
 * @param {Object}        session
 * @param {string}        text
 */
async function procesarIdEliminacion(chatId, session, text) {
  const id       = text.trim();
  const products = getProducts();
  const product  = products.find(p => p.id === id);

  if (!product) {
    await sendMd(
      chatId,
      `⚠️ *No encontré ningún producto con ese ID*\n\n\`${esc(id)}\`\n\nVerificá que hayas copiado el ID completo correctamente\\.\nUsá /listar para ver los IDs disponibles\\.`
    );
    return;
  }

  // Guardar el ID pendiente y pedir confirmación
  session.pendingDeleteId = id;
  session.step            = "confirm_delete";

  const emoji = getEmojiForTipo(product.tipo);

  await sendMd(
    chatId,
    `⚠️ *¿Confirmás que querés eliminar esta prenda?*\n\n${emoji} *${esc(product.nombre)}*\n💰 ${esc(formatPrice(product.precio))} \\| 📐 ${esc(product.talle)} \\| 🧵 ${esc(product.tela)}\n\n_Esta acción no se puede deshacer\\._`,
    { reply_markup: makeConfirmKeyboard("delete__yes", "delete__no", "🗑️ Sí, eliminar", "❌ Cancelar") }
  );
}

// =============================================================================
// ── SECCIÓN 13: ESTADO DEL BOT
// =============================================================================

/**
 * Muestra el estado actual del bot: sesión, productos cargados, etc.
 * Útil para debugging cuando algo no funciona bien.
 *
 * @param {string|number} chatId
 * @param {Object}        session
 */
async function mostrarEstado(chatId, session) {
  const products = getProducts();

  const estadoSesion = {
    idle:              "💤 Sin actividad",
    accumulating:      "📸 Acumulando fotos",
    wait_album_answer: "❓ Esperando respuesta de álbum",
    asking_product:    "📝 Preguntando datos de prenda",
    wait_delete_id:    "🗑️ Esperando ID para eliminar",
    confirm_delete:    "⚠️ Esperando confirmación de eliminación",
  }[session.step] || `❓ Estado: ${session.step}`;

  const statusMsg = [
    `🤖 *Estado del Bot*`,
    ``,
    `📊 *Sesión actual:*`,
    `• Estado: ${estadoSesion}`,
    `• Modo: ${esc(session.mode || "ninguno")}`,
    `• Fotos en cola: ${session.queue.length}`,
    `• Prenda actual: ${session.current + 1} de ${session.queue.length || 1}`,
    `• Sub\\-paso: ${esc(session.tempStep || "—")}`,
    ``,
    `📦 *Catálogo:*`,
    `• Productos totales: ${products.length}`,
    ``,
    `⚙️ *Bot:*`,
    `• Token configurado: ${BOT_TOKEN ? "✅" : "❌"}`,
    `• Owner ID configurado: ${OWNER_ID ? "✅" : "❌"}`,
    ``,
    `_Si algo no funciona, usá /cancelar para reiniciar\\._`,
  ].join("\n");

  await sendMd(chatId, statusMsg);
}

// =============================================================================
// ── SECCIÓN 14: ROUTER DE MENSAJES DE TEXTO
// =============================================================================
async function routeTextMessage(chatId, session, message) {
  const text = (message.text || message.caption || "").trim();
  const hasphoto = message.photo && message.photo.length > 0;

  if (hasphoto) {
    if (session.step === "idle") {
      await manejarSubidaFoto(chatId, session, message.photo);
      return;
    } else {
      await sendMd(chatId, "⚠️ *Ya se está procesando una prenda\\.*\nTerminá el formulario o usá /cancelar\\.");
      return;
    }
  }

  if (text === "/start" || text.startsWith("/start ")) {
    resetSession(chatId);
    await sendMd(chatId, MSG_BIENVENIDA, { reply_markup: KB_REMOVE });
    return;
  }

  if (text === "/ayuda" || text === "/help") {
    await sendMd(chatId, MSG_AYUDA_COMPLETA);
    return;
  }

  if (text === "/cancelar" || text === "/cancel" || text === "❌ Cancelar operación") {
    resetSession(chatId);
    await sendMd(chatId, "❌ *Operación cancelada\\.*", { reply_markup: KB_REMOVE });
    return;
  }

  if (text === "/subir") {
    await sendMd(chatId, "📸 *Subir prenda\\(s\\)*\n\nMandame la foto\\.", { reply_markup: KB_WITH_CANCEL });
    return;
  }

  if (text === "/listar") {
    await listarProductos(chatId);
    return;
  }

  if (text === "/eliminar") {
    await iniciarEliminacion(chatId, session);
    return;
  }

  if (text === "/estado") {
    await mostrarEstado(chatId, session);
    return;
  }

  if (session.step === "wait_album_answer") {
    if (text === "🎨 Sí, mismo modelo — distintos colores") {
      session.mode = "album";
      session.step = "asking_product";
      await iniciarPreguntasPrenda(chatId, session, 0, false);
    } else if (text === "📦 No, son prendas distintas") {
      session.mode = "individual";
      session.step = "asking_product";
      await iniciarPreguntasPrenda(chatId, session, 0, true);
    }
    return;
  }

  if (session.step === "asking_product") {
    await procesarRespuestaPrenda(chatId, session, text);
    return;
  }
} // <--- CIERRA routeTextMessage CORRECTAMENTE

// =============================================================================
// ── FUNCIONES DE APOYO AL FINAL
// =============================================================================

async function manejarSubidaFoto(chatId, session, photoArray) {
  const photoId = photoArray[photoArray.length - 1].file_id;
  if (!session.queue) session.queue = [];
  session.queue.push({ fileId: photoId });
  session.step = "wait_album_answer";

  await sendMd(
    chatId,
    "📸 *¡Foto recibida\\!* \n\n¿Esta prenda es parte de un *mismo modelo* o son *prendas distintas*?",
    {
      reply_markup: {
        keyboard: [
          [{ text: "🎨 Sí, mismo modelo — distintos colores" }],
          [{ text: "📦 No, son prendas distintas" }],
          [{ text: "❌ Cancelar operación" }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    }
  );
}
// =============================================================================
// ── SECCIÓN 15: ROUTER DE CALLBACKS
// =============================================================================
// =============================================================================
// ── SECCIÓN 15: ROUTER DE CALLBACKS
// =============================================================================

/**
 * Enruta todos los callbacks de botones inline.
 * Los callback_data siguen el formato "accion__valor".
 *
 * ACCIONES DISPONIBLES:
 *   tipo__valor       → Selección de tipo de prenda
 *   talle__valor      → Selección de talle
 *   confirm__yes/no   → Confirmar o cancelar la carga
 *   edit__campo       → Editar un campo específico del resumen
 *   delete__yes/no    → Confirmar o cancelar la eliminación
 *   explain__yes/no   → Mostrar o no la explicación del modo individual
 *
 * @param {Object} callbackQuery - Objeto completo de Telegram
 */
async function routeCallback(callbackQuery) {
  const chatId  = String(callbackQuery.message.chat.id);
  const data    = callbackQuery.data || "";
  const session = getSession(chatId);

  // Confirmar que recibimos el callback (quita el relojito del botón)
  await answerCallback(callbackQuery.id);

  // Verificar autorización
  if (OWNER_ID && chatId !== OWNER_ID) return;

  // Parsear "accion__valor"
  const doubleUnderIdx = data.indexOf("__");
  const action = doubleUnderIdx >= 0 ? data.substring(0, doubleUnderIdx) : data;
  const value  = doubleUnderIdx >= 0 ? data.substring(doubleUnderIdx + 2) : "";

  console.log(`[callback] action=${action}, value=${value}, step=${session.step}`);

  // ── SELECCIÓN DE TIPO ─────────────────────────────────────────────────────
  if (action === "tipo") {
    const tipoInfo  = TIPOS_PRENDA.find(t => t.value === value);
    const tipoLabel = tipoInfo?.label || value;

    session.tempData.tipo = value;
    session.tempStep      = "tela";

    await sendMd(
      chatId,
      `✅ Tipo: *${esc(tipoLabel)}*\n\n🧵 *¿De qué tela es?*\n_Ejemplos: Algodón 100%, Modal, Lycra, Jean, Lino, Saten..._`,
      { reply_markup: KB_WITH_CANCEL }
    );
    return;
  }

  // ── SELECCIÓN DE TALLE ────────────────────────────────────────────────────
  if (action === "talle") {
    session.tempData.talle = value;
    session.tempStep       = "precio";

    await sendMd(
      chatId,
      `✅ Talle: *${esc(value)}*\n\n💰 *¿Cuánto cuesta?*\n_Solo el número\\. Ejemplos: 15000, 8500, 22000_`,
      { reply_markup: KB_WITH_CANCEL }
    );
    return;
  }

  // ── CONFIRMAR CARGA ───────────────────────────────────────────────────────
  if (action === "confirm") {
    if (value === "yes") {
      await guardarProducto(chatId, session);
    } else {
      // Cancelar solo esta prenda
      const numbered = session.mode === "individual";
      const quedan   = session.queue.length - session.current - 1;

      if (quedan > 0 && session.mode !== "album") {
        // Hay más prendas, saltar esta y continuar
        await sendMd(chatId, `❌ *Prenda descartada\\.*\n\nQuedan ${quedan} prenda\\(s\\) más\\.`);
        session.current++;
        await iniciarPreguntasPrenda(chatId, session, session.current, numbered);
      } else {
        // No hay más o es álbum
        resetSession(chatId);
        await sendMd(chatId, "❌ *Carga cancelada\\.* No se subió ninguna prenda\\.", { reply_markup: KB_REMOVE });
      }
    }
    return;
  }

  // ── EDITAR UN CAMPO ───────────────────────────────────────────────────────
  if (action === "edit") {
    session.tempStep = value;

    const promptsEdicion = {
      nombre:      "📝 *Nuevo nombre de la prenda:*",
      tela:        "🧵 *Nueva tela:*",
      precio:      "💰 *Nuevo precio \\(solo número\\):*",
      descripcion: "📄 *Nueva descripción \\(o enviá \\. para borrarla\\):*",
    };

    if (value === "tipo") {
      await sendMd(chatId, "🏷️ *Seleccioná el nuevo tipo:*", { reply_markup: makeTiposKeyboard() });
    } else if (value === "talle") {
      await sendMd(chatId, "📐 *Seleccioná el nuevo talle:*", { reply_markup: makeTallesKeyboard() });
    } else if (promptsEdicion[value]) {
      await sendMd(chatId, promptsEdicion[value], { reply_markup: KB_WITH_CANCEL });
    } else {
      await sendPlain(chatId, `Enviá el nuevo valor para ${value}:`);
    }
    return;
  }

  // ── CONFIRMAR/CANCELAR ELIMINACIÓN ────────────────────────────────────────
  if (action === "delete") {
    if (value === "yes") {
      const id     = session.pendingDeleteId;
      const result = removeProduct(id);

      if (result.success) {
        const nombre = result.product?.nombre || "Producto";
        await sendMd(
          chatId,
          `✅ *${esc(nombre)} eliminado correctamente\\.* \n🆔 ID: \`${esc(id)}\``,
          { reply_markup: KB_REMOVE }
        );
      } else {
        await sendMd(
          chatId,
          `❌ *No se pudo eliminar\\.*\nEl producto quizás ya fue eliminado anteriormente\\.`,
          { reply_markup: KB_REMOVE }
        );
      }
    } else {
      await sendMd(chatId, "❌ *Eliminación cancelada\\.* No se borró nada\\.", { reply_markup: KB_REMOVE });
    }
    resetSession(chatId);
    return;
  }

  // ── EXPLICACIÓN DEL MODO INDIVIDUAL ──────────────────────────────────────
  if (action === "explain") {
    if (value === "yes") {
      const count = session.queue.length;
      const pasos = session.queue
        .map((_, i) => `*Prenda ${i + 1}:* Nombre → Tipo → Tela → Talle → Precio → Descripción`)
        .join("\n");

      const explicacion = [
        `📋 *Así funciona el modo de prendas individuales:*`,
        ``,
        `Tenés *${count} fotos*\\. Voy a preguntarte los datos de cada una por separado:`,
        ``,
        pasos,
        ``,
        `Al final de cada prenda te muestro un resumen para que puedas confirmar o editar\\.`,
        ``,
        `*¡Arrancamos\\!* 🚀`,
      ].join("\n");

      await sendMd(chatId, explicacion);
      await new Promise(r => setTimeout(r, 600));
    }

    // En ambos casos (explicó o no), iniciar el flujo
    session.step    = "asking_product";
    session.current = 0;
    await iniciarPreguntasPrenda(chatId, session, 0, true);
    return;
  }

  // ── Callback no reconocido ────────────────────────────────────────────────
  console.warn("[callback] Acción no reconocida:", action, value);
  await answerCallback(callbackQuery.id, "Acción no reconocida");
}

// =============================================================================
// ── SECCIÓN 16: ENTRY POINT — NETLIFY FUNCTION HANDLER
// =============================================================================

/**
 * Handler principal de la Netlify Function.
 *
 * Telegram envía todos los updates (mensajes, callbacks, etc.) como
 * POST requests a la URL del webhook. Esta función los recibe y enruta.
 *
 * IMPORTANTE: Siempre respondemos con HTTP 200, incluso si hay errores.
 * Si Telegram recibe otro código, reintenta el update múltiples veces,
 * lo que causaría mensajes duplicados o loops.
 *
 * @param {Object} event  - Evento de Netlify (request HTTP)
 * @returns {Object}      - Respuesta HTTP
 */
exports.handler = async (event) => {

  // ── Headers de CORS (para el preflight de OPTIONS) ─────────────────────────
  const corsHeaders = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

  // ── Verificar configuración crítica ──────────────────────────────────────────
  if (!BOT_TOKEN) {
    console.error("🔴 [CRÍTICO] TELEGRAM_BOT_TOKEN no está configurado en Netlify.");
    return { statusCode: 500, body: "Bot token not configured" };
  }

  if (!OWNER_ID) {
    console.warn("🟡 [ADVERTENCIA] OWNER_ID no configurado. Cualquiera puede usar el bot.");
  }

  // ── Parsear el update de Telegram ────────────────────────────────────────────
  let update;
  try {
    update = JSON.parse(event.body || "{}");
  } catch (e) {
    console.error("[Handler] Body inválido:", e.message, "| Body:", event.body?.substring(0, 200));
    return { statusCode: 400, headers: corsHeaders, body: "Bad Request" };
  }

  // Log básico para debugging en Netlify Functions
  console.log(`[Update ${update.update_id}] Tipo: ${
    update.message       ? `mensaje de ${update.message.from?.first_name}` :
    update.callback_query? `callback "${update.callback_query.data}"` :
    "desconocido"
  }`);

  try {

    // ── CALLBACK QUERY (botón inline presionado) ──────────────────────────────
    if (update.callback_query) {
      const cb     = update.callback_query;
      const chatId = String(cb.message.chat.id);

      // Control de acceso
      if (OWNER_ID && chatId !== OWNER_ID) {
        await answerCallback(cb.id, "⛔ Sin acceso");
        return { statusCode: 200, body: "ok" };
      }

      await routeCallback(cb);
      return { statusCode: 200, body: "ok" };
    }

    // ── MENSAJE ───────────────────────────────────────────────────────────────
    if (update.message) {
      const message = update.message;
      const chatId  = String(message.chat.id);

      // Control de acceso: solo la dueña puede usar el bot
      if (OWNER_ID && chatId !== OWNER_ID) {
        console.log(`[acceso] Chat ${chatId} rechazado (OWNER: ${OWNER_ID})`);
        await sendPlain(
          chatId,
          "⛔ Este bot es privado.\n\nSolo puede ser usado por la dueña de Sofy MDN."
        );
        return { statusCode: 200, body: "ok" };
      }

      const session = getSession(chatId);

      // ── Foto recibida ──────────────────────────────────────────────────────
      if (message.photo) {
        await procesarFoto(chatId, session, message);
        return { statusCode: 200, body: "ok" };
      }

      // ── Texto recibido ─────────────────────────────────────────────────────
      if (message.text) {
        await routeTextMessage(chatId, session, message);
        return { statusCode: 200, body: "ok" };
      }

      // ── Otros tipos de contenido ───────────────────────────────────────────
      if (message.document) {
        await sendPlain(
          chatId,
          "📎 Recibí un archivo, pero solo proceso fotos.\n\nPara subir una prenda, enviame la foto directamente (no como archivo adjunto).\n\nEn iOS/Android: mantené presionada la foto y elegí 'Enviar como foto'."
        );
        return { statusCode: 200, body: "ok" };
      }

      if (message.video || message.animation) {
        await sendPlain(chatId, "🎥 Solo proceso fotos, no videos.\n\nMandame una foto de la prenda.");
        return { statusCode: 200, body: "ok" };
      }

      if (message.sticker) {
        await sendPlain(chatId, "😊 ¡Qué lindo sticker! Pero para subir prendas necesito fotos 📸");
        return { statusCode: 200, body: "ok" };
      }

      if (message.voice || message.audio) {
        await sendPlain(chatId, "🎙️ No puedo procesar audios. Escribime o mandame una foto.");
        return { statusCode: 200, body: "ok" };
      }

      // Tipo de mensaje no manejado
      console.log("[Handler] Tipo de mensaje no manejado:", Object.keys(message).join(", "));
      return { statusCode: 200, body: "ok" };
    }

    // ── Otros tipos de update (edited_message, channel_post, etc.) ───────────
    console.log("[Handler] Update no manejado:", Object.keys(update).filter(k => k !== "update_id").join(", "));

  } catch (error) {
    // ── Error inesperado ──────────────────────────────────────────────────────
    // Loguear para debugging en Netlify pero NO propagar el error
    console.error("[Handler] Error inesperado:", error.message);
    console.error("[Handler] Stack:", error.stack);

    // Intentar notificar a la dueña (puede fallar si el error es de red)
    if (OWNER_ID) {
      try {
        await sendPlain(
          OWNER_ID,
          `⚠️ Hubo un error en el bot:\n\n${error.message}\n\nSi este error se repite, contactá al desarrollador.\nUsá /cancelar para reiniciar.`
        );
      } catch (_) {
        // Silenciar error al notificar (evitar loops)
      }
    }
  }

  // Siempre responder 200 a Telegram
  return { statusCode: 200, headers: corsHeaders, body: "ok" };
};

/**
 * Procesa la recepción inicial de una foto y dispara el flujo de subida.
 */
async function manejarSubidaFoto(chatId, session, photoArray) {
  // 1. Extraer el file_id de la foto con mejor resolución (la última del array)
  const photoId = photoArray[photoArray.length - 1].file_id;

  // 2. Inicializar la cola si no existe y guardar la foto
  if (!session.queue) session.queue = [];
  session.queue.push({ fileId: photoId });

  // 3. Cambiar el estado para que el Router sepa qué sigue
  session.step = "wait_album_answer";

  // 4. Enviar el mensaje con los botones para decidir el modo
  await sendMd(
    chatId,
    "📸 *¡Foto recibida\\!* \n\n¿Esta prenda es parte de un *mismo modelo* (distintos colores) o son *prendas distintas*?",
    {
      reply_markup: {
        keyboard: [
          [{ text: "🎨 Sí, mismo modelo — distintos colores" }],
          [{ text: "📦 No, son prendas distintas" }],
          [{ text: "❌ Cancelar operación" }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    }
  );
}
