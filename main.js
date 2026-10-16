// Browser interface: read form values, preview images, and display Ollama results.
// The browser calls Ollama directly; no application server is required.
// Open index.html with Live Server for a localhost/127.0.0.1 page origin.
// If the browser blocks requests, allow that origin via OLLAMA_ORIGINS
// and restart Ollama. See https://docs.ollama.com/faq for configuration.
const OLLAMA_API_URL = "http://localhost:11434/api";
const OLLAMA_TAG = "http://localhost:11434/api/tags";

// FOLLOW THE WORKFLOW:
// 1. check() finds installed models that accept images.
// 2. choose(files) prepares up to two images for previews and API requests.
// 3. The form sends each image and task to /api/chat in a separate request.
// 4. requestOllama() parses JSON; data.message.content contains the answer.
// 5. The answer becomes literal OCR text or filtered HTML in the result panel.

// A short helper finds an element by its HTML id.
const $ = (id) => document.getElementById(id);
// Keep the selected base64 image in memory; track requests and their cancel signal.
// Each entry is { name, data, base64 }: filename, full preview data URL, and API payload.
// This ordered array is the source of truth: images[0] is Image 1, images[1] is Image 2.
// Keeping preview and request loops in the same order makes their labels match.
let images = [];
let busy = false;
let controller;
let checkingModels = false;
let visionModels = [];
let loadingImage = false;


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
    // Read the whole result container, including every image heading and answer.
    // Copy/download therefore exports all responses together in their display order.
    return $("result").innerText || $("result").textContent || "";
}

// Model output is untrusted. Rebuild only simple formatting tags, without attributes.
// Scripts, links, images, styles, and event handlers never enter the live page.
function renderDescription(html, target) {
    // target is one image's output div, not the shared result container.
    // Formatting Image 2 must not overwrite Image 1's heading or completed answer.
    target.classList.add("formatted");
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
    target.replaceChildren(...Array.from(parsed.body.childNodes, clean));
}

// Keep buttons and inputs consistent with the selected image and request state.
function sync() {
    $("generate").disabled =
        busy ||
        loadingImage ||
        checkingModels ||
        !images.length ||
        !visionModels.includes($("model").value);
    $("generate").textContent = busy
        ? "Processing image..."
        : $("mode").value === "extract"
            ? "Extract text"
            : "Describe image";
    for (const id of ["file", "mode", "instructions"])
        $(id).disabled = busy;
    for (const button of $("previews").querySelectorAll("button")) {
        // Freeze removal while reading files or running the queue. Otherwise an
        // array index could change halfway through a request and labels could drift.
        button.disabled = busy || loadingImage;
    }
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

// Read one or two images. A second selection adds to the first (maximum two).
// Data URLs power previews; only the base64 portion is sent in JSON to Ollama.
async function choose(files) {
    if (busy || loadingImage || !files.length) return;
    const candidates = Array.from(files);
    // Count existing selections too: choosing one now and one later still totals two.
    if (images.length + candidates.length > 2) {
        $("error").textContent = "Choose up to two images. Remove an image before adding another.";
        $("file").value = "";
        return;
    }
    loadingImage = true;
    $("error").textContent = "";
    $("status").textContent = "Opening images...";
    sync();
    try {
        // Commit the selection only after every new file is validated and decoded.
        // A temporary array makes each selection atomic: if decoding one of the
        // new files fails, none of that selection is appended to the saved images.
        const prepared = [];
        for (const file of candidates) {
            if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
                !file.size || file.size > 10 * 1024 * 1024) {
                throw Error("Each image must be a PNG, JPEG, or WebP up to 10 MB.");
            }
            const data = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reader.onabort = () => reject(Error("Image could not be read."));
                reader.readAsDataURL(file);
            });
            const decoded = new Image();
            decoded.src = data;
            await decoded.decode();
            prepared.push({ name: file.name, data, base64: data.split(",")[1] });
        }
        // Append in picker/drop order; do not replace an image already selected.
        images.push(...prepared);
        renderPreviews();
        // Previous answers belonged to the previous selection; discard stale output.
        $("result").replaceChildren();
        $("status").textContent = "Ready when you are";
    } catch (error) {
        $("error").textContent = error.message || "An image could not be opened.";
        $("status").textContent = "Image selection failed";
    } finally {
        loadingImage = false;
        // Reset the picker so the same file can be selected again after removal.
        $("file").value = "";
        sync();
    }
}

