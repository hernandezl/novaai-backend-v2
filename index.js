import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Replicate from 'replicate';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// __dirname para módulos ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Servir archivos estáticos si fuera necesario
app.use(express.static(path.join(__dirname, 'public')));

// Conexión a Replicate
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// Ruta para generar imágenes
app.post('/generate', async (req, res) => {
  const { prompt } = req.body;
  try {
    const output = await replicate.run(
      'stability-ai/sdxl:7587df305c41a8d2b0ce299f650d3e8b71a7d2b74c8f9c4dc2b1acfa51f3c3c7',
      { input: { prompt } }
    );

    return res.json({ image: output[0] });
  } catch (error) {
    console.error('Error generating image:', error);
    return res.status(500).json({ error: 'Image generation failed' });
  }
});

// Puerto dinámico para Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor funcionando en puerto ${PORT}`);
});
