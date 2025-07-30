import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Replicate from "replicate";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Rutas estáticas (sirve archivos del frontend si es necesario)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "../public")));

// Inicializa Replicate con tu token
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// Endpoint para generar imágenes
app.post("/generate", async (req, res) => {
  const { prompt, negative_prompt } = req.body;

  if (!prompt || prompt.trim() === "") {
    return res.status(400).json({ error: "Prompt is required" });
  }

  try {
    const output = await replicate.run("stability-ai/sdxl", {
      input: {
        prompt: prompt,
        negative_prompt: negative_prompt,
        width: 512,
        height: 512,
        guidance_scale: 7.5,
        num_outputs: 1,
        scheduler: "K_EULER",
        refine: "expert_ensemble_refiner"
      }
    });

    if (!output || !output[0]) {
      return res.status(500).json({ error: "No image received" });
    }

    res.json({ image: output[0] });

  } catch (error) {
    console.error("Error generating image:", error);
    res.status(500).json({ error: "Failed to generate image" });
  }
});


// Iniciar servidor
app.listen(port, () => {
  console.log(`Servidor funcionando en http://localhost:${port}/novaai.html`);
});
