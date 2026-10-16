// Browser interface: read form values, preview images, and display Ollama results.
// The browser calls Ollama directly; no application server is required.
// Open index.html with Live Server for a localhost/127.0.0.1 page origin.
// If the browser blocks requests, allow that origin via OLLAMA_ORIGINS
// and restart Ollama. See https://docs.ollama.com/faq for configuration.
const OLLAMA_API_URL = "http://localhost:11434/api";
const OLLAMA_TAG = "http://localhost:11434/api/tags";

// FOLLOW THE WORKFLOW:
// 1. check() finds installed models that accept images.
// 2. choose(file) reads the user's image and prepares its base64 representation.
// 3. The form's onsubmit handler sends the image and task to /api/chat.
// 4. requestOllama() parses JSON; data.message.content contains the answer.
// 5. The answer becomes literal OCR text or filtered HTML in the result panel.

// A short helper finds an element by its HTML id.
const $ = (id) => document.getElementById(id);
// Keep the selected base64 image in memory; track requests and their cancel signal.
let image = null;
let busy = false;
let controller;
let checkingModels = false;
let visionModels = [];
let loadingImage = false;
let imageSelection = 0;

// Parse Ollama responses consistently and preserve useful model/server errors.
async function requestOllama(url, options = {}) {
  // fetch() returns a Promise: await waits without freezing the page.
  // Network/CORS failures reject it, but HTTP errors such as 404 still return
  // a Response. That is why response.ok must be checked separately below.
  const response = await fetch(url, options);
  let data;
  try {
    // JSON arrives as bytes/text; .json() converts it into a JavaScript object.
    data = await response.json();
  } catch {
    throw Error(`Ollama returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok || data.error) {
    throw Error(data.error || `Ollama request failed (HTTP ${response.status}).`);
  }
  return data;
}

// Each task supplies a starting prompt; user instructions are appended on submit.
const prompts = {
  extract:
    "Transcribe all visible text. Preserve reading order, line breaks and tables where possible. Return only extracted text. Mark unclear words as [unclear]. Do not invent missing text.",
  describe:
    "Describe this image accurately: its subjects, setting, and notable details. Do not invent details. Format your response as an HTML fragment: use <p> for paragraphs, <strong> for bold labels, <em> for emphasis, and <ul>/<li> for lists. Use HTML tags instead of Markdown asterisks. Do not include Markdown code fences, scripts, styles, or a full HTML document.",
};

// Read visible words for clipboard and .txt exports, without HTML markup.
function resultText() {
  return $("result").innerText || $("result").textContent || "";
}

// Model output is untrusted. Rebuild only simple formatting tags, without attributes.
// Scripts, links, images, styles, and event handlers never enter the live page.
function renderDescription(html) {
  $("result").classList.add("formatted");
  // A textarea cannot render <strong>. Our result element is a normal <div>.
  // Parse into a separate document, then copy only the allowed formatting nodes.
  // Do not replace this with result.innerHTML = html: generated markup may be unsafe.
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const allowed = new Set([
    "P", "BR", "STRONG", "B", "EM", "I", "UL", "OL", "LI",
    "H2", "H3", "H4", "BLOCKQUOTE", "PRE", "CODE",
  ]);
  const blocked = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "SVG", "MATH", "TEMPLATE"]);
  function clean(node) {
    if (node.nodeType === 3) return document.createTextNode(node.textContent);
    if (node.nodeType !== 1 || blocked.has(node.tagName)) {
      return document.createDocumentFragment();
    }
    const target = allowed.has(node.tagName)
      ? document.createElement(node.tagName.toLowerCase())
      : document.createDocumentFragment();
    for (const child of node.childNodes) target.append(clean(child));
    return target;
  }
  // replaceChildren updates the live DOM, so the browser paints the formatted answer.
  // CSS supplies spacing and bold weight; markup controls paragraphs and emphasis.
  $("result").replaceChildren(...Array.from(parsed.body.childNodes, clean));
}

// Keep buttons and inputs consistent with the selected image and request state.
function sync() {
  $("generate").disabled =
    busy ||
    loadingImage ||
    checkingModels ||
    !image ||
    !visionModels.includes($("model").value);
  $("generate").textContent = busy
    ? "Processing image..."
    : $("mode").value === "extract"
      ? "Extract text"
      : "Describe image";
  for (const id of ["file", "remove", "mode", "instructions"])
    $(id).disabled = busy;
  $("model").disabled = busy || checkingModels || !visionModels.length;
  $("refresh").disabled = busy || checkingModels;
  $("cancel").hidden = !busy;
  $("copy").disabled = $("save").disabled = busy || !resultText().trim();
}

// /tags lists installed names; /show reports capabilities for each model.
// Only confirmed vision models are offered; failed checks are never guessed by name.
// A vision/multimodal model accepts image input as well as text. A text-only model
// cannot interpret pixels just because we include an image in its prompt.
// Gemma 4 is our preferred selection, but the exact installed tag and capabilities
// matter: /show must report "vision". Names and parameter counts are not proof.
async function check() {
  if (busy || checkingModels) return;
  const previousModel = $("model").value;
  checkingModels = true;
  visionModels = [];
  $("model").replaceChildren(new Option("Checking vision models...", ""));
  $("connection").textContent = "Checking installed vision models...";
  sync();
  try {
    const data = await requestOllama(OLLAMA_TAG, {
      signal: AbortSignal.timeout(10000),
    });
    if (!Array.isArray(data.models)) {
      throw Error("Ollama did not return a model list.");
    }
    // Check models independently so one failed lookup does not hide valid models.
    const checks = await Promise.allSettled(
      data.models.map(async (model) => {
        const details = await requestOllama(`${OLLAMA_API_URL}/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: model.name }),
          signal: AbortSignal.timeout(10000),
        });
        if (!Array.isArray(details.capabilities)) {
          throw Error("Model capabilities are unavailable.");
        }
        // Example: { capabilities: ["completion", "vision"] } passes this check.
        // Missing capabilities or a failed lookup excludes a model until rechecked.
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
  } catch (error) {
    $("model").replaceChildren(new Option("Vision models unavailable", ""));
    $("connection").textContent =
      `Cannot load models: ${error.message} Start Ollama and check its browser origin permissions.`;
  } finally {
    checkingModels = false;
    sync();
  }
}

