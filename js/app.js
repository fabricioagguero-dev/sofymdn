// ── STATE ──
let cart = JSON.parse(localStorage.getItem('sofymdn_cart') || '[]');
let allProducts = [];
let activeFilter = 'all';

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
  initNavbar();
  loadProducts();
  renderCart();
});

// ── NAVBAR SCROLL ──
function initNavbar() {
  const navbar = document.getElementById('navbar');
  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 60);
  });
}

// ── MENU HAMBURGUESA ──
function toggleMenu() {
  const hamburger = document.getElementById('hamburger');
  const navLinks  = document.getElementById('navLinks');
  hamburger.classList.toggle('open');
  navLinks.classList.toggle('open');
}
function closeMenu() {
  document.getElementById('hamburger').classList.remove('open');
  document.getElementById('navLinks').classList.remove('open');
}

// ── CARGAR PRODUCTOS ──
async function loadProducts() {
  const grid = document.getElementById('productsGrid');
  try {
    const res  = await fetch('/data/products.json');
    const data = await res.json();
    allProducts = data.products || [];
    buildFilters(allProducts);
    renderProducts(allProducts);
  } catch (e) {
    grid.innerHTML = `
      <div class="empty-state">
        <h3>¡Próximamente!</h3>
        <p>Estamos cargando los productos 🛍️</p>
      </div>`;
  }
}

// ── FILTROS DINÁMICOS ──
function buildFilters(products) {
  const types   = [...new Set(products.map(p => p.tipo).filter(Boolean))];
  const filtersEl = document.getElementById('filters');
  types.forEach(tipo => {
    const btn = document.createElement('button');
    btn.className   = 'filter-btn';
    btn.dataset.filter = tipo;
    btn.textContent = tipo.charAt(0).toUpperCase() + tipo.slice(1);
    btn.onclick = () => setFilter(tipo);
    filtersEl.appendChild(btn);
  });
}

function setFilter(filter) {
  activeFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  const filtered = filter === 'all'
    ? allProducts
    : allProducts.filter(p => p.tipo === filter);
  renderProducts(filtered);
}

