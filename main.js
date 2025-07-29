const generateBtn = document.getElementById("generateBtn");
const resultDiv = document.getElementById("result");
const promptInput = document.getElementById("prompt");

generateBtn.addEventListener("click", async () => {
  const prompt = promptInput.value;
  if (!prompt) {
    alert("Please enter a prompt.");
    return;
  }

  generateBtn.disabled = true;
  generateBtn.innerText = "Generating...";

  try {
    const response = await fetch("https://novaai-backend-v2.onrender.com/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    const data = await response.json();

    if (data.image) {
      const img = document.createElement("img");
      img.src = data.image;
      img.alt = "Generated Image";
      img.classList.add("generated-image");

      resultDiv.innerHTML = "";
      resultDiv.appendChild(img);
    } else {
      resultDiv.innerHTML = "❌ No image returned.";
    }
  } catch (error) {
    console.error("Error:", error);
    resultDiv.innerHTML = "❌ Error generating image.";
  } finally {
    generateBtn.disabled = false;
    generateBtn.innerText = "Generate";
  }
});
