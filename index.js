import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Replicate from "replicate";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Ruta estática para servir la carpeta "public"
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "../public")));

// Configuración de Replicate
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// Ruta de prueba
app.get("/", (req, res) => {
  res.send("Servidor funcionando correctamente");
});

// Ruta principal para generar imágenes
app.post("/generate", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || prompt.trim() === "") {
    return res.status(400).json({ error: "Prompt is required" });
  }

  try {
    console.log(`🔍 Generando imagen para el prompt: ${prompt}`);

    // Modelo usando alias (sin versión específica)
    const output = await replicate.run("stability-ai/sdxl", {
      input: {
        prompt: prompt,
        width: 768,
        height: 768,
        num_outputs: 1,
        guidance_scale: 7.5,
      },
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

// Iniciar el servidor
app.listen(PORT, () => {
  console.log(`Servidor funcionando en http://localhost:${PORT}/novaai.html`);
});
