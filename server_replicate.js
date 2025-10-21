// server_replicate.js
// NovaAI Proxy → Replicate (SEED-3 por defecto) con image-to-image de alta fidelidad.
// Endpoints:
//   GET  /api/health
//   POST /api/generate
//
// Acepta:
//  - multipart/form-data: field "file" (imagen) + campos "prompt","font","negative","strength","steps","seed",
//                        "model"(opcional), "version"(opcional), "mode"(customer|fast)
//  - JSON: { ref, prompt, font, negative, strength, steps, seed, model?, version?, mode? }
//
// Prioriza "file" si existe. Si no hay prompt y sí hay referencia → imitación fiel (strength bajo).
// Devuelve { ok, image (dataURL), engine, model, version, strength, steps }.

import express from 'express';
import multer from 'multer';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ────────────────────────────────────────────────────────────────────────────────
// Config & bootstrap
// ────────────────────────────────────────────────────────────────────────────────
dotenv.config();

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

const PORT = Number(process.env.PORT || 3000);
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';

// Modelo por defecto (puedes sobreescribir con env)
const DEFAULT_MODEL   = (process.env.DEFAULT_MODEL   || 'bytedance/seededit-3.0').trim();
const DEFAULT_VERSION = (process.env.DEFAULT_VERSION || '5hwtb2bp9hrmc0cszwdrj7v564').trim();

// URL pública (Render) para exponer /tmp a Replicate
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || '').trim();

// ── CORS robusto (lista blanca desde env CORS_ORIGIN, separada por comas) ──────
const rawCors = process.env.CORS_ORIGIN || '';
const ALLOW = rawCors.split(',').map(s => s.trim()).filter(Boolean);
const corsOpts = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);                 // permite llamadas sin Origin (curl/health)
    if (ALLOW.includes(origin)) return cb(null, true);  // coincide con la whitelist
    return cb(new Error(`CORS: origin ${origin} is not allowed`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  maxAge: 86400
};
app.use(cors(corsOpts));
app.options('*', cors(corsOpts)); // preflight

// Polling
const MAX_POLL_MS   = Number(process.env.MAX_POLL_MS   || 120000); // 120s
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 2500);   // 2.5s

if (!REPLICATE_API_TOKEN) {
  console.error('FATAL: missing REPLICATE_API_TOKEN');
  process.exit(1);
}
if (!PUBLIC_BASE) {
  console.warn('WARN: set PUBLIC_BASE_URL so Replicate can fetch /tmp/:id');
}

// Body parsers
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ────────────────────────────────────────────────────────────────────────────────
// /tmp hosting para servir imágenes intermedias a Replicate
// ────────────────────────────────────────────────────────────────────────────────
const TMP_DIR = path.join(os.tmpdir(), 'novaai_tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

app.get('/tmp/:id', (req, res) => {
  const p = path.join(TMP_DIR, req.params.id);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  fs.createReadStream(p).pipe(res);
});

function saveImageAndGetUrl(buf) {
  const id = nanoid() + '.png';
  const p = path.join(TMP_DIR, id);
  fs.writeFileSync(p, buf);
  return { id, url: `${PUBLIC_BASE}/tmp/${id}` };
}

async function fetchAsBuffer(url) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(r.data);
}

function dataUriToBuffer(uri) {
  const m = /^data:(.+?);base64,(.+)$/.exec(uri);
  if (!m) throw new Error('Invalid data URI');
  return Buffer.from(m[2], 'base64');
}

// ────────────────────────────────────────────────────────────────────────────────
// Replicate helpers
// ────────────────────────────────────────────────────────────────────────────────
async function createPrediction({ modelVersion, input }) {
  const resp = await axios.post('https://api.replicate.com/v1/predictions', {
    version: modelVersion,
    input
  }, {
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });
  return resp.data;
}

async function getPrediction(id) {
  const resp = await axios.get(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
    timeout: 15000
  });
  return resp.data;
}

