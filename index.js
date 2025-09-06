// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors()); // CORS abierto para tu estático
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;

function b64ToDataUrl(b64, mime = "image/png") {
  if (!b64) return null;
  if (b64.startsWith("data:")) return b64;
  return `data:${mime};base64,${b64}`;
}

async function openaiGenerate({ prompt, size = "1024x1024" }) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const body = { model: "gpt-image-1", prompt, size };
    const r = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`openai ${r.status}`);
    const j = await r.json();
    const b64 = j?.data?.[0]?.b64_json;
    return b64ToDataUrl(b64, "image/png");
  } catch (e) {
    console.warn("[openai] fail ⇒ fallback Flux:", e?.message || e);
    return null;
  }
}

async function fluxSchnell({ prompt, steps = 4 }) {
  if (!process.env.REPLICATE_API_TOKEN) return null;
  try {
    const r = await fetch(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: { prompt, num_inference_steps: Math.min(Math.max(1, steps), 4) },
        }),
      }
    );
    if (!r.ok) throw new Error(`flux ${r.status}`);
    const j = await r.json();
    let url = j.urls.get;
    for (let i = 0; i < 24; i++) {
      const rr = await fetch(url, {
        headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` },
      });
      const jj = await rr.json();
      if (jj.status === "succeeded") {
        const out = Array.isArray(jj.output) ? jj.output[0] : jj.output;
        return out || null;
      }
      if (jj.status === "failed" || jj.status === "canceled") break;
      await new Promise((s) => setTimeout(s, 1250));
    }
    return null;
  } catch (e) {
    console.warn("[flux] error:", e?.message || e);
    return null;
  }
}

async function recraftSvg({ prompt }) {
  if (!process.env.REPLICATE_API_TOKEN) return null;
  try {
    const r = await fetch(
      "https://api.replicate.com/v1/models/recraft-ai/recraft-20b-svg/predictions",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: { prompt, num_inference_steps: 4 },
        }),
      }
    );
    if (!r.ok) throw new Error(`recraft ${r.status}`);
    const j = await r.json();
    let url = j.urls.get;
    for (let i = 0; i < 24; i++) {
      const rr = await fetch(url, {
        headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` },
      });
      const jj = await rr.json();
      if (jj.status === "succeeded") {
        const out = Array.isArray(jj.output) ? jj.output[0] : jj.output;
        return out || null;
      }
      if (jj.status === "failed" || jj.status === "canceled") break;
      await new Promise((s) => setTimeout(s, 1250));
    }
    return null;
  } catch (e) {
    console.warn("[recraft] error:", e?.message || e);
    return null;
  }
}

async function generatePair({ prompt, ref, meta }) {
  const ownerPrompt =
    `${prompt || ""}\nStyle: clean, flat, thick outline, solid bright colors, simplified shapes (SVG).`
      .trim();

  const custPrompt = ref
    ? `${prompt}\nKeep the base composition consistent with the uploaded reference image.`
    : prompt;

  const [ownerUrl, openaiUrl] = await Promise.all([
    recraftSvg({ prompt: ownerPrompt }),
    openaiGenerate({ prompt: custPrompt }),
  ]);

  const customerUrl = openaiUrl || (await fluxSchnell({ prompt: custPrompt }));

  return {
    ownerUrl: ownerUrl || ref || null,
    customerUrl: customerUrl || ref || null,
    title: meta?.title || "Generated",
    code: `GEN-${Date.now()}`,
    base_from: meta?.source || "ai",
  };
}

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "NovaAI Node",
    port: Number(PORT),
    vector_model: "recraft-ai/recraft-20b-svg",
    raster_model: "openai:gpt-image-1 (fallback flux-schnell)",
    ref_enabled: true,
  })
);

app.post("/api/generate", async (req, res) => {
  try {
    const { prompt = "", ref = null, meta = null } = req.body || {};
    if (!prompt && ref) {
      return res.json({
        ok: true,
        owner: ref,
        customer: ref,
        title: meta?.title || "Reference",
        code: meta?.id || `REF-${Date.now()}`,
        base_from: meta?.source || "reference",
      });
    }

    const { ownerUrl, customerUrl, title, code, base_from } = await generatePair({
      prompt,
      ref,
      meta,
    });

    res.json({
      ok: true,
      owner: ownerUrl || ref || null,
      customer: customerUrl || ref || null,
      title,
      code,
      base_from,
    });
  } catch (e) {
    console.error("[/api/generate] error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Backend ready on http://localhost:${PORT}`);
});
