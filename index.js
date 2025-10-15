/* =====================================================
 * NeguNova – index.js (Frontend)
 * Usa backend Render: /api/generate (Owner + Customer)
 * ===================================================== */

(() => {
  // === CONFIG ===
  const BACKEND_URL = "https://novaai-backend-v2.onrender.com/api/generate";

  // === Utils ===
  const $  = (s, c=document) => c.querySelector(s);
  const $$ = (s, c=document) => Array.from(c.querySelectorAll(s));
  const onReady = (fn) =>
    (document.readyState === "complete" || document.readyState === "interactive")
      ? setTimeout(fn, 0)
      : document.addEventListener("DOMContentLoaded", fn);

  // Persistencia simple del producto seleccionado (opcional)
  const PRODUCT_KEY = "negunova:selectedProduct";
  const saveSelectedProduct = (p) => { try { sessionStorage.setItem(PRODUCT_KEY, JSON.stringify(p||{})); } catch{} };
  const loadSelectedProduct = () => { try { return JSON.parse(sessionStorage.getItem(PRODUCT_KEY)||"{}"); } catch { return {}; } };

  // === Producto seleccionado (de window, session o query) ===
  function getSelectedProduct() {
    if (window.selectedProduct && typeof window.selectedProduct === "object") return window.selectedProduct;
    const s = loadSelectedProduct(); if (s && (s.name || s.category)) return s;
    const qs = new URLSearchParams(location.search); const p = qs.get("product");
    return p ? { name: decodeURIComponent(p), category: "" } : {};
  }

  // === Construir prompt aunque el usuario no escriba ===
  function buildPromptFromUI() {
    const p   = getSelectedProduct();
    const clr = ($("#color")?.value || "").trim();
    const t1  = ($("#text1")?.value || "").trim();
    const t2  = ($("#text2")?.value || "").trim();

    const parts = [];
    if (p.category || p.name) parts.push(`Product mockup for laser/acrylic: ${(p.category||"") + " " + (p.name||"")}`.trim());
    if (clr) parts.push(`dominant color: ${clr}`);
    if (t1 || t2) parts.push(`include the text: "${[t1,t2].filter(Boolean).join(" ")}"`);

    return parts.join(". ") || "Product mockup for acrylic/wood layered sign";
  }

  // === Render helpers ===
  function setText(el, txt){ if (el) el.textContent = txt; }
  function renderImageBase64(container, b64) {
    if (!container || !b64) return false;
    const img = new Image();
    img.alt = "Generated";
    img.src = "data:image/png;base64," + b64;
    container.replaceChildren(img);
    return true;
  }
  function renderImageURL(container, url) {
    if (!container || !url) return false;
    container.innerHTML = `<img alt="Generated" src="${url}">`;
    return true;
  }

  // === Generar ===
  async function generateNovaAI() {
    const ownerStatus   = $("#owner-status");
    const customerStatus= $("#customer-status");
    const ownerBox      = $("#result-owner");
    const customerBox   = $("#result-customer");

    // Reset UI
    if (ownerBox) ownerBox.innerHTML = "";
    if (customerBox) customerBox.innerHTML = "";
    setText(ownerStatus, "Owner: generating… (vector)");
    setText(customerStatus, "Customer: generating…");

    // Prompt final
    const userPrompt = ($("#prompt")?.value || "").trim();
    const prompt = userPrompt || buildPromptFromUI();

    try {
      const res = await fetch(BACKEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          mode: "both",                           // pide Owner + Customer
          product: getSelectedProduct(),          // para fallback del backend
          color: $("#color")?.value || "",
          text1: $("#text1")?.value || "",
          text2: $("#text2")?.value || "",
          params: { size: "1024x1024" }
        })
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = data?.error?.message || JSON.stringify(data) || `HTTP ${res.status}`;
        throw new Error(msg);
      }

      // CUSTOMER
      let customerRendered = false;
      if (data?.customer?.b64_json) {
        customerRendered = renderImageBase64(customerBox, data.customer.b64_json);
      } else if (data?.customer?.url) {
        customerRendered = renderImageURL(customerBox, data.customer.url);
      }
      setText(customerStatus, customerRendered ? "Customer: done" : "Customer: no image");

      // OWNER (vector) – puede venir como b64_json o url según tu backend
      let ownerRendered = false;
      if (data?.owner?.b64_json) {
        ownerRendered = renderImageBase64(ownerBox, data.owner.b64_json);
      } else if (data?.owner?.url) {
        ownerRendered = renderImageURL(ownerBox, data.owner.url);
      }
      setText(ownerStatus, ownerRendered ? "Owner: done" : "Owner: no vector");

    } catch (err) {
      console.error(err);
      setText(customerStatus, `Error: ${err?.message || err}`);
      setText(ownerStatus, "Owner: skipped due to error");
    }
  }

  // === Bootstrap NovaAI ===
  function initNovaAIPage() {
    // Botón Generate
    const btn = $("#btn-generate") || $('[data-action="generate"]') || $("#generate") || $("button.generate");
    if (btn) btn.addEventListener("click", (e) => { e.preventDefault(); generateNovaAI(); });

    // Atajo Ctrl/⌘+Enter en #prompt
    const p = $("#prompt");
    if (p) p.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault(); generateNovaAI();
      }
    });
  }

  // === (Opcional) Products: guardar selección y navegar a NovaAI ===
  function initProductsPage() {
    $$(".to-novaai").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const card = e.currentTarget.closest("[data-product]") || e.currentTarget;
        const prod = {
          id: card.getAttribute("data-id") || "",
          name: card.getAttribute("data-name") || card.querySelector(".p-name")?.textContent?.trim() || "New product",
          category: card.getAttribute("data-category") || card.querySelector(".p-cat")?.textContent?.trim() || "custom"
        };
        saveSelectedProduct(prod);
        location.href = "/novaai.html?product=" + encodeURIComponent(prod.name);
      });
    });
  }

  // === Entradas por página ===
  onReady(() => {
    const path = location.pathname.toLowerCase();
    if (path.endsWith("/novaai.html") || path.endsWith("novaai.html")) initNovaAIPage();
    if (path.endsWith("/products.html") || path.endsWith("products.html")) initProductsPage();
  });
})();
