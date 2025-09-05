// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// --- Configuración de modelos ---
const VECTOR_MODEL = "recraft-ai/recraft-20b-svg";
const RASTER_MODEL = "gpt-image-1"; // Modelo de OpenAI para imágenes realistas
const FALLBACK_MODEL = "black-forest-labs/flux-schnell"; // Fallback si OpenAI falla

// --- Helpers ---
function clampInt(value, min, max, def) {
  const v = parseInt(value, 10);
  if (isNaN(v)) return def;
  return Math.min(Math.max(v, min), max);
}

// --- Generación vector (Replicate) ---
async function generateVector(prompt) {
  const resp = await fetch("https://api.replicate.com/v1/models/" + VECTOR_MODEL + "/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: { prompt }
    }),
  });
  if (!resp.ok) throw new Error("Replicate vector failed: " + (await resp.text()));
  const data = await resp.json();
  return data.urls.get;
}

// --- Generación realista (OpenAI + fallback Flux) ---
async function generateRealistic({ prompt, params }) {
  // 1) Intentar OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const resp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: RASTER_MODEL,
          prompt,
          size: "1024x1024",
          n: 1
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.data[0].url;
      } else {
        const err = await resp.text();
        console.error("OpenAI error:", err);
        throw new Error("OpenAI failed");
      }
    } catch (e) {
      console.error("⚠️ OpenAI request error:", e.message);
    }
  }

  // 2) Fallback Flux Schnell
  const steps = clampInt(params?.steps, 1, 4, 4); // límite permitido
  const resp = await fetch("https://api.replicate.com/v1/models/" + FALLBACK_MODEL + "/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: {
        prompt,
        num_inference_steps: steps
      }
    }),
  });
  if (!resp.ok) throw new Error("Flux fallback failed: " + (await resp.text()));
  const data = await resp.json();
  return data.urls.get;
}

// --- Rutas ---
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "NovaAI Node",
    port: Number(process.env.PORT) || 3000,
    vector_model: VECTOR_MODEL,
    raster_model: RASTER_MODEL,
    fallback_model: FALLBACK_MODEL
  });
});

app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, mode, params } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    if (mode === "vector") {
      const url = await generateVector(prompt);
      return res.json({ ok: true, mode, url });
    } else if (mode === "realistic") {
      const url = await generateRealistic({ prompt, params });
      return res.json({ ok: true, mode, url });
    } else {
      return res.status(400).json({ error: "Invalid mode" });
    }
  } catch (e) {
    console.error("❌ /api/generate error:", e);
    res.status(500).json({ error: e.message });
  }
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend listo en http://localhost:${PORT}`);
});
