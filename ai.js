/**
 * ai.js
 * Local inference via Transformers.js. Handles model load, generation, streaming.
 * Architecture: single pipeline instance, swapped on model change.
 * Worker-less for now (main thread) — offload to SharedWorker in v2 if jank appears.
 */

import { pipeline, TextStreamer, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.1.2';

// supported models + their quantization hints
export const MODELS = {
  'HuggingFaceTB/SmolLM2-360M-Instruct': {
    name: 'SmolLM2 360M',
    desc: 'Fast, lightweight — good for most tasks',
    size: '~360MB',
    dtype: 'q4f16',
  },
  'Qwen/Qwen2.5-0.5B-Instruct': {
    name: 'Qwen2.5 0.5B',
    desc: 'Slightly larger, better reasoning',
    size: '~500MB',
    dtype: 'q4',
  },
  'onnx-community/Phi-3.5-mini-instruct-onnx-web': {
    name: 'Phi-3.5 Mini',
    desc: 'Most capable, needs more RAM',
    size: '~2.3GB',
    dtype: 'q4',
  },
};

export const DEFAULT_GEN = {
  temperature: 0.7,
  max_new_tokens: 512,
  top_p: 0.9,
  repetition_penalty: 1.1,
  do_sample: true,
};

export const DEFAULT_SYSTEM = 'You are a helpful, honest, and concise AI assistant.';

// module-level state — one pipe at a time
let pipe = null;
let loadedModel = null;
let loading = false;
let stopFlag = false;

function setupEnv() {
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  env.useIndexedDB = true;
}

// load (or swap) the active model
export async function loadModel(modelId, onProgress = () => {}) {
  if (loadedModel === modelId && pipe) {
    onProgress({ status: 'ready', progress: 100 });
    return;
  }

  if (loading) throw new Error('Already loading a model, please wait.');

  const cfg = MODELS[modelId];
  if (!cfg) throw new Error(`Unknown model: ${modelId}`);

  loading = true;
  pipe = null;
  loadedModel = null;

  try {
    setupEnv();
    onProgress({ status: 'initiate', progress: 0, text: 'Connecting…' });

    // try WebGPU first, fall back to WASM
    try {
      pipe = await pipeline('text-generation', modelId, {
        dtype: cfg.dtype || 'q4',
        device: 'webgpu',
        progress_callback: onProgress,
      });
    } catch (gpuErr) {
      console.warn('WebGPU failed, using WASM:', gpuErr.message);
      onProgress({ status: 'initiate', progress: 0, text: 'Falling back to CPU…' });
      pipe = await pipeline('text-generation', modelId, {
        dtype: 'q4',
        device: 'wasm',
        progress_callback: onProgress,
      });
    }

    loadedModel = modelId;
    onProgress({ status: 'ready', progress: 100 });
  } finally {
    loading = false;
    if (!pipe) { loadedModel = null; }
  }
}

// streaming generation — uses TextStreamer for real token callbacks
export async function generate(msgs, settings = {}, onToken = () => {}, onDone = () => {}) {
  if (!pipe) throw new Error('No model loaded.');

  stopFlag = false;
  let output = '';

  const streamer = new TextStreamer(pipe.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (token) => {
      if (stopFlag) return;
      output += token;
      onToken(token);
    },
  });

  const opts = {
    ...DEFAULT_GEN,
    ...settings,
    streamer,
    return_full_text: false,
  };

  try {
    await pipe(msgs, opts);
  } catch (err) {
    if (stopFlag) {
      onDone(output + ' ▪');
      return output;
    }
    throw err;
  }

  onDone(output);
  return output;
}

export function stop() {
  stopFlag = true;
}

export function isLoaded() {
  return pipe !== null && loadedModel !== null;
}

export function getModelId() {
  return loadedModel;
}

export function isLoading() {
  return loading;
}

// rough cache check — looks for model name in Transformers.js cache buckets
export async function isCached(modelId) {
  try {
    if (!('caches' in window)) return false;
    const keys = await caches.keys();
    const slug = modelId.split('/')[1]?.toLowerCase() || '';
    for (const key of keys) {
      const c = await caches.open(key);
      const reqs = await c.keys();
      if (reqs.some(r => r.url.toLowerCase().includes(slug))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function clearCache() {
  const keys = await caches.keys();
  for (const key of keys) {
    if (key.includes('transformers') || key.includes('huggingface')) {
      await caches.delete(key);
    }
  }
  pipe = null;
  loadedModel = null;
}

// prepend system prompt if not already there
export function withSystem(msgs, prompt = DEFAULT_SYSTEM) {
  if (!prompt || msgs.some(m => m.role === 'system')) return msgs;
  return [{ role: 'system', content: prompt }, ...msgs];
}
