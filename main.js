// Browser interface: read form values, preview images, and display Ollama results.
// The browser calls Ollama directly; no application server is required.
// Open index.html with Live Server for a localhost/127.0.0.1 page origin.
// If the browser blocks requests, allow that origin via OLLAMA_ORIGINS
// and restart Ollama. See https://docs.ollama.com/faq for configuration.
const OLLAMA_API_URL = "http://localhost:11434/api";
const OLLAMA_TAG = "http://localhost:11434/api/tags";

// A short helper finds an element by its HTML id.
const $ = (id) => document.getElementById(id);
// Keep the selected base64 image in memory; track requests and their cancel signal.
let image = null;
let busy = false;
let controller;
let checkingModels = false;
let visionModels = [];

// Each task supplies a starting prompt; user instructions are appended on submit.
const prompts = {
  extract:
    "Transcribe all visible text. Preserve reading order, line breaks and tables where possible. Return only extracted text. Mark unclear words as [unclear]. Do not invent missing text.",
  describe:
    "Describe this image accurately: its subjects, setting, and notable details. Do not invent details.",
};

// Keep buttons and inputs consistent with the selected image and request state.
function sync() {
  $("generate").disabled =
    busy || checkingModels || !image || !visionModels.includes($("model").value);
  for (const id of ["file", "remove", "mode", "instructions"])
    $(id).disabled = busy;
  $("model").disabled = busy || checkingModels || !visionModels.length;
  $("refresh").disabled = busy || checkingModels;
  $("cancel").hidden = !busy;
  $("copy").disabled = $("save").disabled = busy || !$("result").value;
}

