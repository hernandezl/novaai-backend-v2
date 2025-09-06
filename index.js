// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;

// === Helpers ================================================================

function b64ToDataUrl(b64, mime = "image/png") {
  if (!b64) return null;
  if (b64.startsWith("data:")) return b64;
  return `data:${mime};base64,${b64}`;
}

// OpenAI realistic image (tries to use ref; if not supported, caller will fallback)
async function openaiGenerate({ prompt, ref, size = "1024x1024" }) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    // NOTE: OpenAI image generations endpoint is JSON; image-to-image needs multipart.
    // We try the simple generations call; if you later switch to edits with multipart,
    // plug it here. Frontend will preserve the reference if provider refuses it.
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
    console.warn("[openai] fail ⇒ fallback to Flux:", e?.message || e);
    return null;
  }
}

// Replicate: FLUX (fallback realistic)
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
          input: {
            prompt,
            num_inference_steps: Math.min(Math.max(1, steps), 4),
          },
        }),
      }
    );
    if (!r.ok) throw new Error(`flux ${r.status}`);
    const j = await r.json();
    // poll
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

// Replicate: Recraft vector SVG (owner)
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
          input: {
            prompt,
            // keep within limits to avoid 422
            num_inference_steps: 4,
          },
        }),
      }
    );
    if (!r.ok) throw new Error(`recraft ${r.status}`);
    const j = await r.json();
    // poll
    let url = j.urls.get;
    for (let i = 0; i < 24; i++) {
      const rr = await fetch(url, {
        headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` },
      });
      const jj = await rr.json();
      if (jj.status === "succeeded") {
        // recraft returns an array of assets; prefer SVG
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
  // Owner (vector) – Recraft; no image-to-image, así que guiamos por prompt.
  const ownerPrompt = ref
    ? `${prompt || ""}\nStyle: clean, flat, solid colors, simplified shapes (SVG).`
    : `${prompt}\nStyle: clean, flat, solid colors, simplified shapes (SVG).`;

  // Customer (realistic) – OpenAI → fallback FLUX
  const custPrompt = ref
    ? `${prompt}\nKeep the base composition consistent with the uploaded reference image.`
    : prompt;

  const [ownerUrl, openaiUrl] = await Promise.all([
    recraftSvg({ prompt: ownerPrompt }),
    openaiGenerate({ prompt: custPrompt, ref }),
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

// === Routes =================================================================

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
    const { prompt = "", ref = null, meta = null, mode = "pair" } = req.body || {};

    // No prompt + reference ⇒ return the reference as-is (no cost)
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
