// index.js — NovaAI Backend (Render-ready)
// Runtime: Node 18+ | ESM
import 'dotenv/config.js';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import Replicate from 'replicate';
import fetch from 'node-fetch';

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT         = process.env.PORT || 3000;
const BASE_URL     = process.env.BASE_URL || ''; // ej: https://novaai-backend-v2.onrender.com
const OUT_DIR      = path.join(__dirname, 'outputs');

const VECTOR_MODEL = process.env.REPLICATE_VECTOR_MODEL || 'recraft-ai/recraft-20b-svg';
const RASTER_MODEL = process.env.REPLICATE_RASTER_MODEL || 'black-forest-labs/flux-schnell';
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

if (!REPLICATE_API_TOKEN) {
  console.error('[NovaAI] FALTA REPLICATE_API_TOKEN en .env');
  process.exit(1);
}
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// ────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // soporta image_base64
app.use('/outputs', express.static(OUT_DIR, { maxAge: '30d', fallthrough: true }));

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function todayDir() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(OUT_DIR, `${y}-${m}-${day}`);
}

function sanitizeName(s = '') {
  return String(s).toLowerCase()
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
}

async function saveContentAsFile(baseName, ext, contentOrUrl) {
  const dir = todayDir();
  await ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.Z\-T]/g, '').slice(0, 14);
  const file = `${sanitizeName(baseName)}_${stamp}.${ext}`;
  const full = path.join(dir, file);

  let buf;
  if (typeof contentOrUrl === 'string' && contentOrUrl.startsWith('http')) {
    const r = await fetch(contentOrUrl);
    buf = Buffer.from(await r.arrayBuffer());
  } else if (typeof contentOrUrl === 'string' && contentOrUrl.startsWith('data:')) {
    const b64 = contentOrUrl.split(',')[1] || '';
    buf = Buffer.from(b64, 'base64');
  } else if (typeof contentOrUrl === 'string' && ext === 'svg') {
    buf = Buffer.from(contentOrUrl, 'utf8');
  } else if (Buffer.isBuffer(contentOrUrl)) {
    buf = contentOrUrl;
  } else {
    throw new Error('saveContentAsFile: tipo no soportado');
  }

  await fs.writeFile(full, buf);
  // URL pública (si BASE_URL está configurado la usaremos, si no, dejaremos relativa)
  const pub = (BASE_URL ? `${BASE_URL}` : '') + `/outputs/${path.basename(path.dirname(full))}/${file}`;
  return { full, public_url: pub };
}

function normalizeAny(any) {
  // Intenta extraer la primera imagen (url/data/svg)
  const tryStr = (s) => {
    if (!s) return null;
    if (typeof s !== 'string') return null;
    if (s.startsWith('data:image/')) return s;
    if (/^https?:\/\/.*\.(png|jpg|jpeg|webp|svg)(\?.*)?$/i.test(s)) return s;
    if (s.trim().startsWith('<svg')) {
      const b64 = Buffer.from(s, 'utf8').toString('base64');
      return `data:image/svg+xml;base64,${b64}`;
    }
    return null;
  };

  const dfs = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return tryStr(v);
    if (Array.isArray(v)) {
      for (const x of v) { const r = dfs(x); if (r) return r; }
    } else if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const maybe = tryStr(v[k]);
        if (maybe) return maybe;
      }
      for (const k of Object.keys(v)) {
        const r = dfs(v[k]); if (r) return r;
      }
    }
    return null;
  };

  return dfs(any);
}

// ────────────────────────────────────────────────────────────────────────────
// Replicate calls
// ────────────────────────────────────────────────────────────────────────────
async function generateVector({ prompt, negative, params, image_base64 }) {
  // Recraft 20B SVG
  const width     = params?.width     ?? 1024;
  const height    = params?.height    ?? 1024;
  const guidance  = params?.guidance  ?? 7.5;
  const steps     = params?.steps     ?? 40;

  const input = {
    prompt,
    negative_prompt: negative || undefined,
    width,
    height,
    guidance,
    num_inference_steps: steps,
    output_format: 'svg'
  };
  if (image_base64) {
    input.image = `data:image/png;base64,${image_base64}`; // la API acepta data-url
    input.strength = params?.strength ?? 0.65;
  }

  const out = await replicate.run(VECTOR_MODEL, { input });
  // La salida puede ser: SVG string, URL o estructura. Normalizamos.
  const img = normalizeAny(out) || out;
  if (!img) throw new Error('Vector model returned empty result');
  return { kind: 'vector', raw: out, image: img };
}

