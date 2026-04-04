// =============================================================================
// products.js — Netlify Function
// Lee el products.json DIRECTAMENTE desde GitHub en cada request.
// Así los productos subidos por el bot aparecen en la web al instante,
// sin necesitar redespliegue de Netlify.
//
// VARIABLES DE ENTORNO REQUERIDAS:
//   GITHUB_TOKEN      → Personal Access Token de GitHub
//   GITHUB_REPO       → usuario/repositorio
//   GITHUB_FILE_PATH  → data/products.json
// =============================================================================

"use strict";

const https = require("https");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO;
const GITHUB_FILE  = process.env.GITHUB_FILE_PATH;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type":                 "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "GET")     return { statusCode: 405, headers: CORS, body: "Method Not Allowed" };

  try {
    // Leer el archivo desde GitHub API
    const { status, data } = await githubGet();

    if (status === 404) {
      // El archivo no existe todavía → devolver lista vacía
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ products: [] }) };
    }

    if (status !== 200 || !data?.content) {
      throw new Error(`GitHub respondió con status ${status}`);
    }

    // El contenido viene en base64
    const raw = Buffer.from(data.content, "base64").toString("utf8").trim();

    // Archivo vacío → devolver lista vacía
    if (!raw) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ products: [] }) };
    }

    // Parsear JSON
    let products;
    try {
      products = JSON.parse(raw);
      if (!Array.isArray(products)) products = products.products || [];
    } catch {
      products = [];
    }

    return {
      statusCode: 200,
      headers: {
        ...CORS,
        // Cache corto (30 seg) para que los productos nuevos aparezcan rápido
        "Cache-Control": "public, max-age=30",
      },
      body: JSON.stringify({ products }),
    };

  } catch (err) {
    console.error("[products] Error:", err.message);
    return {
      statusCode: 200, // devolvemos 200 con lista vacía para no romper la web
      headers: CORS,
      body: JSON.stringify({ products: [] }),
    };
  }
};

// ── Petición GET a la GitHub API ──────────────────────────────────────────────
function githubGet() {
  return new Promise((resolve) => {
    const options = {
      hostname: "api.github.com",
      path:     `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      method:   "GET",
      headers: {
        "Authorization": `token ${GITHUB_TOKEN}`,
        "Accept":        "application/vnd.github.v3+json",
        "User-Agent":    "SofyMDN-Bot/1.0",
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", d => { raw += d; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });

    req.on("timeout", () => { req.destroy(); resolve({ status: 408, data: null }); });
    req.on("error",   ()  => resolve({ status: 500, data: null }));
    req.end();
  });
}
