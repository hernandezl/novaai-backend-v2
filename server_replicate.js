// server_replicate.js
// NovaAI Backend v2 – Proxy para Replicate (oficial models)
// Node 18/20+, ESM

import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";

dotenv.config();

// ====== Config ======
const PORT = process.env.PORT || 8080;
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "bytedance/seededit-3.0"; // imagen->imagen
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// Node 18+ tiene fetch/Blob/FormData globales
if (!globalThis.fetch) {
  throw new Error("This server requires Node 18+ (global fetch).");
}
if (!REPLICATE_TOKEN) {
  console.warn("[WARN] Missing REPLICATE_API_TOKEN env var.");
}

// ====== App ======
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN, credentials: false }));

// Multer (memoria) para /api/upload
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ====== Utilidades ======
const R_BASE = "https://api.replicate.com/v1";

function authHeaders(extra = {}) {
  return {
    Authorization: `Token ${REPLICATE_TOKEN}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function getLatestVersionId(modelId) {
  // modelId: "owner/name", p.ej. "bytedance/seededit-3.0"
  const url = `${R_BASE}/models/${modelId}`;
  const resp = await fetch(url, { headers: authHeaders() });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Failed to fetch model info (${resp.status}): ${txt}`);
  }
  const data = await resp.json();
  const ver = data?.latest_version?.id;
  if (!ver) throw new Error("Model latest_version.id not found.");
  return ver;
}

async function createPrediction({ version, input }) {
  const url = `${R_BASE}/predictions`;
  const body = JSON.stringify({ version, input });
  const resp = await fetch(url, { method: "POST", headers: authHeaders(), body });
  const data = await resp.json();
  if (!resp.ok) {
    // Devuelve el error de Replicate tal cual para depurar
    throw new Error(JSON.stringify(data));
  }
  return data; // contiene id, status, output? (si wait no se usa, output vendrá polling)
}

// ====== Rutas ======

// Health
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "NovaAI Backend v2", time: new Date().toISOString() });
});

// Echo (debug)
app.post("/api/echo", (req, res) => {
  res.json({ ok: true, recv: req.body });
});

// Test de token a Replicate (lee el modelo por defecto)
app.get("/replicate-test", async (req, res) => {
  try {
    const model = req.query.model || DEFAULT_MODEL;
    const url = `${R_BASE}/models/${model}`;
    const r = await fetch(url, { headers: authHeaders() });
    const data = await r.json();
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Subida de imagen -> Replicate Files API
app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, msg: "Missing image file" });

    const fd = new FormData();
    // Blob desde buffer (Node 18+)
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || "application/octet-stream" });
    fd.append("file", blob, req.file.originalname || "upload.png");

    const r = await fetch(`${R_BASE}/files`, {
      method: "POST",
      headers: { Authorization: `Token ${REPLICATE_TOKEN}` }, // sin Content-Type, lo pone fetch
      body: fd,
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, msg: "Upload failed", data });

    // Respuesta típica: { id, name, content_type, size, upload_url, download_url }
    res.json({ ok: true, url: data?.download_url || data?.url || null, data });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message || String(err) });
  }
});

// Generate (predicción)
// Acepta dos formatos:
//  A) Simple: { model, version?, ref, prompt, guidance_scale?, strength?, steps?, ... }
//  B) Avanzado: { model, version?, input: { ... } }  -> se manda tal cual a Replicate
app.post("/api/generate", async (req, res) => {
  try {
    const body = req.body || {};
    const model = body.model || DEFAULT_MODEL;

    // Construye input si no vino input completo
    let input = body.input;
    if (!input) {
      const { ref, prompt, guidance_scale, strength, steps, ...rest } = body;

      // Validación mínima
      if (!prompt) return res.status(400).json({ ok: false, msg: "Missing 'prompt'." });

      // Para modelos image-edit (seededit / kontext-pro), una imagen es necesaria:
      // - Si traes 'ref' (URL) úsalo. Si no, falla con 400.
      // - Alternativamente, puedes subir antes a /api/upload y pasar esa URL aquí.
      if (!ref) {
        return res.status(400).json({
          ok: false,
          msg: "Missing reference image URL 'ref'. Upload first to /api/upload or pass a valid URL.",
        });
      }

      // Inputs comunes a modelos oficiales de edición (Replicate los ignora si no aplican)
      input = {
        image: ref,
        prompt,
        guidance_scale: guidance_scale ?? 5.5,
        strength: strength ?? 0.2,
        steps: steps ?? 28,
        ...rest, // por si quieres pasar otros parámetros soportados por el modelo elegido
      };
    }

    // Determina versión:
    let version = body.version;
    if (!version) {
      version = await getLatestVersionId(model);
    }

    // Crea la predicción
    const pred = await createPrediction({ version, input });

    // Si quieres bloquear hasta que termine, podrías hacer polling aquí
    // (dejamos la respuesta inmediata; frontend puede pollear /predictions/:id si quiere)
    res.json({
      ok: true,
      id: pred.id,
      status: pred.status,
      output: pred.output || null,
      urls: pred.urls || null,
      version,
      model,
    });
  } catch (err) {
    // Intenta parsear errores de Replicate para que el frontend los muestre
    let msg = String(err.message || err);
    try {
      const j = JSON.parse(msg);
      return res.status(422).json({ ok: false, msg: "Replicate error", data: j });
    } catch (_) {
      // no-op
    }
    res.status(400).json({ ok: false, msg });
  }
});

// (Opcional) Obtener una predicción por id (para polling)
app.get("/api/predictions/:id", async (req, res) => {
  try {
    const url = `${R_BASE}/predictions/${req.params.id}`;
    const r = await fetch(url, { headers: authHeaders() });
    const data = await r.json();
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message || String(err) });
  }
});

// ====== Start ======
app.listen(PORT, () => {
  console.log(`NovaAI backend running on :${PORT}`);
  console.log(`Allowed CORS origin: ${CORS_ORIGIN}`);
});