async function waitForPrediction(id) {
  const t0 = Date.now();
  while (Date.now() - t0 < MAX_POLL_MS) {
    const d = await getPrediction(id);
    if (d.status === 'succeeded' || d.status === 'failed' || d.status === 'canceled') {
      return d;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error('Timeout waiting for Replicate prediction');
}

// ────────────────────────────────────────────────────────────────────────────────
// Health
// ────────────────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    engine: 'replicate',
    default_model: DEFAULT_MODEL,
    version: DEFAULT_VERSION,
    allow: ALLOW,
    public_base: PUBLIC_BASE || '(set PUBLIC_BASE_URL!)'
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// Generate
// ────────────────────────────────────────────────────────────────────────────────
app.post('/api/generate', upload.single('file'), async (req, res) => {
  try {
    const promptRaw = (req.body.prompt || '').toString().trim();
    const negative  = (req.body.negative || '').toString().trim();
    const fontName  = (req.body.font || 'DM Sans').toString().trim();

    // Strength: 0 = muy fiel a la imagen; 1 = más libertad al texto
    const strength  = clamp(Number(req.body.strength ?? 0.20), 0, 1);
    const steps     = clampInt(Number(req.body.steps ?? 28), 12, 80);
    const seed      = req.body.seed !== undefined && req.body.seed !== '' ? Number(req.body.seed) : undefined;

    // Overrides
    const mode      = (req.body.mode || 'customer').toString(); // 'customer' | 'fast'
    const model     = (req.body.model || DEFAULT_MODEL).toString().trim();
    const version   = (req.body.version || DEFAULT_VERSION).toString().trim();

    // Imagen de referencia
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
    if (!imageUrl) {
      return res.status(400).json({ ok: false, msg: 'Missing reference image. Provide file or ref (dataURL/https).' });
    }

    // Prompt “bloqueado” + negativos para no alterar estilo/composición
    const guard = `Only change the main figure and/or texts. Keep original style, composition, background, lighting, and line weights. Use font: ${fontName}.`;
    const fullPrompt = promptRaw ? `${guard} Instructions: ${promptRaw}` : guard;

    const neg = negative || [
      'no background changes',
      'no layout changes',
      'no composition changes',
      'no extra objects',
      'no new elements',
      'no 3D volume',
      'no gradients',
      'no realistic materials',
      'keep same lighting',
      'keep same line weights'
    ].join(', ');

    // Parámetros por modo
    const modeCfg = (mode === 'fast')
      ? { guidance: 3.0, steps: Math.min(steps, 28), strength: Math.max(strength, 0.35) }
      : { guidance: 4.0, steps: Math.max(steps, 24), strength: Math.min(strength, 0.25) };

    // Input para Replicate
    const input = {
      prompt: fullPrompt,
      image: imageUrl,
      negative_prompt: neg,
      num_inference_steps: modeCfg.steps,
      guidance: modeCfg.guidance,
      strength: modeCfg.strength
    };
    if (seed !== undefined && !Number.isNaN(seed)) input.seed = seed;

    console.log('==> Replicate create', { model, version, mode, strength: input.strength, steps: input.num_inference_steps });

    const pred  = await createPrediction({ modelVersion: version, input });
    const final = await waitForPrediction(pred.id);

    if (final.status !== 'succeeded') {
      console.error('[replicate-proxy] failed:', final?.error || final?.logs || final?.status);
      return res.status(502).json({ ok: false, msg: `Generation failed: ${final.status}`, logs: final.logs || null, error: final.error || null });
    }

    const outArr = Array.isArray(final.output) ? final.output : [final.output].filter(Boolean);
    if (!outArr.length) return res.status(502).json({ ok: false, msg: 'No output image URLs' });

    const url0   = outArr[0];
    const imgBuf = await fetchAsBuffer(url0);
    const b64    = imgBuf.toString('base64');

    return res.json({
      ok: true,
      image: `data:image/png;base64,${b64}`,
      engine: 'replicate',
      model,
      version,
      strength: input.strength,
      steps: input.num_inference_steps
    });
  } catch (err) {
    const det = err?.response?.data || err?.message || err;
    console.error('[replicate-proxy] error:', det);
    // 422: "Invalid version or not permitted" → version id incorrecta
    // 404: "The requested resource could not be found" → version inexistente
    return res.status(500).json({ ok: false, msg: 'Proxy error', error: String(err?.message || err) });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('////////////////////////////////////////////////////////////');
  console.log('==> NovaAI Replicate proxy running on port', PORT);
  console.log('==> Default model:', DEFAULT_MODEL);
  console.log('==> Default version:', DEFAULT_VERSION);
  console.log('==> Public base:', PUBLIC_BASE || '(set PUBLIC_BASE_URL!)');
  console.log('==> Allowed origins:', ALLOW.length ? ALLOW.join(', ') : '(* open *)');
  console.log('////////////////////////////////////////////////////////////');
});

// ────────────────────────────────────────────────────────────────────────────────
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function clampInt(n, min, max) {
  const v = Number.isFinite(n) ? Math.round(n) : min;
  return Math.max(min, Math.min(max, v));
}
