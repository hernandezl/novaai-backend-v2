// index.js — NovaAI backend (Render-ready)
// Node 18+ (con fetch global). Paquetes: express, cors, dotenv

import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" })); // acepta imágenes en base64

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;

// Modelos
const VECTOR_MODEL = "recraft-ai/recraft-20b-svg";                // Replicate (SVG)
const RASTER_FALLBACK = "black-forest-labs/flux-schnell";         // Replicate (fallback)
const OPENAI_IMAGE_MODEL = "gpt-image-1";                          // OpenAI

// Claves
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY || "";

// Límites (sencillos, en memoria)
const CUSTOMER_DAILY_LIMIT = Number(process.env.CUSTOMER_DAILY_LIMIT || 20);
const OWNER_DAILY_LIMIT    = Number(process.env.OWNER_DAILY_LIMIT || 200);
const userCounters = new Map(); // key => { day, owner, customer }

// Helpers de límite
function keyFor(req, provided) {
  return provided || req.headers["x-forwarded-for"] || req.ip || "anon";
}
function todayStamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
}
function canUse(kind, k) {
  const stamp = todayStamp();
  const cur = userCounters.get(k) || { day: stamp, owner:0, customer:0 };
  if (cur.day !== stamp) { cur.day = stamp; cur.owner = 0; cur.customer = 0; }
  if (kind === "customer" && cur.customer >= CUSTOMER_DAILY_LIMIT) return { ok:false, cur };
  if (kind === "owner"    && cur.owner    >= OWNER_DAILY_LIMIT)    return { ok:false, cur };
  return { ok:true, cur };
}
function consume(kind, k) {
  const stamp = todayStamp();
  const cur = userCounters.get(k) || { day: stamp, owner:0, customer:0 };
  if (cur.day !== stamp) { cur.day = stamp; cur.owner = 0; cur.customer = 0; }
  cur[kind] += 1;
  userCounters.set(k, cur);
  return cur;
}

// ====== HEALTH ======
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "NovaAI Node",
    port: Number(PORT),
    base_url: null,
    vector_model: VECTOR_MODEL,
    raster_model: OPENAI_IMAGE_MODEL,
    fallback: RASTER_FALLBACK
  });
});

// ====== GENERATE ======
app.post("/api/generate", async (req, res) => {
  try {
    const {
      prompt,
      negative = "",
      // aceptamos 'mode' o el legacy 'target'
      mode,
      target,
      image_base64 = null,
      params = {},
      userId = null
    } = req.body || {};

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "missing prompt" });
    }

    const choice = (target || mode || "both").toLowerCase();
    if (!["owner", "customer", "both"].includes(choice)) {
      return res.status(400).json({ error: "invalid mode", received: target ?? mode });
    }

    // normalizar parámetros
    const size = typeof params.size === "string" ? params.size : "1024x1024";
    const steps = Math.min(4, Number(params.steps ?? 4)); // Flux-schnell máx 4
    const uKey = keyFor(req, userId);

    // controles de límite
    if (choice === "customer" || choice === "both") {
      const chk = canUse("customer", uKey);
      if (!chk.ok) return res.status(429).json({ error: "customer daily limit reached" });
    }
    if (choice === "owner" || choice === "both") {
      const chk = canUse("owner", uKey);
      if (!chk.ok) return res.status(429).json({ error: "owner daily limit reached" });
    }

    let vector_url = null;
    let raster_url = null;

    // === OWNER (SVG con Recraft) ===
    if (choice === "owner" || choice === "both") {
      const v = await generateVectorReplicate({ prompt, negative });
      vector_url = v;
      consume("owner", uKey);
    }

    // === CUSTOMER (realista con OpenAI; fallback Flux) ===
    if (choice === "customer" || choice === "both") {
      try {
        const r = await generateRealisticOpenAI({ prompt, size, image_base64 });
        raster_url = r;
      } catch (e) {
        // fallback automático a Replicate Flux (gratis no, pero estable)
        const r = await generateRasterFlux({ prompt, steps });
        raster_url = r;
      }
      consume("customer", uKey);
    }

    const left = userCounters.get(uKey);
    res.json({
      ok: true,
      vector_url,
      raster_url,
      model: {
        vector: VECTOR_MODEL,
        raster: raster_url?.includes("openai") ? OPENAI_IMAGE_MODEL : RASTER_FALLBACK
      },
      usage: {
        day: left?.day,
        owner_used: left?.owner ?? 0,
        customer_used: left?.customer ?? 0,
        owner_limit: OWNER_DAILY_LIMIT,
        customer_limit: CUSTOMER_DAILY_LIMIT
      }
    });
  } catch (err) {
    console.error("[/api/generate] Error:", err);
    res.status(500).json({ error: "server-error", detail: String(err?.message || err) });
  }
});

