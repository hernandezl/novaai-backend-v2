import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import Replicate from 'replicate';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.send('Servidor funcionando correctamente');
});

app.post('/generate', async (req, res) => {
  try {
    const prompt = req.body.prompt;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt requerido' });
    }

    const replicate = new Replicate({
      auth: process.env.REPLICATE_API_TOKEN,
    });

    const output = await replicate.run(
      "stability-ai/sdxl:fd8b3cf01c02cb8eb871b6c3cc1bd6837c69c2dc3c3b5a0b4e3c380208089caa",
      {
        input: {
          prompt: prompt,
          width: 768,
          height: 768,
        },
      }
    );

    res.json({ image: output[0] });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message || 'Error interno del servidor' });
  }
});

app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});
