// =============================================================================
// BOT DE TELEGRAM — SOFY MDN
// Netlify Function | Node.js nativo (sin librerías externas)
//
// VARIABLES DE ENTORNO REQUERIDAS EN NETLIFY:
//   TELEGRAM_BOT_TOKEN  → Token del bot (@BotFather)
//   OWNER_ID            → Tu chat_id de Telegram
//   GITHUB_TOKEN        → Personal Access Token de GitHub
//   GITHUB_REPO         → usuario/repositorio  (ej: fabricioaguero-dev/sofymdn)
//   GITHUB_FILE_PATH    → Ruta al JSON         (ej: data/products.json)
//
// FLUJO PRINCIPAL:
//   Usuario manda FOTO
//   → Bot pregunta: Tela → Talle → Precio → Título → ¿Descripción?
//   → Se guarda en GitHub via API
//   → Aparece en la web automáticamente
// =============================================================================

"use strict";

const https = require("https");

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURACIÓN — Variables de entorno
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID        = String(process.env.OWNER_ID || "");
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const GITHUB_REPO     = process.env.GITHUB_REPO;       // "usuario/repo"
const GITHUB_FILE     = process.env.GITHUB_FILE_PATH;  // "data/products.json"

// ─────────────────────────────────────────────────────────────────────────────
// ESTADO DE SESIÓN EN MEMORIA
// Netlify puede "enfriar" la función entre mensajes separados por varios
// minutos. Si eso ocurre, el estado se pierde y hay que usar /cancelar.
// ─────────────────────────────────────────────────────────────────────────────

const sessions = {};

// Estructura de una sesión vacía
function emptySession() {
  return {
    step:       "idle",  // idle | wait_tela | wait_talle | wait_precio | wait_titulo | wait_desc
    fileId:     null,    // file_id de la foto enviada
    fileIds:    [],      // todos los file_ids si envía varias fotos (álbum)
    mediaGroup: null,    // media_group_id para agrupar fotos
    tela:       null,
    talle:      null,
    precio:     null,
    titulo:     null,
    descripcion: null,
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
// OPCIONES DE TELAS Y TALLES (para los botones inline)
// Podés modificar estas listas según los productos de Sofy MDN
// ─────────────────────────────────────────────────────────────────────────────

const TELAS = [
  "Algodón", "Modal", "Lycra", "Jean",
  "Lino", "Saten", "Tul", "Cuerina",
  "Polar", "Otra",
];

const TALLES = ["XS", "S", "M", "L", "XL", "XXL", "Único"];

const PRECIOS_RAPIDOS = [
  "$5.000", "$8.000", "$10.000", "$12.000",
  "$15.000", "$18.000", "$20.000", "Otro precio",
];

// ─────────────────────────────────────────────────────────────────────────────
// GITHUB API — Leer y escribir el JSON de productos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hace una petición HTTPS a la API de GitHub.
 * Devuelve { status, data } donde data ya está parseado como JSON.
 */
function githubRequest(method, path, body = null) {
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
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });

    req.on("timeout", () => { req.destroy(); reject(new Error("GitHub API timeout")); });
    req.on("error",   reject);

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Lee los productos desde GitHub.
 * Maneja el caso de archivo vacío o inexistente devolviendo [] sin romper.
 * Devuelve { products: Array, sha: string }
 */
async function readProducts() {
  const { status, data } = await githubRequest("GET");

  // Si el archivo no existe todavía
  if (status === 404) {
    console.log("[GitHub] Archivo no encontrado, se creará uno nuevo.");
    return { products: [], sha: null };
  }

  if (status !== 200 || !data || !data.content) {
    throw new Error(`GitHub GET falló con status ${status}`);
  }

  const sha = data.sha;

  // El contenido viene en base64 desde GitHub
  const rawContent = Buffer.from(data.content, "base64").toString("utf8").trim();

  // MANEJO DE ARCHIVO VACÍO: si está vacío, devolver lista vacía
  if (!rawContent) {
    console.log("[GitHub] Archivo vacío detectado, inicializando con []");
    return { products: [], sha };
  }

  // Parsear el JSON
  let products;
  try {
    products = JSON.parse(rawContent);
    // Si por alguna razón no es un array, forzar array vacío
    if (!Array.isArray(products)) {
      console.warn("[GitHub] El JSON no era un array, reiniciando a []");
      products = [];
    }
  } catch (e) {
    // SyntaxError u otro error de parseo → inicializar vacío en lugar de romper
    console.error("[GitHub] Error parseando JSON:", e.message, "| Contenido:", rawContent.substring(0, 100));
    products = [];
  }

  return { products, sha };
}

/**
 * Guarda los productos en GitHub (hace un PUT al archivo).
 * @param {Array}  products  - Array completo de productos
 * @param {string} sha       - SHA del archivo actual (requerido por GitHub para actualizar)
 * @param {string} message   - Mensaje del commit
 */
async function saveProducts(products, sha, message = "Actualizar productos via bot") {
  const jsonString = JSON.stringify(products, null, 2);
  const base64     = Buffer.from(jsonString).toString("base64");

  const body = {
    message,
    content: base64,
    ...(sha ? { sha } : {}), // si sha es null, GitHub crea el archivo nuevo
  };

  const { status, data } = await githubRequest("PUT", null, body);

  if (status !== 200 && status !== 201) {
    console.error("[GitHub] PUT falló:", status, JSON.stringify(data).substring(0, 200));
    throw new Error(`GitHub PUT falló con status ${status}: ${data?.message || "Error desconocido"}`);
  }

  console.log("[GitHub] Guardado OK. Commit:", data?.commit?.sha?.substring(0, 7));
  return true;
}

/**
 * Obtiene la URL pública de un archivo enviado al bot de Telegram.
 * @param {string} fileId
 * @returns {Promise<string>} URL o "" si falla
 */
function getTelegramFileUrl(fileId) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ file_id: fileId });
    const options = {
      hostname: "api.telegram.org",
      path:     `/bot${BOT_TOKEN}/getFile`,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", d => { raw += d; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.ok && parsed.result?.file_path) {
            resolve(`https://api.telegram.org/file/bot${BOT_TOKEN}/${parsed.result.file_path}`);
          } else {
            console.error("[getFile] Sin file_path:", raw.substring(0, 150));
            resolve("");
          }
        } catch {
          resolve("");
        }
      });
    });

    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM API — Funciones de envío
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Llama a cualquier método de la API de Telegram via POST.
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
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", d => { raw += d; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed.ok) console.error(`[Telegram ${method}] Error:`, parsed.description);
          resolve(parsed);
        } catch {
          resolve({ ok: false });
        }
      });
    });

    req.on("error",   () => resolve({ ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
    req.write(body);
    req.end();
  });
}

