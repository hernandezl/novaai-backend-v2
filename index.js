// index.js — NovaAI Backend v2 (Recraft + OpenAI con fallback Flux)
// Requisitos ENV en Render:
// - REPLICATE_API_TOKEN  (obligatoria)
// - OPENAI_API_KEY       (opcional; si falta o falla, usa Flux de fallback)
// - PORT                 (Render lo inyecta)
// Opcional:
// - REPLICATE_VECTOR_MODEL="recraft-ai/recraft-20b-svg"
// - REPLICATE_RASTER_MODEL="black-forest-labs/flux-schnell"

import express from "express";
import cors from "cors";
import "dotenv/config";
import fetch from "node-fetch";
import Replicate from "replicate";

// ────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const VECTOR_MODEL = process.env.REPLICATE_VECTOR_MODEL || "recraft-ai/recraft-20b-svg";
const FLUX_MODEL   = process.env.REPLICATE_RASTER_MODEL  || "black-forest-labs/flux-schnell";

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

function log(...args){ console.log("[api]", ...args); }
function logErr(...args){ console.error("[api]", ...args); }

// ────────────────────────────────────────────────────────────
app.get("/", (_req,res)=>res.send("NovaAI Backend OK"));
// Health
app.get("/health", (_req,res)=> {
  res.json({
    ok: true,
    service: "NovaAI Node",
    port: Number(PORT),
    base_url: null,
    vector_model: VECTOR_MODEL,
    raster_model: process.env.OPENAI_API_KEY ? "openai:gpt-image-1" : `replicate:${FLUX_MODEL}`,
  });
});

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────
function asDataURLIfNeeded(b64){
  if(!b64) return undefined;
  if (b64.startsWith("data:")) return b64;
  return `data:image/png;base64,${b64}`;
}

function clampInt(v, min, max, def){
  const n = Number.isFinite(+v) ? Math.round(+v) : def;
  return Math.max(min, Math.min(max, n));
}

// Normaliza salida para el front
function packResponse({kind, image}){
  if(kind==="vector"){
    return { owner_image: image, customer_image: image };
  }
  return { owner_image: image, customer_image: image };
}

// ────────────────────────────────────────────────────────────
// Generadores
// ────────────────────────────────────────────────────────────

// 1) VECTOR (SVG) - Recraft
async function generateVector({ prompt, negative, params, image_base64 }){
  const width  = clampInt(params?.width,  256, 2048, 1024);
  const height = clampInt(params?.height, 256, 2048, 1024);

  const input = {
    // Prompt “vector style” se añade ya en tu front; aquí usamos tal cual
    prompt,
    negative_prompt: negative || undefined,
    width,
    height,
    // El modelo de Recraft ignora steps/guidance tradicionales;
    // se mantienen por compatibilidad, no afectan si el backend del modelo no los usa.
  };

  if (image_base64) {
    input.image = asDataURLIfNeeded(image_base64);
  }

  log("Recraft run", { model: VECTOR_MODEL, width, height });
  const out = await replicate.run(VECTOR_MODEL, { input });
  // Recraft devuelve URL (svg/png). Normalizamos:
  const url = Array.isArray(out) ? out[0] : (typeof out === "string" ? out : out?.output || out?.image || null);
  if (!url) throw new Error("Recraft no devolvió URL");
  return { kind: "vector", image: url };
}

// 2) REALISTA - OpenAI con fallback a Flux
async function generateRealistic({ prompt, negative, params, image_base64 }){
  // Primero intentamos OpenAI si hay API key
  if (process.env.OPENAI_API_KEY) {
    try{
      // gpt-image-1 (Images API endpoint)
      const body = {
        model: "gpt-image-1",
        prompt,
        size: "1024x1024",
      };
      // Si quieres soporte img2img con OpenAI: enviar "image" con URL pública;
      // para dataURL el endpoint actual no acepta binario inline. Para simplicidad, omitimos.
      const resp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      if(!resp.ok) {
        // Errores comunes: 403 org verification, 429 rate/limit, 400 inputs… registramos y saltamos al fallback
        logErr("[OpenAI gen]", resp.status, text);
        throw new Error(`OpenAI gen ${resp.status}: ${text}`);
      }
      const data = JSON.parse(text);
      const url = data?.data?.[0]?.url || null;
      if (url) return { kind:"real", image:url };
      throw new Error("OpenAI: respuesta sin URL");
    }catch(e){
      logErr("[OpenAI->Flux fallback]", e?.message || e);
      // continúa a Flux
    }
  }

  // Fallback: Flux (Replicate)
  const width  = clampInt(params?.width,  256, 2048, 1024);
  const height = clampInt(params?.height, 256, 2048, 1024);
  const steps = clampInt(params?.steps,  4,  50, 12);
  const guidance = Number.isFinite(+params?.guidance) ? +params.guidance : 1.5;

  const input = {
    prompt,
    width,
    height,
    guidance,
    num_inference_steps: steps,
  };
  if (negative) input.negative_prompt = negative;
  if (image_base64) input.image = asDataURLIfNeeded(image_base64); // Flux acepta dataURL

  log("Flux run", { model: FLUX_MODEL, width, height, steps, guidance });
  const out = await replicate.run(FLUX_MODEL, { input });
  const url = Array.isArray(out) ? out[0] : (typeof out === "string" ? out : out?.output || out?.image || null);
  if (!url) throw new Error("Flux no devolvió URL");
  return { kind:"real", image:url };
}

// ────────────────────────────────────────────────────────────
// API
// ────────────────────────────────────────────────────────────
app.post("/api/generate", async (req,res)=>{
  const { target="owner", prompt="", negative="", params={}, image_base64 } = req.body || {};
  try{
    if(!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing prompt" });
    }
    let result;
    if (target === "owner" || target === "vector") {
      result = await generateVector({ prompt, negative, params, image_base64 });
    } else {
      result = await generateRealistic({ prompt, negative, params, image_base64 });
    }
    const packed = packResponse(result);
    res.json(packed);
  }catch(e){
    logErr("[/api/generate] Error:", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ────────────────────────────────────────────────────────────
app.listen(PORT, ()=> {
  log(`Backend listo en http://localhost:${PORT}`);
});
