// index.js — NovaAI Backend (Render-ready, OpenAI + Replicate)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import Replicate from 'replicate';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Config env ─────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const BASE_URL     = process.env.BASE_URL || ''; // ej: https://novaai-backend-v2.onrender.com
const OUT_DIR      = path.join(__dirname, 'outputs');

// Vector (Replicate – Recraft SVG)
const VECTOR_MODEL = process.env.REPLICATE_VECTOR_MODEL || 'recraft-ai/recraft-20b-svg';

// Realista (preferir OpenAI si está la key; si no, Replicate Flux)
const RASTER_MODEL = process.env.REPLICATE_RASTER_MODEL || 'black-forest-labs/flux-schnell';
const OPENAI_KEY   = process.env.OPENAI_API_KEY || null;

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) {
  console.error('[NovaAI] FALTA REPLICATE_API_TOKEN');
  process.exit(1);
}
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use('/outputs', express.static(OUT_DIR, { maxAge: '30d', fallthrough: true }));

// ── Helpers de archivos/urls ──────────────────────────────
async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }
function todayDir(){ const d=new Date(); const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0'); return path.join(OUT_DIR, `${y}-${m}-${day}`); }
function sanitizeName(s=''){ return String(s).toLowerCase().replace(/[^\w\-]+/g,'_').replace(/_+/g,'_').slice(0,80); }

async function saveContentAsFile(baseName, ext, contentOrUrl){
  const dir=todayDir(); await ensureDir(dir);
  const stamp=new Date().toISOString().replace(/[:.Z\-T]/g,'').slice(0,14);
  const file=`${sanitizeName(baseName)}_${stamp}.${ext}`;
  const full=path.join(dir,file);

  let buf;
  if (typeof contentOrUrl==='string' && contentOrUrl.startsWith('http')){
    const r=await fetch(contentOrUrl); buf=Buffer.from(await r.arrayBuffer());
  } else if (typeof contentOrUrl==='string' && contentOrUrl.startsWith('data:')){
    const b64=contentOrUrl.split(',')[1]||''; buf=Buffer.from(b64,'base64');
  } else if (typeof contentOrUrl==='string' && ext==='svg'){
    buf=Buffer.from(contentOrUrl,'utf8');
  } else if (Buffer.isBuffer(contentOrUrl)){
    buf=contentOrUrl;
  } else { throw new Error('saveContentAsFile: tipo no soportado'); }

  await fs.writeFile(full, buf);
  const pub=(BASE_URL?`${BASE_URL}`:'')+`/outputs/${path.basename(path.dirname(full))}/${file}`;
  return { full, public_url: pub };
}

// Encuentra primera imagen (url/data/svg) en cualquier forma
function normalizeAny(any){
  const tryStr=(s)=>{
    if(!s||typeof s!=='string') return null;
    if(s.startsWith('data:image/')) return s;
    if(/^https?:\/\/.*\.(png|jpg|jpeg|webp|svg)(\?.*)?$/i.test(s)) return s;
    if(s.trim().startsWith('<svg')){ const b64=Buffer.from(s,'utf8').toString('base64'); return `data:image/svg+xml;base64,${b64}`; }
    return null;
  };
  const dfs=(v)=>{
    if(!v) return null;
    if(typeof v==='string') return tryStr(v);
    if(Array.isArray(v)){ for(const x of v){ const r=dfs(x); if(r) return r; } }
    else if(typeof v==='object'){
      for(const k of Object.keys(v)){ const maybe=tryStr(v[k]); if(maybe) return maybe; }
      for(const k of Object.keys(v)){ const r=dfs(v[k]); if(r) return r; }
    }
    return null;
  };
  return dfs(any);
}

// ── Model calls ───────────────────────────────────────────
// Vector (Recraft SVG en Replicate)
async function generateVector({ prompt, negative, params, image_base64 }){
  const width=params?.width??1024, height=params?.height??1024;
  const guidance=params?.guidance??7.5, steps=params?.steps??40;
  const input={
    prompt,
    negative_prompt: negative||undefined,
    width, height, guidance,
    num_inference_steps: steps,
    output_format: 'svg'
  };
  if(image_base64){
    input.image = `data:image/png;base64,${image_base64}`;
    input.strength = params?.strength ?? 0.65;
  }
  const out=await replicate.run(VECTOR_MODEL,{ input });
  const img=normalizeAny(out)||out; if(!img) throw new Error('Vector model empty');
  return { kind:'vector', image:img };
}

// Realista con OpenAI si hay key; si no, Replicate Flux
async function generateRealistic({ prompt, negative, params, image_base64 }){
  if(OPENAI_KEY){
    // OpenAI gpt-image-1 — generation o edit
    const size = `${params?.width??1024}x${params?.height??1024}`;
    const fullPrompt = negative ? `${prompt}. Avoid: ${negative}` : prompt;

    if (image_base64){
      // EDIT (img2img) con multipart form
      const formData = new FormData();
      formData.set('model', 'gpt-image-1');
      formData.set('prompt', fullPrompt);
      formData.set('size', size);

      // convertir base64 a Blob
      const b64 = image_base64;
      const bin = Buffer.from(b64, 'base64');
      const blob = new Blob([bin], { type: 'image/png' });
      formData.set('image', blob, 'reference.png');

      const r = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}` },
        body: formData
      });
      if(!r.ok){ throw new Error(`OpenAI edits ${r.status}: ${await r.text()}`); }
      const data=await r.json();
      const img = data?.data?.[0]?.b64_json ? `data:image/png;base64,${data.data[0].b64_json}` : null;
      if(!img) throw new Error('OpenAI edits no image');
      return { kind:'real', image: img };
    } else {
      // GENERATION
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-image-1',
          prompt: fullPrompt,
          size,
          response_format: 'b64_json'
        })
      });
      if(!r.ok){ throw new Error(`OpenAI gen ${r.status}: ${await r.text()}`); }
      const data=await r.json();
      const img = data?.data?.[0]?.b64_json ? `data:image/png;base64,${data.data[0].b64_json}` : null;
      if(!img) throw new Error('OpenAI gen no image');
      return { kind:'real', image: img };
    }
  }

  // Fallback a Replicate Flux
  const width=params?.width??1024, height=params?.height??1024;
  const guidance=params?.guidance??1.5, steps=params?.steps??12;
  const input={ prompt, width, height, guidance, num_inference_steps: steps };
  if(negative) input.negative_prompt = negative;
  if(image_base64) input.image = `data:image/png;base64,${image_base64}`;
  const out=await replicate.run(RASTER_MODEL,{ input });
  const img=normalizeAny(out)||(Array.isArray(out)?out[0]:null);
  if(!img) throw new Error('Flux model empty');
  return { kind:'real', image: img };
}

// ── Endpoints ─────────────────────────────────────────────
app.get('/health', (_req,res)=>res.json({
  ok:true, service:'NovaAI Node',
  port:Number(PORT), base_url:BASE_URL||null,
  vector_model:VECTOR_MODEL, raster_model:OPENAI_KEY?'openai:gpt-image-1':RASTER_MODEL
}));

app.get('/list', async (_req,res)=>{
  await ensureDir(OUT_DIR);
  const days=await fs.readdir(OUT_DIR).catch(()=>[]);
  const items=[];
  for(const d of days.sort().reverse()){
    const p=path.join(OUT_DIR,d);
    const st=await fs.stat(p).catch(()=>null);
    if(!st?.isDirectory()) continue;
    for(const f of await fs.readdir(p).catch(()=>[])){
      items.push({ day:d, file:f, url:(BASE_URL?`${BASE_URL}`:'')+`/outputs/${d}/${f}` });
    }
  }
  res.json({ count:items.length, items });
});

app.post('/api/generate', async (req,res)=>{
  try{
    const { target='owner', prompt, negative, params, image_base64 } = req.body||{};
    if(!prompt) return res.status(400).json({ error:'Missing prompt' });

    if(target==='owner'){
      const r=await generateVector({ prompt, negative, params, image_base64 });
      return res.json({ owner_image:r.image, customer_image:null });
    }
    if(target==='customer'){
      const r=await generateRealistic({ prompt, negative, params, image_base64 });
      return res.json({ owner_image:null, customer_image:r.image });
    }
    return res.status(400).json({ error:'Invalid target (owner|customer)' });
  }catch(e){
    console.error('[api/generate]', e);
    res.status(500).json({ error:String(e.message||e) });
  }
});

app.post('/generate', async (req,res)=>{
  try{
    const { target='vector', prompt, negative_prompt, steps, guidance, width, height, image_base64 } = req.body||{};
    if(!prompt) return res.status(400).json({ error:'Missing prompt' });
    const params={ steps:Number(steps)||undefined, guidance:Number(guidance)||undefined, width:Number(width)||undefined, height:Number(height)||undefined };

    if(target==='vector'){
      const r=await generateVector({ prompt, negative:negative_prompt, params, image_base64 });
      const saved=await saveContentAsFile(prompt,'svg', r.image);
      return res.json({ model:VECTOR_MODEL, target, prompt, source_url:r.image, public_url:saved.public_url });
    } else {
      const r=await generateRealistic({ prompt, negative:negative_prompt, params, image_base64 });
      const saved=await saveContentAsFile(prompt,'png', r.image);
      return res.json({ model:OPENAI_KEY?'openai:gpt-image-1':RASTER_MODEL, target:'real', prompt, source_url:r.image, public_url:saved.public_url });
    }
  }catch(e){
    console.error('[generate]', e);
    res.status(500).json({ error:String(e.message||e) });
  }
});

app.listen(PORT, async ()=>{ await ensureDir(OUT_DIR); console.log(`✅ Backend listo en http://localhost:${PORT}`); });
