// =============================================================================
// 🧾 BOT DE COMPROBANTES — Sofy MDN
// =============================================================================
// Archivo: netlify/functions/comprobantes.js
//
// DESCRIPCIÓN:
//   Bot secundario que recibe los comprobantes de pago de los clientes
//   junto con sus datos de formulario, y los reenvía a la dueña de Sofy MDN.
//
// FLUJO:
//   1. El cliente completa el formulario en la web (nombre, apellido, DNI, etc.)
//   2. La web llama a /api/comprobante con los datos + la foto del comprobante
//   3. Esta función formatea todo y lo envía por Telegram a la dueña
//
// VARIABLES DE ENTORNO REQUERIDAS:
//   - TELEGRAM_BOT_TOKEN  → Token del bot (mismo que el bot de catálogo)
//   - OWNER_ID            → Chat ID de la dueña
//
// NOTA: Se puede usar el mismo bot token o uno diferente.
// =============================================================================

"use strict";

const https = require("https");

// ── Configuración ──────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID  = process.env.OWNER_ID;

// =============================================================================
// ── UTILIDADES DE TELEGRAM
// =============================================================================

/**
 * Hace una petición a la API de Telegram.
 * @param {string} method
 * @param {Object} payload
 * @returns {Promise<Object>}
 */
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
      timeout: 15000,
    };

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", d => { data += d; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ ok: false });
        }
      });
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
    req.write(body);
    req.end();
  });
}

/**
 * Envía un mensaje de texto al chat de la dueña.
 * @param {string} text
 * @param {string} [parseMode]
 */
async function sendToOwner(text, parseMode = "MarkdownV2") {
  return callTelegram("sendMessage", {
    chat_id:    OWNER_ID,
    text:       text.substring(0, 4096),
    parse_mode: parseMode,
  });
}

/**
 * Reenvía una foto al chat de la dueña con un caption.
 * @param {string} fileId  - file_id de Telegram si es una foto del bot
 * @param {string} caption
 */
async function sendPhotoToOwner(fileId, caption) {
  return callTelegram("sendPhoto", {
    chat_id:    OWNER_ID,
    photo:      fileId,
    caption:    caption.substring(0, 1024),
    parse_mode: "MarkdownV2",
  });
}

/**
 * Escapa caracteres especiales para MarkdownV2.
 * @param {string|number} str
 * @returns {string}
 */
function esc(str) {
  return String(str || "").replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, c => `\\${c}`);
}

/**
 * Valida que un DNI argentino sea válido (7 u 8 dígitos).
 * @param {string} dni
 * @returns {boolean}
 */
function validarDNI(dni) {
  return /^\d{7,8}$/.test(String(dni).replace(/\./g, "").trim());
}

/**
 * Formatea precio en pesos argentinos.
 * @param {number|string} amount
 * @returns {string}
 */
function formatPrice(amount) {
  return `$${Number(amount || 0).toLocaleString("es-AR")}`;
}

/**
 * Formatea una fecha ISO a formato legible.
 * @param {string} [iso]
 * @returns {string}
 */
function formatDateTime(iso) {
  try {
    return new Date(iso || Date.now()).toLocaleString("es-AR", {
      timeZone:    "America/Argentina/Buenos_Aires",
      day:         "2-digit",
      month:       "2-digit",
      year:        "numeric",
      hour:        "2-digit",
      minute:      "2-digit",
    });
  } catch {
    return new Date().toLocaleString("es-AR");
  }
}

// =============================================================================
// ── VALIDACIÓN DE DATOS DEL FORMULARIO
// =============================================================================

/**
 * Valida los datos del formulario de pago.
 * Devuelve lista de errores (vacía si todo está OK).
 *
 * @param {Object} data
 * @returns {string[]} Array de errores
 */
function validarFormulario(data) {
  const errores = [];

  if (!data.nombre || data.nombre.trim().length < 2) {
    errores.push("El nombre es requerido (mínimo 2 caracteres)");
  }
  if (!data.apellido || data.apellido.trim().length < 2) {
    errores.push("El apellido es requerido (mínimo 2 caracteres)");
  }
  if (!data.dni || !validarDNI(data.dni)) {
    errores.push("El DNI debe tener 7 u 8 dígitos");
  }
  if (!data.nombreTransferencia || data.nombreTransferencia.trim().length < 2) {
    errores.push("El nombre de la transferencia es requerido");
  }
  if (!data.monto || isNaN(Number(data.monto)) || Number(data.monto) <= 0) {
    errores.push("El monto debe ser un número válido mayor a 0");
  }

  return errores;
}

// =============================================================================
// ── CONSTRUIR MENSAJE PARA LA DUEÑA
// =============================================================================

