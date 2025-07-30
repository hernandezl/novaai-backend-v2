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

// Servir archivos estáticos desde la carpeta public
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "../public")));

// Inicializar Replicate con el token
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
      return res.status(500).json({ error: "No se recibió ninguna imagen" });
    }

    res.json({ image: output[0] });
  } catch (error) {
    console.error("❌ Error al generar la imagen:", error);
    res
      .status(500)
      .json({ error: "Ocurrió un error al generar la imagen", details: error.message });
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});
