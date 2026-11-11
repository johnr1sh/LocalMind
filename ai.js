/**
 * ai.js
 * Local inference via Transformers.js. Handles model load, generation, streaming.
 * Includes resilient model loading with shared in-flight requests, backend/dtype
 * fallback, aggregate progress, diagnostics, and a browser-helper fallback so
 * users are never trapped behind a failed model download.
 *
 * Every model below was checked against its Hugging Face repo: the `onnx/`
 * folder must contain `model_<dtype>.onnx` for each dtype we request, otherwise
 * Transformers.js gets a 404 and the model "downloads" forever / never loads.
 */

import {
  pipeline,
  TextStreamer,
  InterruptableStoppingCriteria,
  ModelRegistry,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';

/**
 * Per-model runtime plan.
 *  webgpu.dtype      -> used when the GPU reports shader-f16 (fast, smallest)
 *  webgpu.noF16Dtype -> used on WebGPU without shader-f16 (omit = skip WebGPU)
 *  wasm              -> CPU fallback (omit = model is WebGPU-only)
 * `mb` is the real download size of that file set (weights + external data).
 */
export const MODELS = {
  'HuggingFaceTB/SmolLM2-360M-Instruct': {
    name: 'SmolLM2 360M',
    desc: 'Fast, lightweight — safest first download for most browsers',
    size: '~300–420MB download',
    storageMB: 700,
    runtimeMB: 1200,
    minDeviceMemoryGB: 4,
    recommendedDeviceMemoryGB: 8,
    webgpu: { dtype: 'q4f16', mb: 300, noF16Dtype: 'q4', noF16Mb: 420 },
    wasm: { dtype: 'q4', mb: 420 },
  },
  // NOTE: the official Qwen/ repo has NO onnx/ folder (404). onnx-community has it.
  'onnx-community/Qwen2.5-0.5B-Instruct': {
    name: 'Qwen2.5 0.5B',
    desc: 'More capable, still reasonable on modern laptops',
    size: '~485–515MB download',
    storageMB: 900,
    runtimeMB: 1600,
    minDeviceMemoryGB: 6,
    recommendedDeviceMemoryGB: 8,
    webgpu: { dtype: 'q4f16', mb: 485 },
    wasm: { dtype: 'q8', mb: 515 },
  },
  // This repo only ships model_q4f16.onnx (+ .onnx_data) => WebGPU with shader-f16 only.
  'onnx-community/Phi-3.5-mini-instruct-onnx-web': {
    name: 'Phi-3.5 Mini',
    desc: 'Largest local model — WebGPU only, needs lots of free storage/RAM',
    size: '~2.3GB download (WebGPU only)',
    storageMB: 3600,
    runtimeMB: 3500,
    minDeviceMemoryGB: 8,
    recommendedDeviceMemoryGB: 16,
    webgpu: { dtype: 'q4f16', mb: 2320 },
    wasm: null,
  },
};

export const DEFAULT_MODEL = 'HuggingFaceTB/SmolLM2-360M-Instruct';

// Old saved settings / conversations may reference ids that never worked.
const LEGACY_IDS = {
  'Qwen/Qwen2.5-0.5B-Instruct': 'onnx-community/Qwen2.5-0.5B-Instruct',
};

export function normalizeModelId(id) {
  const mapped = LEGACY_IDS[id] || id;
  return MODELS[mapped] ? mapped : DEFAULT_MODEL;
}

export function formatMB(mb) {
  if (!Number.isFinite(mb)) return 'unknown';
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)}GB` : `${Math.round(mb)}MB`;
}

// ---- backend detection ----------------------------------------------------

let gpuProbe = null;

/** Real WebGPU probe: adapter must exist; also report shader-f16 support. */
export function probeWebGPU(force = false) {
  if (gpuProbe && !force) return gpuProbe;
  gpuProbe = (async () => {
    const none = { usable: false, f16: false };
    if (!navigator.gpu?.requestAdapter) return none;
    let timeoutId;
    try {
      const adapter = await Promise.race([
        navigator.gpu.requestAdapter(),
        new Promise(resolve => { timeoutId = setTimeout(() => resolve(null), 5000); }),
      ]);
      if (!adapter) return none;
      return { usable: true, f16: Boolean(adapter.features?.has('shader-f16')) };
    } catch {
      return none;
    } finally {
      clearTimeout(timeoutId);
    }
  })();
  return gpuProbe;
}

/** Ordered list of runtimes to try for a model on THIS device. */
export async function planFor(modelId) {
  const cfg = MODELS[modelId];
  const attempts = [];
  if (!cfg) return attempts;
  const gpu = await probeWebGPU();
  if (gpu.usable && cfg.webgpu) {
    if (gpu.f16 && cfg.webgpu.dtype) {
      attempts.push({ device: 'webgpu', dtype: cfg.webgpu.dtype, mb: cfg.webgpu.mb });
    } else if (cfg.webgpu.noF16Dtype) {
      attempts.push({ device: 'webgpu', dtype: cfg.webgpu.noF16Dtype, mb: cfg.webgpu.noF16Mb });
    }
  }
  if (cfg.wasm) attempts.push({ device: 'wasm', dtype: cfg.wasm.dtype, mb: cfg.wasm.mb });
  return attempts;
}

export async function systemHealth(modelId = DEFAULT_MODEL) {
  modelId = normalizeModelId(modelId);
  const cfg = MODELS[modelId];
  let usageMB = null;
  let quotaMB = null;
  let freeMB = null;
  let persisted = false;

  if (navigator.storage?.estimate) {
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      usageMB = usage / 1048576;
      quotaMB = quota / 1048576;
      freeMB = Math.max(0, quotaMB - usageMB);
    } catch {
      // Leave storage values unknown; the UI will explain that clearly.
    }
  }

  if (navigator.storage?.persisted) {
    try { persisted = await navigator.storage.persisted(); } catch { persisted = false; }
  }

  const deviceMemoryGB = Number.isFinite(navigator.deviceMemory) ? navigator.deviceMemory : null;
  const cores = Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : null;
  const gpu = await probeWebGPU();
  const webgpu = gpu.usable;
  const online = navigator.onLine;
  const cached = await isCached(modelId);
  const plan = await planFor(modelId);
  const downloadMB = plan[0]?.mb ?? cfg.webgpu?.mb ?? cfg.wasm?.mb ?? 0;
  const neededStorageMB = Math.max(cfg.storageMB, downloadMB * 1.6);

  const issues = [];
  const warnings = [];
  if (!plan.length) {
    issues.push(`${cfg.name} only runs on WebGPU with 16-bit shader support (shader-f16), which this browser/device does not report. Pick SmolLM2 360M or Qwen2.5 0.5B instead.`);
  }
  if (!online && !cached) issues.push('First-time model download needs an internet connection.');
  if (freeMB !== null && freeMB < neededStorageMB && !cached) {
    issues.push(`Not enough browser storage. Needs about ${formatMB(neededStorageMB)} free; available is ${formatMB(freeMB)}.`);
  }
  if (freeMB === null && downloadMB > 1000 && !cached) {
    issues.push('Browser did not report free storage, so this large model is blocked for device safety.');
  }
  if (deviceMemoryGB !== null && deviceMemoryGB <= 2) {
    issues.push(`Device memory is only ${deviceMemoryGB}GB — too low to run a local model reliably.`);
  } else if (deviceMemoryGB !== null && deviceMemoryGB < cfg.minDeviceMemoryGB) {
    warnings.push(`This model is happiest with ${cfg.minDeviceMemoryGB}GB+ RAM; browser reports ${deviceMemoryGB}GB. It may fail on a busy device.`);
  }
  if (deviceMemoryGB === null && downloadMB > 1000) {
    warnings.push('Memory is not reported by this browser; use a smaller model unless you know this device has enough RAM.');
  }
  if (!webgpu) warnings.push('WebGPU is unavailable, so responses will be slower on CPU/WASM.');
  else if (!gpu.f16) warnings.push('GPU lacks 16-bit shader support; using a larger/slower build.');
  if (freeMB !== null && freeMB < neededStorageMB * 1.5 && !cached) warnings.push('Storage margin is tight; close other apps/tabs and keep space free during setup.');
  if (deviceMemoryGB !== null && deviceMemoryGB < cfg.recommendedDeviceMemoryGB && deviceMemoryGB >= cfg.minDeviceMemoryGB) {
    warnings.push(`Recommended memory is ${cfg.recommendedDeviceMemoryGB}GB+ for smoother use.`);
  }

  const safe = issues.length === 0;
  const recommended = safe && warnings.length === 0;
  const level = !safe ? 'danger' : recommended ? 'good' : 'warn';

  return {
    modelId,
    modelName: cfg.name,
    cached,
    online,
    webgpu,
    cores,
    persisted,
    usageMB,
    quotaMB,
    freeMB,
    deviceMemoryGB,
    downloadMB,
    storageMB: neededStorageMB,
    runtimeMB: cfg.runtimeMB,
    minDeviceMemoryGB: cfg.minDeviceMemoryGB,
    recommendedDeviceMemoryGB: cfg.recommendedDeviceMemoryGB,
    safe,
    recommended,
    level,
    issues,
    warnings,
  };
}


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
let loadedRuntime = null;
let loading = false;
let loadingModel = null;
let loadingPromise = null;
let stopFlag = false;
let stopper = null;
let lastError = null;
let fallbackMode = false;

function setupEnv() {
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  // Static no-build app: keep ONNX Runtime on the main thread. Multi-threaded WASM
  // needs SharedArrayBuffer, i.e. cross-origin isolation, which this host does not
  // enable — so only use extra threads when the page happens to be isolated.
  const wasm = env.backends?.onnx?.wasm;
  if (wasm) {
    wasm.proxy = false;
    // A single WASM worker minimizes peak memory during ONNX session creation.
    // More threads can multiply temporary allocations and trigger std::bad_alloc
    // on otherwise capable machines. Prefer predictable startup over throughput.
    wasm.numThreads = 1;
  }
}

/**
 * Transformers.js emits one event per file (initiate/download/progress/done) plus
 * an aggregate `progress_total`. Only the aggregate is useful for one smooth bar;
 * forwarding per-file events made the UI flip back to "Checking Device Safety".
 */
function normalizeProgress(update, modelId, attempt = {}) {
  if (update?.status !== 'progress_total') return null;
  return {
    status: 'progress',
    modelId,
    device: attempt.device,
    dtype: attempt.dtype,
    file: 'model files',
    progress: Number.isFinite(update.progress) ? update.progress : undefined,
    loaded: update.loaded,
    total: update.total,
  };
}

function isMemoryAllocationError(err) {
  const message = (err?.message || String(err || '')).toLowerCase();
  return message.includes('array buffer allocation failed')
    || message.includes('out of memory')
    || message.includes('memory access out of bounds')
    || message.includes('allocation failed')
    || message.includes('failed to allocate')
    || message.includes('aborted(oom')
    || message.includes('std::bad_alloc')
    || message.includes("can't create a session")
    || message.includes('cannot create a session')
    || message.includes('error_code: 6')
    || message.includes('device lost');
}

function memoryRecoveryAdvice() {
  return 'The ONNX runtime could not reserve memory while creating its inference session (std::bad_alloc). This is different from browser storage quota: cached model files can fit on disk while the runtime still cannot allocate enough working memory. Close other heavy tabs/apps, restart the browser, keep SmolLM2 360M selected, and retry. If WebGPU is available, enable hardware acceleration and relaunch Chrome/Edge; otherwise WASM is the CPU fallback. Clearing the model cache is a last resort because it forces a fresh download.';
}

function friendlyLoadError(err, attempts) {
  const tried = attempts.map(a => `${a.device}/${a.dtype}`).join(', ') || 'no runtime';
  const message = err?.message || String(err);
  let advice;
  if (isMemoryAllocationError(err)) advice = memoryRecoveryAdvice();
  else if (/404|not found|could not locate|unauthorized/i.test(message)) advice = 'The model files were not found on Hugging Face (wrong repo or dtype). Update LocalMind to the latest version.';
  else advice = 'Check that you are online for the first download, have enough free browser storage, and are using a recent Chrome/Edge browser. You can still use Browser Helper mode for diagnostics.';
  return new Error(`Could not finish loading the local AI model. Tried ${tried}. ${message} ${advice}`);
}

async function disposePipe() {
  const old = pipe;
  pipe = null;
  loadedModel = null;
  loadedRuntime = null;
  if (old?.dispose) {
    try { await old.dispose(); } catch (err) { console.warn('[AI] dispose failed:', err); }
  }
}

export async function loadModel(modelId = DEFAULT_MODEL, onProgress = () => {}) {
  modelId = normalizeModelId(modelId);

  if (loadedModel === modelId && pipe) {
    fallbackMode = false;
    onProgress({ status: 'ready', progress: 100, modelId });
    return;
  }

  if (loading && loadingPromise) {
    if (loadingModel === modelId) return loadingPromise;
    throw new Error(`Already loading ${MODELS[loadingModel]?.name || loadingModel}. Please wait before switching models.`);
  }

  const cfg = MODELS[modelId];
  if (!cfg) throw new Error(`Unknown model: ${modelId}`);

  setupEnv();
  loading = true;
  loadingModel = modelId;
  fallbackMode = false;
  lastError = null;

  loadingPromise = (async () => {
    const attempts = await planFor(modelId);
    const failures = [];

    if (!attempts.length) {
      throw friendlyLoadError(
        new Error(`${cfg.name} needs WebGPU with shader-f16 support, which is not available here.`),
        attempts,
      );
    }

    onProgress({
      status: 'initiate',
      progress: 0,
      modelId,
      text: `Preparing ${cfg.name}. ${attempts.length} compatible runtime(s) available.`,
    });

    // Free the previous model's weights/session before allocating another.
    await disposePipe();

    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      try {
        onProgress({
          status: index ? 'retry' : 'initiate',
          progress: 0,
          modelId,
          device: attempt.device,
          dtype: attempt.dtype,
          text: index
            ? `GPU initialization failed. Retrying with CPU/WASM (${attempt.dtype}).`
            : `Loading ${cfg.name} with ${attempt.device.toUpperCase()} (${attempt.dtype})…`,
        });

        const candidate = await pipeline('text-generation', modelId, {
          dtype: attempt.dtype,
          device: attempt.device,
          progress_callback: update => {
            const p = normalizeProgress(update, modelId, attempt);
            if (p) onProgress(p);
          },
        });

        // Do not publish a half-created pipeline as ready.
        if (typeof candidate !== 'function' || !candidate.tokenizer) {
          try { await candidate?.dispose?.(); } catch { /* ignore */ }
          throw new Error('The inference runtime returned an incomplete text-generation pipeline.');
        }

        pipe = candidate;
        loadedModel = modelId;
        loadedRuntime = attempt;
        fallbackMode = false;
        onProgress({
          status: 'ready',
          progress: 100,
          modelId,
          device: attempt.device,
          dtype: attempt.dtype,
          text: `${cfg.name} is ready.`,
        });
        return;
      } catch (err) {
        lastError = err;
        failures.push({ ...attempt, message: err?.message || String(err) });
        console.warn(`[AI] ${modelId} failed on ${attempt.device}/${attempt.dtype}:`, err);
        await disposePipe();
      }
    }

    const details = failures.map(item => `${item.device}/${item.dtype}: ${item.message}`).join(' | ');
    throw friendlyLoadError(new Error(details || 'No compatible inference runtime was available.'), attempts);
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
    return generateFallback(msgs, settings, onToken, onDone);
  }

  let output = '';
  // A fresh criteria object per run; a used/interrupted one stays "stopped".
  stopper = new InterruptableStoppingCriteria();

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
    stopping_criteria: stopper,
    return_full_text: false,
  };

  try {
    await pipe(msgs, opts);
  } catch (err) {
    if (stopFlag) {
      onDone(output);
      return output;
    }
    if (isMemoryAllocationError(err)) {
      lastError = err;
      await disposePipe();           // actually release the weights, don't just drop the ref
      return generateMemoryFallback(msgs, settings, onToken, onDone, err);
    }
    throw err;
  } finally {
    stopper = null;
  }

  onDone(output);
  return output;
}

async function generateMemoryFallback(msgs, settings, onToken, onDone, err) {
  fallbackMode = true;
  const diag = await browserDiagnostics();
  const answer = [
    'The local model ran out of browser memory while trying to respond, so I switched to Browser Helper mode instead of crashing.',
    '',
    memoryRecoveryAdvice(),
    '',
    'Current browser diagnostics:',
    '',
    diag,
    '',
    `Original error: ${err?.message || String(err)}`,
  ].join('\n');

  for (const chunk of answer.match(/.{1,18}(\s|$)/g) || [answer]) {
    if (stopFlag) break;
    onToken(chunk);
    await new Promise(r => setTimeout(r, 8));
  }
  onDone(answer);
  return answer;
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
  const gpu = await probeWebGPU(true);
  parts.push(`- WebGPU API: ${'gpu' in navigator ? 'present' : 'not available'}`);
  parts.push(`- WebGPU adapter: ${gpu.usable ? 'available' : 'not available (browser may expose the API without a usable adapter)'}`);
  if (gpu.usable) parts.push(`- WebGPU shader-f16: ${gpu.f16 ? 'supported' : 'not supported'}`);
  parts.push(`- Planned runtime: ${(await planFor(DEFAULT_MODEL)).map(item => `${item.device}/${item.dtype}`).join(', ') || 'none'}`);
  parts.push(`- WebAssembly: ${typeof WebAssembly !== 'undefined' ? 'available' : 'not available'}`);
  parts.push(`- Device memory: ${Number.isFinite(navigator.deviceMemory) ? `${navigator.deviceMemory} GB` : 'not reported'}`);
  parts.push(`- CPU cores: ${Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 'not reported'}`);
  parts.push(`- Browser: ${navigator.userAgent}`);
  if (navigator.storage?.estimate) {
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      const usedMB = usage / 1048576;
      const quotaMB = quota / 1048576;
      parts.push(`- Storage used: ${usedMB.toFixed(0)} MB`);
      parts.push(`- Storage quota: ${quotaMB.toFixed(0)} MB`);
      parts.push(`- Storage available to browser: ${Math.max(0, quotaMB - usedMB).toFixed(0)} MB`);
    } catch {
      parts.push('- Storage estimate: unavailable');
    }
  }
  if (lastError) parts.push(`- Last model error: ${lastError.message || String(lastError)}`);
  return parts.join('\n');
}

export function stop() {
  stopFlag = true;
  try { stopper?.interrupt(); } catch { /* ignore */ }
}
export function isLoaded() { return pipe !== null && loadedModel !== null; }
export function isFallback() { return fallbackMode; }
export function getModelId() { return loadedModel; }
export function getRuntime() { return loadedRuntime; }
export function isLoading() { return loading; }
export function getLoadingModelId() { return loadingModel; }
export function getLastError() { return lastError; }
export function resetModel() {
  disposePipe();
  loading = false;
  loadingModel = null;
  loadingPromise = null;
  fallbackMode = true;
}
export function isLikelyMemoryError(err) { return isMemoryAllocationError(err); }

/**
 * True only when every file this device would actually download is cached.
 * (The old check matched any cached URL containing the model name, so a single
 * cached config.json made a half-downloaded model look "Cached".)
 */
export async function isCached(modelId) {
  try {
    modelId = normalizeModelId(modelId);
    if (!('caches' in self)) return false;
    const plan = await planFor(modelId);
    const dtypes = [...new Set(plan.map(a => a.dtype))];
    for (const dtype of dtypes) {
      if (await ModelRegistry.is_cached(modelId, { dtype })) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function clearCache() {
  await disposePipe();
  for (const [modelId, cfg] of Object.entries(MODELS)) {
    const dtypes = new Set([
      cfg.webgpu?.dtype, cfg.webgpu?.noF16Dtype, cfg.wasm?.dtype,
    ].filter(Boolean));
    for (const dtype of dtypes) {
      try { await ModelRegistry.clear_cache(modelId, { dtype }); } catch (err) {
        console.warn(`[AI] clear_cache failed for ${modelId}/${dtype}:`, err);
      }
    }
  }
  // Duplicate model copies left behind by older service workers.
  if ('caches' in self) {
    for (const key of await caches.keys()) {
      if (key.startsWith('lm-models-')) await caches.delete(key);
    }
  }
  loadedRuntime = null;
  fallbackMode = false;
}

export function withSystem(msgs, prompt = DEFAULT_SYSTEM) {
  if (!prompt || msgs.some(m => m.role === 'system')) return msgs;
  return [{ role: 'system', content: prompt }, ...msgs];
}
