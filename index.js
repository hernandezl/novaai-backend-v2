// index.js
import express from "express";
import cors from "cors";
import Replicate from "replicate";

// ---------- Config ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

const PORT = process.env.PORT || 3000;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Modelos
const FLUX_RASTER    = "black-forest-labs/flux-schnell";   // fallback raster
const VECTORIZER     = "methexis-inc/img2svg";             // raster->SVG alta fidelidad
const RECRAFT_VECTOR = "recraft-ai/recraft-20b-svg";       // texto->SVG fallback

// ---------- Helpers ----------
const isDataUrl = s => typeof s === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s);

async function dataUrlToBlob(dataUrl) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1];
  const b64  = m[2];
  const buf  = Buffer.from(b64, "base64");
  return { mime, buf, ext: mime.split("/")[1] || "png" };
}
async function urlToBlob(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  const mime = r.headers.get("content-type") || "image/png";
  const buf  = Buffer.from(await r.arrayBuffer());
  return { mime, buf, ext: mime.split("/")[1] || "png" };
}
async function refToBlob(ref) {
  if (!ref) return null;
  if (isDataUrl(ref)) return await dataUrlToBlob(ref);
  return await urlToBlob(ref);
}

function buildLockedPrompt({ figure, t1, t2, basePrompt = "" }) {
  const parts = [];
  if (figure) parts.push(`Change only the main figure to: "${figure}".`);
  if (t1 || t2) {
    const lines = [t1, t2].filter(Boolean).map(v => `"${v}"`).join(", ");
    parts.push(`Update visible text to: ${lines}.`);
  }
  if (basePrompt) parts.push(basePrompt);
  parts.push(
    "Keep the original STYLE exactly: line weight, color palette, materials, lighting, reflections, background, camera and composition.",
    "Do NOT change thickness of strokes, colors, shadows or layout.",
    "Apply edits only where necessary to update the requested figure/text."
  );
  return parts.join(" ");
}

function svgReplaceText(svgString, newLines = []) {
  try {
    if (!svgString || !newLines?.length) return svgString;
    let idx = 0;
    const out = svgString.replace(/(<text[^>]*>)([\s\S]*?)(<\/text>)/g, (_m, open, _content, close) => {
      const line = newLines[idx++] ?? null;
      if (!line) return _m;
      const safe = String(line).replace(/[<&>]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]));
      return `${open}${safe}${close}`;
    });
    return out;
  } catch { return svgString; }
}

// ---------- Health ----------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "NovaAI Backend (Style-locked)",
    raster: `openai:edits/variations → fallback ${FLUX_RASTER}`,
    vector: `${VECTORIZER} → fallback ${RECRAFT_VECTOR}`,
    node: process.version,
    port: Number(PORT),
  });
});

// ---------- Generate ----------
/**
 * body: {
 *   prompt?: string,
 *   ref?: string (dataURL o URL),
 *   mask?: string (dataURL o URL, PNG),
 *   strict?: boolean,
 *   strength?: number,
 *   figure?: string,
 *   text1?: string,
 *   text2?: string,
 *   font?: string,
 *   colors?: Record<string,string>,
 *   notes?: string,
 *   meta?: { title?, source?, product_id?, category? }
 * }
 */
