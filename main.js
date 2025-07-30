document.getElementById('generate-btn').addEventListener('click', async () => {
  const prompt = document.getElementById('prompt').value;
  const resultDiv = document.getElementById('result');
  resultDiv.innerHTML = "🌀 Generating...";

  try {
    const response = await fetch('https://novaai-backend-v2.onrender.com/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: prompt,
        negative_prompt: "realistic, 3d, photo, blurry, shadows, background"
      }),
    });

    const data = await response.json();

    if (data.image) {
      resultDiv.innerHTML = `<img src="${data.image}" alt="Generated Image" width="512"/>`;
    } else {
      resultDiv.innerHTML = "⚠️ No image generated.";
    }
  } catch (error) {
    console.error(error);
    resultDiv.innerHTML = "❌ Error generating image.";
  }
});