// Validate the file, confirm the browser can decode it, then show its preview.
// The file picker/drop event gives us a File object, not a usable server file path.
// Browser privacy rules mean Ollama cannot read the user's path on our behalf;
// this app reads the selected file and includes its actual image bytes in JSON.
async function choose(file) {
  if (busy || !file) return;
  // A newer file selection supersedes any earlier FileReader/decode operation.
  const selection = ++imageSelection;
  loadingImage = false;
  $("error").textContent = "";
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    !file.size ||
    file.size > 10 * 1024 * 1024
  ) {
    $("error").textContent =
      "Choose a valid PNG, JPEG, or WebP image up to 10 MB.";
    sync();
    return;
  }
  loadingImage = true;
  $("status").textContent = "Opening image...";
  sync();
  try {
    // readAsDataURL turns the bytes into a string such as:
    // "data:image/png;base64,iVBORw0KGgo..."
    // Base64 encodes binary data using text characters so it can travel in JSON.
    // It does not compress the image; it increases its encoded size by roughly 1/3.
    // A data URL supports the preview; Ollama receives only its base64 payload.
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.onabort = reject;
      r.readAsDataURL(file);
    });
    const decoded = new Image();
    decoded.src = data;
    // MIME type/size checks alone cannot prove the file is a decodable image.
    await decoded.decode();
    if (selection !== imageSelection || busy) return;
    // Strip "data:image/...;base64," for Ollama; keep the full URL for <img src>.
    image = data.split(",")[1];
    $("preview").src = data;
    $("filename").textContent = file.name;
    $("preview-wrap").hidden = false;
    $("dropzone").hidden = true;
    $("result").textContent = "";
    $("status").textContent = "Ready when you are";
    sync();
  } catch {
    if (selection === imageSelection) {
      $("error").textContent = "This image could not be opened.";
      $("status").textContent = "Image could not be opened";
    }
  } finally {
    if (selection === imageSelection) {
      loadingImage = false;
      sync();
    }
  }
}

// File selection and drag-and-drop share the same image-loading function.
$("file").addEventListener("change", (e) => choose(e.target.files[0]));
for (const name of ["dragover", "dragleave", "drop"])
  $("dropzone").addEventListener(name, (e) => {
    // Suppress the browser's normal action of opening the dropped file as a page.
    e.preventDefault();
    $("dropzone").classList.toggle("dragging", name === "dragover");
    if (name === "drop") choose(e.dataTransfer.files[0]);
  });

