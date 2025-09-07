// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import Replicate from "replicate";

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Modelos “por nombre” (sin mandar version para evitar 422)
const VECTOR_MODEL = "recraft-ai/recraft-20b-svg";          // Owner (vector)
const RASTER_MODEL = "black-forest-labs/flux-schnell";      // Fallback cliente (realista)

// Helpers
const isDataUrl = (s = "") => /^data:image\/[a-zA-Z]+;base64,/.test(s);
const short = (s = "", n = 120) => (s.length > n ? s.slice(0, n) + "…" : s);

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "NovaAI Node",
    port: Number(PORT),
    base_url: null,
    vector_model: VECTOR_MODEL,
    raster_model: RASTER_MODEL,
  })
);

/**
 * /api/generate
 * body: { prompt?: string, ref?: string|url, reference?: string|url, meta?: any }
 * Devuelve: { owner: dataUrl|url, customer: dataUrl|url }
 */
app.post("/api/generate", async (req, res) => {
  const prompt = (req.body?.prompt || "").trim();
  const ref = req.body?.ref || req.body?.reference || null; // dataURL o URL
  const meta = req.body?.meta || req.body?.ref_meta || null;

  // Prompt base segun referencia
  const refHint = ref
    ? "Faithfully keep the base pattern, composition and proportions of the reference image. Apply only the requested changes."
    : "";
  const ownerPrompt =
    (ref ? `${refHint} Vector, flat colors, thick outlines. ` : "Vector, flat colors, thick outlines. ") +
    (prompt || "Create a clean vector icon.");
  const customerPrompt =
    (ref ? `${refHint} Photorealistic look, studio lighting, product mockup style. ` : "Photorealistic product mockup, studio lighting. ") +
    (prompt || "Render a realistic product photo.");

  try {
    // =========================
    // 1) OWNER (vector) — Recraft (Replicate SDK)
    // =========================
    let ownerUrl = null;
    if (!REPLICATE_API_TOKEN) {
      throw new Error("Missing REPLICATE_API_TOKEN");
    }
    const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

    // Recraft acepta prompt de texto. Si hay referencia la incorporamos en el prompt.
    // Usamos el “model” sin enviar un campo "version" para evitar el 422.
    const recraftOut = await replicate.run(VECTOR_MODEL, {
      input: {
        prompt: ownerPrompt,
        // Campos seguros; evitamos mandar "version" o campos no permitidos.
        // Si tu plan incluye seed/num_inference_steps puedes añadirlos aquí.
      },
    });

    // `recraftOut` suele retornar array de URLs
    if (Array.isArray(recraftOut) && recraftOut.length) {
      ownerUrl = recraftOut[0];
    } else if (typeof recraftOut === "string") {
      ownerUrl = recraftOut;
    }

    // =========================
    // 2) CUSTOMER (realista) — OpenAI; fallback a FLUX (Replicate)
    // =========================
    let customerUrl = null;
    let openaiOk = false;

    if (OPENAI_API_KEY) {
      try {
        // Usamos /images/generations (texto). Si hay ref dataURL, la incluimos como “guide” en prompt.
        // (El endpoint de edits requiere multipart; para máxima compatibilidad dejamos generations.)
        const oa = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-image-1",
            prompt: ref ? `${customerPrompt}\nReference URL (if any): ${isDataUrl(ref) ? "" : ref}` : customerPrompt,
            size: "1024x1024",
            // No mandamos response_format para evitar “unknown parameter”
          }),
        });

        const j = await oa.json();
        if (!oa.ok) {
          // Si OpenAI rechaza por verificación / cuota, lo registramos y pasamos a fallback
          console.warn("[openai] generation failed:", j);
          throw new Error(j?.error?.message || "openai gen failed");
        }
        customerUrl = j?.data?.[0]?.url || null;
        openaiOk = !!customerUrl;
      } catch (e) {
        openaiOk = false;
      }
    }

    // Fallback a FLUX (Replicate) si OpenAI falla o no hay API key
    if (!openaiOk) {
      const fluxOut = await replicate.run(RASTER_MODEL, {
        input: {
          prompt: customerPrompt,
          // Para evitar 422 no enviamos “version” ni campos que no figuren.
          // Si tu plan admite num_inference_steps <= 4 puedes añadir: num_inference_steps: 4
        },
      });
      if (Array.isArray(fluxOut) && fluxOut.length) {
        customerUrl = fluxOut[0];
      } else if (typeof fluxOut === "string") {
        customerUrl = fluxOut;
      }
    }

    // Safety
    if (!ownerUrl && !customerUrl) {
      throw new Error("No output from providers.");
    }

    res.json({ owner: ownerUrl, customer: customerUrl, meta: { usedRef: !!ref, title: meta?.title || null } });
  } catch (err) {
    console.error("[api/generate] Error:", err);
    res.status(500).json({
      error: {
        message: String(err?.message || err),
        type: "server_error",
      },
    });
  }
});

app.listen(PORT, () => console.log(`Backend ready on http://localhost:${PORT}`));
