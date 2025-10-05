// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import Replicate from "replicate";
import FormData from "form-data";
import { Buffer } from "node:buffer";

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Modelos por nombre (sin version para evitar 422 en Replicate)
const VECTOR_MODEL = "recraft-ai/recraft-20b-svg";     // Owner (vector)
const FLUX_MODEL   = "black-forest-labs/flux-schnell"; // Fallback raster

const isDataUrl = s => typeof s === "string" && /^data:image\/[a-zA-Z]+;base64,/.test(s);

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "NovaAI Node",
    port: Number(PORT),
    vector_model: VECTOR_MODEL,
    raster_model: `openai:gpt-image-1 (fallback ${FLUX_MODEL})`
  })
);

/**
 * POST /api/generate
 * body: { prompt?: string, ref?: dataURL|url|null, meta?: {title?,source?} }
 * resp: { ok, owner, customer, title, code, base_from }
 */
app.post("/api/generate", async (req, res) => {
  const prompt = (req.body?.prompt || "").trim();
  const ref    = req.body?.ref || null;   // dataURL o URL
  const meta   = req.body?.meta || null;

  const keepRef =
    ref ? "Keep the same composition, proportion, camera angle and base geometry from the reference. Only replace the main motif per the prompt." : "";

  const ownerPrompt =
    `${keepRef ? keepRef + " " : ""}Clean vector style, flat solid colors, thick outlines, high contrast (SVG). ` +
    (prompt || "Create a clean vector icon, laser-friendly.");

  const customerPrompt =
    `${keepRef ? keepRef + " " : ""}Photorealistic product mockup, studio lighting, soft shadows, high realism. ` +
    (prompt || "Realistic product photo.");

  try {
    // Replicate SDK para vector
    if (!REPLICATE_API_TOKEN) throw new Error("Missing REPLICATE_API_TOKEN");
    const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

    // 1) OWNER (vector) — Recraft
    let ownerUrl = null;
    const recraftOut = await replicate.run(VECTOR_MODEL, { input: { prompt: ownerPrompt } });
    if (Array.isArray(recraftOut) && recraftOut.length) ownerUrl = recraftOut[0];
    else if (typeof recraftOut === "string") ownerUrl = recraftOut;

    // 2) CUSTOMER (realista) — OpenAI i2i si hay ref, si no texto; fallback FLUX
    let customerUrl = null;
    let openaiOk = false;

    async function dataUrlToBuffer(dataUrl){
      const m = /^data:(.+?);base64,(.*)$/i.exec(dataUrl || "");
      if(!m) return null;
      return Buffer.from(m[2], "base64");
    }
    async function fetchAsBuffer(u){
      const rr = await fetch(u);
      if(!rr.ok) throw new Error("ref fetch failed");
      const ab = await rr.arrayBuffer();
      return Buffer.from(ab);
    }

    if (OPENAI_API_KEY) {
      try {
        if (ref) {
          // ==== Image-to-Image (OpenAI /images/edits, multipart) ====
          let buf = null, filename = "reference.png";
          if (isDataUrl(ref)) {
            buf = await dataUrlToBuffer(ref);
          } else {
            buf = await fetchAsBuffer(ref);
            if (ref.includes(".jpg") || ref.includes(".jpeg")) filename = "reference.jpg";
            if (ref.includes(".png")) filename = "reference.png";
            if (ref.includes(".webp")) filename = "reference.webp";
          }
          if (!buf) throw new Error("invalid reference buffer");

          const form = new FormData();
          form.append("model", "gpt-image-1");
          form.append("prompt", customerPrompt);
          form.append("size", "1024x1024");
          form.append("image", buf, { filename, contentType: "application/octet-stream" });

          const oa = await fetch("https://api.openai.com/v1/images/edits", {
            method: "POST",
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
            body: form,
          });
          const j = await oa.json();
          if (!oa.ok) throw new Error(j?.error?.message || "openai edits failed");
          customerUrl = j?.data?.[0]?.url || null;
          openaiOk = !!customerUrl;
        } else {
          // ==== Texto a imagen ====
          const oa = await fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: "gpt-image-1",
              prompt: customerPrompt,
              size: "1024x1024"
            }),
          });
          const j = await oa.json();
          if (!oa.ok) throw new Error(j?.error?.message || "openai gen failed");
          customerUrl = j?.data?.[0]?.url || null;
          openaiOk = !!customerUrl;
        }
      } catch (e) {
        console.warn("[openai] fallback to Replicate:", e?.message || e);
        openaiOk = false;
      }
    }

    if (!openaiOk) {
      // Fallback a FLUX (Replicate) si OpenAI falla o no hay API key
      const fluxOut = await replicate.run(FLUX_MODEL, { input: { prompt: customerPrompt } });
      if (Array.isArray(fluxOut) && fluxOut.length) customerUrl = fluxOut[0];
      else if (typeof fluxOut === "string") customerUrl = fluxOut;
    }

    if (!ownerUrl && !customerUrl) throw new Error("No output from providers.");

    res.json({
      ok: true,
      owner: ownerUrl || ref || null,
      customer: customerUrl || ref || null,
      title: meta?.title || "Generated",
      code: `GEN-${Date.now()}`,
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
