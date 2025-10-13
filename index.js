// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import FormData from "form-data";
import Replicate from "replicate";

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Modelos
const VECTOR_MODEL = "recraft-ai/recraft-20b-svg";        // owner (vector) - text model
const FLUX_I2I      = "black-forest-labs/flux-schnell";   // fallback img2img (raster)

// Helpers
const isDataUrl = s => typeof s === "string" && /^data:image\/[a-zA-Z]+;base64,/.test(s);
const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0));

// Descarga una URL o DataURL a Buffer
async function getImageBuffer(urlOrData) {
  if (!urlOrData) return null;
  if (isDataUrl(urlOrData)) {
    const base64 = urlOrData.split(",")[1] || "";
    return Buffer.from(base64, "base64");
  }
  const r = await fetch(urlOrData);
  if (!r.ok) throw new Error(`fetch ref ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "NovaAI Backend (Style-locked)",
    port: Number(PORT),
    vector_model: VECTOR_MODEL,
    raster_model: `openai:edits (fallback ${FLUX_I2I})`,
  })
);

/**
 * POST /api/generate
 * body:
 * {
 *   prompt?: string,
 *   ref?: string (url o dataURL),
 *   mask?: string (url o dataURL PNG con transparencia),
 *   strict?: boolean,          // true = preservar estilo/composición
 *   strength?: number,         // 0..1 (0 = máxima preservación)
 *   meta?: { title? }
 * }
 */
app.post("/api/generate", async (req, res) => {
  const promptRaw = (req.body?.prompt || "").trim();
  const ref = req.body?.ref || null;
  const mask = req.body?.mask || null;
  const strict = !!req.body?.strict;
  // Interpretación: strength=0.0 preserva al máximo; 1.0 cambia más
  const strength = clamp01(req.body?.strength ?? 0.15); // por defecto muy conservador
  const meta = req.body?.meta || null;

  // Si hay referencia y NO hay prompt -> eco exacto (tal cual)
  if (ref && !promptRaw) {
    return res.json({
      ok: true,
      owner: ref,
      customer: ref,
      base_from: "reference",
      used: "echo",
      title: meta?.title || "Reference",
      meta_echo: { strict, strength }
    });
  }

  // Prompts afinados para preservar estilo
  const preservePreamble = strict
    ? "Keep the original style, lighting, camera, materials, color palette and composition EXACTLY the same. Only modify the requested figure and/or text. Do not change background, base, pose, or framing."
    : "Match the product theme; keep a clean studio look.";

  const customerPrompt = `${preservePreamble}\n${promptRaw || "Produce a realistic studio product photo."}`;

  const replicate = REPLICATE_API_TOKEN ? new Replicate({ auth: REPLICATE_API_TOKEN }) : null;

  let ownerUrl = null;
  let customerUrl = null;

  try {
    // ===== CUSTOMER (raster) : prefer OpenAI 'edits' cuando hay ref o strict =====
    if (OPENAI_API_KEY && (ref || strict)) {
      try {
        const fd = new FormData();
        // Imagen base (si no hay ref pero strict=true, fallará; lo chequeamos)
        if (!ref) throw new Error("strict mode requires a reference image");
        const baseBuf = await getImageBuffer(ref);
        fd.append("image", baseBuf, { filename: "base.png", contentType: "image/png" });

        // Máscara opcional: píxeles transparentes = ÁREA A EDITAR (OpenAI rule)
        if (mask) {
          const maskBuf = await getImageBuffer(mask);
          fd.append("mask", maskBuf, { filename: "mask.png", contentType: "image/png" });
        } else {
          // Sin máscara: instrucción muy conservadora + baja fuerza textual
          // OpenAI 'edits' no expone strength; imitamos usando prosa y una única muestra
        }

        fd.append("model", "gpt-image-1");
        fd.append("prompt", customerPrompt);
        fd.append("size", "1024x1024");
        // Puedes añadir 'background':'transparent' si tu plan lo permite.

        const r = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
          body: fd,
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error?.message || `openai edits ${r.status}`);
        customerUrl = j?.data?.[0]?.url || null;
      } catch (e) {
        console.warn("[openai edits] fail, fallback flux:", e.message);
      }
    }

    // Fallback raster con FLUX img2img (si hay ref se respeta via strength)
    if (!customerUrl && replicate) {
      const input = ref
        ? { prompt: customerPrompt, image: ref, strength: 1 - Math.max(0.01, 1 - strength * 3) } // invertir lógica para este modelo
        : { prompt: customerPrompt };
      const out = await replicate.run(FLUX_I2I, { input });
      if (Array.isArray(out) && out.length) customerUrl = out[0];
      else if (typeof out === "string") customerUrl = out;
    }

    // ===== OWNER (vector) : si hay ref y no queremos inventar, eco; si no, Recraft
    if (ref && !promptRaw) {
      ownerUrl = ref;
    } else if (replicate) {
      try {
        const vPrompt =
          `${strict ? "Keep base shapes and layout. " : ""}Clean vector icon, flat solid colors, thick outlines, high contrast. ` +
          (promptRaw || "Vectorize the product design.");
        const v = await replicate.run(VECTOR_MODEL, { input: { prompt: vPrompt } });
        if (Array.isArray(v) && v.length) ownerUrl = v[0]; else if (typeof v === "string") ownerUrl = v;
      } catch (e) {
        console.warn("[recraft vector] fail:", e.message);
      }
    }

    // Si sigue vacío, al menos devuelve algo coherente
    if (!ownerUrl && ref) ownerUrl = ref;
    if (!customerUrl && ref) customerUrl = ref;

    if (!ownerUrl && !customerUrl) throw new Error("no outputs from providers");

    res.json({
      ok: true,
      owner: ownerUrl,
      customer: customerUrl,
      title: meta?.title || "Generated",
      base_from: ref ? "reference" : "prompt",
      used: OPENAI_API_KEY ? "openai-edits/fallback-flux" : "flux",
      meta_echo: { strict, strength }
    });
  } catch (err) {
    console.error("[/api/generate] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Backend ready on http://localhost:${PORT}`);
});