async function generateRealistic({ prompt, negative, params, image_base64 }) {
  // Flux Schnell (raster)
  const width     = params?.width     ?? 1024;
  const height    = params?.height    ?? 1024;
  const guidance  = params?.guidance  ?? 1.5; // suele ser bajo en flux
  const steps     = params?.steps     ?? 12;

  const input = {
    prompt,
    guidance,
    num_inference_steps: steps,
    width,
    height
  };
  if (negative) input.negative_prompt = negative;
  if (image_base64) input.image = `data:image/png;base64,${image_base64}`;

  const out = await replicate.run(RASTER_MODEL, { input });
  // Normalmente es array de URLs
  const img = normalizeAny(out) || (Array.isArray(out) ? out[0] : null);
  if (!img) throw new Error('Raster model returned empty result');
  return { kind: 'real', raw: out, image: img };
}

// ────────────────────────────────────────────────────────────────────────────
// Endpoints
// ────────────────────────────────────────────────────────────────────────────

// Health
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'NovaAI Node',
    port: Number(PORT),
    base_url: BASE_URL || null,
    vector_model: VECTOR_MODEL,
    raster_model: RASTER_MODEL || null,
  });
});

// Lista simple de salidas
app.get('/list', async (_req, res) => {
  await ensureDir(OUT_DIR);
  const days = await fs.readdir(OUT_DIR).catch(() => []);
  const items = [];
  for (const d of days.sort().reverse()) {
    const p = path.join(OUT_DIR, d);
    const stats = await fs.stat(p).catch(() => null);
    if (!stats?.isDirectory()) continue;
    const files = await fs.readdir(p).catch(() => []);
    for (const f of files) {
      items.push({
        file: f,
        day: d,
        url: (BASE_URL ? `${BASE_URL}` : '') + `/outputs/${d}/${f}`
      });
    }
  }
  res.json({ count: items.length, items });
});

// Adaptador para el frontend (no obliga a guardar en disco)
app.post('/api/generate', async (req, res) => {
  try {
    const { target = 'owner', prompt, negative, params, image_base64 } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing prompt' });
    }

    if (target === 'owner') {
      const r = await generateVector({ prompt, negative, params, image_base64 });
      return res.json({ owner_image: r.image, customer_image: null });
    } else if (target === 'customer') {
      const r = await generateRealistic({ prompt, negative, params, image_base64 });
      return res.json({ owner_image: null, customer_image: r.image });
    } else {
      return res.status(400).json({ error: 'Invalid target. Use "owner" or "customer".' });
    }
  } catch (e) {
    console.error('[api/generate] error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Endpoint que guarda archivo en /outputs (útil para tus tests/scripts)
app.post('/generate', async (req, res) => {
  try {
    const {
      target = 'vector',
      prompt,
      negative_prompt,
      steps,
      guidance,
      width,
      height,
      image_base64,
    } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing prompt' });
    }

    const params = {
      steps: Number(steps) || undefined,
      guidance: Number(guidance) || undefined,
      width: Number(width) || undefined,
      height: Number(height) || undefined
    };

    let result;
    if (target === 'vector') {
      result = await generateVector({
        prompt,
        negative: negative_prompt,
        params,
        image_base64
      });
      // Guardar SVG/URL
      const saved = await saveContentAsFile(prompt, 'svg', result.image);
      return res.json({
        model: VECTOR_MODEL,
        target,
        prompt,
        source_url: result.image,
        public_url: saved.public_url
      });
    } else if (target === 'real' || target === 'customer') {
      result = await generateRealistic({
        prompt,
        negative: negative_prompt,
        params,
        image_base64
      });
      // Guardar PNG (si viene url/data/svg se descargará como binario)
      const saved = await saveContentAsFile(prompt, 'png', result.image);
      return res.json({
        model: RASTER_MODEL,
        target,
        prompt,
        source_url: result.image,
        public_url: saved.public_url
      });
    } else {
      return res.status(400).json({ error: 'Invalid target. Use "vector" or "customer/real".' });
    }
  } catch (e) {
    console.error('[generate] error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ────────────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  await ensureDir(OUT_DIR);
  console.log(`✅ Backend listo en http://localhost:${PORT}`);
});