/**
 * Construye el mensaje de notificación para la dueña con todos los datos.
 *
 * @param {Object} formData    - Datos del formulario
 * @param {Object} pedido      - Datos del pedido (items del carrito)
 * @param {string} timestamp   - Timestamp del pedido
 * @param {string} pedidoId    - ID único del pedido
 * @returns {string} Mensaje en formato MarkdownV2
 */
function buildOwnerMessage(formData, pedido, timestamp, pedidoId) {
  // Datos del cliente
  const nombre     = esc(formData.nombre?.trim());
  const apellido   = esc(formData.apellido?.trim());
  const dni        = esc(formData.dni?.replace(/\./g, "").trim());
  const nombreTrf  = esc(formData.nombreTransferencia?.trim());
  const monto      = esc(formatPrice(formData.monto));
  const fecha      = esc(formatDateTime(timestamp));
  const id         = esc(pedidoId);

  // Items del pedido (si los hay)
  let itemsText = "";
  if (pedido && pedido.items && pedido.items.length > 0) {
    const itemLines = pedido.items.map((item, i) =>
      `  ${i + 1}\\. ${esc(item.nombre)} \\(Talle ${esc(item.talle)}\\) × ${item.qty} \\= ${esc(formatPrice(item.precio * item.qty))}`
    );
    itemLines.push(`  *Total: ${esc(formatPrice(pedido.total))}*`);
    itemsText = `\n📦 *PEDIDO:*\n${itemLines.join("\n")}\n`;
  }

  return [
    `🧾 *NUEVO COMPROBANTE DE PAGO*`,
    `━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `👤 *DATOS DEL CLIENTE:*`,
    `• Nombre: *${nombre} ${apellido}*`,
    `• DNI: \`${dni}\``,
    ``,
    `💳 *DATOS DEL PAGO:*`,
    `• Nombre en transferencia: *${nombreTrf}*`,
    `• Monto pagado: *${monto}*`,
    itemsText,
    `📅 *Fecha:* ${fecha}`,
    `🆔 *ID Pedido:* \`${id}\``,
    `━━━━━━━━━━━━━━━━━━━━━`,
    `_El comprobante aparece en la imagen adjunta\\._`,
  ].filter(l => l !== undefined).join("\n");
}

// =============================================================================
// ── ENTRY POINT
// =============================================================================

/**
 * Handler de Netlify Function.
 * Acepta POST con multipart/form-data (foto + datos JSON).
 *
 * BODY ESPERADO (JSON):
 * {
 *   nombre:              string,
 *   apellido:            string,
 *   dni:                 string,
 *   nombreTransferencia: string,
 *   monto:               number,
 *   comprobanteBase64:   string,  ← foto en base64
 *   pedido: {
 *     items: [{ nombre, talle, precio, qty }],
 *     total: number
 *   }
 * }
 *
 * @param {Object} event
 * @returns {Object} Respuesta HTTP
 */
