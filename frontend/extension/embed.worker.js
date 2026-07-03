import { pipeline, env } from "./lib/transformers.min.js";

// Point ONNX runtime at our locally-bundled WASM files so nothing is fetched
// from a CDN at runtime. Model weights still download from HuggingFace on first
// use and are cached by the browser's Cache API.
env.backends.onnx.wasm.wasmPaths = new URL("./lib/", self.location.href).href;
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1; // ← disable multi-threading
env.backends.onnx.wasm.proxy = false; // ← don't proxy through a blob worker

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let extractor = null;
let loadingPromise = null;
const queue = [];

async function loadModel() {
  if (extractor) return extractor;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    self.postMessage({ type: "status", message: "Downloading smart search model…" });
    extractor = await pipeline("feature-extraction", MODEL_ID, {
      quantized: true,
      progress_callback: (progress) => {
        if (progress.status === "progress") {
          self.postMessage({
            type: "download_progress",
            file: progress.file,
            loaded: progress.loaded,
            total: progress.total,
          });
        }
      },
    });
    self.postMessage({ type: "status", message: "ready" });
    return extractor;
  })();

  return loadingPromise;
}

async function embed(text) {
  const model = await loadModel();
  const output = await model(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

// Drain the queue once the model is ready.
async function processQueue() {
  for (const { id, text, resolve, reject } of queue) {
    try {
      resolve(await embed(text));
    } catch (e) {
      reject(e);
    }
  }
  queue.length = 0;
}

self.addEventListener("message", async ({ data }) => {
  const { id, text } = data;
  try {
    const vector = await embed(text);
    self.postMessage({ id, vector });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
});

// Kick off model loading immediately when the worker starts so it's ready by
// the time the user triggers their first search.
loadModel().catch(() => {});
