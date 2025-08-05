import express from "express";
import cors from "cors";
import Replicate from "replicate";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Inicializa Replicate con la API Key desde .env
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

// Endpoint para generar imágenes
app.post("/generate", async (req, res) => {
  try {
    const { prompt, negative_prompt } = req.body;

    if (!prompt || prompt.trim() === "") {
      return res.status(400).json({ error: "Prompt is required" });
    }

    console.log(`🎨 Generando imagen para el prompt: ${prompt}`);

    // Usa el modelo que antes funcionó (stable-diffusion-3)
    const output = await replicate.run("stability-ai/stable-diffusion-3", {
      input: {
        prompt: `${prompt}, vector illustration, thick outlines, flat contrast colors`,
        negative_prompt: negative_prompt || "realistic, 3d, photo, blurry, shadows, complex background",
        width: 1024,
        height: 1024
      }
    });

    if (!output || !output[0]) {
      return res.status(500).json({ error: "No se recibió ninguna imagen" });
    }

    res.json({ image: output[0] });
  } catch (error) {
    console.error("❌ Error al generar la imagen:", error);
    res.status(500).json({ error: "Failed to generate image" });
  }
});

app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
});
