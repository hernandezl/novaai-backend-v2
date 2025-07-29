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
  const { prompt } = req.body;

  if (!prompt || prompt.trim() === "") {
    return res.status(400).json({ error: "Prompt is required" });
  }

  try {
    console.log(`🔍 Generando imagen para el prompt: ${prompt}`);

    // Usando alias general (siempre apunta a la versión estable más reciente)
    const output = await replicate.run("stability-ai/stable-diffusion-3", {
      input: { prompt },
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
  console.log(`Servidor funcionando en http://localhost:${port}/novaai.html`);
});
