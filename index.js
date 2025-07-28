const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Replicate = require('replicate');

const app = express();
const port = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('Servidor funcionando correctamente');
});

// Ruta para generar imagen
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
          height: 768
        }
      }
    );

    res.json({ image: output[0] });

  } catch (error) {
    console.error('❌ Error en /generate:', error);
    res.status(500).json({ error: error.message || 'Error interno' });
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`Servidor funcionando en http://localhost:${port}`);
});
