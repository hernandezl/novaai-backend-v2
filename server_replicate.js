// server_replicate.js
// NovaAI Proxy -> Replicate (img2img con enfoque en fidelidad y negativos guiados)
//
// Endpoints:
//   GET  /api/health
//   POST /api/generate
//
// Entrada (multipart o JSON):
//   - file (multipart)  -> imagen de referencia (prioritario si existe)
//   - ref (dataURL o https) -> referencia si no hay file
//   - prompt (string)  -> instrucciones del usuario (secundario; la imagen guía domina)
//   - negative (string opcional) -> negativos extra
//   - strength (0..1)  -> qué tanto altera la imagen (0 = muy fiel, 1 = libre). Por defecto 0.20 si hay imagen
//   - steps (12..50)   -> num_inference_steps
//   - seed (int opcional)
//   - model (opcional) -> uno de las claves de MODEL_VERSIONS (si no, usa DEFAULT_MODEL)
//
// .env (Render):
//   REPLICATE_API_TOKEN= r8_*************************
//   CORS_ORIGIN= https://negunova.com,http://localhost:5560
//   PUBLIC_BASE_URL= https://novaai-backend-v2.onrender.com
//   DEFAULT_MODEL= black-forest-labs/flux-kontext-pro
//   MAX_POLL_MS=120000
//   POLL_INTERVAL=2500

import express from 'express';
import multer from 'multer';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import os from 'os';

dotenv.config();

// ===== Config =====
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

const PORT = Number(process.env.PORT || 3001);
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || '';
const CORS = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : true;

const MAX_POLL_MS = Number(process.env.MAX_POLL_MS || 120000);
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 2500);

// Modelo por defecto (por nombre, no por versión)
const DEFAULT_MODEL = (process.env.DEFAULT_MODEL || 'black-forest-labs/flux-kontext-pro').trim();

// ======= IMPORTANTE: Mapa de version IDs (actualízalos si los cambias en Replicate) =======
const MODEL_VERSIONS = {
  // Rápido y estable para previsualización con buena preservación de composición
  'black-forest-labs/flux-kontext-pro':
    'black-forest-labs/flux-kontext-pro:6d13a50de357d44c17c7b15e671b65f13df21eab3ab5f34b5f606193ed1da9b8',

  // Alta calidad realista (más costo/latencia)
  'bytedance/seedream-3':
    'bytedance/seedream-3:bb6a4d7cd34e94f184dc84cfe513dd3b9b84c20382b93aa2493acb616ec6f35e',

  // Edición controlada; útil si luego migras a flujos con ControlNet/IP-Adapters
  'qwen/qwen-image-edit':
    'qwen/qwen-image-edit:3e176d0370f0cd89b5c88852b4891d87630e73fa25f3e1dc1a20f43de41b8c72'
};

if (!REPLICATE_API_TOKEN) {
  console.error('FATAL: missing REPLICATE_API_TOKEN');
  process.exit(1);
}
if (!PUBLIC_BASE) {
  console.warn('WARN: PUBLIC_BASE_URL not set. /tmp images won’t be fetchable from Replicate.');
}

// ===== Middlewares =====
app.use(cors({ origin: CORS, credentials: false }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ===== /tmp público para que Replicate pueda descargar la imagen de referencia =====
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
  const m = /^data:(.+?);base64,(.+)$/.exec(uri || '');
  if (!m) throw new Error('Invalid data URI');
  return Buffer.from(m[2], 'base64');
}

// ===== Helpers Replicate =====
async function createPrediction(version, input) {
  const resp = await axios.post(
    'https://api.replicate.com/v1/predictions',
    { version, input },
    {
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 20000
    }
  );
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

// ===== API =====
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    engine: 'replicate',
    default_model: DEFAULT_MODEL,
    version: MODEL_VERSIONS[DEFAULT_MODEL] || null,
    public_base: PUBLIC_BASE || null,
    cors: Array.isArray(CORS) ? CORS : '*'
  });
});

