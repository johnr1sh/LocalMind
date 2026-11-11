/**
 * ai.js
 * Local inference via Transformers.js. Handles model load, generation, streaming.
 * Includes resilient model loading with shared in-flight requests, backend/dtype
 * fallback, aggregate progress, and diagnostics so model failures are visible
 * and never disguised as successful assistant responses.
 *
 * Every model below was checked against its Hugging Face repo: the `onnx/`
 * folder must contain `model_<dtype>.onnx` for each dtype we request, otherwise
 * Transformers.js gets a 404 and the model "downloads" forever / never loads.
 */

// Load the heavy inference runtime only after the service worker controls the page.
// A static CDN import runs before app.js can register the worker and breaks reliable
// offline startup on a fresh install.
const RUNTIME_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
let runtimePromise = null;
let pipeline = null;
let TextStreamer = null;
let InterruptableStoppingCriteria = null;
let ModelRegistry = null;
let env = null;

async function ensureRuntime() {
  if (!runtimePromise) {
    runtimePromise = import(RUNTIME_URL).then(runtime => {
      pipeline = runtime.pipeline;
      TextStreamer = runtime.TextStreamer;
      InterruptableStoppingCriteria = runtime.InterruptableStoppingCriteria;
      ModelRegistry = runtime.ModelRegistry;
      env = runtime.env;
      if (!pipeline || !TextStreamer || !InterruptableStoppingCriteria || !ModelRegistry || !env) {
        throw new Error('The Transformers.js runtime loaded, but required inference APIs are missing.');
      }
      return runtime;
    }).catch(err => {
      runtimePromise = null;
      throw new Error(`Could not load the local AI runtime from the CDN. Check the connection or reload after the runtime has been cached. ${err?.message || String(err)}`);
    });
  }
  return runtimePromise;
}

/**
 * Per-model runtime plan.
 *  webgpu.dtype      -> used when the GPU reports shader-f16 (fast, smallest)
 *  webgpu.noF16Dtype -> used on WebGPU without shader-f16 (omit = skip WebGPU)
 *  wasm              -> CPU fallback (omit = model is WebGPU-only)
 * `mb` is the real download size of that file set (weights + external data).
 */
export const MODELS = {
  'onnx-community/SmolLM2-135M-Instruct-ONNX': {
    name: 'SmolLM2 135M',
    desc: 'Ultra-light starter model for low-memory devices',
    size: '117MB WebGPU / 181MB WASM',
    storageMB: 360,
    runtimeMB: 650,
    minDeviceMemoryGB: 3,
    recommendedDeviceMemoryGB: 4,
    webgpu: { dtype: 'q4f16', mb: 117, noF16Dtype: 'q4', noF16Mb: 181 },
    wasm: { dtype: 'q4', mb: 181 },
  },
  'HuggingFaceTB/SmolLM2-360M-Instruct': {
    name: 'SmolLM2 360M',
    desc: 'Lightweight general-purpose assistant',
    size: '273MB WebGPU / 388MB WASM',
    storageMB: 700,
    runtimeMB: 1200,
    minDeviceMemoryGB: 4,
    recommendedDeviceMemoryGB: 8,
    webgpu: { dtype: 'q4f16', mb: 273, noF16Dtype: 'q4', noF16Mb: 388 },
    wasm: { dtype: 'q4', mb: 388 },
  },
  'onnx-community/Qwen2.5-0.5B-Instruct': {
    name: 'Qwen2.5 0.5B',
    desc: 'Stronger multilingual assistant for supported devices',
    size: '483MB WebGPU / 786MB WASM',
    storageMB: 1200,
    runtimeMB: 1700,
    minDeviceMemoryGB: 6,
    recommendedDeviceMemoryGB: 8,
    webgpu: { dtype: 'q4f16', mb: 483, noF16Dtype: 'q4', noF16Mb: 786 },
    wasm: { dtype: 'q4', mb: 786 },
  },
  'onnx-community/Qwen2.5-1.5B-Instruct': {
    name: 'Qwen2.5 1.5B',
    desc: 'Higher quality; requires more memory and storage',
    size: '1.22GB WebGPU / 1.79GB WASM',
    storageMB: 2600,
    runtimeMB: 3600,
    minDeviceMemoryGB: 8,
    recommendedDeviceMemoryGB: 12,
    webgpu: { dtype: 'q4f16', mb: 1249, noF16Dtype: 'q4', noF16Mb: 1833 },
    wasm: { dtype: 'q4', mb: 1833 },
  },
  'onnx-community/Phi-3.5-mini-instruct-onnx-web': {
    name: 'Phi-3.5 Mini',
    desc: 'Advanced large model; WebGPU with shader-f16 required',
    size: '~2.3GB WebGPU only',
    storageMB: 3600,
    runtimeMB: 3500,
    minDeviceMemoryGB: 8,
    recommendedDeviceMemoryGB: 16,
    webgpu: { dtype: 'q4f16', mb: 2320 },
    wasm: null,
  },
};

