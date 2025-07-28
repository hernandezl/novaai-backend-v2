import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import Replicate from 'replicate';

const app = express();
const port = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('Servidor funcionando correctamente');
});

// Ruta principal para generar imágenes
app.post('/generate', async (req, res) => {
  try {
    const prompt = req.body.prompt;

    if (!prompt) {
      return res.status(400).json({ error: 'El prompt es obligatorio' });
    }

    const replicate = new Replicate({
      auth: process.env.REPLICATE_API_TOKEN,
    });

    // Modelo SDXL versión estable
    const modelVersion =
      'stability-ai/sdxl:58b650651e09e23d40c7a7b9f1af7e3b23511a11e95492c6a1a22a58d8a4f24c';

    const output = await replicate.run(modelVersion, {
      input: {
        prompt: prompt,
        width: 768, // buena calidad + velocidad razonable
        height: 768,
        refine: 'expert_ensemble_refiner', // mejora detalles
        scheduler: 'K_EULER',
        num_outputs: 1,
        guidance_scale: 7.5,
        high_noise_frac: 0.8,
      },
    });

    res.json({ image: output[0] });
  } catch (error) {
    console.error('Error en /generate:', error);
    res
      .status(500)
      .json({ error: error.message || 'Error generando la imagen' });
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});
