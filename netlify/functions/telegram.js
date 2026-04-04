"use strict";

const https = require("https");

const CONFIG = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    owner: String(process.env.OWNER_ID || ""),
    githubToken: process.env.GITHUB_TOKEN,
    githubRepo: process.env.GITHUB_REPO,
    githubPath: process.env.GITHUB_FILE_PATH || "data/products.json"
};

const sessions = {};

// Listas para los botones
const OPCIONES = {
    telas: ["Algodón", "Lino", "Seda", "Lana", "Jean", "Poliester", "Viscosa", "Otro"],
    talles: ["XS", "S", "M", "L", "XL", "XXL", "Único"],
    precios: ["$5000", "$8000", "$10000", "$12000", "$15000", "Escribir manualmente"]
};

// --- AYUDANTE DE TELEGRAM ---
async function callTelegram(method, payload) {
    const body = JSON.stringify(payload);
    return new Promise((resolve) => {
        const req = https.request({
            hostname: "api.telegram.org",
            path: `/bot${CONFIG.token}/${method}`,
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
        }, (res) => {
            let d = "";
            res.on("data", (chunk) => d += chunk);
            res.on("end", () => resolve(JSON.parse(d)));
        });
        req.write(body);
        req.end();
    });
}

async function enviarTeclado(chatId, texto, opciones) {
    const keyboard = opciones.map(opt => [{ text: opt }]);
    return callTelegram("sendMessage", {
        chat_id: chatId,
        text: texto,
        parse_mode: "MarkdownV2",
        reply_markup: { keyboard: keyboard, resize_keyboard: true, one_time_keyboard: true }
    });
}

// --- MOTOR DE GITHUB ---
async function guardarEnGitHub(nuevoProducto) {
    const url = `https://api.github.com/repos/${CONFIG.githubRepo}/contents/${CONFIG.githubPath}`;
    const headers = { 
        "Authorization": `Bearer ${CONFIG.githubToken}`, 
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "SofyBot-App"
    };

    try {
        const resGet = await fetch(url, { headers });
        let sha = "";
        let productos = [];

        if (resGet.ok) {
            const fileData = await resGet.json();
            sha = fileData.sha;
            productos = JSON.parse(Buffer.from(fileData.content, "base64").toString());
        }

        productos.push(nuevoProducto);

        const resPut = await fetch(url, {
            method: "PUT",
            headers,
            body: JSON.stringify({
                message: `📦 Nuevo producto: ${nuevoProducto.titulo}`,
                content: Buffer.from(JSON.stringify(productos, null, 2)).toString("base64"),
                sha: sha
            })
        });
        return resPut.ok;
    } catch (e) {
        console.error("Error GitHub:", e);
        return false;
    }
}

// --- FLUJO DE CONTROL ---
exports.handler = async (event) => {
    const update = JSON.parse(event.body);
    if (!update.message) return { statusCode: 200 };

    const chatId = update.message.chat.id;
    const text = (update.message.text || "").trim();
    const photo = update.message.photo;
    
    if (!sessions[chatId]) sessions[chatId] = { step: "idle", data: {}, photos: [] };
    const session = sessions[chatId];

    // Seguridad
    if (String(chatId) !== CONFIG.owner) {
        await callTelegram("sendMessage", { chat_id: chatId, text: "🚫 No autorizado\\." });
        return { statusCode: 200 };
    }

    // Comandos de interrupción
    if (text === "/start" || text === "/cancelar") {
        sessions[chatId] = { step: "idle", data: {}, photos: [] };
        await callTelegram("sendMessage", { chat_id: chatId, text: "🔄 *Bot reiniciado*\\. Mandame una foto para empezar\\.", parse_mode: "MarkdownV2", reply_markup: { remove_keyboard: true } });
        return { statusCode: 200 };
    }

    // MÁQUINA DE ESTADOS (FLUJO)
    switch (session.step) {
        case "idle":
            if (photo) {
                session.photos = [photo.pop().file_id];
                session.step = "esperando_tela";
                await enviarTeclado(chatId, "📸 *¡Foto recibida\\!*\\nAhora elegí la *TELA*:", OPCIONES.telas);
            } else {
                await callTelegram("sendMessage", { chat_id: chatId, text: "👋 Hola Fabri\\. Para cargar algo, primero pasame la *FOTO* del producto\\.", parse_mode: "MarkdownV2" });
            }
            break;

        case "esperando_tela":
            session.data.tela = text;
            session.step = "esperando_talle";
            await enviarTeclado(chatId, "📏 *Talle registrado\\.*\\nSeleccioná el *TALLE*:", OPCIONES.talles);
            break;

        case "esperando_talle":
            session.data.talle = text;
            session.step = "esperando_precio";
            await enviarTeclado(chatId, "💰 *Precio:* Seleccioná uno o escribilo:", OPCIONES.precios);
            break;

        case "esperando_precio":
            session.data.precio = text;
            session.step = "esperando_titulo";
            await callTelegram("sendMessage", { chat_id: chatId, text: "✍️ Escribí el *TÍTULO* o nombre de la prenda:", parse_mode: "MarkdownV2" });
            break;

        case "esperando_titulo":
            session.data.titulo = text;
            session.step = "esperando_desc_opcion";
            await enviarTeclado(chatId, "📝 ¿Querés agregar una *DESCRIPCIÓN*?", ["Sí, quiero", "No, finalizar"]);
            break;

        case "esperando_desc_opcion":
            if (text === "Sí, quiero") {
                session.step = "esperando_desc_texto";
                await callTelegram("sendMessage", { chat_id: chatId, text: "🖋️ Escribí la descripción ahora:", parse_mode: "MarkdownV2" });
            } else {
                await finalizarYGuardar(chatId, session);
            }
            break;

        case "esperando_desc_texto":
            session.data.descripcion = text;
            await finalizarYGuardar(chatId, session);
            break;

        default:
            await callTelegram("sendMessage", { chat_id: chatId, text: "🧐 No entendí eso\\. Usá /cancelar si te trabaste\\." });
    }

    return { statusCode: 200 };
};

async function finalizarYGuardar(chatId, session) {
    await callTelegram("sendMessage", { chat_id: chatId, text: "⏳ Guardando en GitHub\\.\\.\\." });
    
    const producto = {
        id: Date.now(),
        ...session.data,
        imagenes: session.photos,
        fecha: new Date().toLocaleString("es-AR")
    };

    const exito = await guardarEnGitHub(producto);
    
    if (exito) {
        await callTelegram("sendMessage", { chat_id: chatId, text: `✅ *¡Listo\\!* El producto *${producto.titulo}* se guardó permanentemente en tu JSON\\.`, parse_mode: "MarkdownV2", reply_markup: { remove_keyboard: true } });
    } else {
        await callTelegram("sendMessage", { chat_id: chatId, text: "❌ *Error al guardar en GitHub*\\. Revisá el Token o el nombre del repo en Netlify\\.", parse_mode: "MarkdownV2" });
    }
    
    // Resetear sesión
    delete sessions[chatId];
}