// ====== SERVIDO ======
app.listen(PORT, () => {
  console.log(`Backend listo en http://localhost:${PORT}`);
});

// ----------------- FUNCIONES DE MODELOS -----------------

// Recraft SVG (Replicate)
async function generateVectorReplicate({ prompt, negative }) {
  if (!REPLICATE_API_TOKEN) throw new Error("Missing REPLICATE_API_TOKEN");
  const url = `https://api.replicate.com/v1/models/${VECTOR_MODEL}/predictions`;
  const body = {
    input: {
      prompt,
      negative_prompt: negative || undefined,
      output_format: "svg"
    }
  };
  const headers = {
    "Authorization": `Token ${REPLICATE_API_TOKEN}`,
    "Content-Type": "application/json"
  };
  const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`Replicate start failed ${resp.status}`);
  let data = await resp.json();

  // poll
  while (data?.status && !["succeeded","failed","canceled"].includes(data.status)) {
    await sleep(1200);
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${data.id}`, { headers });
    data = await poll.json();
  }
  if (data?.status !== "succeeded") {
    throw new Error(`Replicate vector failed: ${data?.error || data?.status}`);
  }

  // el modelo devuelve una URL (o array)
  const out = Array.isArray(data.output) ? data.output[0] : data.output;
  return String(out);
}

// OpenAI gpt-image-1 (realista)
async function generateRealisticOpenAI({ prompt, size = "1024x1024", image_base64 = null }) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const body = {
    model: OPENAI_IMAGE_MODEL,
    prompt,
    size,
    response_format: "b64_json"
  };

  // si viene imagen de referencia, la pasamos como "image[]"
  // (para evitar complejidad, usamos sólo generations sin edit; sigue funcionando con prompt)
  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await safeJson(resp);
    throw new Error(`OpenAI gen ${resp.status}: ${JSON.stringify(err)}`);
  }
  const json = await resp.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI response without b64_json");

  // subimos rápido a data URL (el front la puede renderizar directamente)
  return `data:image/png;base64,${b64}`;
}

// Replicate Flux (fallback)
async function generateRasterFlux({ prompt, steps = 4 }) {
  if (!REPLICATE_API_TOKEN) throw new Error("Missing REPLICATE_API_TOKEN");
  const url = `https://api.replicate.com/v1/models/${RASTER_FALLBACK}/predictions`;
  const body = { input: { prompt, num_inference_steps: Math.min(4, Number(steps || 4)) } };
  const headers = {
    "Authorization": `Token ${REPLICATE_API_TOKEN}`,
    "Content-Type": "application/json"
  };
  const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`Replicate start failed ${resp.status}`);
  let data = await resp.json();

  while (data?.status && !["succeeded","failed","canceled"].includes(data.status)) {
    await sleep(1200);
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${data.id}`, { headers });
    data = await poll.json();
  }
  if (data?.status !== "succeeded") {
    throw new Error(`Replicate raster failed: ${data?.error || data?.status}`);
  }
  const out = Array.isArray(data.output) ? data.output[0] : data.output;
  return String(out);
}

// ---- utils ----
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function safeJson(r){ try { return await r.json(); } catch { return await r.text(); } }
