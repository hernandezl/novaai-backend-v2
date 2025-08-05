
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import Replicate from "replicate";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// Static file directory resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Replicate setup
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// Generate image endpoint
app.post("/generate", async (req, res) => {
  const { prompt, negative_prompt } = req.body;

  if (!prompt || prompt.trim() === "") {
    return res.status(400).json({ error: "Prompt is required" });
  }

  try {
    const output = await replicate.run(
      "stability-ai/sdxl:58b650651e09e23d40c7a7b9f1af7e3b23511a11e95492c6a1a22a58d8a4f24c",
      {
        input: {
          prompt: prompt,
          negative_prompt: negative_prompt || "realistic, 3d, photo, blurry, shadows, background, gradients",
          width: 768,
          height: 768,
          refine: "expert_ensemble_refiner",
          scheduler: "K_EULER",
          num_outputs: 1,
          guidance_scale: 7.5,
          high_noise_frac: 0.8
        }
      }
    );

    if (!output || !output[0]) {
      return res.status(500).json({ error: "No image returned from the model." });
    }

    res.json({ image: output[0] });
  } catch (error) {
    console.error("❌ Error generating image:", error);
    res.status(500).json({ error: "Image generation failed", details: error.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server is running at http://localhost:${port}`);
});
