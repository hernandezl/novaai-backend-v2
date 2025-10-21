// server_replicate.js (completo)
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

// ====== config por ENV ======
const PORT = process.env.PORT || 3000;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN?.trim();
if (!REPLICATE_API_TOKEN) {
  console.error("Falta REPLICATE_API_TOKEN en Environment.");
  process.exit(1);
}

// CORS: tu dominio + localhost
const CORS_LIST = (process.env.CORS_ORIGIN || "https://www.negunova.com,https://negunova.com,http://localhost:5560,http://127.0.0.1:5560")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const DEFAULT_MODEL_ID = process.env.DEFAULT_MODEL || "bytedance/seededit-3.0"; // i2i de ByteDance
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || "https://novaai-backend-v2.onrender.com";
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 1500);
const MAX_POLLS = Number(process.env.MAX_POLLS || 120); // ~3 min

// ====== app ======
const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "24mb" }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const ok = CORS_LIST.some(allowed => origin.startsWith(allowed));
      if (ok) cb(null, true);
      else cb(new Error(`CORS: origin ${origin} is not allowed`));
    },
    credentials: false,
  })
);

// ====== uploads tmp (opcional) ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ====== helpers ======
async function resolveLatestVersion(ownerSlashName) {
  // ownerSlashName: "bytedance/seededit-3.0"
  const url = `https://api.replicate.com/v1/models/${ownerSlashName}/versions`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`No pude obtener versions de ${ownerSlashName}: ${r.status} ${t}`);
  }
  const data = await r.json();
  const latest = data?.results?.[0]?.id;
  if (!latest) throw new Error(`El modelo ${ownerSlashName} no tiene versions visibles.`);
  return latest;
}

async function startPrediction({ model, version, input }) {
  // Si no mandan version, la resolvemos
  const modelId = model || DEFAULT_MODEL_ID;
  const versionId = version || (await resolveLatestVersion(modelId));

  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version: versionId,
      input,
    }),
  });

  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = out?.detail || out?.error || JSON.stringify(out);
    throw new Error(`Replicate create failed: ${r.status} ${msg}`);
  }
  return out; // contiene id, status, etc.
}

async function getPrediction(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` },
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = out?.detail || out?.error || JSON.stringify(out);
    throw new Error(`Replicate get failed: ${r.status} ${msg}`);
  }
  return out;
}

// Adaptamos inputs a modelos “edición” comunes (seededit / flux-kontext-pro)
function buildInputForEdit({ ref, prompt, font, strength, steps }) {
  // Muchos modelos aceptan: image, prompt, (strength|guidance|num_steps)
  const input = {
    image: ref,        // URL https/https o dataURL base64
    prompt: prompt || "",
  };

  // Parámetros opcionales comunes
  if (typeof strength === "number") input.strength = strength;       // 0..1 (seededit usa guidance_scale; otros usan strength)
  if (typeof steps === "number") input.num_steps = steps;             // algunos modelos
  if (font) input.font = font;                                        // si tu prompt/plantilla lo usa

  return input;
}

// ====== endpoints ======
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    engine: "replicate: i2i",
    default_model: DEFAULT_MODEL_ID,
    version: "auto-latest (if missing)",
    cors: CORS_LIST,
    public_base: PUBLIC_BASE,
  });
});

app.post("/api/generate", upload.single("file"), async (req, res) => {
  try {
    const body = req.body || {};
    const { model, version, ref, prompt, font } = body;
    let { strength, steps } = body;

    // Normaliza números
    strength = typeof strength !== "undefined" ? Number(strength) : undefined;
    steps = typeof steps !== "undefined" ? Number(steps) : undefined;

    // Imagen de referencia: o viene como URL/base64 en `ref`, o suben archivo en `file`
    let imageRef = ref?.trim();
    if (!imageRef && req.file) {
      const b64 = req.file.buffer.toString("base64");
      imageRef = `data:${req.file.mimetype || "image/png"};base64,${b64}`;
    }
    if (!imageRef) {
      return res.status(400).json({ ok: false, msg: "Missing reference image. Provide file or ref (dataURL/https)." });
    }

    // Arma input
    const input = buildInputForEdit({ ref: imageRef, prompt, font, strength, steps });

    // Crea predicción (resuelve version si no se pasa)
    const start = await startPrediction({ model, version, input });
    const pid = start?.id;
    if (!pid) throw new Error("No recibí id de predicción.");

    // Polling hasta resultado
    let current = start;
    for (let i = 0; i < MAX_POLLS; i++) {
      if (current.status === "succeeded" || current.status === "failed" || current.status === "canceled") break;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      current = await getPrediction(pid);
    }

    if (current.status !== "succeeded") {
      return res.status(500).json({ ok: false, msg: "Prediction did not succeed", status: current.status, error: current.error || null });
    }

    // Algunos modelos devuelven string, otros array
    let out = current.output;
    if (Array.isArray(out)) out = out[0];

    return res.json({
      ok: true,
      id: pid,
      status: current.status,
      image: out, // URL
      raw: {
        started_at: current.started_at,
        metrics: current.metrics,
        urls: current.urls,
      },
    });
  } catch (err) {
    console.error("[replicate-proxy] error:", err);
    const msg = err?.message || String(err);
    const code = /Missing reference image/i.test(msg) ? 400 : 422;
    res.status(code).json({ ok: false, msg });
  }
});

// ====== start ======
app.listen(PORT, () => {
  console.log("////////////////////////////////////////////////////////");
  console.log(`==> Your service is live 🎉`);
  console.log(`==> Available at your primary URL ${PUBLIC_BASE}`);
  console.log("////////////////////////////////////////////////////////");
  console.log(`Allowed origins: ${CORS_LIST.join(", ")}`);
  console.log(`Default model: ${DEFAULT_MODEL_ID} (version: auto-resolve)`);
});