// /tags lists installed names; /show reports capabilities for each model.
// Only confirmed vision models are offered; failed checks are never guessed by name.
async function check() {
  if (busy || checkingModels) return;
  const previousModel = $("model").value;
  checkingModels = true;
  visionModels = [];
  $("model").replaceChildren(new Option("Checking vision models...", ""));
  $("connection").textContent = "Checking installed vision models...";
  sync();
  try {
    const response = await fetch(OLLAMA_TAG, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error);
    // Check models independently so one failed lookup does not hide valid models.
    const checks = await Promise.allSettled(
      data.models.map(async (model) => {
        const response = await fetch(`${OLLAMA_API_URL}/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: model.name }),
          signal: AbortSignal.timeout(10000),
        });
        const details = await response.json();
        if (!response.ok) throw Error(details.error || "Model lookup failed.");
        if (!Array.isArray(details.capabilities)) {
          throw Error("Model capabilities are unavailable.");
        }
        return details.capabilities.includes("vision") ? model.name : null;
      }),
    );
    visionModels = checks
      .filter((check) => check.status === "fulfilled" && check.value)
      .map((check) => check.value);
    const failed = checks.filter((check) => check.status === "rejected").length;
    $("model").replaceChildren(
      ...visionModels.map((name) => new Option(name, name)),
    );
    if (visionModels.length) {
      // Preserve the user's selection, then prefer Gemma 4 when first connecting.
      $("model").value = visionModels.includes(previousModel)
        ? previousModel
        : visionModels.find((name) => name === "gemma4" || name === "gemma4:latest")
          || visionModels[0];
    } else {
      $("model").replaceChildren(new Option("No confirmed vision models available", ""));
    }
    $("connection").textContent =
      `Ollama connected - ${visionModels.length} vision model(s) available.` +
      (failed ? ` Could not verify ${failed} model(s); check again or update Ollama.` : "") +
      (!visionModels.length && !failed ? " Install a vision model, then check again." : "");
  } catch {
    $("model").replaceChildren(new Option("Vision models unavailable", ""));
    $("connection").textContent =
      "Cannot connect to Ollama. Start Ollama and check its browser origin permissions.";
  } finally {
    checkingModels = false;
    sync();
  }
}

// Validate the file, confirm the browser can decode it, then show its preview.
async function choose(file) {
  if (busy || !file) return;
  $("error").textContent = "";
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    !file.size ||
    file.size > 10 * 1024 * 1024
  ) {
    $("error").textContent =
      "Choose a valid PNG, JPEG, or WebP image up to 10 MB.";
    return;
  }
  try {
    // A data URL supports the preview; Ollama receives only its base64 payload.
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    const decoded = new Image();
    decoded.src = data;
    await decoded.decode();
    if (busy) return;
    image = data.split(",")[1];
    $("preview").src = data;
    $("filename").textContent = file.name;
    $("preview-wrap").hidden = false;
    $("dropzone").hidden = true;
    $("result").value = "";
    $("status").textContent = "Ready when you are";
    sync();
  } catch {
    $("error").textContent = "This image could not be opened.";
  }
}

// File selection and drag-and-drop share the same image-loading function.
$("file").addEventListener("change", (e) => choose(e.target.files[0]));
for (const name of ["dragover", "dragleave", "drop"])
  $("dropzone").addEventListener(name, (e) => {
    e.preventDefault();
    $("dropzone").classList.toggle("dragging", name === "dragover");
    if (name === "drop") choose(e.dataTransfer.files[0]);
  });

// Clear both the image and its previous output when the user removes it.
$("remove").onclick = () => {
  image = null;
  $("file").value = "";
  $("preview").removeAttribute("src");
  $("preview-wrap").hidden = true;
  $("dropzone").hidden = false;
  $("result").value = "";
  $("status").textContent = "Ready when you are";
  sync();
};

// Cancel closes the browser's direct request to Ollama.
$("refresh").onclick = check;
$("model").onchange = sync;
$("cancel").onclick = () => controller?.abort();

// Submit one image and task directly to Ollama; wait for the complete response.
$("form").onsubmit = async (e) => {
  e.preventDefault();
  if (busy || checkingModels || !image || !visionModels.includes($("model").value)) return;
  const instructions = $("instructions").value.trim();
  busy = true;
  controller = new AbortController();
  sync();
  $("result").value = "";
  $("error").textContent = "";
  $("status").textContent =
    "Reading your image� The model may take a moment to load.";
  try {
    const response = await fetch(`${OLLAMA_API_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]),
      body: JSON.stringify({
        model: $("model").value.trim(),
        messages: [
          {
            role: "user",
            // Optional instructions or questions apply to OCR and description.
            content:
              prompts[$("mode").value] +
              (instructions ? "\nAdditional instructions: " + instructions : ""),
            // Ollama expects the raw base64 payload, without a data URL prefix.
            images: [image],
          },
        ],
        stream: false,
        options: { temperature: 0.1 },
      }),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Generation failed.");
    if (!data.message?.content?.trim()) {
      throw Error("Ollama returned no text. Check that your model supports images.");
    }
    $("result").value = data.message.content;
    $("status").textContent = "Complete";
  } catch (error) {
    $("status").textContent =
      error.name === "AbortError" ? "Cancelled" : "Generation failed";
    if (error.name !== "AbortError") {
      $("error").textContent =
        error.name === "TimeoutError"
          ? "Ollama took longer than five minutes. Try again or use a smaller image."
          : error instanceof TypeError
            ? "Cannot reach Ollama. Check that it is running and allows this page's origin."
            : error.message;
    }
  } finally {
    // Restore controls after success, failure, or cancellation.
    busy = false;
    sync();
  }
};

// Export the displayed result through the clipboard or a plain-text download.
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("result").value);
    $("status").textContent = "Copied";
  } catch {
    $("error").textContent =
      "Select and copy the result manually; clipboard unavailable.";
  }
};
$("save").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([$("result").value], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "image-to-text.txt";
  a.click();
  // Release the temporary download URL once the browser has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
// Check the connection as soon as the deferred script runs after HTML parsing.
check();