app.post("/api/generate", async (req, res) => {
  const promptRaw = (req.body?.prompt || "").trim();
  const ref       = req.body?.ref   || null;
  const mask      = req.body?.mask  || null;
  const strict    = (req.body?.strict === undefined) ? true : !!req.body?.strict;
  const strength  = Math.max(0.1, Math.min(1.0, Number(req.body?.strength || 0.9)));

  const figure = (req.body?.figure || "").trim();
  const text1  = (req.body?.text1  || "").trim();
  const text2  = (req.body?.text2  || "").trim();

  const font   = (req.body?.font   || "").trim();
  const colors = req.body?.colors || {};
  const notes  = (req.body?.notes  || "").trim();

  const meta   = req.body?.meta  || null;

  const replicate = REPLICATE_API_TOKEN ? new Replicate({ auth: REPLICATE_API_TOKEN }) : null;

  const used = {
    raster_primary: null,
    raster_fallback: null,
    vector_primary: null,
    vector_fallback: null,
    ref: !!ref,
    strict,
    strength,
    figure: !!figure,
    text: !!(text1 || text2),
  };

  // 0) Clon 1:1 → si hay ref y NO prompt/mask/figure/text
  if (ref && !promptRaw && !mask && !figure && !text1 && !text2) {
    let ownerFrom = ref;
    let ownerUrl = null;

    try {
      if (!replicate) throw new Error("Missing REPLICATE_API_TOKEN");
      const vec = await replicate.run(VECTORIZER, { input: { image: ownerFrom } });
      used.vector_primary = VECTORIZER;
      if (Array.isArray(vec) && vec.length) ownerUrl = vec[0];
      else if (typeof vec === "string") {
        const svg = vec.trim();
        if (svg.startsWith("<svg")) {
          const b64 = Buffer.from(svg, "utf-8").toString("base64");
          ownerUrl = `data:image/svg+xml;base64,${b64}`;
        } else ownerUrl = svg;
      }
    } catch (e) {
      console.warn("[img2svg clone] failed:", e?.message || e);
    }

    if (!ownerUrl && replicate) {
      try {
        const out = await replicate.run(RECRAFT_VECTOR, { input: { prompt: "Vectorize this product exactly, laser-friendly." } });
        used.vector_fallback = RECRAFT_VECTOR;
        if (Array.isArray(out) && out.length) ownerUrl = out[0];
        else if (typeof out === "string") ownerUrl = out;
      } catch {}
    }

    return res.json({
      ok: true,
      owner: ownerUrl || ref || null,
      customer: ref,
      used,
      title: meta?.title || "Cloned",
      base_from: "reference",
      meta_echo: { font, colors, notes, product_id: meta?.product_id, category: meta?.category }
    });
  }

  // 1) Prompt “style-locked”
  const locked = buildLockedPrompt({ figure, t1: text1, t2: text2, basePrompt: promptRaw });

  let customerUrl = null;
  let ownerUrl    = null;

  try {
    // 2) Raster con OpenAI si hay ref
    if (OPENAI_API_KEY && ref) {
      try {
        const refBlob = await refToBlob(ref);
        if (!refBlob) throw new Error("Cannot read reference image.");

        const fd = new FormData();
        const effectivePrompt = locked || "Apply minimal edits strictly to subject/text, keep style identical.";
        fd.append("prompt", effectivePrompt);
        fd.append("n", "1");
        fd.append("size", "1024x1024");

        let openaiUrl = "https://api.openai.com/v1/images/variations";
        fd.append("image", new Blob([refBlob.buf], { type: refBlob.mime }), `reference.${refBlob.ext}`);

        if (mask || strict) {
          openaiUrl = "https://api.openai.com/v1/images/edits";
          if (mask) {
            const maskBlob = await refToBlob(mask);
            if (maskBlob) {
              fd.append("mask", new Blob([maskBlob.buf], { type: maskBlob.mime }), `mask.${maskBlob.ext}`);
            }
          }
        }

        const oa = await fetch(openaiUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
          body: fd
        });

        const j = await oa.json();
        if (!oa.ok) throw new Error(j?.error?.message || "OpenAI image edit/variation failed");
        customerUrl = j?.data?.[0]?.url || null;
        used.raster_primary = openaiUrl.includes("edits") ? "openai:images/edits" : "openai:images/variations";
      } catch (e) {
        console.warn("[OpenAI raster] failed:", e?.message || e);
      }
    }

    // 3) Fallback raster con Replicate (FLUX)
    if (!customerUrl && replicate) {
      try {
        const out = await replicate.run(FLUX_RASTER, {
          input: {
            prompt: (ref ? `${locked} Use the reference image as exact base.` : locked),
            // guidance / steps opcionales según plan
          }
        });
        if (Array.isArray(out) && out.length) customerUrl = out[0];
        else if (typeof out === "string") customerUrl = out;
        used.raster_fallback = FLUX_RASTER;
      } catch (e) {
        console.warn("[FLUX raster] failed:", e?.message || e);
      }
    }

    // 4) OWNER (vector) ⇒ vectoriza raster final; si no hay, usa ref
    const inputForVector = customerUrl || ref || null;
    if (inputForVector && replicate) {
      try {
        const vec = await replicate.run(VECTORIZER, { input: { image: inputForVector } });
        used.vector_primary = VECTORIZER;
        if (Array.isArray(vec) && vec.length) ownerUrl = vec[0];
        else if (typeof vec === "string") {
          const svg = vec.trim();
          if (svg.startsWith("<svg")) {
            const svg2 = svgReplaceText(svg, [text1, text2].filter(Boolean));
            const b64 = Buffer.from(svg2, "utf-8").toString("base64");
            ownerUrl = `data:image/svg+xml;base64,${b64}`;
          } else ownerUrl = svg;
        }
      } catch (e) {
        console.warn("[img2svg] failed:", e?.message || e);
      }
    }

    if (!ownerUrl && replicate) {
      try {
        const out = await replicate.run(RECRAFT_VECTOR, { input: { prompt: `Exact vector in original style. ${locked}` } });
        used.vector_fallback = RECRAFT_VECTOR;
        if (Array.isArray(out) && out.length) ownerUrl = out[0];
        else if (typeof out === "string") ownerUrl = out;
      } catch (e) {
        console.warn("[recraft svg] failed:", e?.message || e);
      }
    }

    if (!ownerUrl && !customerUrl) throw new Error("No output from providers.");

    res.json({
      ok: true,
      owner: ownerUrl || null,
      customer: customerUrl || null,
      used,
      title: meta?.title || "Generated",
      base_from: meta?.source || (ref ? "reference" : "prompt"),
      meta_echo: { font, colors, notes, product_id: meta?.product_id, category: meta?.category }
    });
  } catch (err) {
    console.error("[/api/generate] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Backend ready on http://localhost:${PORT}`);
});
