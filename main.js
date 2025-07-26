document.getElementById('prompt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = document.getElementById('prompt').value;
  const resultDiv = document.getElementById('result');
  resultDiv.innerHTML = "Generating image...";

  try {
    const response = await fetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const data = await response.json();

    if (data.image) {
      resultDiv.innerHTML = `<img src="${data.image}" alt="Generated Image" width="512"/>`;
    } else {
      resultDiv.innerHTML = "No image generated.";
    }
  } catch (error) {
    console.error(error);
    resultDiv.innerHTML = "An error occurred while generating the image.";
  }
});