exports.handler = async (event) => {
  // ── CORS ──────────────────────────────────────────────────────────────────────
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type":                 "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  // ── Verificar configuración ───────────────────────────────────────────────────
  if (!BOT_TOKEN || !OWNER_ID) {
    console.error("[comprobantes] Variables de entorno no configuradas");
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Bot no configurado correctamente" }),
    };
  }

  // ── Parsear body ──────────────────────────────────────────────────────────────
  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch (e) {
    console.error("[comprobantes] Body inválido:", e.message);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Datos inválidos" }),
    };
  }

  // ── Validar formulario ────────────────────────────────────────────────────────
  const errores = validarFormulario(data);
  if (errores.length > 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Datos incompletos", detalles: errores }),
    };
  }

  // Verificar que haya comprobante
  if (!data.comprobanteBase64) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Falta el comprobante de pago" }),
    };
  }

  // ── Generar ID único del pedido ───────────────────────────────────────────────
  const pedidoId  = `PED_${Date.now()}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const timestamp = new Date().toISOString();

  console.log(`[comprobantes] Procesando pedido ${pedidoId} de ${data.nombre} ${data.apellido}`);

  try {
    // ── Enviar foto del comprobante con caption ────────────────────────────────

    // El comprobante viene como base64 desde el frontend
    // Lo enviamos via sendPhoto con base64
    const caption = buildOwnerMessage(data, data.pedido, timestamp, pedidoId);

    // Para enviar imagen base64 a Telegram necesitamos usar multipart
    // Convertimos y enviamos como sendDocument con el base64
    const fotoResult = await enviarFotoBase64(data.comprobanteBase64, caption);

    if (!fotoResult.ok) {
      console.error("[comprobantes] Error enviando foto:", fotoResult.description);

      // Si falló la foto, al menos enviar los datos como texto
      await sendToOwner(caption + `\n\n⚠️ _No se pudo adjuntar el comprobante automáticamente\\._`);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success:  true,
          pedidoId,
          warning:  "Datos enviados pero el comprobante tuvo un error. La dueña fue notificada.",
        }),
      };
    }

    console.log(`[comprobantes] Pedido ${pedidoId} enviado correctamente a la dueña`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:  true,
        pedidoId,
        mensaje:  "Comprobante enviado correctamente. Nos pondremos en contacto pronto.",
      }),
    };

  } catch (error) {
    console.error("[comprobantes] Error inesperado:", error.message, error.stack);

    // Intentar enviar notificación de error
    try {
      await sendToOwner(
        `⚠️ *Error procesando comprobante*\n\nCliente: ${esc(data.nombre)} ${esc(data.apellido)}\nError: ${esc(error.message)}\n\n_Revisá los logs de Netlify\\._`
      );
    } catch (_) {}

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Error interno. Por favor contactanos directamente por WhatsApp.",
      }),
    };
  }
};

// =============================================================================
// ── ENVIAR FOTO BASE64 A TELEGRAM
// =============================================================================

/**
 * Envía una imagen en formato base64 a Telegram usando multipart/form-data.
 * Telegram no acepta base64 directo en el JSON, necesita multipart.
 *
 * @param {string} base64Data  - Imagen en base64 (puede incluir el header data:image/...)
 * @param {string} caption     - Caption del mensaje
 * @returns {Promise<Object>}
 */
function enviarFotoBase64(base64Data, caption) {
  return new Promise((resolve) => {
    try {
      // Limpiar el header del base64 si existe (data:image/jpeg;base64,...)
      const base64Clean = base64Data.includes(",")
        ? base64Data.split(",")[1]
        : base64Data;

      // Detectar el tipo de imagen por el header
      const mimeType = base64Data.startsWith("data:image/png")
        ? "image/png"
        : base64Data.startsWith("data:image/gif")
        ? "image/gif"
        : "image/jpeg";

      const imageBuffer = Buffer.from(base64Clean, "base64");

      // Construir multipart/form-data manualmente
      const boundary = `----FormBoundary${Date.now()}`;
      const CRLF     = "\r\n";

      // Campo chat_id
      const chatIdPart =
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}` +
        `${OWNER_ID}${CRLF}`;

      // Campo caption
      const captionPart =
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="caption"${CRLF}${CRLF}` +
        `${caption.substring(0, 1024)}${CRLF}`;

      // Campo parse_mode
      const parsePart =
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="parse_mode"${CRLF}${CRLF}` +
        `MarkdownV2${CRLF}`;

      // Campo photo (la imagen)
      const photoHeader =
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="photo"; filename="comprobante.jpg"${CRLF}` +
        `Content-Type: ${mimeType}${CRLF}${CRLF}`;

      const closing = `${CRLF}--${boundary}--${CRLF}`;

      // Combinar todo en un Buffer
      const bodyParts = [
        Buffer.from(chatIdPart, "utf8"),
        Buffer.from(captionPart, "utf8"),
        Buffer.from(parsePart, "utf8"),
        Buffer.from(photoHeader, "utf8"),
        imageBuffer,
        Buffer.from(closing, "utf8"),
      ];
      const bodyBuffer = Buffer.concat(bodyParts);

      const options = {
        hostname: "api.telegram.org",
        path:     `/bot${BOT_TOKEN}/sendPhoto`,
        method:   "POST",
        headers: {
          "Content-Type":   `multipart/form-data; boundary=${boundary}`,
          "Content-Length": bodyBuffer.length,
        },
        timeout: 30000, // 30 segundos para subida de imagen
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.ok) {
              console.error("[enviarFoto] Error de Telegram:", parsed.description);
            }
            resolve(parsed);
          } catch (e) {
            console.error("[enviarFoto] Error parseando respuesta:", e.message);
            resolve({ ok: false, description: "Parse error" });
          }
        });
      });

      req.on("timeout", () => {
        console.error("[enviarFoto] Timeout");
        req.destroy();
        resolve({ ok: false, description: "Timeout" });
      });

      req.on("error", (e) => {
        console.error("[enviarFoto] Error de red:", e.message);
        resolve({ ok: false, description: e.message });
      });

      req.write(bodyBuffer);
      req.end();

    } catch (e) {
      console.error("[enviarFotoBase64] Error preparando imagen:", e.message);
      resolve({ ok: false, description: e.message });
    }
  });
}
