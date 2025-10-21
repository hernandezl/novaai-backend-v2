// server_replicate.js
// Backend Express para NovaAI usando modelos oficiales de Replicate (sin version).

import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch"; // v3
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 55660;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
if (!REPLICATE_API_TOKEN) {
  console.error("❌ Falta REPLICATE_API_TOKEN en variables de entorno");
  process.exit(1);
}

const CORS_ORIGIN = (process.env.CORS_ORIGIN || "http://localhost:5500,https://www.negunova.com,https://negunova.com")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (CORS_ORIGIN.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: false,
  })
);

const REPL_API = "https://api.replicate.com/v1";

// ---------- util: subir archivo a Replicate (opcional) ----------
async function uploadToReplicate(fileBuf, filename, mimetype) {
  const form = new FormData();
  form.append("file", new Blob([fileBuf], { type: mimetype }), filename || "upload.png");

  const r = await fetch(`${REPL_API}/files`, {
    method: "POST",
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
    body: form,
  });

  if (!r.ok) {
    const msg = await r.text();
    throw new Error(`uploadToReplicate failed: ${r.status} ${msg}`);
  }
  const j = await r.json();
  // j = { id, name, size, content_type, urls: { get, ... } }
  return j.urls.get; // URL pública temporal que acepta como input los modelos
}

// ---------- util: crear predicción y esperar ----------
async function createAndWait(modelPath, input) {
  // POST /models/{owner}/{name}/predictions  (modelos oficiales -> sin version)
  const create = await fetch(`${REPL_API}/models/${modelPath}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });

  const cjson = await create.json().catch(() => ({}));
  if (!create.ok) {
    throw new Error(`create error ${create.status}: ${JSON.stringify(cjson)}`);
  }

  const getUrl = cjson?.urls?.get;
  if (!getUrl) {
    throw new Error(`No get URL from Replicate: ${JSON.stringify(cjson)}`);
  }

  // poll
  let status = cjson.status || "starting";
  let last = cjson;
  const t0 = Date.now();
  while (["starting", "processing", "queued"].includes(status)) {
    await new Promise(r => setTimeout(r, 1200));
    const g = await fetch(getUrl, {
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
    });
    last = await g.json().catch(() => ({}));
    status = last.status;
    if (Date.now() - t0 > 120000) break; // 2 min timeout
  }

  if (status !== "succeeded") {
    const err = last?.error || last?.logs || "prediction failed";
    throw new Error(`prediction status=${status}. ${err}`);
  }

  // algunos modelos devuelven string/url, otros array de urls
  const out = last.output;
  let url = Array.isArray(out) ? out[0] : out;
  if (typeof url !== "string") {
    // seededit a veces entrega { image: "..." } — guardamos primer string que veamos
    if (out && typeof out === "object") {
      const maybe = out.image || out.url || out.output;
      if (typeof maybe === "string") url = maybe;
    }
  }
  if (!url || typeof url !== "string") {
    throw new Error(`No output URL found: ${JSON.stringify(last)}`);
  }
  return { url, raw: last };
}

// ---------- health ----------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    models: {
      edit: "bytedance/seededit-3.0",
      txt2img: "bytedance/seedream-3",
      inpaint: "stability-ai/stable-diffusion-inpainting",
    },
    cors: CORS_ORIGIN,
  });
});

/**
 * POST /api/generate
 * JSON o multipart/form-data (campo "file" opcional).
 * body:
 *  - mode: "edit" | "txt2img" | "inpaint"   (default: "edit")
 *  - prompt: string
 *  - ref: url (imagen)  // si no viene y hay file, se sube file
 *  - negative (opcional), seed, steps, etc. (algunos modelos lo ignoran)
 *  - model (opcional): sobrescribe los defaults por si quieres forzar un modelo
 */
app.post("/api/generate", upload.single("file"), async (req, res) => {
  try {
    const isMultipart = !!req.file;
    const body = isMultipart ? req.body : req.body || {};
    const mode = (body.mode || "edit").toLowerCase();
    const prompt = (body.prompt || "").trim();
    let ref = (body.ref || "").trim();
    const modelOverride = (body.model || "").trim();

    // si viene archivo, lo subimos a Replicate y usamos esa URL
    if (!ref && req.file) {
      ref = await uploadToReplicate(req.file.buffer, req.file.originalname, req.file.mimetype);
    }

    if (mode !== "txt2img" && !ref) {
      return res.status(400).json({ ok: false, msg: "Missing reference image. Provide file or ref (https://…)" });
    }
    if (!prompt) {
      return res.status(400).json({ ok: false, msg: "Missing prompt" });
    }

    let modelPath = "bytedance/seededit-3.0";
    let input = {};

    if (mode === "txt2img") {
      modelPath = modelOverride || "bytedance/seedream-3";
      input = {
        prompt,
        // parámetros razonables; estos modelos ignoran lo que no usan
        width: 1024,
        height: 1024,
        guidance_scale: Number(body.guidance || 6) || 6,
        num_inference_steps: Number(body.steps || 28) || 28,
        seed: body.seed ? Number(body.seed) : undefined,
      };
    } else if (mode === "inpaint") {
      modelPath = modelOverride || "stability-ai/stable-diffusion-inpainting";
      input = {
        image: ref,
        prompt,
        // si luego incorporas máscara, sería input.mask (URL)
        num_inference_steps: Number(body.steps || 28) || 28,
        guidance_scale: Number(body.guidance || 7.5) || 7.5,
        seed: body.seed ? Number(body.seed) : undefined,
      };
    } else {
      // edit (conservar composición)
      modelPath = modelOverride || "bytedance/seededit-3.0";
      input = {
        image: ref,
        prompt,
        guidance_scale: Number(body.guidance || 5.5) || 5.5,
        // algunos extras “suaves” que el modelo ignora si no aplica
        seed: body.seed ? Number(body.seed) : undefined,
      };
    }

    // limpiar undefined
    Object.keys(input).forEach(k => input[k] === undefined && delete input[k]);

    const { url } = await createAndWait(modelPath, input);

    res.json({ ok: true, image: url, model: modelPath });
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    console.error("GEN ERROR:", msg);
    res.status(422).json({ ok: false, msg });
  }
});

app.listen(PORT, () => {
  console.log("NovaAI backend on", PORT);
  console.log("Allowed origins:", CORS_ORIGIN.join(", "));
});
