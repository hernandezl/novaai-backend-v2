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

// Modelos principales
const VECTOR_MODEL = "recraft-ai/recraft-20b-svg";     // Para vector (Owner)
const FLUX_MODEL   = "black-forest-labs/flux-schnell"; // Fallback raster (Customer)

const isDataUrl = s => typeof s === "string" && /^data:image\/[a-zA-Z]+;base64,/.test(s);

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "NovaAI Node",
    port: Number(PORT),
    vector_model: VECTOR_MODEL,
    raster_model: `openai:gpt-image-1 (fallback ${FLUX_MODEL})`,
  })
);

app.post("/api/generate", async (req, res) => {
  const prompt = (req.body?.prompt || "").trim();
  const ref = req.body?.ref || null; // Imagen base o null
  const meta = req.body?.meta || {};

  const keepRef = ref
    ? "Preserve the same composition, angle, and proportions of the reference image. Modify only the main element according to the prompt."
    : "";

  const ownerPrompt =
    `${keepRef ? keepRef + " " : ""}Clean vector style, flat solid colors, bold outlines, high contrast, laser-friendly SVG. ` +
    (prompt || "Create a vector icon with bold outlines.");

  const customerPrompt =
    `${keepRef ? keepRef + " " : ""}Photorealistic studio mockup, product lighting, soft reflections, professional render. ` +
    (prompt || "Realistic product photo in studio lighting.");

  try {
    if (!REPLICATE_API_TOKEN) throw new Error("Missing REPLICATE_API_TOKEN");
    const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

    // ========== VECTOR (Owner) ==========
    let ownerUrl = null;
    const recraftOut = await replicate.run(VECTOR_MODEL, { input: { prompt: ownerPrompt } });
    if (Array.isArray(recraftOut) && recraftOut.length) ownerUrl = recraftOut[0];
    else if (typeof recraftOut === "string") ownerUrl = recraftOut;

    // ========== RASTER (Customer) ==========
    let customerUrl = null;
    let openaiOk = false;

    async function dataUrlToBuffer(dataUrl) {
      const m = /^data:(.+?);base64,(.*)$/i.exec(dataUrl || "");
      if (!m) return null;
      return Buffer.from(m[2], "base64");
    }
    async function fetchAsBuffer(u) {
      const r = await fetch(u);
      if (!r.ok) throw new Error("ref fetch failed");
      const ab = await r.arrayBuffer();
      return Buffer.from(ab);
    }

    if (OPENAI_API_KEY) {
      try {
        if (ref) {
          // ===== Image to Image (OpenAI edits endpoint) =====
          let buf = null;
          let filename = "reference.png";
          if (isDataUrl(ref)) {
            buf = await dataUrlToBuffer(ref);
          } else {
            buf = await fetchAsBuffer(ref);
            if (ref.includes(".jpg")) filename = "reference.jpg";
            if (ref.includes(".jpeg")) filename = "reference.jpeg";
            if (ref.includes(".png")) filename = "reference.png";
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
          // ===== Text to Image =====
          const oa = await fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: "gpt-image-1",
              prompt: customerPrompt,
              size: "1024x1024",
            }),
          });
          const j = await oa.json();
          if (!oa.ok) throw new Error(j?.error?.message || "openai gen failed");
          customerUrl = j?.data?.[0]?.url || null;
          openaiOk = !!customerUrl;
        }
      } catch (e) {
        console.warn("[openai error] → fallback to FLUX:", e.message);
        openaiOk = false;
      }
    }

    // Fallback si OpenAI falla
    if (!openaiOk) {
      const fluxOut = await replicate.run(FLUX_MODEL, { input: { prompt: customerPrompt } });
      if (Array.isArray(fluxOut) && fluxOut.length) customerUrl = fluxOut[0];
      else if (typeof fluxOut === "string") customerUrl = fluxOut;
    }

    if (!ownerUrl && !customerUrl) throw new Error("No output from providers.");

    res.json({
      ok: true,
      owner: ownerUrl,
      customer: customerUrl,
      title: meta?.title || "Generated",
      code: `GEN-${Date.now()}`,
      base_from: meta?.source || (ref ? "reference" : "prompt"),
    });
  } catch (err) {
    console.error("[/api/generate] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend ready on http://localhost:${PORT}`);
});