/**
 * Envía un mensaje de texto simple.
 */
function sendMessage(chatId, text, extra = {}) {
  return callTelegram("sendMessage", { chat_id: chatId, text, ...extra });
}

/**
 * Envía un mensaje con botones inline.
 * @param {string}   chatId
 * @param {string}   text
 * @param {string[][]} buttonRows  - Ej: [["Btn1", "Btn2"], ["Btn3"]]
 *                                   El texto del botón == callback_data
 */
function sendButtons(chatId, text, buttonRows) {
  const inline_keyboard = buttonRows.map(row =>
    row.map(label => ({ text: label, callback_data: label }))
  );
  return callTelegram("sendMessage", {
    chat_id:      chatId,
    text,
    reply_markup: { inline_keyboard },
  });
}

/**
 * Confirma un callback query (quita el indicador de carga del botón).
 */
function answerCallback(id) {
  return callTelegram("answerCallbackQuery", { callback_query_id: id });
}

// ─────────────────────────────────────────────────────────────────────────────
// LÓGICA DEL FLUJO DE CARGA DE PRENDA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Paso 1 — El usuario mandó una foto.
 * Guardamos el file_id y preguntamos la tela.
 */
async function handlePhoto(chatId, session, message) {
  // Tomar la foto de mayor resolución
  const photo  = message.photo;
  const fileId = photo[photo.length - 1].file_id;
  const mgId   = message.media_group_id;

  // Si ya está en un flujo activo, ignorar
  if (session.step !== "idle") {
    await sendMessage(chatId, "⚠️ Ya estoy procesando una prenda. Usá /cancelar si querés empezar de nuevo.");
    return;
  }

  // Acumular file_ids del álbum si aplica
  session.fileIds.push(fileId);
  if (mgId) {
    session.mediaGroup = mgId;
    // Esperar a que lleguen todas las fotos del grupo
    await new Promise(r => setTimeout(r, 2000));
  }

  // Guardar el primer fileId como principal
  session.fileId = session.fileIds[0];
  session.step   = "wait_tela";

  await sendButtons(chatId, "📸 ¡Foto recibida!\n\n🧵 *¿De qué tela es la prenda?*", [
    TELAS.slice(0, 5),
    TELAS.slice(5),
  ]);
}

/**
 * Paso 2 — Preguntar el talle.
 */
