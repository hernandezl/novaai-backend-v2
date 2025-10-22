import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";
import bodyParser from "body-parser";
import Replicate from "replicate";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
const upload = multer({ storage: multer.memoryStorage() });

/* ====== CONFIG ====== */
const PORT = process.env.PORT || 3000;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

/* ====== HEALTH CHECK ====== */
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    engine: "NovaAI Backend v2",
    time: new Date().toISOString(),
  });
});

/* ====== TEST REPLICATE ====== */
app.get("/api/replicate-test", async (req, res) => {
  try {
    const r = await fetch("https://api.replicate.com/v1/models/bytedance/seededit-3.0", {
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    const data = await r.json();
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ====== GENERATE ENDPOINT ====== */
app.post("/api/generate", upload.single("file"), async (req, res) => {
  try {
    const { ref, prompt, negative, font, strength = 0.35 } = req.body;
    const hasFile = !!req.file;

    // image input
    let inputImage = ref || null;
    if (hasFile) {
      const buffer = req.file.buffer.toString("base64");
      inputImage = `data:${req.file.mimetype};base64,${buffer}`;
    }

    // Prefer Replicate (SeedEdit or Flux)
    try {
      const output = await replicate.run("bytedance/seededit-3.0", {
        input: {
          image: inputImage,
          prompt: prompt || "Faithful design recreation",
          negative_prompt: negative || "",
          strength: strength,
          steps: 4,
        },
      });
      return res.json({
        used: "replicate/seededit-3.0",
        image: Array.isArray(output) ? output[0] : output,
        steps: 4,
        strength,
      });
    } catch (repErr) {
      console.error("Replicate failed:", repErr);
    }

    // fallback (Flux Schnell)
    try {
      const out2 = await replicate.run("black-forest-labs/flux-schnell", {
        input: {
          image: inputImage,
          prompt: prompt || "Faithful design recreation",
          negative_prompt: negative || "",
          strength,
          steps: 4,
        },
      });
      return res.json({
        used: "replicate/flux-schnell",
        image: Array.isArray(out2) ? out2[0] : out2,
        steps: 4,
        strength,
      });
    } catch (err2) {
      console.error("Flux fallback failed:", err2);
    }

    // fallback OpenAI (solo si está configurada)
    if (OPENAI_API_KEY) {
      const resp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt,
          size: "1024x1024",
        }),
      });
      const data = await resp.json();
      return res.json({
        used: "openai/gpt-image-1",
        image: data.data?.[0]?.b64_json
          ? `data:image/png;base64,${data.data[0].b64_json}`
          : null,
      });
    }

    throw new Error("No valid engine available");
  } catch (err) {
    res.status(500).json({ error: err.message || "Unknown error" });
  }
});

/* ====== RUN ====== */
app.listen(PORT, () => {
  console.log(`✅ NovaAI Backend running on port ${PORT}`);
});
