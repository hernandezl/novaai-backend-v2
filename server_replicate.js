// server_replicate.js
// NovaAI Proxy → Replicate (Flux-Schnell) image-to-image con fidelidad
// Endpoints:
//   GET  /api/health
//   POST /api/generate

import express from "express";
import multer from "multer";
import axios from "axios";
import cors from "cors";
import { nanoid } from "nanoid";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

/* ===== CONFIG ===== */
const PORT = process.env.PORT || 10000;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION = "jd96x0dyqsrm00cj1jp90zeye0";
const PUBLIC_BASE = "https://novaai-backend-v2.onrender.com";

// Permitir IONOS + localhost para pruebas
const ALLOWED_ORIGINS = [
  "https://negunova.com",
  "http://localhost:5500",
];

/* ===== CORS (multi-origin + preflight) ===== */
const corsOptions = {
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: origin ${origin} is not allowed`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
  credentials: false,
};
app.use(cors(corsOptions));
app.options("/api/*", cors(corsOptions));

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

/* ===== TMP STORAGE ===== */
const TMP_DIR = path.join(os.tmpdir(), "novaai_tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });

app.get("/tmp/:id", (req, res) => {
  const p = path.join(TMP_DIR, req.params.id);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.setHeader("Content-Type", "image/png");
  fs.createReadStream(p).pipe(res);
});

function saveImageAndGetUrl(buf) {
  const id = nanoid() + ".png";
  const p = path.join(TMP_DIR, id);
  fs.writeFileSync(p, buf);
  return { id, url: `${PUBLIC_BASE}/tmp/${id}` };
}

async function fetchAsBuffer(url) {
  const r = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  return Buffer.from(r.data);
}

function dataUriToBuffer(uri) {
  const m = /^data:(.+?);base64,(.+)$/.exec(uri);
  if (!m) throw new Error("Invalid data URI");
  return Buffer.from(m[2], "base64");
}

/* ===== REPLICATE HELPERS ===== */
async function createPrediction(input) {
  const resp = await axios.post(
    "https://api.replicate.com/v1/predictions",
    { version: MODEL_VERSION, input },
    {
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );
  return resp.data;
}

async function getPrediction(id) {
  const resp = await axios.get(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
    timeout: 15000,
  });
  return resp.data;
}

async function waitForPrediction(id) {
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const d = await getPrediction(id);
    if (["succeeded", "failed", "canceled"].includes(d.status)) return d;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error("Timeout waiting for Replicate prediction");
}

/* ===== API ===== */
app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    engine: "replicate:flux-schnell",
    version: MODEL_VERSION,
    origins: ALLOWED_ORIGINS,
    public_base: PUBLIC_BASE,
  })
);

app.post("/api/generate", upload.single("file"), async (req, res) => {
  try {
    const promptRaw = (req.body.prompt || "").toString().trim();
    const negative = (req.body.negative || "").toString().trim();
    const strength = Math.max(0.0, Math.min(1.0, Number(req.body.strength || 0.20)));
    const steps = Math.max(12, Math.min(50, parseInt(req.body.steps || 28, 10)));
    const seed = req.body.seed ? Number(req.body.seed) : undefined;
    const font = (req.body.font || "DM Sans").toString();

    let imageUrl = null;
    if (req.file) {
      const tmp = saveImageAndGetUrl(req.file.buffer);
      imageUrl = tmp.url;
    } else if (req.body.ref && /^data:/.test(req.body.ref)) {
      const buf = dataUriToBuffer(req.body.ref);
      const tmp = saveImageAndGetUrl(buf);
      imageUrl = tmp.url;
    } else if (req.body.ref && /^https?:\/\//i.test(req.body.ref)) {
      const buf = await fetchAsBuffer(req.body.ref);
      const tmp = saveImageAndGetUrl(buf);
      imageUrl = tmp.url;
    }

    // PROMPT INTELIGENTE (imitación fiel si no hay texto)
    const guided = `Only change the main figure and/or overlaid texts. Keep the original style, composition, background, and line weights. Use font: ${font}.`;
    const imitate = !promptRaw && imageUrl
      ? ` Imitate the reference image exactly; preserve proportions, lighting, and composition.`
      : "";
    const fullPrompt = (guided + imitate + (promptRaw ? ` Instructions: ${promptRaw}` : "")).trim();

    const neg =
      negative ||
      [
        "no background changes",
        "no layout changes",
        "no composition changes",
        "no extra objects",
        "no new elements",
        "no 3D volume",
        "no gradients",
        "no realistic materials",
        "keep same lighting",
        "keep same line weights",
        "no style drift",
      ].join(", ");

    const input = {
      prompt: fullPrompt,
      negative_prompt: neg,
      guidance: 3.5,
      num_inference_steps: steps,
      strength: imageUrl ? strength : 1.0,
    };
    if (imageUrl) input.image = imageUrl;
    if (seed !== undefined) input.seed = seed;

    const pred = await createPrediction(input);
    const final = await waitForPrediction(pred.id);

    if (final.status !== "succeeded") {
      return res.status(502).json({
        ok: false,
        msg: `Generation failed: ${final.status}`,
        logs: final.logs || null,
      });
    }

    const outArr = Array.isArray(final.output) ? final.output : [final.output].filter(Boolean);
    if (!outArr.length)
      return res.status(502).json({ ok: false, msg: "No output image URLs" });

    const imgUrl = outArr[0];
    const imgBuf = await fetchAsBuffer(imgUrl);
    const b64 = imgBuf.toString("base64");

    return res.json({
      ok: true,
      image: `data:image/png;base64,${b64}`,
      used: "replicate:flux-schnell",
      strength,
      steps,
    });
  } catch (err) {
    console.error("[replicate-proxy] error:", err?.response?.data || err.message || err);
    res.status(500).json({ ok: false, msg: "Proxy error", error: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ NovaAI Replicate proxy running on port ${PORT}`);
  console.log(`🧠 Model version: ${MODEL_VERSION}`);
  console.log(`🌐 Public base: ${PUBLIC_BASE}`);
  console.log(`🌍 Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
