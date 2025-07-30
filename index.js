import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Replicate from "replicate";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Ruta para servir archivos estáticos desde "public"
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "../public")));

// Instancia de Replicate con tu token del archivo .env
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// Ruta principal de generación de imágenes
app.post("/generate", async (req, res) => {
  const { prompt, negative_prompt } = req.body;

  if (!prompt || prompt.trim() === "") {
    return res.status(400).json({ error: "El prompt es obligatorio" });
  }

  try {
    console.log("🔍 Generando imagen con estilo vector...");

    const output = await replicate.run("stability-ai/sdxl", {
      input: {
        prompt: prompt,
        negative_prompt: negative_prompt || "realistic, 3d, photo, blurry, shadows, background",
        width: 768,
        height: 768,
        guidance_scale: 7.5,
        num_outputs: 1,
        scheduler: "K_EULER",
        refine: "expert_ensemble_refiner",
        high_noise_frac: 0.8,
      },
    });

    if (!output || !output[0]) {
      return res.status(500).json({ error: "No se generó ninguna imagen." });
    }

    res.json({ image: output[0] });

  } catch (error) {
    console.error("❌ Error al generar la imagen:", error);
    res.status(500).json({
      error: "Error al generar la imagen",
      details: error.message,
    });
  }
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`🚀 Servidor funcionando en http://localhost:${port}/novaai.html`);
});
