// index.js — NovaAI backend (Express)
// Env: OPENAI_API_KEY, REPLICATE_API_TOKEN, PORT (Render injects one)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;

// ---------- helpers
async function pollReplicate(predUrl, token) {
  // Simple polling loop
  for (let i = 0; i < 60; i++) {
    const r = await fetch(predUrl, {
      headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
    });
    const j = await r.json();
    if (j.status === "succeeded" || j.status === "failed" || j.status === "canceled") {
      return j;
    }
    await new Promise(res => setTimeout(res, 1500));
  }
  throw new Error("Replicate: timeout");
}

function b64FromDataURL(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith("data:")) return null;
  const i = dataUrl.indexOf("base64,");
  return i >= 0 ? dataUrl.slice(i + 7) : null;
}

// ---------- health
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "NovaAI Node",
    port: Number(PORT),
    vector_model: "recraft-ai/recraft-20b-svg",
    raster_model: "openai:gpt-image-1 (fallback: Flux Schnell)",
  })
);

// ---------- /api/generate
// body: { prompt?:string, ref?: dataURL or http(s) url, meta?: {...} }
app.post("/api/generate", async (req, res) => {
  const { prompt = "", ref = null, meta = {} } = req.body || {};

  // Build prompts using the reference
  const hasRef = !!ref;
  const promptOwner =
    (prompt || "").trim() ||
    (hasRef ? `Vectorize and color the reference image for laser-cut friendly SVG.` : `Color vector illustration, laser-friendly.`);

  const promptCustomer =
    (prompt || "").trim() ||
    (hasRef ? `Create a photorealistic mockup faithful to the reference image.` : `Realistic product photo, studio lighting.`);

  try {
    // 1) OWNER (vector) via Replicate / Recraft SVG
    const ownerUrl = await (async () => {
      const token = process.env.REPLICATE_API_TOKEN;
      if (!token) throw new Error("Missing REPLICATE_API_TOKEN");

      const body = {
        version: "latest", // let Replicate use default for this model
        input: {
          // model takes 'prompt'; keep minimal + safe params
          prompt: hasRef ? `${promptOwner} Keep shapes & composition based on the reference.` : promptOwner,
          // steps must be <= 4 in Schnell; SVG endpoint is safe with small steps too
          // if the model ignores unknown params, that's fine:
          num_inference_steps: 4,
          // Some Recraft builds accept image as "image" or "reference_image".
          // We pass both (one will be ignored safely if not supported):
          image: hasRef && ref.startsWith("http") ? ref : undefined,
          reference_image: hasRef && ref.startsWith("data:") ? b64FromDataURL(ref) : undefined,
          // Encourage SVG look:
          style: "vector"
        }
      };

      const start = await fetch("https://api.replicate.com/v1/models/recraft-ai/recraft-20b-svg/predictions", {
        method: "POST",
        headers: {
          Authorization: `Token ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (!start.ok) {
        const t = await start.text();
        throw new Error(`Replicate start error: ${t}`);
      }

      const job = await start.json();
      const result = await pollReplicate(job.urls.get, token);
      if (result.status !== "succeeded") {
        throw new Error(`Replicate failed: ${result.status}`);
      }

      // result.output may be array or single url
      const out = Array.isArray(result.output) ? result.output[0] : result.output;
      return out;
    })();

    // 2) CUSTOMER (realistic) via OpenAI, fallback to Flux Schnell
    const customerUrl = await (async () => {
      const key = process.env.OPENAI_API_KEY;

      // try OpenAI first
      if (key) {
        try {
          const body = {
            model: "gpt-image-1",
            prompt: hasRef
              ? `${promptCustomer} Stay faithful to the base reference.`
              : promptCustomer,
            size: "1024x1024"
          };

          // Support reference: pass as image array (data URL or remote)
          if (hasRef) {
            body.image = ref; // OpenAI accepts data URL or remote URL for inpainting/background tasks
          }

          const r = await fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
          });

          const j = await r.json();
          if (r.ok && j?.data?.[0]?.url) return j.data[0].url;

          // If OpenAI returns org verification/quota/etc, fall back
          console.warn("OpenAI image failed, falling back. Details:", j);
        } catch (err) {
          console.warn("OpenAI call error -> fallback", err);
        }
      }

      // Fallback: Flux Schnell on Replicate
      const token = process.env.REPLICATE_API_TOKEN;
      if (!token) throw new Error("Missing REPLICATE_API_TOKEN for fallback");

      const body = {
        version: "latest",
        input: {
          prompt: hasRef
            ? `${promptCustomer} Preserve global composition from the reference.`
            : promptCustomer,
          num_inference_steps: 4,
          // Flux accepts "image" as URL or b64 data; we pass both safely
          image: hasRef && ref.startsWith("http") ? ref : undefined,
          image_base64: hasRef && ref.startsWith("data:") ? b64FromDataURL(ref) : undefined
        }
      };

      const start = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions", {
        method: "POST",
        headers: {
          Authorization: `Token ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (!start.ok) {
        const t = await start.text();
        throw new Error(`Flux start error: ${t}`);
      }

      const job = await start.json();
      const result = await pollReplicate(job.urls.get, token);
      if (result.status !== "succeeded") {
        throw new Error(`Flux failed: ${result.status}`);
      }

      const out = Array.isArray(result.output) ? result.output[0] : result.output;
      return out;
    })();

    res.json({
      owner: { url: ownerUrl, title: meta?.title || "Owner (vector)" },
      customer: { url: customerUrl, title: meta?.title || "Customer (realistic)" }
    });
  } catch (error) {
    console.error("[/api/generate] Error:", error);
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.listen(PORT, () => console.log(`Backend ready on http://localhost:${PORT}`));
