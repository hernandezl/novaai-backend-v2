// server_replicate.js
// NovaAI Proxy -> Replicate (image-to-image / edit) usando /v1/predictions con "model"
// Endpoints:
//   GET  /api/health
//   POST /api/generate
//
// Entrada:
//  - multipart/form-data: field "file" (imagen) + campos "prompt","negative","font","strength","steps","seed","model"
//  - JSON: { ref, prompt, negative, font, strength, steps, seed, model }
//
// .env (Render):
//  - REPLICATE_API_TOKEN = r8_************************
//  - REPLICATE_MODEL_ID  = black-forest-labs/flux-kontext-pro   (default recomendado)
//  - PUBLIC_BASE_URL     = https://novaai-backend-v2.onrender.com
//  - CORS_ORIGIN         = https://negunova.com,https://www.negunova.com

import express from "express";
import multer from "multer";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { nanoid } from "nanoid";
import fs from "fs";
import path from "path";
import os from "os";

dotenv.config();

const app = express();

// ===== CONFIG =====
const PORT = Number(process.env.PORT || 3001);
const CORS_LIST = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
  : true;

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const DEFAULT_MODEL_ID =
  process.env.REPLICATE_MODEL_ID || "black-forest-labs/flux-kontext-pro";

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || "";
const MAX_POLL_MS = Number(process.env.MAX_POLL_MS || 120000);
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 2500);

if (!REPLICATE_API_TOKEN) {
  console.error("FATAL: missing REPLICATE_API_TOKEN");
  process.exit(1);
}
if (!PUBLIC_BASE) {
  console.warn("WARN: set PUBLIC_BASE_URL to expose /tmp images.");
}

// ===== MIDDLEWARE =====
app.use(cors({ origin: CORS_LIST, credentials: false }));
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ===== TMP público para que Replicate pueda leer la imagen =====
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

// ===== Replicate helpers (sin version, vía /v1/predictions) =====
async function createPrediction(modelId, input) {
  const resp = await axios.post(
    "https://api.replicate.com/v1/predictions",
    { model: modelId, input },
    {
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );
  return resp.data; // { id, status, ... }
}

async function getPrediction(id) {
  const resp = await axios.get(
    `https://api.replicate.com/v1/predictions/${id}`,
    {
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
      timeout: 15000,
    }
  );
  return resp.data;
}

async function waitForPrediction(id) {
  const t0 = Date.now();
  while (Date.now() - t0 < MAX_POLL_MS) {
    const d = await getPrediction(id);
    if (["succeeded", "failed", "canceled"].includes(d.status)) return d;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error("Timeout waiting for Replicate prediction");
}

// ===== health =====
app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    engine: "replicate",
    default_model: DEFAULT_MODEL_ID,
    public_base: PUBLIC_BASE || "(set PUBLIC_BASE_URL)",
    cors: Array.isArray(CORS_LIST) ? CORS_LIST : "true",
  })
);

// ===== generate =====
app.post("/api/generate", upload.single("file"), async (req, res) => {
  try {
    // 1) Imagen de referencia
    let refUrl = null;
    if (req.file) {
      const tmp = saveImageAndGetUrl(req.file.buffer);
      refUrl = tmp.url;
    } else if (req.body.ref && /^data:/.test(req.body.ref)) {
      const buf = dataUriToBuffer(req.body.ref);
      const tmp = saveImageAndGetUrl(buf);
      refUrl = tmp.url;
    } else if (req.body.ref && /^https?:\/\//i.test(req.body.ref)) {
      const buf = await fetchAsBuffer(req.body.ref);
      const tmp = saveImageAndGetUrl(buf);
      refUrl = tmp.url;
    }

    // 2) Parámetros comunes
    const promptRaw = (req.body.prompt || "").toString().trim();
    const negative = (req.body.negative || "").toString().trim();
    const font = (req.body.font || "DM Sans").toString().trim();

    const strength = Math.max(
      0.0,
      Math.min(1.0, Number(req.body.strength ?? (refUrl ? 0.2 : 1.0)))
    );
    const steps = Math.max(12, Math.min(50, parseInt(req.body.steps || 28, 10)));
    const seed = req.body.seed ? Number(req.body.seed) : undefined;

    const modelId = (req.body.model || DEFAULT_MODEL_ID).trim();

    // 3) Prompt bloqueado + negativos para no cambiar fondo/estilo
    const guided =
      `Only change the main figure and/or the overlaid texts. ` +
      `Keep the original style, composition, background, and line weights. ` +
      `Use font: ${font}.`;
    const fullPrompt = promptRaw ? `${guided} Instructions: ${promptRaw}` : guided;

    const negDefault = [
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
    const neg = negative || negDefault;

    // 4) Input común (Kontext Pro / SEED-3 lo aceptan; Qwen Edit simple también)
    const input = {
      prompt: fullPrompt,
      negative_prompt: neg,
      num_inference_steps: steps,
      guidance: 3.5,
    };
    if (seed !== undefined) input.seed = seed;
    if (refUrl) {
      input.image = refUrl;
      input.strength = strength;
    }

    const pred = await createPrediction(modelId, input);
    const final = await waitForPrediction(pred.id);

    if (final.status !== "succeeded") {
      return res
        .status(502)
        .json({ ok: false, msg: `Generation failed: ${final.status}`, logs: final.logs || null });
    }

    const outArr = Array.isArray(final.output)
      ? final.output
      : [final.output].filter(Boolean);
    if (!outArr.length) return res.status(502).json({ ok: false, msg: "No output image URLs" });

    const imgUrl = outArr[0];
    const imgBuf = await fetchAsBuffer(imgUrl);
    const b64 = imgBuf.toString("base64");

    return res.json({
      ok: true,
      image: `data:image/png;base64,${b64}`,
      used: `replicate:${modelId}`,
      strength,
      steps,
    });
  } catch (err) {
    const detail = err?.response?.data || err?.message || err;
    console.error("[replicate-proxy] error:", detail);
    const code = err?.response?.status || 500;
    res.status(code).json({
      ok: false,
      msg: "proxy error",
      error: typeof detail === "string" ? detail : JSON.stringify(detail),
    });
  }
});

// ===== start =====
app.listen(PORT, () => {
  console.log(`NovaAI Replicate proxy listening on :${PORT}`);
  console.log(`Default model: ${DEFAULT_MODEL_ID}`);
  console.log(`Public base: ${PUBLIC_BASE || "(set PUBLIC_BASE_URL!)"}`);
  console.log(
    `Allowed origins: ${
      Array.isArray(CORS_LIST) ? CORS_LIST.join(", ") : "true"
    }`
  );
});
