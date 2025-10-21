// ---- helpers arriba del todo o junto a otras utils
const ABS_HTTPS = (url, base) => {
  try {
    if (!url) return '';
    if (/^(data|https?):/i.test(url)) return url;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) {
      const u = new URL(base || process.env.PUBLIC_BASE || 'https://www.negunova.com/');
      return u.origin + url;
    }
    // cualquier otra cosa: lo tratamos como relativo a base
    const u = new URL(base || process.env.PUBLIC_BASE || 'https://www.negunova.com/');
    return new URL(url, u.origin + '/').href.replace(/^http:/, 'https:');
  } catch {
    return url;
  }
};

function pickRef(body){
  // acepta múltiples nombres
  const raw =
    body?.ref ??
    body?.image ??
    body?.image_url ??
    body?.input?.image ??
    '';
  return (raw ?? '').toString().trim();
}

// ---- endpoint de diagnóstico (déjalo)
app.post('/api/echo', express.json(), (req, res) => {
  const raw = pickRef(req.body);
  const ref = ABS_HTTPS(raw, process.env.PUBLIC_BASE);
  return res.json({
    ok: true,
    received: { raw, ref, len: ref?.length || 0, startsWith: ref?.slice(0, 32) || '' },
    hint: 'ref debe empezar con https:// o data: . blob:/idb: no sirven en el servidor.'
  });
});

// ---- en /api/generate, justo al empezar
app.post('/api/generate', express.json({ limit: '12mb' }), async (req, res) => {
  try {
    const { model, prompt, font, strength, steps } = req.body || {};
    const rawRef = pickRef(req.body);
    const ref = ABS_HTTPS(rawRef, process.env.PUBLIC_BASE);

    // logs claros
    console.log('[generate] rawRef=', rawRef);
    console.log('[generate] ref=', ref, 'len=', (ref || '').length, 'head=', (ref || '').slice(0, 40));

    // validación + mensaje útil
    if (!ref || !/^(https:|data:)/i.test(ref)) {
      return res.status(400).json({
        ok: false,
        status: 400,
        msg: 'Missing or invalid reference image',
        server_saw: { rawRef, ref, len: (ref || '').length, startsWith: (ref || '').slice(0, 32) },
        fix: 'Envía un dataURL (data:image/...) o una URL https pública. Rutas relativas/bloc/idb no sirven.'
      });
    }

    // ... aquí ya llamas a tu función de Replicate con {model, ref, prompt, ...}
    // const outputUrl = await runReplicate({ model, ref, prompt, font, strength, steps });
    // return res.json({ ok: true, output: outputUrl });

  } catch (e) {
    console.error('[generate] error:', e);
    return res.status(500).json({ ok: false, status: 500, msg: 'proxy error', error: String(e?.message || e) });
  }
});
