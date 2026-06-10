/**
 * ai.js
 * Local inference via Transformers.js. Handles model load, generation, streaming.
 * Includes resilient model loading with shared in-flight requests, backend/dtype
 * fallback, progress normalization, diagnostics, and a browser-helper fallback so
 * users are never trapped behind a failed model download.
 */

import { pipeline, TextStreamer, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.1.2';

export const MODELS = {
  'HuggingFaceTB/SmolLM2-360M-Instruct': {
    name: 'SmolLM2 360M',
    desc: 'Fast, lightweight — best first download for most browsers',
    size: '~360MB',
    dtype: 'q4f16',
    fallbacks: ['q4f16', 'q4', 'q8'],
  },
  'Qwen/Qwen2.5-0.5B-Instruct': {
    name: 'Qwen2.5 0.5B',
    desc: 'Slightly larger, better reasoning',
    size: '~500MB',
    dtype: 'q4',
    fallbacks: ['q4', 'q4f16', 'q8'],
  },
  'onnx-community/Phi-3.5-mini-instruct-onnx-web': {
    name: 'Phi-3.5 Mini',
    desc: 'Most capable, needs more RAM and patience',
    size: '~2.3GB',
    dtype: 'q4',
    fallbacks: ['q4', 'q4f16'],
  },
};

export const DEFAULT_MODEL = 'HuggingFaceTB/SmolLM2-360M-Instruct';

export const DEFAULT_GEN = {
  temperature: 0.7,
  max_new_tokens: 512,
  top_p: 0.9,
  repetition_penalty: 1.1,
  do_sample: true,
};

export const DEFAULT_SYSTEM = [
  'You are LocalMind, a helpful, honest, and concise AI assistant running privately inside the user\'s browser.',
  'You can explain browser capabilities, offline model status, downloads, storage, and privacy clearly.',
  'If the user asks for current web facts, say you do not have live browsing unless the page/app provides that data.',
].join(' ');

let pipe = null;
let loadedModel = null;
let loading = false;
let loadingModel = null;
let loadingPromise = null;
let stopFlag = false;
let lastError = null;
let fallbackMode = false;

function setupEnv() {
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.useIndexedDB = true;
}

function normalizeProgress(update, modelId, attempt = {}) {
  const progress = Number.isFinite(update?.progress) ? update.progress : undefined;
  return {
    ...update,
    modelId,
    device: attempt.device,
    dtype: attempt.dtype,
    progress,
    text: update?.text,
  };
}

function devicesForBrowser() {
  const devices = [];
  if ('gpu' in navigator) devices.push('webgpu');
  devices.push('wasm');
  return devices;
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function friendlyLoadError(err, attempts) {
  const tried = attempts.map(a => `${a.device}/${a.dtype}`).join(', ');
  const message = err?.message || String(err);
  return new Error([
    `Could not finish loading the local AI model. Tried ${tried}.`,
    message,
    'Check that you are online for the first download, have enough free browser storage, and are using a recent Chrome/Edge browser. You can still use Browser Helper mode for diagnostics.',
  ].join(' '));
}

export async function loadModel(modelId = DEFAULT_MODEL, onProgress = () => {}) {
  if (loadedModel === modelId && pipe) {
    fallbackMode = false;
    onProgress({ status: 'ready', progress: 100, modelId });
    return;
  }

  if (loading && loadingPromise) {
    if (loadingModel === modelId) return loadingPromise;
    throw new Error(`Already loading ${MODELS[loadingModel]?.name || loadingModel}. Please wait or cancel before switching models.`);
  }

  const cfg = MODELS[modelId];
  if (!cfg) throw new Error(`Unknown model: ${modelId}`);

  setupEnv();
  loading = true;
  loadingModel = modelId;
  fallbackMode = false;
  lastError = null;
  pipe = null;
  loadedModel = null;

  loadingPromise = (async () => {
    const attempts = [];
    onProgress({ status: 'initiate', progress: 0, modelId, text: `Preparing ${cfg.name}…` });

    for (const device of devicesForBrowser()) {
      const dtypes = device === 'wasm' ? unique(['q8', 'q4', cfg.dtype, ...(cfg.fallbacks || [])]) : unique([cfg.dtype, ...(cfg.fallbacks || [])]);
      for (const dtype of dtypes) {
        const attempt = { device, dtype };
        attempts.push(attempt);
        try {
          onProgress({ status: 'initiate', progress: 0, modelId, device, dtype, text: `Loading ${cfg.name} with ${device.toUpperCase()} (${dtype})…` });
          pipe = await pipeline('text-generation', modelId, {
            dtype,
            device,
            progress_callback: update => onProgress(normalizeProgress(update, modelId, attempt)),
          });
          loadedModel = modelId;
          fallbackMode = false;
          onProgress({ status: 'ready', progress: 100, modelId, device, dtype, text: `${cfg.name} is ready.` });
          return;
        } catch (err) {
          lastError = err;
          console.warn(`[AI] ${modelId} failed on ${device}/${dtype}:`, err);
          pipe = null;
          loadedModel = null;
          onProgress({ status: 'retry', progress: 0, modelId, device, dtype, text: `${device.toUpperCase()} ${dtype} failed. Trying another runtime…` });
        }
      }
    }

    throw friendlyLoadError(lastError, attempts);
  })();

  try {
    return await loadingPromise;
  } finally {
    loading = false;
    loadingModel = null;
    loadingPromise = null;
    if (!pipe) loadedModel = null;
  }
}

export async function generate(msgs, settings = {}, onToken = () => {}, onDone = () => {}) {
  stopFlag = false;

  if (!pipe) {
    const answer = await generateFallback(msgs, settings, onToken, onDone);
    return answer;
  }

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

async function generateFallback(msgs, settings, onToken, onDone) {
  fallbackMode = true;
  const last = [...msgs].reverse().find(m => m.role === 'user')?.content || '';
  const diag = await browserDiagnostics();
  const lower = last.toLowerCase();
  let answer;

  if (lower.includes('download') || lower.includes('model') || lower.includes('stuck') || lower.includes('load')) {
    answer = `I can help diagnose the model download. The local LLM is not loaded yet, so I am using Browser Helper mode.\n\n${diag}\n\nTry this:\n1. Keep this tab open and online until the first model finishes.\n2. Use SmolLM2 360M first; it is the smallest supported model.\n3. Free browser storage if quota is low, then clear the model cache in Settings and retry.\n4. Use Chrome or Edge for WebGPU acceleration; CPU/WASM fallback is slower but should still work.\n5. If a corporate/ad blocker blocks cdn.jsdelivr.net or huggingface.co, allow those domains for the first download.`;
  } else if (lower.includes('browser') || lower.includes('storage') || lower.includes('webgpu') || lower.includes('offline')) {
    answer = `Here is what I can see from the browser right now:\n\n${diag}\n\nI can read these browser-provided capabilities and explain what they mean. For privacy, I cannot control other tabs or browse arbitrary pages unless the app adds an explicit web-search/browser connector.`;
  } else {
    answer = `I am in Browser Helper mode because the local AI model is not loaded yet. I can still help with setup, browser diagnostics, and app usage.\n\n${diag}\n\nAsk me about the model download, storage, WebGPU, offline use, or open Settings to retry the model.`;
  }

  const max = Number(settings.max_new_tokens || 512) * 4;
  answer = answer.slice(0, Math.max(500, max));
  for (const chunk of answer.match(/.{1,18}(\s|$)/g) || [answer]) {
    if (stopFlag) break;
    onToken(chunk);
    await new Promise(r => setTimeout(r, 8));
  }
  onDone(answer);
  return answer;
}

export async function browserDiagnostics() {
  const parts = [];
  parts.push(`- Online: ${navigator.onLine ? 'yes' : 'no'}`);
  parts.push(`- WebGPU: ${'gpu' in navigator ? 'available' : 'not available'}`);
  parts.push(`- WebAssembly: ${typeof WebAssembly !== 'undefined' ? 'available' : 'not available'}`);
  parts.push(`- Browser: ${navigator.userAgent}`);
  if (navigator.storage?.estimate) {
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      parts.push(`- Storage used: ${(usage / 1048576).toFixed(0)} MB`);
      parts.push(`- Storage quota: ${(quota / 1048576).toFixed(0)} MB`);
    } catch {
      parts.push('- Storage estimate: unavailable');
    }
  }
  if (lastError) parts.push(`- Last model error: ${lastError.message || String(lastError)}`);
  return parts.join('\n');
}

export function stop() { stopFlag = true; }
export function isLoaded() { return pipe !== null && loadedModel !== null; }
export function isFallback() { return fallbackMode; }
export function getModelId() { return loadedModel; }
export function isLoading() { return loading; }
export function getLoadingModelId() { return loadingModel; }
export function getLastError() { return lastError; }

export async function isCached(modelId) {
  try {
    if (!('caches' in window)) return false;
    const keys = await caches.keys();
    const slug = modelId.toLowerCase();
    const tail = modelId.split('/').pop()?.toLowerCase() || '';
    for (const key of keys) {
      const c = await caches.open(key);
      const reqs = await c.keys();
      if (reqs.some(r => {
        const u = r.url.toLowerCase();
        return u.includes(slug) || u.includes(tail);
      })) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function clearCache() {
  if ('caches' in window) {
    const keys = await caches.keys();
    for (const key of keys) {
      if (key.includes('transformers') || key.includes('huggingface') || key.includes('lm-models') || key.includes('lm-rt')) {
        await caches.delete(key);
      }
    }
  }
  pipe = null;
  loadedModel = null;
  fallbackMode = false;
}

export function withSystem(msgs, prompt = DEFAULT_SYSTEM) {
  if (!prompt || msgs.some(m => m.role === 'system')) return msgs;
  return [{ role: 'system', content: prompt }, ...msgs];
}
