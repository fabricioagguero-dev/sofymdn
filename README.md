# 🛍️ Sofy MDN — Guía de Deploy

## Estructura del proyecto

```
sofy-mdn/
├── index.html                  ← Página web principal
├── css/style.css               ← Estilos
├── js/app.js                   ← Lógica del frontend
├── data/products.json          ← Base de datos de productos
├── netlify.toml                ← Configuración de Netlify
├── setup-webhook.js            ← Script para conectar el bot (correr 1 sola vez)
└── netlify/
    └── functions/
        ├── telegram.js         ← Bot de Telegram (serverless)
        └── products.js         ← API de productos
```

---

## PASO 1 — Crear cuenta en GitHub

1. Entrá a **github.com** y creá una cuenta gratuita
2. Creá un repositorio nuevo llamado `sofy-mdn`
3. Subí todos los archivos de este proyecto

---

## PASO 2 — Crear cuenta en Netlify

1. Entrá a **netlify.com** → "Sign up" → elegí "GitHub"
2. Autorizá el acceso a GitHub
3. Hacé clic en **"Add new site"** → **"Import an existing project"**
4. Seleccioná tu repositorio `sofy-mdn`
5. En configuración de build dejá todo vacío (no hay build)
6. Hacé clic en **"Deploy site"**

---

## PASO 3 — Configurar variables de entorno en Netlify

En tu sitio de Netlify:
1. Andá a **Site settings** → **Environment variables**
2. Agregá estas dos variables:

| Variable | Valor |
|---|---|
| `TELEGRAM_BOT_TOKEN` | El token de tu bot (lo da @BotFather) |
| `OWNER_CHAT_ID` | Tu chat ID de Telegram |

### ¿Cómo encontrar tu Chat ID?
1. Buscá **@userinfobot** en Telegram
2. Escribile `/start`
3. Te responde con tu `Id:` → ese número es tu OWNER_CHAT_ID

### ¿Cómo crear un bot si no tenés?
1. Buscá **@BotFather** en Telegram
2. Escribile `/newbot`
3. Elegí un nombre y username
4. Te da un token → ese va en `TELEGRAM_BOT_TOKEN`

---

## PASO 4 — Configurar el Webhook del bot

Una vez deployado (vas a tener una URL tipo `https://sofy-mdn.netlify.app`):

```bash
node setup-webhook.js TU_BOT_TOKEN https://sofy-mdn.netlify.app
```

Eso le dice a Telegram: "cuando alguien le escriba al bot, mandalo a esta URL".

---

## PASO 5 — Configurar el número de WhatsApp

En `js/app.js`, en la línea que dice:
```
https://wa.me/549XXXXXXXXXX
```
Reemplazá `549XXXXXXXXXX` por tu número de WhatsApp:
- Formato: `549` + tu número sin el 0 y sin el 15
- Ejemplo: si tu número es 011-15-1234-5678 → `5491112345678`

---

## ¿Cómo funciona el bot?

```
Sofy le manda una foto al bot
          ↓
¿Es una foto o varias?
     /         \
  UNA         VARIAS
   ↓              ↓
Pregunta:     ¿Mismo álbum?
- Nombre       Sí → preguntas UNA VEZ para todas
- Tela         No → pregunta PARA CADA UNA enumerando
- Talle
- Precio
- Tipo
   ↓
Se guarda en data/products.json
   ↓
Aparece en la web automáticamente
```

---

## ⚠️ Limitación importante (plan gratuito)

Netlify Free tiene **funciones serverless stateless**: cada llamada es independiente.
El estado de conversación (`sessions`) se guarda en memoria, lo que significa que si
hay un reinicio "frío" entre dos mensajes (raro en conversaciones rápidas), puede
perderse el contexto.

**Solución**: en conversaciones normales no pasa, pero si hay un problema, la dueña
puede mandar `/cancelar` y empezar de nuevo.

Para producción más robusta → usar **Upstash Redis** (también gratuito) como storage.
