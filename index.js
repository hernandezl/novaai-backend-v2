import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Replicate from "replicate";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Para servir archivos estáticos (public)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "../public")));

// Configurar Replicate con el token de tu .env
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// Endpoint para generar imágenes
app.post("/generate", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || prompt.trim() === "") {
    return res.status(400).json({ error: "Prompt is required" });
  }

  try {
    console.log(`🔍 Generando imagen para el prompt: ${prompt}`);
    const output = await replicate.run("stability-ai/sdxl", {
      input: { prompt },
    });

    // Asegurarse de que hay salida válida
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Servidor funcionando en http://localhost:${PORT}/novaai.html`)
);