async function askTalle(chatId) {
  await sendButtons(chatId, "✅ Tela guardada.\n\n📐 *¿Qué talle tiene?*", [
    TALLES.slice(0, 4),
    TALLES.slice(4),
  ]);
}

/**
 * Paso 3 — Preguntar el precio (botones de atajos + posibilidad de escribir).
 */
async function askPrecio(chatId) {
  await sendButtons(
    chatId,
    "✅ Talle guardado.\n\n💰 *¿Cuánto cuesta?*\nElegí un precio rápido o escribí el número:",
    [
      PRECIOS_RAPIDOS.slice(0, 4),
      PRECIOS_RAPIDOS.slice(4),
    ]
  );
}

/**
 * Paso 4 — Preguntar el título (texto libre).
 */
async function askTitulo(chatId) {
  await sendMessage(chatId, "✅ Precio guardado.\n\n🏷️ *¿Cuál es el nombre o título de esta prenda?*\n\n_Ejemplo: Remera básica oversize, Vestido floral midi..._");
}

/**
 * Paso 5 — Preguntar si quiere agregar descripción.
 */
async function askDescripcion(chatId) {
  await sendButtons(
    chatId,
    "✅ Título guardado.\n\n📄 *¿Querés agregar una descripción?*\n_Puede incluir detalles, cómo combinarla, etc._",
    [["✏️ Sí, agregar descripción", "⏭️ No, saltar"]]
  );
}

/**
 * Paso final — Guardar el producto en GitHub y notificar.
 */