export const DEFAULT_MODEL = 'onnx-community/SmolLM2-135M-Instruct-ONNX';

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

function setupEnv() {
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.useWasmCache = true;

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
  else advice = 'Check that you are online for the first download, have enough free browser storage, and are using a recent Chrome/Edge browser. Open /browser for device diagnostics.';
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
      onProgress({ status: 'ready', progress: 100, modelId });
    return;
  }

  if (loading && loadingPromise) {
    if (loadingModel === modelId) return loadingPromise;
    throw new Error(`Already loading ${MODELS[loadingModel]?.name || loadingModel}. Please wait before switching models.`);
  }

  const cfg = MODELS[modelId];
  if (!cfg) throw new Error(`Unknown model: ${modelId}`);

  // Set the lock before any asynchronous runtime import. Two rapid requests
  // must never initialize two ONNX sessions in parallel.
  loading = true;
  loadingModel = modelId;

  lastError = null;

  loadingPromise = (async () => {
    await ensureRuntime();
    setupEnv();
    let attempts = await planFor(modelId);

    // Preflight remote artifacts only when this device has no complete cached
    // runtime/dtype. A previously downloaded model must remain usable even if its
    // upstream repository later becomes unavailable.
    if (navigator.onLine && attempts.length && !cacheChecks.some(Boolean)
      && typeof ModelRegistry.get_available_dtypes === 'function') {
      try {
        const available = await ModelRegistry.get_available_dtypes(modelId);
        if (!available?.length) {
          throw new Error(`The model repository ${modelId} has no usable ONNX text-generation weights.`);
        }
        attempts = attempts.filter(attempt => available.includes(attempt.dtype));
        if (!attempts.length) {
          throw new Error(`No compatible quantization was found for ${modelId}. Hub offers: ${available.join(', ')}.`);
        }
        cacheChecks = await Promise.all(attempts.map(async attempt => {
          try { return await ModelRegistry.is_cached(modelId, { dtype: attempt.dtype }); }
          catch { return false; }
        }));
      } catch (err) {
        if (/404|not found|no usable ONNX|no compatible quantization|unauthorized/i.test(err?.message || '')) throw err;
        console.warn('[AI] Could not preflight model artifacts:', err);
      }
    }

    // Reuse a fully cached backend/dtype first. This is essential offline and
    // avoids downloading a second quantization when the first one is already ready.
    let cacheChecks = await Promise.all(attempts.map(async attempt => {
      try { return await ModelRegistry.is_cached(modelId, { dtype: attempt.dtype }); }
      catch { return false; }
    }));
    const orderedAttempts = attempts.map((attempt, index) => ({ attempt, cached: cacheChecks[index] }))
      .sort((a, b) => Number(b.cached) - Number(a.cached))
      .map(item => item.attempt);
    const failures = [];

    if (!orderedAttempts.length) {
      throw friendlyLoadError(
        new Error(!cfg.wasm && cfg.webgpu
          ? `${cfg.name} requires WebGPU with shader-f16 support, which is not available here.`
          : `No compatible runtime is available for ${cfg.name} on this device.`),
        orderedAttempts,
      );
    }

    onProgress({
      status: 'initiate',
      progress: 0,
      modelId,
      text: `Preparing ${cfg.name}. ${orderedAttempts.length} compatible runtime(s) available.`,
    });

    // Free the previous model's weights/session before allocating another.
    await disposePipe();

    for (let index = 0; index < orderedAttempts.length; index += 1) {
      const attempt = orderedAttempts[index];
      let candidate = null;
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

        candidate = await pipeline('text-generation', modelId, {
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

        // A pipeline can construct successfully and still fail on its first
        // ONNX session/generation. Run a tiny real inference before declaring Ready.
        onProgress({
          status: 'loading',
          progress: 92,
          modelId,
          device: attempt.device,
          dtype: attempt.dtype,
          text: 'Running a short inference self-test…',
        });
        const smoke = await candidate('Hello.', { max_new_tokens: 4, do_sample: false });
        if (!Array.isArray(smoke) || smoke.length === 0) {
          throw new Error('The model initialized but returned no output during its inference self-test.');
        }

        pipe = candidate;
        loadedModel = modelId;
        loadedRuntime = attempt;
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
        try { await candidate?.dispose?.(); } catch (disposeError) {
          console.warn('[AI] failed candidate disposal:', disposeError);
        }
        await disposePipe();
      }
    }

    const details = failures.map(item => `${item.device}/${item.dtype}: ${item.message}`).join(' | ');
    throw friendlyLoadError(new Error(details || 'No compatible inference runtime was available.'), orderedAttempts);
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
    throw new Error('No local AI model is loaded. Choose a compatible model and download it before generating a response.');
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
      await disposePipe();
      throw new Error(`Local inference ran out of memory. The model has been unloaded safely. ${memoryRecoveryAdvice()} Original error: ${err?.message || String(err)}`);
    }
    throw err;
  } finally {
    stopper = null;
  }

  onDone(output);
  return output;
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
export function getModelId() { return loadedModel; }
export function getRuntime() { return loadedRuntime; }
export function isLoading() { return loading; }
export function getLoadingModelId() { return loadingModel; }
export function getLastError() { return lastError; }
export async function resetModel() {
  await disposePipe();
  loading = false;
  loadingModel = null;
  loadingPromise = null;
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
    await ensureRuntime();
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

export async function clearModelCache(modelId) {
  modelId = normalizeModelId(modelId);
  if (loadedModel === modelId) await disposePipe();
  await ensureRuntime();
  const cfg = MODELS[modelId];
  const dtypes = new Set([
    cfg.webgpu?.dtype, cfg.webgpu?.noF16Dtype, cfg.wasm?.dtype,
  ].filter(Boolean));
  let deleted = 0;
  for (const dtype of dtypes) {
    try {
      const result = await ModelRegistry.clear_cache(modelId, { dtype });
      deleted += Number(result?.filesDeleted || 0);
    } catch (err) {
      console.warn(`[AI] clear_cache failed for ${modelId}/${dtype}:`, err);
    }
  }
  loadedRuntime = null;

  return deleted;
}

export async function clearCache() {
  for (const modelId of Object.keys(MODELS)) await clearModelCache(modelId);
  // Retire only obsolete app-owned model caches; never delete Transformers.js cache.
  if ('caches' in self) {
    for (const key of await caches.keys()) {
      if (key.startsWith('lm-models-')) await caches.delete(key);
    }
  }
}
export function withSystem(msgs, prompt = DEFAULT_SYSTEM) {
  if (!prompt || msgs.some(m => m.role === 'system')) return msgs;
  return [{ role: 'system', content: prompt }, ...msgs];
}
