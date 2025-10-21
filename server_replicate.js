// server_replicate.js – versión estable sin versión fija
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";

const app = express();

// === CONFIG ===
const PORT = process.env.PORT || 3000;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN?.trim();
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "bytedance/seededit-3.0";
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || "https://novaai-backend-v2.onrender.com";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "https://www.negunova.com,https://negunova.com,http://localhost:5560";
const POLL_INTERVAL = 2000;
const MAX_POLLS = 90;

if (!REPLICATE_API_TOKEN) {
  console.error("❌ Falta REPLICATE_API_TOKEN");
  process.exit(1);
}

// === MIDDLEWARE ===
app.use(express.json({ limit: "12mb" }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const ok = CORS_ORIGIN.split(",").some(o => origin.startsWith(o));
    if (ok) cb(null, true);
    else cb(new Error(`CORS bloqueado para ${origin}`));
  }
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// === FUNCIONES AUX ===
async function getLatestVersion(model) {
  const url = `https://api.replicate.com/v1/models/${model}/versions`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` } });
  const j = await r.json();
  return j?.results?.[0]?.id;
}

async function createPrediction(model, version, input) {
  const body = { version, input };
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function getPrediction(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { "Authorization": `Bearer ${REPLICATE_API_TOKEN}` }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

// === ENDPOINTS ===
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    default_model: DEFAULT_MODEL,
    cors: CORS_ORIGIN,
    base: PUBLIC_BASE
  });
});

app.post("/api/generate", upload.single("file"), async (req, res) => {
  try {
    const { model, prompt, strength, steps } = req.body;
    let { ref } = req.body;
    if (!ref && req.file) {
      ref = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    }
    if (!ref) return res.status(400).json({ ok: false, msg: "Missing ref image" });

    const modelId = model || DEFAULT_MODEL;
    const version = await getLatestVersion(modelId);

    const input = {
      image: ref,
      prompt: prompt || "make it artistic",
      guidance_scale: Number(strength || 4.5),
      num_steps: Number(steps || 28)
    };

    const start = await createPrediction(modelId, version, input);
    let result = start;
    for (let i = 0; i < MAX_POLLS; i++) {
      if (["succeeded", "failed"].includes(result.status)) break;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      result = await getPrediction(start.id);
    }

    if (result.status !== "succeeded") {
      return res.status(500).json({ ok: false, msg: "Prediction failed", result });
    }

    const img = Array.isArray(result.output) ? result.output[0] : result.output;
    res.json({ ok: true, image: img, id: result.id });
  } catch (err) {
    console.error("⚠️ Error:", err);
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// === START ===
app.listen(PORT, () => {
  console.log(`✅ Running at ${PUBLIC_BASE} (model: ${DEFAULT_MODEL})`);
});