async function saveProduct(chatId, session) {
  await sendMessage(chatId, "⏳ Guardando en GitHub, un momento...");

  try {
    // Obtener URL de la imagen
    const imageUrl = await getTelegramFileUrl(session.fileId);

    // Si hay múltiples fotos (álbum), obtener todas las URLs
    let imagenes = [];
    if (session.fileIds.length > 1) {
      const urls = await Promise.all(session.fileIds.map(id => getTelegramFileUrl(id)));
      imagenes   = urls.filter(Boolean);
    } else {
      imagenes = imageUrl ? [imageUrl] : [];
    }

    if (imagenes.length === 0) {
      await sendMessage(chatId, "❌ No pude obtener la URL de la foto. Intentá de nuevo enviando la foto.");
      resetSession(chatId);
      return;
    }

    // Parsear precio: eliminar $, puntos, y convertir a número
    const precioLimpio = String(session.precio)
      .replace(/[$\s.]/g, "")
      .replace(",", ".");
    const precioNum = parseFloat(precioLimpio) || 0;

    // Construir objeto producto
    const producto = {
      id:           `prod_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      nombre:       session.titulo,
      tela:         session.tela,
      talle:        session.talle,
      precio:       precioNum,
      descripcion:  session.descripcion || "",
      tipo:         "otro",            // puede editarse manualmente en el JSON
      imagenes,
      activo:       true,
      fechaAgregado: new Date().toISOString(),
    };

    // Leer productos actuales de GitHub
    const { products, sha } = await readProducts();

    // Agregar al inicio del array (más nuevo primero)
    products.unshift(producto);

    // Guardar de vuelta en GitHub
    await saveProducts(
      products,
      sha,
      `Agregar producto: ${producto.nombre} (${producto.talle})`
    );

    // Confirmar a la dueña
    const msg = [
      `✅ *¡${producto.nombre} subida a la web!*`,
      ``,
      `🧵 Tela: ${producto.tela}`,
      `📐 Talle: ${producto.talle}`,
      `💰 Precio: $${precioNum.toLocaleString("es-AR")}`,
      producto.descripcion ? `📄 Descripción: ${producto.descripcion}` : ``,
      `🖼️ Fotos: ${imagenes.length}`,
      `🆔 ID: \`${producto.id}\``,
      ``,
      `_¡Ya está visible en la web!_ 🎉`,
    ].filter(l => l !== "").join("\n");

    await sendMessage(chatId, msg, { parse_mode: "Markdown" });
    resetSession(chatId);

  } catch (err) {
    console.error("[saveProduct] Error:", err.message);
    await sendMessage(
      chatId,
      `❌ Error al guardar: ${err.message}\n\nVerificá las variables de entorno GITHUB_TOKEN, GITHUB_REPO y GITHUB_FILE_PATH en Netlify.`
    );
    resetSession(chatId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTER DE MENSAJES DE TEXTO
// ─────────────────────────────────────────────────────────────────────────────

async function handleText(chatId, session, text) {

  // ── COMANDOS (siempre tienen prioridad) ───────────────────────────────────

  if (text === "/start") {
    resetSession(chatId);
    await sendMessage(chatId,
      `🛍️ *¡Hola Sofy! Soy tu bot de catálogo.*\n\n` +
      `Para subir una prenda, *mandame una foto* y te guío paso a paso.\n\n` +
      `*Comandos disponibles:*\n` +
      `/listar — Ver todos los productos\n` +
      `/cancelar — Cancelar la operación actual\n` +
      `/ayuda — Ver esta ayuda`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (text === "/ayuda") {
    await sendMessage(chatId,
      `📖 *Guía de uso:*\n\n` +
      `1️⃣ Mandame una *foto* de la prenda\n` +
      `2️⃣ Te pregunto: *Tela → Talle → Precio → Título*\n` +
      `3️⃣ Pregunto si querés agregar descripción\n` +
      `4️⃣ Se guarda automáticamente en la web\n\n` +
      `Si mandás *varias fotos juntas*, todas quedan como imágenes de la misma prenda.\n\n` +
      `Usá /cancelar en cualquier momento para reiniciar.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (text === "/cancelar") {
    resetSession(chatId);
    await sendMessage(chatId, "❌ Operación cancelada. Cuando quieras, mandame una foto para subir una prenda.");
    return;
  }

  if (text === "/listar") {
    await handleListar(chatId);
    return;
  }

  // ── FLUJO DE PASOS ────────────────────────────────────────────────────────

  // STEP: wait_precio — puede llegar como texto si no usó el botón
  if (session.step === "wait_precio") {
    // Parsear precio escrito manualmente
    const limpio = text.replace(/[$\s.]/g, "").replace(",", ".");
    const num    = parseFloat(limpio);

    if (isNaN(num) || num <= 0) {
      await sendMessage(chatId, "⚠️ Precio inválido. Ingresá solo el número. Ej: 15000 o $15.000");
      return;
    }

    session.precio = num;
    session.step   = "wait_titulo";
    await askTitulo(chatId);
    return;
  }

  // STEP: wait_titulo
  if (session.step === "wait_titulo") {
    if (!text || text.trim().length < 2) {
      await sendMessage(chatId, "⚠️ El título es muy corto. Ingresá al menos 2 caracteres.");
      return;
    }
    session.titulo = text.trim();
    session.step   = "wait_desc";
    await askDescripcion(chatId);
    return;
  }

  // STEP: wait_desc — si escribe texto en lugar de usar el botón
  if (session.step === "wait_desc") {
    // Interpretar como descripción directa si escribe algo
    session.descripcion = text.trim();
    await saveProduct(chatId, session);
    return;
  }

  // ── Sin contexto ──────────────────────────────────────────────────────────
  if (session.step === "idle") {
    await sendMessage(chatId, "👋 Mandame una foto de una prenda para empezar, o usá /ayuda para ver los comandos.");
    return;
  }

  // Fallback
  await sendMessage(chatId, "No entendí eso. Usá /cancelar para reiniciar o /ayuda para ver los comandos.");
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTAR PRODUCTOS
// ─────────────────────────────────────────────────────────────────────────────

async function handleListar(chatId) {
  try {
    const { products } = await readProducts();

    if (!products.length) {
      await sendMessage(chatId, "📭 No hay productos en el catálogo todavía. Mandame una foto para agregar el primero.");
      return;
    }

    await sendMessage(chatId, `📋 *Catálogo — ${products.length} producto(s):*`, { parse_mode: "Markdown" });

    // Mostrar en grupos de 8 para no saturar
    const PAGE = 8;
    for (let i = 0; i < products.length; i += PAGE) {
      const lines = products.slice(i, i + PAGE).map((p, j) => {
        const num   = i + j + 1;
        const imgs  = (p.imagenes || []).length;
        const price = `$${Number(p.precio || 0).toLocaleString("es-AR")}`;
        return `${num}. *${p.nombre}* — ${price}\n   Tela: ${p.tela} | Talle: ${p.talle} | 📷 ${imgs}\n   ID: \`${p.id}\``;
      });
      await sendMessage(chatId, lines.join("\n\n"), { parse_mode: "Markdown" });
      if (i + PAGE < products.length) await new Promise(r => setTimeout(r, 400));
    }
  } catch (err) {
    await sendMessage(chatId, `❌ Error al leer productos: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTER DE CALLBACKS (botones inline presionados)
// ─────────────────────────────────────────────────────────────────────────────

async function handleCallback(chatId, session, callbackId, data) {
  // Confirmar que se procesó el botón (quita el relojito)
  await answerCallback(callbackId);

  // ── STEP: wait_tela ───────────────────────────────────────────────────────
  if (session.step === "wait_tela") {
    if (!TELAS.includes(data)) return;
    session.tela = data;
    session.step = "wait_talle";
    await askTalle(chatId);
    return;
  }

  // ── STEP: wait_talle ──────────────────────────────────────────────────────
  if (session.step === "wait_talle") {
    if (!TALLES.includes(data)) return;
    session.talle = data;
    session.step  = "wait_precio";
    await askPrecio(chatId);
    return;
  }

  // ── STEP: wait_precio ─────────────────────────────────────────────────────
  if (session.step === "wait_precio") {
    if (data === "Otro precio") {
      // Pedir que lo escriban
      await sendMessage(chatId, "💰 Escribí el precio (solo el número, ej: 15000):");
      // El step queda en wait_precio, handleText lo va a capturar
      return;
    }

    // Parsear precio del botón (puede ser "$15.000")
    const limpio = data.replace(/[$\s.]/g, "").replace(",", ".");
    const num    = parseFloat(limpio);

    if (isNaN(num) || num <= 0) {
      await sendMessage(chatId, "⚠️ No pude leer ese precio. Escribilo manualmente (ej: 15000).");
      return;
    }

    session.precio = num;
    session.step   = "wait_titulo";
    await askTitulo(chatId);
    return;
  }

  // ── STEP: wait_desc ───────────────────────────────────────────────────────
  if (session.step === "wait_desc") {
    if (data === "⏭️ No, saltar") {
      session.descripcion = "";
      await saveProduct(chatId, session);
      return;
    }

    if (data === "✏️ Sí, agregar descripción") {
      await sendMessage(chatId, "📄 Escribí la descripción de la prenda:");
      // El step queda en wait_desc, handleText lo va a capturar cuando escriba
      return;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT — NETLIFY FUNCTION HANDLER
// ─────────────────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Headers CORS (Telegram también necesita 200 en OPTIONS a veces)
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: "Method Not Allowed" };

  // Verificar variables de entorno críticas
  if (!BOT_TOKEN) {
    console.error("CRÍTICO: TELEGRAM_BOT_TOKEN no configurado");
    return { statusCode: 500, body: "Bot token missing" };
  }
  if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_FILE) {
    console.error("CRÍTICO: Variables de GitHub no configuradas");
    // No bloqueamos el inicio del bot, pero las operaciones de GitHub van a fallar
  }

  // Parsear el update de Telegram
  let update;
  try {
    update = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Bad request" };
  }

  // Log básico para los logs de Netlify
  console.log(`[Update ${update.update_id}]`, update.message ? "mensaje" : update.callback_query ? "callback" : "otro");

  try {
    // ── CALLBACK (botón presionado) ──────────────────────────────────────────
    if (update.callback_query) {
      const cb     = update.callback_query;
      const chatId = String(cb.message.chat.id);

      if (OWNER_ID && chatId !== OWNER_ID) {
        await answerCallback(cb.id);
        return { statusCode: 200, body: "ok" };
      }

      const session = getSession(chatId);
      await handleCallback(chatId, session, cb.id, cb.data);
      return { statusCode: 200, body: "ok" };
    }

    // ── MENSAJE ──────────────────────────────────────────────────────────────
    if (update.message) {
      const msg    = update.message;
      const chatId = String(msg.chat.id);

      // Seguridad: solo responder al OWNER_ID
      if (OWNER_ID && chatId !== OWNER_ID) {
        await sendMessage(chatId, "⛔ Este bot es privado.");
        return { statusCode: 200, body: "ok" };
      }

      const session = getSession(chatId);

      // Foto
      if (msg.photo) {
        await handlePhoto(chatId, session, msg);
        return { statusCode: 200, body: "ok" };
      }

      // Texto
      if (msg.text) {
        await handleText(chatId, session, msg.text.trim());
        return { statusCode: 200, body: "ok" };
      }

      // Documento (foto enviada como archivo)
      if (msg.document) {
        await sendMessage(chatId, "📎 Recibí un archivo. Para subir prendas, enviame la foto directamente (no como archivo adjunto).");
        return { statusCode: 200, body: "ok" };
      }
    }

  } catch (err) {
    console.error("[Handler] Error inesperado:", err.message, err.stack);
    // Notificar a la dueña si es posible
    if (OWNER_ID) {
      try {
        await sendMessage(OWNER_ID, `⚠️ Error en el bot: ${err.message}\n\nUsá /cancelar y probá de nuevo.`);
      } catch { /* ignorar */ }
    }
  }

  // Siempre responder 200 (Telegram reintenta si recibe otro código)
  return { statusCode: 200, headers, body: "ok" };
};
