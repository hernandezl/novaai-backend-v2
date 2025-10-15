// server.js (CommonJS)
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const app = express();
app.use(cors({
  origin: ['https://negunova.com', 'http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
}));
app.use(express.json({ limit: '20mb' }));

// Salud
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), node: process.version });
});

// Helper: llamada simple a OpenAI Images
async function generateCustomerImage({ prompt, size = '1024x1024', image_base64 }) {
  if (!OPENAI_API_KEY) {
    return { __ok: false, error: { code: 'no_api_key', message: 'OPENAI_API_KEY faltante' } };
  }
  const payload = { model: 'gpt-image-1', prompt, size };
  if (image_base64) payload.image = image_base64;

  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => null);
  return { __ok: r.ok, __status: r.status, data };
}

// API principal, compatible con tu flujo previo
app.post('/api/generate', async (req, res) => {
  const body = req.body || {};
  const {
    prompt,
    mode = 'customer', // 'owner' | 'customer' | 'both'
    params = {},
    image_base64
  } = body;

  // Fallback básico por si viene sin prompt (similar a tu PHP)
  function fallbackPromptFromPayload(b) {
    const p = b.product || {};
    const parts = [];
    if (p.category || p.name) parts.push(`Product mockup for laser/acrylic: ${p.category || ''} ${p.name || ''}`.trim());
    if (b.color) parts.push(`dominant color: ${b.color}`);
    const t1 = (b.text1 || '').trim(); const t2 = (b.text2 || '').trim();
    if (t1 || t2) parts.push(`include the text: "${`${t1} ${t2}`.trim()}"`);
    return parts.join('. ') || '';
  }

  let finalPrompt = (prompt || '').trim();
  if (!finalPrompt) finalPrompt = fallbackPromptFromPayload(body);
  if (!finalPrompt) {
    return res.status(400).json({ ok: false, error: { code: 'prompt_required', message: 'Se requiere prompt o datos de producto.' } });
  }

  // Owner aún no implementado aquí (vector). Devuelve placeholder.
  if (mode === 'owner') {
    return res.status(501).json({ ok: false, error: { code: 'owner_not_implemented', message: 'Owner (vector) no cableado en este backend.' } });
  }

  if (mode === 'customer' || mode === 'both') {
    const out = await generateCustomerImage({
      prompt: finalPrompt,
      size: params.size || '1024x1024',
      image_base64
    });

    if (!out.__ok) {
      return res.status(out.__status || 500).json({ ok: false, error: out.data?.error || out.error || { code: 'openai_error' } });
    }

    // Devuelve en un formato cómodo
    const img = out.data?.data?.[0] || null;
    const result = {
      ok: true,
      mode,
      customer: img ? (img.b64_json ? { b64_json: img.b64_json } : { url: img.url }) : null,
      // owner: null // (por ahora)
    };
    return res.status(200).json(result);
  }

  return res.status(400).json({ ok: false, error: { code: 'bad_mode', message: `Modo no reconocido: ${mode}` } });
});

// (Opcional) Sirve estáticos si mueves frontend aquí
app.use(express.static('public'));

app.listen(PORT, () => {
  console.log(`NovaAI backend listening on :${PORT}`);
});
