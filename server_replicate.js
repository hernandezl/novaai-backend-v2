// server_replicate.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Verifica que el token exista
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) {
  console.error("❌ Falta REPLICATE_API_TOKEN en .env");
  process.exit(1);
}

// Ruta principal para probar salud
app.get("/api/health", (req, res) => {
  res.json({ ok: true, status: "Replicate proxy ready" });
});

// Ruta de generación de imagen
app.post("/api/generate", async (req, res) => {
  try {
    const { model, version, prompt, ref } = req.body;

    if (!model || !version) {
      return res
        .status(422)
        .json({ ok: false, msg: "Faltan parámetros: model o version" });
    }

    const input = {};
    if (prompt) input.prompt = prompt;
    if (ref) input.image = ref;

    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version,
        input,
      }),
    });

    const data = await response.json();
    if (response.ok && data?.urls?.get) {
      // Polling rápido para obtener la salida final
      let output = null;
      for (let i = 0; i < 12; i++) {
        const poll = await fetch(data.urls.get, {
          headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
        });
        const pollData = await poll.json();
        if (pollData.status === "succeeded" && pollData.output) {
          output = pollData.output[0];
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (output)
        return res.json({ ok: true, image: output, model, version, prompt });

      return res.status(202).json({
        ok: false,
        msg: "Modelo iniciado, pero sin resultado aún",
      });
    } else {
      return res
        .status(400)
        .json({ ok: false, msg: "Error al crear predicción", data });
    }
  } catch (err) {
    console.error("❌ Error interno:", err);
    res.status(500).json({ ok: false, msg: "Error interno del servidor" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ NovaAI Replicate proxy listening on port ${PORT}`);
});
