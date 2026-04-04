// =============================================================================
// APP.JS — Sofy MDN
// - Carga productos desde GitHub via Netlify Function
// - Muestra colores como swatches clicables en las cards
// - Carrito con selección de talle + cantidad (+ / -)
// =============================================================================

// ── ESTADO GLOBAL ──
let cart        = JSON.parse(localStorage.getItem('sofymdn_cart') || '[]');
let allProducts = [];
let activeFilter = 'all';

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
  initNavbar();
  loadProducts();
  renderCart();
});

// ── NAVBAR ──
function initNavbar() {
  const navbar = document.getElementById('navbar');
  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 60);
  });
}

// ── MENÚ HAMBURGUESA ──
function toggleMenu() {
  document.getElementById('hamburger').classList.toggle('open');
  document.getElementById('navLinks').classList.toggle('open');
}
function closeMenu() {
  document.getElementById('hamburger').classList.remove('open');
  document.getElementById('navLinks').classList.remove('open');
}

// ── CARGAR PRODUCTOS DESDE GITHUB (vía Netlify Function) ──
async function loadProducts() {
  const grid = document.getElementById('productsGrid');
  try {
    const res = await fetch('/.netlify/functions/products');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data  = await res.json();
    allProducts = Array.isArray(data) ? data : (data.products || []);

    if (!allProducts.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <h3>¡Próximamente!</h3>
          <p>Estamos preparando el catálogo. ¡Volvé pronto! ✨</p>
        </div>`;
      return;
    }
    buildFilters(allProducts);
    renderProducts(allProducts);
  } catch (e) {
    console.error('[loadProducts]', e.message);
    grid.innerHTML = `
      <div class="empty-state">
        <h3>¡Próximamente!</h3>
        <p>Estamos cargando los productos 🛍️</p>
      </div>`;
  }
}

// ── FILTROS ──
function buildFilters(products) {
  const types     = [...new Set(products.map(p => p.tipo).filter(Boolean))];
  const filtersEl = document.getElementById('filters');
  filtersEl.querySelectorAll('.filter-btn:not([data-filter="all"])').forEach(b => b.remove());
  types.forEach(tipo => {
    const btn          = document.createElement('button');
    btn.className      = 'filter-btn';
    btn.dataset.filter = tipo;
    btn.textContent    = tipo.charAt(0).toUpperCase() + tipo.slice(1);
    btn.onclick        = () => setFilter(tipo);
    filtersEl.appendChild(btn);
  });
}

function setFilter(filter) {
  activeFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  renderProducts(filter === 'all' ? allProducts : allProducts.filter(p => p.tipo === filter));
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: construir swatches de color para una prenda
// Mapea nombre de color → CSS color aproximado
// ─────────────────────────────────────────────────────────────────────────────
const COLOR_MAP = {
  blanco: '#ffffff', negro: '#111111', gris: '#888888',
  beige: '#d4b896', camello: '#c19a6b', crema: '#fffdd0',
  tostado: '#8b6914', marron: '#7b3f00', bordo: '#800020',
  rojo: '#e63946', rosa: '#f472b6', fucsia: '#ff1493',
  naranja: '#ff7849', amarillo: '#fbbf24', verde: '#22c55e',
  oliva: '#708238', celeste: '#89d4f5', azul: '#3b82f6',
  marino: '#003087', violeta: '#7c3aed', lila: '#c084fc',
  plateado: '#c0c0c0', dorado: '#ffd700',
};

function getColorCSS(nombre) {
  if (!nombre) return '#888';
  const key = nombre.toLowerCase().trim();
  // Buscar coincidencia parcial
  for (const [k, v] of Object.entries(COLOR_MAP)) {
    if (key.includes(k)) return v;
  }
  return '#888';
}

/**
 * Genera HTML de swatches de color para una prenda.
 * Al hacer clic en un swatch, cambia la imagen mostrada.
 */
function buildColorSwatches(product, cardId) {
  if (!product.colores || product.colores.length < 2) return '';
  return `
    <div class="color-swatches" id="swatches-${cardId}">
      ${product.colores.map((color, i) => `
        <div
          class="color-swatch ${i === 0 ? 'active' : ''}"
          style="background:${getColorCSS(color)}"
          title="${color}"
          onclick="event.stopPropagation(); switchColor('${product.id}', ${i}, this)"
        ></div>
      `).join('')}
    </div>
    <div class="color-label" id="colorlabel-${cardId}">${product.colores[0]}</div>
  `;
}

function switchColor(productId, index, swatchEl) {
  const product = allProducts.find(p => p.id === productId);
  if (!product || !product.imagenes?.[index]) return;

  // Cambiar imagen
  const card = swatchEl.closest('.product-card') || swatchEl.closest('.modal');
  if (card) {
    const img = card.querySelector('.product-images img') || card.querySelector('.modal-gallery img');
    if (img) img.src = product.imagenes[index];
  }

  // Actualizar swatch activo
  swatchEl.closest('.color-swatches').querySelectorAll('.color-swatch').forEach((s, i) => {
    s.classList.toggle('active', i === index);
  });

  // Actualizar label
  const labelId = `colorlabel-${productId}`;
  const label   = document.getElementById(labelId);
  if (label && product.colores?.[index]) label.textContent = product.colores[index];
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDERIZAR GRID DE PRODUCTOS
// ─────────────────────────────────────────────────────────────────────────────
function renderProducts(products) {
  const grid = document.getElementById('productsGrid');
  if (!products.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <h3>¡Próximamente!</h3>
        <p>Todavía no hay productos en esta categoría.<br>¡Volvé pronto! ✨</p>
      </div>`;
    return;
  }

  grid.innerHTML = products.map((p, i) => `
    <div class="product-card" style="animation-delay:${i * 0.07}s" onclick="openModal('${p.id}')">
      <div class="product-images">
        ${p.colores && p.colores.length > 1
          ? `<span class="product-badge">${p.colores.length} colores</span>`
          : p.imagenes && p.imagenes.length > 1
          ? `<span class="product-badge">+${p.imagenes.length} fotos</span>`
          : ''}
        <img
          src="${p.imagenes?.[0] || ''}"
          alt="${p.nombre}"
          loading="lazy"
          onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'400\' height=\'533\'%3E%3Crect fill=\'%231a1a1a\' width=\'400\' height=\'533\'/%3E%3Ctext x=\'50%25\' y=\'50%25\' fill=\'%23f472b6\' text-anchor=\'middle\' dy=\'.3em\' font-size=\'60\'%3E👗%3C/text%3E%3C/svg%3E'"
        />
      </div>
      <div class="product-info">
        <div class="product-name">${p.nombre}</div>
        <div class="product-meta">
          <span>🧵 ${p.tela || '—'}</span>
          <span>📐 ${p.talle || '—'}</span>
        </div>
        ${buildColorSwatches(p, p.id)}
        <div class="product-price">$${Number(p.precio).toLocaleString('es-AR')}</div>
        <button class="product-add" onclick="event.stopPropagation(); openModal('${p.id}')">
          Ver tallas y agregar
        </button>
      </div>
    </div>
  `).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// MODAL DE PRODUCTO — con selector de talle múltiple
// ─────────────────────────────────────────────────────────────────────────────

// Estado de la selección del modal actual
let modalSelections = {}; // { talle: qty }
let modalProductId  = null;
let modalColorIdx   = 0;

function openModal(id) {
  const product = allProducts.find(p => p.id === id);
  if (!product) return;

  modalProductId  = id;
  modalSelections = {};
  modalColorIdx   = 0;

  const content = document.getElementById('modalContent');
  content.innerHTML = `
    <div class="modal-gallery">
      <img
        id="modalMainImg"
        src="${product.imagenes?.[0] || ''}"
        alt="${product.nombre}"
        onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'400\' height=\'533\'%3E%3Crect fill=\'%231a1a1a\' width=\'400\' height=\'533\'/%3E%3Ctext x=\'50%25\' y=\'50%25\' fill=\'%23f472b6\' text-anchor=\'middle\' dy=\'.3em\' font-size=\'80\'%3E👗%3C/text%3E%3C/svg%3E'"
      />
    </div>
    <div class="modal-info">
      <div class="modal-name">${product.nombre}</div>
      <div class="modal-tela">Tela: <span>${product.tela || '—'}</span></div>

      ${product.colores && product.colores.length > 0 ? `
        <div class="modal-colors-section">
          <div class="modal-section-label">🎨 Colores disponibles</div>
          <div class="modal-color-list">
            ${product.colores.map((color, i) => `
              <div
                class="modal-color-item ${i === 0 ? 'active' : ''}"
                onclick="selectModalColor(${i}, this)"
              >
                <div class="modal-color-swatch" style="background:${getColorCSS(color)}"></div>
                <span>${color}</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      ${product.descripcion ? `<p class="modal-desc">${product.descripcion}</p>` : ''}

      <div class="modal-price">$${Number(product.precio).toLocaleString('es-AR')}</div>

      <!-- Selector de talles con cantidades -->
      <div class="modal-section-label" style="margin-top:1rem">📐 Seleccioná talle(s) y cantidad</div>
      <div class="talle-selector" id="talleSelector">
        ${buildTalleSelector(product)}
      </div>

      <div class="modal-cart-summary" id="cartSummary" style="display:none"></div>

      <button class="modal-add-btn" id="modalAddBtn" onclick="addModalToCart()" disabled>
        Agregar al carrito 🛍️
      </button>
    </div>
  `;

  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('productModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

/**
 * Construye el selector de talles con botones + / -
 * Si la prenda tiene un talle único, lo muestra directo.
 */
function buildTalleSelector(product) {
  // Detectar si hay múltiples talles o uno solo
  const talles = product.talle
    ? product.talle.split(/[,\/\s]+/).map(t => t.trim()).filter(Boolean)
    : ['Único'];

  // Si solo tiene "Único", mostrar selector simple de cantidad
  if (talles.length === 1 && (talles[0] === 'Único' || talles[0] === 'U')) {
    return `
      <div class="talle-row">
        <span class="talle-name">Único</span>
        <div class="qty-controls">
          <button class="qty-btn" onclick="changeQty('Único', -1)">−</button>
          <span class="qty-value" id="qty-Único">0</span>
          <button class="qty-btn" onclick="changeQty('Único', 1)">+</button>
        </div>
      </div>
    `;
  }

  // Múltiples talles estándar
  const allTalles = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
  const available = talles.length > 1 ? talles : allTalles;

  return available.map(t => `
    <div class="talle-row">
      <span class="talle-name">${t}</span>
      <div class="qty-controls">
        <button class="qty-btn" onclick="changeQty('${t}', -1)">−</button>
        <span class="qty-value" id="qty-${t}">0</span>
        <button class="qty-btn" onclick="changeQty('${t}', 1)">+</button>
      </div>
    </div>
  `).join('');
}

/** Cambia la cantidad de un talle en el modal */
function changeQty(talle, delta) {
  const current = modalSelections[talle] || 0;
  const next    = Math.max(0, current + delta);

  if (next === 0) {
    delete modalSelections[talle];
  } else {
    modalSelections[talle] = next;
  }

  // Actualizar el número en pantalla
  const el = document.getElementById(`qty-${talle}`);
  if (el) el.textContent = next;

  updateModalSummary();
}

/** Actualiza el resumen y el botón de agregar */
function updateModalSummary() {
  const product  = allProducts.find(p => p.id === modalProductId);
  if (!product) return;

  const entries  = Object.entries(modalSelections).filter(([, q]) => q > 0);
  const summary  = document.getElementById('cartSummary');
  const addBtn   = document.getElementById('modalAddBtn');

  if (!entries.length) {
    summary.style.display = 'none';
    addBtn.disabled       = true;
    addBtn.textContent    = 'Agregar al carrito 🛍️';
    return;
  }

  const total = entries.reduce((a, [, q]) => a + Number(product.precio) * q, 0);
  summary.style.display = 'block';
  summary.innerHTML = `
    <div class="cart-summary-list">
      ${entries.map(([t, q]) => `<span>${t} × ${q}</span>`).join('')}
    </div>
    <div class="cart-summary-total">Total: <strong>$${total.toLocaleString('es-AR')}</strong></div>
  `;

  addBtn.disabled    = false;
  addBtn.textContent = `Agregar al carrito (${entries.reduce((a, [, q]) => a + q, 0)} prenda${entries.reduce((a,[,q])=>a+q,0)>1?'s':''}) 🛍️`;
}

/** Cambia el color mostrado en el modal */
function selectModalColor(index, el) {
  const product = allProducts.find(p => p.id === modalProductId);
  if (!product || !product.imagenes?.[index]) return;

  modalColorIdx = index;

  // Cambiar imagen
  const img = document.getElementById('modalMainImg');
  if (img) img.src = product.imagenes[index];

  // Actualizar activo
  el.closest('.modal-color-list').querySelectorAll('.modal-color-item').forEach((c, i) => {
    c.classList.toggle('active', i === index);
  });
}

/** Agrega todas las selecciones del modal al carrito */
function addModalToCart() {
  const product = allProducts.find(p => p.id === modalProductId);
  if (!product) return;

  const entries = Object.entries(modalSelections).filter(([, q]) => q > 0);
  if (!entries.length) return;

  // El color seleccionado actualmente
  const colorSeleccionado = product.colores?.[modalColorIdx] || null;
  const imagenSeleccionada = product.imagenes?.[modalColorIdx] || product.imagenes?.[0] || '';

  entries.forEach(([talle, qty]) => {
    // ID único por prenda + talle + color
    const cartItemId = `${product.id}_${talle}_${modalColorIdx}`;
    const existing   = cart.find(i => i.cartItemId === cartItemId);

    if (existing) {
      existing.qty += qty;
    } else {
      cart.push({
        cartItemId,
        id:      product.id,
        nombre:  product.nombre,
        tela:    product.tela,
        talle,
        color:   colorSeleccionado,
        precio:  product.precio,
        imagenes: [imagenSeleccionada],
        qty,
      });
    }
  });

  saveCart();
  renderCart();
  closeModal();

  // Feedback
  const total = entries.reduce((a, [, q]) => a + q, 0);
  showToast(`✓ ${total} prenda${total > 1 ? 's' : ''} agregada${total > 1 ? 's' : ''} al carrito`);
}

// ── TOAST ──
function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = `
      position:fixed; bottom:2rem; left:50%; transform:translateX(-50%) translateY(100px);
      background:#22c55e; color:#fff; padding:.75rem 1.5rem; border-radius:100px;
      font-size:.85rem; font-weight:500; z-index:9999; transition:transform .4s;
      white-space:nowrap; font-family:'DM Sans',sans-serif;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.transform = 'translateX(-50%) translateY(0)';
  setTimeout(() => { toast.style.transform = 'translateX(-50%) translateY(100px)'; }, 2500);
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.getElementById('productModal').classList.remove('open');
  document.body.style.overflow = '';
  modalSelections = {};
  modalProductId  = null;
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ─────────────────────────────────────────────────────────────────────────────
// CARRITO
// ─────────────────────────────────────────────────────────────────────────────

function toggleCart() {
  document.getElementById('cartOverlay').classList.toggle('open');
  document.getElementById('cartSidebar').classList.toggle('open');
}

function removeFromCart(cartItemId) {
  cart = cart.filter(i => i.cartItemId !== cartItemId);
  saveCart();
  renderCart();
}

function saveCart() {
  localStorage.setItem('sofymdn_cart', JSON.stringify(cart));
  const count   = cart.reduce((a, i) => a + i.qty, 0);
  const countEl = document.getElementById('cartCount');
  countEl.textContent = count;
  countEl.classList.toggle('visible', count > 0);
}

function renderCart() {
  const itemsEl  = document.getElementById('cartItems');
  const footerEl = document.getElementById('cartFooter');
  const totalEl  = document.getElementById('cartTotal');
  const waLink   = document.getElementById('whatsappOrder');

  if (!cart.length) {
    itemsEl.innerHTML      = `<div class="cart-empty"><p>Tu carrito está vacío 🛍️</p></div>`;
    footerEl.style.display = 'none';
    return;
  }

  itemsEl.innerHTML = cart.map(item => `
    <div class="cart-item">
      <img
        class="cart-item-img"
        src="${item.imagenes?.[0] || ''}"
        alt="${item.nombre}"
        onerror="this.style.display='none'"
      />
      <div class="cart-item-info">
        <div class="cart-item-name">${item.nombre}</div>
        <div class="cart-item-meta">
          Talle ${item.talle}${item.color ? ` · ${item.color}` : ''} · ${item.tela || ''}
        </div>
        <div class="cart-item-price">
          $${Number(item.precio).toLocaleString('es-AR')} × ${item.qty}
        </div>
      </div>
      <button class="cart-item-remove" onclick="removeFromCart('${item.cartItemId}')">✕</button>
    </div>
  `).join('');

  const total            = cart.reduce((a, i) => a + (Number(i.precio) * i.qty), 0);
  totalEl.textContent    = `$${total.toLocaleString('es-AR')}`;
  footerEl.style.display = 'block';

  waLink.href        = '/checkout.html';
  waLink.textContent = 'Confirmar y pagar 🛍️';

  saveCart();
}

// Cerrar menú al hacer clic afuera
document.addEventListener('click', e => {
  const nav = document.getElementById('navLinks');
  const ham = document.getElementById('hamburger');
  if (nav.classList.contains('open') && !nav.contains(e.target) && !ham.contains(e.target)) {
    closeMenu();
  }
});