// POST /api/generate
app.post('/api/generate', upload.single('file'), async (req, res) => {
  try {
    const body = req.body || {};

    // Elegir modelo: del body o por defecto; siempre traducimos a "version"
    const modelName = (body.model || DEFAULT_MODEL).trim();
    const version = MODEL_VERSIONS[modelName] || MODEL_VERSIONS[DEFAULT_MODEL];
    if (!version) {
      return res.status(400).json({ ok: false, msg: `Unknown model name: ${modelName}` });
    }

    // Prompt usuario (+ guía para no cambiar estilo/composición)
    const userPrompt = (body.prompt || '').toString().trim();
    const font = (body.font || 'DM Sans').toString();

    const guided =
      `Only change the main figure and/or the overlaid texts. ` +
      `Keep the original style, composition, background, lighting and line weights exact. ` +
      `Use font: ${font}.`;

    const fullPrompt = userPrompt ? `${guided} Instructions: ${userPrompt}` : guided;

    // Negativos predeterminados + agregados del usuario
    const negativesDefault = [
      'no background changes',
      'no layout changes',
      'no composition changes',
      'no extra objects',
      'no new elements',
      'no 3D volume',
      'no gradients',
      'no realistic materials',
      'keep same lighting',
      'keep same line weights',
      'no style drift'
    ].join(', ');

    const negative = (body.negative || '').toString().trim();
    const negative_prompt = negative ? `${negativesDefault}, ${negative}` : negativesDefault;

    // Strength/steps/seed
    const steps = Math.max(12, Math.min(50, parseInt(body.steps || 28, 10)));
    const seed = body.seed ? Number(body.seed) : undefined;

    // Resolver referencia: prioriza archivo subido
    let imageUrl = null;
    if (req.file) {
      const tmp = saveImageAndGetUrl(req.file.buffer);
      imageUrl = tmp.url;
    } else if (body.ref && /^data:/.test(body.ref)) {
      const buf = dataUriToBuffer(body.ref);
      const tmp = saveImageAndGetUrl(buf);
      imageUrl = tmp.url;
    } else if (body.ref && /^https?:\/\//i.test(body.ref)) {
      const buf = await fetchAsBuffer(body.ref);
      const tmp = saveImageAndGetUrl(buf);
      imageUrl = tmp.url;
    }

    // strength: si hay imagen, por defecto 0.20 (muy fiel). Si no hay imagen, 1.0
    const hasImage = !!imageUrl;
    const strength = Math.max(0, Math.min(1, Number(body.strength !== undefined ? body.strength : (hasImage ? 0.20 : 1.0))));

    // Construir input estándar para modelos img2img en Replicate
    const input = {
      prompt: fullPrompt,
      negative_prompt,
      num_inference_steps: steps,
      guidance: 3.5
    };
    if (hasImage) input.image = imageUrl;
    if (hasImage) input.strength = strength;
    if (seed !== undefined && !Number.isNaN(seed)) input.seed = seed;

    // Invocar
    const pred = await createPrediction(version, input);
    const final = await waitForPrediction(pred.id);

    if (final.status !== 'succeeded') {
      console.error('[replicate-proxy] generation failed:', final);
      return res.status(502).json({
        ok: false,
        msg: `Generation failed: ${final.status}`,
        logs: final.logs || null
      });
    }

    // Salida: array de URLs -> devolvemos la primera como dataURL para el frontend
    const outArr = Array.isArray(final.output) ? final.output : [final.output].filter(Boolean);
    if (!outArr.length) {
      return res.status(502).json({ ok: false, msg: 'No output image URLs' });
    }
    const firstUrl = outArr[0];
    const imgBuf = await fetchAsBuffer(firstUrl);
    const b64 = imgBuf.toString('base64');

    return res.json({
      ok: true,
      image: `data:image/png;base64,${b64}`,
      used: {
        model: modelName,
        version,
        steps,
        strength: hasImage ? strength : undefined
      }
    });
  } catch (err) {
    const detail = err?.response?.data || err?.message || String(err);
    console.error('[replicate-proxy] error:', detail);
    res.status(500).json({ ok: false, msg: 'Proxy error', error: detail });
  }
});

app.listen(PORT, () => {
  console.log('//////////////////////////////////////////////////////////');
  console.log('NovaAI Replicate proxy listening on port', PORT);
  console.log('Default model:', DEFAULT_MODEL);
  console.log('Public base:', PUBLIC_BASE || '(missing PUBLIC_BASE_URL!)');
  console.log('CORS origin:', Array.isArray(CORS) ? CORS.join(', ') : '*');
  console.log('//////////////////////////////////////////////////////////');
});