// ── RENDERIZAR PRODUCTOS ──
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
        ${p.imagenes && p.imagenes.length > 1 ? `<span class="product-badge">+${p.imagenes.length} colores</span>` : ''}
        <img
          src="${p.imagenes?.[0] || 'images/placeholder.jpg'}"
          alt="${p.nombre}"
          onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'400\' height=\'533\' viewBox=\'0 0 400 533\'%3E%3Crect fill=\'%231a1a1a\' width=\'400\' height=\'533\'/%3E%3Ctext x=\'50%25\' y=\'50%25\' fill=\'%23f472b6\' text-anchor=\'middle\' dy=\'.3em\' font-size=\'60\'%3E👗%3C/text%3E%3C/svg%3E'"
        />
        ${p.imagenes && p.imagenes.length > 1 ? `
          <div class="img-dots">
            ${p.imagenes.map((_, di) => `<div class="img-dot ${di === 0 ? 'active' : ''}" onclick="event.stopPropagation();switchImg('${p.id}',${di},this)"></div>`).join('')}
          </div>` : ''}
      </div>
      <div class="product-info">
        <div class="product-name">${p.nombre}</div>
        <div class="product-meta">
          <span>🧵 ${p.tela}</span>
          <span>📐 ${p.talle}</span>
        </div>
        <div class="product-price">$${Number(p.precio).toLocaleString('es-AR')}</div>
        <button class="product-add" onclick="event.stopPropagation();addToCart('${p.id}')">
          + Agregar al carrito
        </button>
      </div>
    </div>
  `).join('');
}

// ── CAMBIAR IMAGEN EN CARD ──
function switchImg(productId, index, dotEl) {
  const product = allProducts.find(p => p.id === productId);
  if (!product || !product.imagenes) return;
  const card = dotEl.closest('.product-card');
  card.querySelector('img').src = product.imagenes[index];
  card.querySelectorAll('.img-dot').forEach((d, i) => d.classList.toggle('active', i === index));
}

// ── MODAL ──
function openModal(id) {
  const product = allProducts.find(p => p.id === id);
  if (!product) return;

  const content = document.getElementById('modalContent');
  content.innerHTML = `
    <div class="modal-gallery">
      <img src="${product.imagenes?.[0] || ''}" alt="${product.nombre}"
        onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'400\' height=\'533\'%3E%3Crect fill=\'%231a1a1a\' width=\'400\' height=\'533\'/%3E%3Ctext x=\'50%25\' y=\'50%25\' fill=\'%23f472b6\' text-anchor=\'middle\' dy=\'.3em\' font-size=\'80\'%3E👗%3C/text%3E%3C/svg%3E'"
      />
    </div>
    <div class="modal-info">
      <div class="modal-name">${product.nombre}</div>
      <div class="modal-tela">Tela: <span>${product.tela}</span></div>
      <div class="modal-talle">Talle: <span>${product.talle}</span></div>
      ${product.descripcion ? `<p style="color:rgba(250,250,250,0.5);font-size:.9rem;line-height:1.7">${product.descripcion}</p>` : ''}
      ${product.imagenes && product.imagenes.length > 1 ? `
        <div>
          <p style="font-size:.75rem;letter-spacing:.15em;text-transform:uppercase;color:var(--pink);margin-bottom:.75rem">Colores disponibles</p>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap">
            ${product.imagenes.map((img, i) => `
              <img src="${img}" style="width:60px;height:80px;object-fit:cover;border-radius:8px;cursor:pointer;border:2px solid ${i===0?'var(--pink)':'transparent'};transition:.3s"
                onclick="this.closest('.modal-info').querySelector('img') ; document.querySelector('.modal-gallery img').src='${img}'; this.parentNode.querySelectorAll('img').forEach(el=>el.style.borderColor='transparent'); this.style.borderColor='var(--pink)'"
              />
            `).join('')}
          </div>
        </div>` : ''}
      <div class="modal-price">$${Number(product.precio).toLocaleString('es-AR')}</div>
      <button class="modal-add-btn" onclick="addToCart('${product.id}');closeModal()">
        Agregar al carrito 🛍️
      </button>
    </div>
  `;

  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('productModal').classList.add('open');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.getElementById('productModal').classList.remove('open');
}

// ── CARRITO ──
function toggleCart() {
  document.getElementById('cartOverlay').classList.toggle('open');
  document.getElementById('cartSidebar').classList.toggle('open');
}

function addToCart(id) {
  const product = allProducts.find(p => p.id === id);
  if (!product) return;
  const existing = cart.find(i => i.id === id);
  if (existing) {
    existing.qty++;
  } else {
    cart.push({ ...product, qty: 1 });
  }
  saveCart();
  renderCart();
  // feedback visual
  const btn = event?.target;
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = '✓ Agregado';
    btn.style.background = 'var(--pink)';
    btn.style.color = 'var(--black)';
    setTimeout(() => {
      btn.textContent = orig;
      btn.style.background = '';
      btn.style.color = '';
    }, 1500);
  }
}

function removeFromCart(id) {
  cart = cart.filter(i => i.id !== id);
  saveCart();
  renderCart();
}

function saveCart() {
  localStorage.setItem('sofymdn_cart', JSON.stringify(cart));
  const count = cart.reduce((a, i) => a + i.qty, 0);
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
    itemsEl.innerHTML = `<div class="cart-empty"><p>Tu carrito está vacío 🛍️</p></div>`;
    footerEl.style.display = 'none';
    return;
  }

  itemsEl.innerHTML = cart.map(item => `
    <div class="cart-item">
      <img class="cart-item-img"
        src="${item.imagenes?.[0] || ''}"
        alt="${item.nombre}"
        onerror="this.style.display='none'"
      />
      <div class="cart-item-info">
        <div class="cart-item-name">${item.nombre}</div>
        <div class="cart-item-meta">Talle ${item.talle} · ${item.tela}</div>
        <div class="cart-item-price">$${Number(item.precio).toLocaleString('es-AR')} × ${item.qty}</div>
      </div>
      <button class="cart-item-remove" onclick="removeFromCart('${item.id}')">✕</button>
    </div>
  `).join('');

  const total = cart.reduce((a, i) => a + (Number(i.precio) * i.qty), 0);
  totalEl.textContent = `$${total.toLocaleString('es-AR')}`;
  footerEl.style.display = 'block';

  // Armar mensaje de WhatsApp
  const msg = cart.map(i =>
    `• ${i.nombre} (Talle ${i.talle}, ${i.tela}) x${i.qty} = $${(Number(i.precio)*i.qty).toLocaleString('es-AR')}`
  ).join('%0A') + `%0A%0A*Total: $${total.toLocaleString('es-AR')}*`;

  waLink.href = `https://wa.me/549XXXXXXXXXX?text=¡Hola Sofy! Quiero hacer este pedido:%0A%0A${msg}`;

  saveCart();
}

// Cerrar menú al hacer clic afuera
document.addEventListener('click', (e) => {
  const nav = document.getElementById('navLinks');
  const ham = document.getElementById('hamburger');
  if (nav.classList.contains('open') && !nav.contains(e.target) && !ham.contains(e.target)) {
    closeMenu();
  }
});
