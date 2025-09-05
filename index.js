// index.js
// NovaAI Backend (Render-ready)
// - Owner/Vector: Replicate (recraft-ai/recraft-20b-svg) => SVG
// - Customer/Realistic: OpenAI (gpt-image-1)            => PNG URL

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Replicate from "replicate";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" })); // soporta imagen base64 opcional
app.set("trust proxy", true);

// ====== Config ======
const PORT = process.env.PORT || 3000;

// Modelos
const VECTOR_MODEL = "recraft-ai/recraft-20b-svg";
const RASTER_MODEL = "openai:gpt-image-1"; // etiqueta interna (usamos REST)

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// SDK Replicate
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// Util: normaliza cualquier respuesta en {owner_image, customer_image}
function normalizeAny(data) {
  const out = { owner_image: null, customer_image: null };
  try {
    if (!data) return out;

    const deepFindFirstImage = (v) => {
      if (!v) return null;
      if (typeof v === "string") {
        if (/^data:image\//.test(v)) return v;
        const m = v.match(/https?:\/\/[^\s"']+\.(?:png|jpg|jpeg|webp|svg)/i);
        if (m) return m[0];
      }
      if (Array.isArray(v)) {
        for (const x of v) {
          const r = deepFindFirstImage(x);
          if (r) return r;
        }
      }
      if (typeof v === "object") {
        for (const k of Object.keys(v)) {
          const r = deepFindFirstImage(v[k]);
          if (r) return r;
        }
      }
      return null;
    };

    out.owner_image =
      data.owner_image || data.vector_image || deepFindFirstImage(data.owner);
    out.customer_image =
      data.customer_image ||
      data.image_url ||
      deepFindFirstImage(data.customer) ||
      deepFindFirstImage(data);

    if (!out.owner_image && out.customer_image)
      out.owner_image = out.customer_image;
    if (!out.customer_image && out.owner_image)
      out.customer_image = out.owner_image;
  } catch (_) {}
  return out;
}

// ====== Health ======
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "NovaAI Node",
    port: Number(PORT),
    base_url: null,
    vector_model: VECTOR_MODEL,
    raster_model: RASTER_MODEL,
  })
);

// ====== Generadores ======
async function generateVector({ prompt, negative, params, image_base64 }) {
  // Entradas típicas para recraft SVG:
  // - prompt
  // - negative_prompt
  // - guidance_scale
  // - num_inference_steps
  // - output_format: "svg"
  // - image (opcional para img2img) ← este modelo acepta referencia
  const input = {
    prompt,
    negative_prompt: negative || "",
    output_format: "svg",
    // Mapeo suave de parámetros
    guidance_scale: params?.guidance ?? 7.5,
    num_inference_steps: params?.steps ?? 40,
  };

  // Si llega referencia, la mandamos. Debe ser dataURL base64 "data:image/..;base64,...."
  if (image_base64 && !image_base64.startsWith("data:")) {
    // Si llega solo el bloque base64 (sin prefijo data:), lo convertimos a dataURL PNG
    input.image = `data:image/png;base64,${image_base64}`;
  } else if (image_base64) {
    input.image = image_base64;
  }

  const out = await replicate.run(VECTOR_MODEL, { input });
  // Recraft normalmente devuelve un único string (URL) o un array con 1
  const svgUrl = Array.isArray(out) ? out[0] : out;
  return { owner_image: svgUrl };
}

async function generateRealistic({ prompt /*, image_base64*/ }) {
  // OpenAI Images - REST directo para evitar agregar SDK como dependencia
  // Importante: NO usar response_format (causa 400).
  // Por ahora generamos sólo desde prompt (sin edits). Variations/edits requieren multipart.
  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      size: "1024x1024",
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI gen ${resp.status}: ${txt}`);
    }

  const data = await resp.json();
  const url =
    (data?.data && data.data[0] && data.data[0].url) ? data.data[0].url : null;
  if (!url) throw new Error("OpenAI: no image url in response");
  return { customer_image: url };
}

// ====== API: /api/generate ======
/**
 * Body esperado (como lo manda tu novaai.html):
 * {
 *   target: 'owner' | 'customer',
 *   prompt: string,
 *   negative: string,
 *   params: { width, height, guidance, steps, strength },
 *   image_base64?: string (puede venir con o sin prefijo data:)
 * }
 */
app.post("/api/generate", async (req, res) => {
  const { target, prompt, negative, params, image_base64 } = req.body || {};
  if (!prompt || !target) {
    return res.status(400).json({ error: "Missing 'prompt' or 'target'" });
  }
  try {
    let result;
    if (target === "owner") {
      if (!REPLICATE_API_TOKEN)
        throw new Error("Missing REPLICATE_API_TOKEN in env");
      result = await generateVector({ prompt, negative, params, image_base64 });
    } else if (target === "customer") {
      if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY in env");
      // Nota: de momento ignoramos image_base64 aquí (edits/variations requieren multipart)
      result = await generateRealistic({ prompt });
    } else {
      throw new Error("Unknown target (use 'owner' or 'customer')");
    }

    // Normaliza y responde (por si en el futuro mezclamos salidas)
    const out = normalizeAny(result);
    if (!out.owner_image && !out.customer_image)
      return res.status(500).json({ error: "No image in response" });
    res.json(out);
  } catch (err) {
    console.error("[/api/generate] Error:", err?.message || err);
    res.status(400).json({ error: String(err?.message || err) });
  }
});

// ====== Start ======
app.listen(PORT, () => {
  console.log(`Backend listo en http://localhost:${PORT}`);
});
