// index.js — NovaAI backend v2+ (safe additions)
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import Replicate from "replicate";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// ===== Config =====
const PORT = process.env.PORT || 3000;
const VECTOR_MODEL = "recraft-ai/recraft-20b-svg";       // Owner
const OPENAI_IMAGE_MODEL = "gpt-image-1";                // Customer (primario)
const RASTER_FALLBACK = "black-forest-labs/flux-schnell"; // Customer fallback
const DEFAULT_SIZE = process.env.DEFAULT_SIZE || "1024x1024";
const LOG_LEVEL = process.env.LOG_LEVEL || "info"; // "silent"|"info"|"debug"
const FORCE_FALLBACK = process.env.FORCE_FALLBACK === "1";

function log(...a){ if(LOG_LEVEL!=="silent") console.log(...a); }
function dbg(...a){ if(LOG_LEVEL==="debug") console.log("[debug]", ...a); }
function err(...a){ console.error(...a); }

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

// ========= helpers =========
async function urlToBase64(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error("No se pudo descargar la imagen base");
  const b = await r.arrayBuffer();
  const base64 = Buffer.from(b).toString("base64");
  const ct = r.headers.get("content-type") || "image/png";
  return { base64, mime: ct };
}

function composeOwnerPrompt(userPrompt, hasBase){
  const style = [
    "flat vector illustration",
    "bold thick outlines",
    "simple geometric shapes",
    "two-tone shading",
    "vivid posterized color blocks",
    "cute mascot proportions"
  ].join(", ");
  const keep = hasBase
    ? "match the base image composition, color harmony and silhouette; only apply requested changes"
    : "centered composition, clean background, iconic silhouette";

  return `${userPrompt}. ${style}. ${keep}.`;
}

function composeCustomerPrompt(userPrompt, mode, onlyText=false){
  const keep = mode === "strict"
    ? "keep the original composition, shapes, palette and materials of the base image; apply only the requested changes"
    : "stay close to the base image look & feel if provided";
  const textRule = onlyText
    ? "do not change shapes; only update lettering/labels requested"
    : "preserve design identity while applying requested modifications";

  return `${userPrompt}. ${keep}. ${textRule}. high quality product photography, soft studio lighting, realistic materials, 85mm lens, shallow depth of field.`;
}

// ========= Health =========
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "NovaAI Node",
    port: Number(PORT),
    base_url: null,
    vector_model: VECTOR_MODEL,
    raster_model: OPENAI_IMAGE_MODEL
  });
});

// ========= Generate endpoint =========
// body: { prompt, negative?, params:{size?,steps?}, image_base64?, source_url?, control?:"strict"|"loose", only_text?:boolean, mode?:"both"|"vector"|"raster" }
app.post("/api/generate", async (req, res) => {
  const { prompt = "", negative = "", params = {}, image_base64, source_url, control="strict", only_text=false, mode="both" } = req.body || {};
  if(!prompt && !image_base64 && !source_url){
    return res.status(400).json({ error: "prompt or reference image required" });
  }

  let baseB64 = image_base64 || null;
  try{
    if(!baseB64 && source_url){
      const { base64 } = await urlToBase64(source_url);
      baseB64 = base64;
    }
  }catch(e){
    err("[base image]", e);
  }

  const size = params?.size || DEFAULT_SIZE;
  const steps = Math.min(Math.max(Number(params?.steps || 4),1),4); // Flux limit

  let vector_url = null;
  let raster_url = null;

  // === Owner (vector) via Recraft SVG ===
  try{
    if(mode==="both" || mode==="vector"){
      const fullPrompt = composeOwnerPrompt(prompt, !!baseB64);
      const input = {
        prompt: fullPrompt,
        // Muchos modelos ignoran la imagen si no soportan i2i; se envía si el modelo la acepta.
        // Recraft SVG no documenta i2i, pero no rompe si se pasa campo desconocido.
        // Si tu variante soporta ref image, cámbialo a "image" o "reference_image".
        size, // algunas variantes aceptan "size"
      };
      // Ejecutar
      const output = await replicate.run(VECTOR_MODEL, { input });
      // El output suele ser URL(s). Tomamos el primero.
      if(Array.isArray(output) && output.length) {
        vector_url = output[0];
      } else if (typeof output === "string") {
        vector_url = output;
      }
      dbg("[vector]", vector_url);
    }
  }catch(e){
    err("[vector/replicate] ", e?.message || e);
  }

  // === Customer (realistic) OpenAI primary, fallback Flux ===
  async function genOpenAI(){
    const key = process.env.OPENAI_API_KEY;
    if(!key) throw new Error("No OPENAI_API_KEY");
    const body = {
      model: OPENAI_IMAGE_MODEL,
      prompt: composeCustomerPrompt(prompt, control, only_text),
      size
    };
    // gpt-image-1 soporta image[] como referencias; enviamos si hay base
    if(baseB64) body.image = [`data:image/png;base64,${baseB64}`];

    const r = await fetch("https://api.openai.com/v1/images/generations",{
      method:"POST",
      headers:{
        "Authorization":`Bearer ${key}`,
        "Content-Type":"application/json"
      },
      body: JSON.stringify(body)
    });
    if(!r.ok){
      const t = await r.text();
      throw new Error(`OpenAI gen ${r.status}: ${t}`);
    }
    const j = await r.json();
    if(!j?.data?.length) throw new Error("OpenAI sin data");
    const b64 = j.data[0].b64_json;
    return `data:image/png;base64,${b64}`;
  }

  async function genFluxFallback(){
    const input = {
      prompt: composeCustomerPrompt(prompt, control, only_text),
      steps,
      // algunos hosts piden "guidance" o "image", si tu variante acepta i2i añade aquí
    };
    const out = await replicate.run(RASTER_FALLBACK, { input });
    if(Array.isArray(out) && out.length) return out[0];
    if(typeof out === "string") return out;
    throw new Error("Flux sin salida");
  }

  try{
    if(mode==="both" || mode==="raster"){
      if(FORCE_FALLBACK) throw new Error("Forced fallback");
      raster_url = await genOpenAI();
    }
  }catch(e){
    err("[openai]", e?.message || e);
    // fallback
    try{
      raster_url = await genFluxFallback();
    }catch(e2){
      err("[flux fallback]", e2?.message || e2);
    }
  }

  if(!vector_url && !raster_url){
    return res.status(500).json({ error: "no image generated" });
  }

  return res.json({
    ok:true,
    vector_url: vector_url || null,
    raster_url: raster_url || null,
    model: {
      vector: VECTOR_MODEL,
      raster: raster_url?.startsWith("data:") ? OPENAI_IMAGE_MODEL : RASTER_FALLBACK
    }
  });
});

// ===== start =====
app.listen(PORT, ()=> log(`Backend listo en http://localhost:${PORT}`));