// Array order determines both preview numbering and result numbering.
function renderPreviews() {
    // Two selections reserve two side-by-side response columns on wide screens.
    $("workspace").classList.toggle("two-images", images.length === 2);
    $("result").classList.toggle("two-images", images.length === 2);
    // Rebuild all cards so labels and removal handlers use the latest array indexes.
    $("previews").replaceChildren();
    images.forEach((image, index) => {
        const figure = document.createElement("figure");
        const preview = document.createElement("img");
        preview.src = image.data;
        preview.alt = `Image ${index + 1}: ${image.name}`;
        const caption = document.createElement("figcaption");
        // Arrays start at zero; people-facing labels start at one.
        caption.textContent = `Image ${index + 1}: ${image.name}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = `Remove Image ${index + 1}`;
        remove.onclick = () => {
            if (busy || loadingImage) return;
            // Remove exactly this entry, then renumber and clear the old answers.
            images.splice(index, 1);
            renderPreviews();
            $("result").replaceChildren();
            $("status").textContent = "Ready when you are";
            sync();
        };
        figure.append(preview, caption, remove);
        $("previews").append(figure);
    });
    $("dropzone").hidden = images.length === 2;
}

$("file").addEventListener("change", (event) => choose(event.target.files));
for (const name of ["dragover", "dragleave", "drop"]) {
    $("dropzone").addEventListener(name, (event) => {
        event.preventDefault();
        $("dropzone").classList.toggle("dragging", name === "dragover");
        if (name === "drop") choose(event.dataTransfer.files);
    });
}
// Cancel closes the browser's direct request to Ollama.
$("refresh").onclick = check;
$("model").onchange = sync;
$("mode").onchange = sync;
$("cancel").onclick = () => controller?.abort();

// Submit one or two images and label each separate response.
$("form").onsubmit = async (e) => {
    // A normal form submission reloads the page. Handle it in JavaScript instead.
    e.preventDefault();
    if (busy || loadingImage || checkingModels) return;
    if (!images.length || !visionModels.includes($("model").value)) {
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
        // Send every selected image in a separate request. This gives each image
        // its own answer, even with models that only accept one image per message.
        // Sequential requests reduce memory pressure and preserve numbering.
        // With one image, this loop runs once: no placeholder or request for Image 2.
        // With two, await finishes Image 1 before starting Image 2. These are two
        // independent requests, not a comparison prompt containing both images.
        // Build both panels immediately so Image 2 is visible while Image 1 runs.
        const outputs = images.map((image, index) => {
            const card = document.createElement("article");
            card.className = "image-result";
            const heading = document.createElement("h3");
            // The application writes this label; it does not rely on the AI to
            // remember numbering. Filenames use textContent so they remain plain text.
            heading.textContent = `Image ${index + 1}: ${image.name}`;
            const output = document.createElement("div");
            output.className = "image-output";
            output.textContent = "Waiting to process...";
            card.append(heading, output);
            // Append, rather than replace, so earlier completed answers remain visible.
            $("result").append(card);
            return output;
        });
        for (const [index, image] of images.entries()) {
            // A cancellation between requests prevents the next job from starting.
            controller.signal.throwIfAborted();
            const output = outputs[index];
            output.textContent = "Waiting for Ollama...";
            $("status").textContent = `Processing Image ${index + 1} of ${images.length}...`;
            try {
                // /chat takes a model tag and a user message containing raw base64.
                const data = await requestOllama(`${OLLAMA_API_URL}/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]),
                    body: JSON.stringify({
                        model: $("model").value,
                        messages: [{
                            role: "user",
                            content: prompts[$("mode").value] +
                                (instructions ? "\nAdditional instructions: " + instructions : ""),
                            // This request gets ONLY the current image's bytes.
                            // The next loop iteration sends the other image separately.
                            images: [image.base64],
                        }],
                        stream: false,
                        options: { temperature: 0.1 },
                    }),
                });
                // Non-streaming /chat returns the answer in message.content.
                if (!data.message?.content?.trim()) throw Error("Ollama returned no text.");
                if ($("mode").value === "describe") {
                    // Both HTML descriptions and literal OCR target their own card.
                    renderDescription(data.message.content, output);
                } else {
                    // OCR stays literal, including any HTML present in the source image.
                    output.textContent = data.message.content;
                }
            } catch (error) {
                // Show failure under the correct image. Earlier answers remain intact.
                // Rethrowing exits the loop: remaining images are not sent after a
                // failure or cancellation. The outer catch updates the overall status.
                output.textContent = error.name === "AbortError"
                    ? "Cancelled. No result generated."
                    : `Could not process this image: ${error.message}`;
                for (const waiting of outputs.slice(index + 1)) {
                    waiting.textContent = "Not processed because generation stopped.";
                }
                throw error;
            }
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
        // This runs once for the entire queue, not once per image, so controls
        // stay locked until all selected images finish or processing stops.
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
