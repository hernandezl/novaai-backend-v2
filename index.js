import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Replicate from 'replicate';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, '../public')));

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

app.post('/generate', async (req, res) => {
  const { prompt, baseImage } = req.body;
  try {
    const output = await replicate.run(
      "stability-ai/stable-diffusion-3", // Modelo que ya estaba funcionando
      {
        input: {
          prompt: prompt || "Generate the same image",
          image: baseImage || undefined
        }
      }
    );
    res.json({ image: output[0] });
  } catch (error) {
    console.error("Error generating image:", error);
    res.status(500).json({ error: "Image generation failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Servidor funcionando en http://localhost:${PORT}/novaai.html`)
);
