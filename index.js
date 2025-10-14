/* =====================================================
 * NeguNova — index.js (COMPLETO)
 * Fecha: 2025-10-14
 *
 * Este archivo unifica utilidades comunes del sitio y
 * la integración de NovaAI con el proxy OpenAI (Customer)
 * + soporte de producto seleccionado desde Products.
 *
 * Páginas esperadas:
 *  - home.html
 *  - products.html
 *  - novaai.html  (Generador AI)
 *
 * Requisitos en el HTML de novaai.html:
 *  - Inputs opcionales: #prompt, #text1, #text2, #color
 *  - Contenedores: #owner-status, #result-owner,
 *                  #customer-status, #result-customer
 *  - Botón: #btn-generate (o data-action="generate")
 *
 * Proxy:
 *  - /proxy.php?action=health
 *  - /proxy.php?action=image
 * ===================================================== */

(() => {
  // --------------------------
  // Utilidades base
  // --------------------------
  const $ = (sel, ctx=document) => ctx.querySelector(sel);
  const $$ = (sel, ctx=document) => Array.from(ctx.querySelectorAll(sel));

  function onReady(fn){
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(fn, 0);
    } else {
      document.addEventListener('DOMContentLoaded', fn);
    }
  }

  function isPage(regex){
    return regex.test(location.pathname);
  }

  // Persistencia simple de producto seleccionado
  const PRODUCT_KEY = 'negunova:selectedProduct';
  function saveSelectedProduct(p){ try { sessionStorage.setItem(PRODUCT_KEY, JSON.stringify(p||{})); } catch(_){} }
  function loadSelectedProduct(){ try { return JSON.parse(sessionStorage.getItem(PRODUCT_KEY)||'{}'); } catch(_){ return {}; } }

  // Badge pequeño para mostrar estado del proxy (en NovaAI)
  function mountProxyBadge(targetSel){
    const target = $(targetSel) || $('nav') || document.body;
    const badge = document.createElement('div');
    badge.id = 'proxy-badge';
    badge.textContent = 'Proxy: …';
    badge.style.cssText = 'position:fixed;top:10px;left:10px;z-index:9999;font:12px/1.2 system-ui;padding:6px 8px;border-radius:10px;background:#222;color:#fff;opacity:.8;';
    target.appendChild(badge);
    return badge;
  }

  async function checkProxyHealth(badge){
    try {
      const res = await fetch('/proxy.php?action=health', {cache:'no-store'});
      const ok = res.ok; const data = await res.json().catch(()=>null);
      if (ok && data?.ok) {
        badge.textContent = `Proxy: OK (PHP ${data.php || ''})`;
        badge.style.background = '#157347';
      } else {
        badge.textContent = 'Proxy: error';
        badge.style.background = '#b02a37';
      }
    } catch(e){
      badge.textContent = 'Proxy: offline';
      badge.style.background = '#b02a37';
    }
  }

  // -------------------------------------------------
  // Bloque NovaAI (Customer vía proxy OpenAI)
  // -------------------------------------------------
  const NovaAI = (() => {
    let ownerStatusEl, customerStatusEl, ownerResultEl, customerResultEl;

    function setOwnerStatus(t){ if (ownerStatusEl) ownerStatusEl.textContent = t; }
    function setCustomerStatus(t){ if (customerStatusEl) customerStatusEl.textContent = t; }

    function getSelectedProduct(){
      // 1) objeto global (si vienes desde Products)
      if (window.selectedProduct && typeof window.selectedProduct === 'object') return window.selectedProduct;
      // 2) sessionStorage
      const s = loadSelectedProduct();
      if (s && (s.name || s.category)) return s;
      // 3) querystring ?product=NAME
      const params = new URLSearchParams(location.search);
      const p = params.get('product');
      return p ? {name: decodeURIComponent(p), category: ''} : {};
    }

    // Construye prompt aun cuando el usuario no escriba nada
    function buildPromptFromUI(){
      const p    = getSelectedProduct();
      const color= ($('#color')?.value || '').trim();
      const t1   = ($('#text1')?.value || '').trim();
      const t2   = ($('#text2')?.value || '').trim();

      const parts = [];
      if (p.category || p.name) parts.push(`Product mockup for laser/acrylic: ${(p.category||'') + ' ' + (p.name||'')}`.trim());
      if (color) parts.push(`dominant color: ${color}`);
      if (t1 || t2) parts.push(`include the text: "${[t1,t2].filter(Boolean).join(' ')}"`);
      return parts.join('. ') || 'Product mockup for laser/acrylic sign';
    }

    async function generate(){
      ownerStatusEl = $('#owner-status');
      customerStatusEl = $('#customer-status');
      ownerResultEl = $('#result-owner');
      customerResultEl = $('#result-customer');

      if (ownerResultEl) ownerResultEl.innerHTML = '';
      if (customerResultEl) customerResultEl.innerHTML = '';
      setOwnerStatus('Owner: omitted (vector pending)');
      setCustomerStatus('Generating…');

      const userPrompt = ($('#prompt')?.value || '').trim();
      const prompt = userPrompt || buildPromptFromUI();

      const body = {
        model: 'gpt-image-1',
        prompt,
        product: getSelectedProduct(),
        color:  $('#color')?.value || '',
        text1:  $('#text1')?.value || '',
        text2:  $('#text2')?.value || ''
      };

      try {
        const res = await fetch('/proxy.php?action=image', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
        });
        const data = await res.json().catch(()=>null);
        if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);

        const b64 = data?.data?.[0]?.b64_json;
        const url = data?.data?.[0]?.url;
        if (customerResultEl) {
          if (b64) {
            const img = new Image(); img.alt='Customer result';
            img.src = 'data:image/png;base64,' + b64; customerResultEl.replaceChildren(img);
            setCustomerStatus('Done');
          } else if (url) {
            customerResultEl.innerHTML = `<img src="${url}" alt="Customer result">`;
            setCustomerStatus('Done');
          } else {
            setCustomerStatus('Respuesta sin imagen');
          }
        }
      } catch(err){
        console.error(err);
        setCustomerStatus('Error: ' + (err?.message || err));
      }
    }

    // Expone API
    return { generate, buildPromptFromUI, getSelectedProduct };
  })();

  // -------------------------------------------------
  // Products: ejemplo de selección y envío a NovaAI
  // -------------------------------------------------
  function initProductsPage(){
    // Este bloque asume que cada card de producto tiene
    // data attributes con name/category y un botón .to-novaai
    $$('.to-novaai').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const card = e.currentTarget.closest('[data-product]') || e.currentTarget;
        const prod = {
          id: card.getAttribute('data-id') || '',
          name: card.getAttribute('data-name') || card.querySelector('.p-name')?.textContent?.trim() || 'New product',
          category: card.getAttribute('data-category') || card.querySelector('.p-cat')?.textContent?.trim() || 'custom',
        };
        saveSelectedProduct(prod);
        // Navega a NovaAI con query para compatibilidad extra
        location.href = '/novaai.html?product=' + encodeURIComponent(prod.name);
      });
    });
  }

  // -------------------------------------------------
  // NovaAI: inicialización de UI y bindings
  // -------------------------------------------------
  function initNovaAIPage(){
    // Badge de estado del proxy
    const badge = mountProxyBadge('body');
    checkProxyHealth(badge);

    // Rellena UI con el producto seleccionado (si lo hay)
    const p = NovaAI.getSelectedProduct();
    const productLabel = $('#product-selected-label');
    if (productLabel) {
      productLabel.textContent = (p.name || 'New product');
    }

    // Hook del botón Generate (varios selectores para tolerar variaciones)
    const btn = $('#btn-generate') || $('[data-action="generate"]') || $('#generate') || $('button.generate');
    if (btn) {
      btn.addEventListener('click', (e) => { e.preventDefault(); NovaAI.generate(); });
    }

    // Atajos: Enter en #prompt lanza generación
    const promptEl = $('#prompt');
    if (promptEl) {
      promptEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault(); NovaAI.generate();
        }
      });
    }
  }

  // -------------------------------------------------
  // Bootstrap por página
  // -------------------------------------------------
  onReady(() => {
    if (isPage(/products\.html$/i)) initProductsPage();
    if (isPage(/novaai\.html$/i))   initNovaAIPage();
  });

})();
