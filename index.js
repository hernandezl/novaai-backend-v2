// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // puedes quitar esta línea y usar el fetch global si quieres
import Replicate from "replicate";

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

const PORT = process.env.PORT || 3000;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Modelos (por nombre)
const RECRAFT_VECTOR = "recraft-ai/recraft-20b-svg";        // Fallback vector (texto→SVG)
const FLUX_RASTER    = "black-forest-labs/flux-schnell";    // Fallback raster
const VECTORIZER     = "methexis-inc/img2svg";              // Raster→SVG (alta fidelidad)

// Utils
const isDataUrl = s => typeof s === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s);

async function dataUrlToBlob(dataUrl) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1];
  const b64 = m[2];
  const buf = Buffer.from(b64, "base64");
  return { mime, buf };
}
async function urlToBlob(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  const mime = r.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await r.arrayBuffer());
  return { mime, buf };
}
async function refToBlob(ref) {
  if (!ref) return null;
  if (isDataUrl(ref)) return await dataUrlToBlob(ref);
  return await urlToBlob(ref);
}

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "NovaAI Backend",
    raster: `openai:images/edits (primary) → fallback ${FLUX_RASTER}`,
    vector: `${VECTORIZER} (primary) → fallback ${RECRAFT_VECTOR}`,
    ref_enabled: true,
    port: Number(PORT)
  })
);

/**
 * POST /api/generate
 * body: {
 *   prompt?: string,
 *   ref?: string (dataURL o URL),
 *   strict?: boolean,
 *   strength?: number (0.2-0.9 sugerido, fallback),
 *   meta?: { title?, source? }
 * }
 * resp: { ok, owner, customer, used }
 */
app.post("/api/generate", async (req, res) => {
  const promptRaw = (req.body?.prompt || "").trim();
  const ref       = req.body?.ref || null;
  const strict    = !!req.body?.strict;
  const strength  = Number(req.body?.strength || 0);
  const meta      = req.body?.meta || null;

  const preserveText = ref
    ? "Preserve the original composition, camera/lens, lighting, background and materials. Do not alter the layout or framing."
    : "";

  const ownerPrompt =
    `${preserveText} Clean vector style, flat solid colors, bold thick outlines, high contrast, simplified shapes for laser engraving/cutting. ` +
    (promptRaw || "Create a clean vector icon, laser-friendly.");

  const customerPrompt =
    `${preserveText} ${strict ? "Change only the requested subject/shape; keep everything else identical. " : ""}` +
    (promptRaw || "Realistic product mockup, studio lighting.");

  if (!REPLICATE_API_TOKEN) {
    return res.status(500).json({ ok: false, error: "Missing REPLICATE_API_TOKEN" });
  }
  const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

  let customerUrl = null;
  let ownerUrl    = null;
  const used = {
    raster_primary: null,
    raster_fallback: FLUX_RASTER,
    vector_primary: VECTORIZER,
    vector_fallback: RECRAFT_VECTOR,
    ref: !!ref,
    strict,
    strength: strength || null
  };

  try {
    // ===== 1) CUSTOMER (raster) =====
    if (OPENAI_API_KEY && ref) {
      try {
        const blob = await refToBlob(ref);
        if (!blob) throw new Error("Could not read reference image.");

        const fd = new FormData(); // ← global en Node 22
        const effectivePrompt = customerPrompt || "Generate a realistic photo, preserving the original composition.";
        fd.append("prompt", effectivePrompt);
        fd.append("model", "gpt-image-1");
        fd.append("size", "1024x1024");

        // Usamos Blob global (Node 22) para adjuntar el binario
        const ext = (blob.mime.split("/")[1] || "png").toLowerCase();
        fd.append("image[]", new Blob([blob.buf], { type: blob.mime }), `reference.${ext}`);

        const oa = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
          body: fd
        });
        const j = await oa.json();
        if (!oa.ok) throw new Error(j?.error?.message || "openai edits failed");

        customerUrl = j?.data?.[0]?.url || null;
        used.raster_primary = "openai:images/edits";
      } catch (e) {
        console.warn("[openai edits] failed:", e?.message || e);
      }
    }

    if (!customerUrl) {
      try {
        const p = ref
          ? `${customerPrompt} Use the reference image as the exact base for composition and lighting.`
          : customerPrompt;

        const out = await replicate.run(FLUX_RASTER, {
          input: {
            prompt: p
            // Puedes mapear strength → pasos si tu plan lo permite:
            // num_inference_steps: Math.max(4, Math.min(12, Math.round((strength || 0.4) * 20)))
          }
        });
        if (Array.isArray(out) && out.length) customerUrl = out[0];
        else if (typeof out === "string") customerUrl = out;
        used.raster_primary = used.raster_primary || "replicate:flux-schnell";
      } catch (e) {
        console.warn("[flux] failed:", e?.message || e);
      }
    }

    // ===== 2) OWNER (vector) =====
    let inputForVector = customerUrl || null;

    if (!inputForVector && ref) {
      if (isDataUrl(ref)) {
        try {
          const p = `${ownerPrompt} (convert reference to vector while preserving composition)`;
          const out = await replicate.run(FLUX_RASTER, { input: { prompt: p } });
          if (Array.isArray(out) && out.length) inputForVector = out[0];
          else if (typeof out === "string") inputForVector = out;
        } catch (e) {
          console.warn("[flux for vector input] failed:", e?.message || e);
        }
      } else {
        inputForVector = ref; // URL pública
      }
    }

    if (inputForVector) {
      try {
        const out = await replicate.run(VECTORIZER, { input: { image: inputForVector } });
        if (Array.isArray(out) && out.length) {
          ownerUrl = out[0];
        } else if (typeof out === "string") {
          const svg = out.trim();
          if (svg.startsWith("<svg")) {
            const b64 = Buffer.from(svg, "utf-8").toString("base64");
            ownerUrl = `data:image/svg+xml;base64,${b64}`;
          } else {
            ownerUrl = svg;
          }
        }
      } catch (e) {
        console.warn("[vectorizer img2svg] failed:", e?.message || e);
      }
    }

    if (!ownerUrl) {
      try {
        const out = await replicate.run(RECRAFT_VECTOR, { input: { prompt: ownerPrompt } });
        if (Array.isArray(out) && out.length) ownerUrl = out[0];
        else if (typeof out === "string") ownerUrl = out;
      } catch (e) {
        console.warn("[recraft svg] failed:", e?.message || e);
      }
    }

    if (!ownerUrl && !customerUrl) {
      throw new Error("No output from providers.");
    }

    res.json({
      ok: true,
      owner: ownerUrl || null,
      customer: customerUrl || null,
      used,
      title: meta?.title || "Generated",
      base_from: meta?.source || (ref ? "reference" : "prompt")
    });
  } catch (err) {
    console.error("[/api/generate] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Backend ready on http://localhost:${PORT}`);
});