// Clear both the image and its previous output when the user removes it.
$("remove").onclick = () => {
  imageSelection++;
  loadingImage = false;
  image = null;
  $("file").value = "";
  $("preview").removeAttribute("src");
  $("preview-wrap").hidden = true;
  $("dropzone").hidden = false;
  $("result").textContent = "";
  $("status").textContent = "Ready when you are";
  sync();
};

// Cancel closes the browser's direct request to Ollama.
$("refresh").onclick = check;
$("model").onchange = sync;
$("mode").onchange = sync;
$("cancel").onclick = () => controller?.abort();

// Submit one image and task directly to Ollama; wait for the complete response.
$("form").onsubmit = async (e) => {
  // A normal form submission reloads the page. Handle it in JavaScript instead.
  e.preventDefault();
  if (busy || loadingImage || checkingModels) return;
  if (!image || !visionModels.includes($("model").value)) {
    $("error").textContent = "Choose an image and an available vision model first.";
    return;
  }
  if (!Object.hasOwn(prompts, $("mode").value)) {
    $("error").textContent = "Choose Extract text or Describe an image.";
    return;
  }
  const instructions = $("instructions").value.trim();
  busy = true;
  controller = new AbortController();
  sync();
  $("result").textContent = "";
  $("error").textContent = "";
  $("status").textContent =
    "Reading your image... The model may take a moment to load.";
  try {
    // POST /api/chat expects JSON shaped like:
    // { model: "gemma4:latest", messages: [
    //   { role: "user", content: "Describe this image", images: ["<base64>"] }
    // ], stream: false, options: { temperature: 0.1 } }
    // model must match an installed tag; images belongs inside the user message.
    // JSON.stringify serializes the object; Content-Type tells Ollama it is JSON.
    const data = await requestOllama(`${OLLAMA_API_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Either the Cancel button or a five-minute timeout can end the request.
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
        // false asks for one complete JSON response, which .json() can read.
        // true would require reading successive newline-delimited JSON chunks.
        stream: false,
        // A low temperature encourages more consistent wording, not guaranteed accuracy.
        options: { temperature: 0.1 },
      }),
    });
    // The answer is nested: { message: { role: "assistant", content: "..." } }.
    // Use message.content, not data.text or the entire response object.
    // ?. avoids a crash if fields are absent; trim() catches blank answers.
    if (!data.message?.content?.trim()) {
      throw Error("Ollama returned no text. Check that your model supports images.");
    }
    if ($("mode").value === "describe") {
      renderDescription(data.message.content);
    } else {
      // OCR stays literal: text resembling HTML in the image must not become markup.
      // textContent displays words safely and replaces the previous answer.
      // CSS white-space: pre-wrap preserves the model's line breaks for OCR.
      $("result").classList.remove("formatted");
      $("result").textContent = data.message.content;
    }
    $("status").textContent = "Complete";
  } catch (error) {
    // TROUBLESHOOTING: open browser DevTools (F12), then inspect Console and Network.
    // Look at the failing /tags, /show, or /chat request, its HTTP status and response.
    // - Connection refused: start Ollama; confirm localhost:11434/api/tags responds.
    // - CORS/403: use Live Server; allow the page's exact origin (scheme, host, port)
    //   through OLLAMA_ORIGINS, then restart Ollama. Changing fetch to no-cors does
    //   not help: an opaque response cannot be read by this JavaScript.
    // - Model not found: compare the requested tag with `ollama list`, then refresh.
    // - No vision options: inspect /show capabilities; install a vision model or
    //   update Ollama if capability metadata is unavailable.
    // - Memory/loading errors: inspect Ollama logs; try a model your hardware can run.
    // - Timeout: initial model loading may be slow; try a smaller model/image.
    // - Poor OCR: use a clear, upright, tightly cropped image; review the result.
    // AbortError is an intentional Cancel; TimeoutError is the time limit.
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
    // finally runs even when an exception occurs, keeping the app usable for retry.
    busy = false;
    controller = null;
    sync();
  }
};

// Export the displayed result through the clipboard or a plain-text download.
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(resultText());
    $("status").textContent = "Copied";
  } catch {
    $("error").textContent =
      "Select and copy the result manually; clipboard unavailable.";
  }
};
$("save").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([resultText()], { type: "text/plain;charset=utf-8" }),
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
