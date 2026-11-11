import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [ai, app, html, worker, vercel, manifest] = await Promise.all([
  readFile(new URL('../ai.js', import.meta.url), 'utf8'),
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../service-worker.js', import.meta.url), 'utf8'),
  readFile(new URL('../vercel.json', import.meta.url), 'utf8'),
  readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
]);

const modelIds = [...ai.matchAll(/^  '([^']+)': \{/gm)].map(match => match[1]);
const selectIds = [...html.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
const defaultModel = ai.match(/DEFAULT_MODEL = '([^']+)'/)?.[1];

assert.ok(modelIds.length >= 7, 'Expected at least five curated local models.');
assert.ok(defaultModel && modelIds.includes(defaultModel), 'Default model must exist in the catalog.');
for (const id of modelIds) {
  assert.ok(selectIds.includes(id), `Model selector is missing catalog entry: ${id}`);
}

assert.match(ai, /import\(RUNTIME_URL\)/, 'Inference runtime must load lazily after service-worker control.');
assert.doesNotMatch(ai, /from ['"]https:\/\/cdn\.jsdelivr\.net/, 'Do not statically import the CDN runtime.');
assert.match(ai, /ModelRegistry\.get_available_dtypes/, 'Validate model quantizations before first download.');

const loadModelStart = ai.indexOf('export async function loadModel');
const generateStart = ai.indexOf('export async function generate', loadModelStart);
assert.ok(loadModelStart >= 0 && generateStart > loadModelStart, 'Could not locate loadModel implementation.');
const loadModelSource = ai.slice(loadModelStart, generateStart);
const cacheDeclaration = loadModelSource.indexOf('let cacheChecks =');
const cachePreflightRead = loadModelSource.indexOf('!cacheChecks.some(Boolean)');
assert.ok(cacheDeclaration >= 0 && cacheDeclaration < cachePreflightRead,
  'cacheChecks must be initialized before the online preflight reads it.');
assert.equal((loadModelSource.match(/let cacheChecks\s*=/g) || []).length, 1,
  'cacheChecks must have one declaration; later cache checks must reassign it.');

assert.match(ai, /candidate\('Hello\.'/,
  'A real generation smoke test must pass before a model is marked ready.');
assert.doesNotMatch(ai, /generateFallback|generateMemoryFallback/,
  'Model failures must not be replaced by simulated assistant responses.');

assert.match(app, /swReady = registerSW\(\)/, 'Register the worker at startup.');
assert.ok(app.indexOf('await swReady;') > 0
  && app.indexOf('await swReady;') < app.indexOf('await AI.isCached(modelId)'),
  'Runtime/model cache checks must wait for the worker, but the first paint must not.');
assert.doesNotMatch(app, /\n\s*AI\.resetModel\(\);/, 'resetModel() is async and must be awaited.');
assert.match(app, /No AI response was generated/, 'Model-load failures must stop the current turn.');
assert.match(app, /model-cache-chip-actions/, 'Model library must expose download/use/remove controls.');

const runtimeVersion = ai.match(/TRANSFORMERS_VERSION = '(\d+\.\d+\.\d+)'/)?.[1];
assert.ok(runtimeVersion, 'ai.js must declare TRANSFORMERS_VERSION.');
assert.ok(worker.includes(`transformers-${runtimeVersion.replaceAll('.', '-')}`),
  'The worker runtime cache name must match TRANSFORMERS_VERSION so the pinned runtime survives deployments.');
assert.doesNotMatch(worker, /PRECACHE = \[[^\]]*index\.html/,
  'Do not precache ./index.html: cleanUrls redirects it and redirected responses break navigations.');
assert.match(worker, /url\.hostname === 'cdn\.jsdelivr\.net'/,
  'Cache the full jsDelivr npm dependency graph for offline runtime startup.');

JSON.parse(vercel);
JSON.parse(manifest);

assert.match(app, /new AbortController\(\)/,
  'Deployment metadata checks must have a bounded network timeout.');
assert.match(app, /versionCheckPromise/,
  'Concurrent deployment checks must share one in-flight request.');
assert.match(app, /invalid deployment metadata/,
  'Deployment metadata must be validated before registering a versioned worker.');

console.log(`LocalMind static checks passed: ${modelIds.length} model entries, selector parity, runtime lifecycle, offline cache, and JSON configuration.`);

assert.match(ai, /wasm\.proxy = true/,
  'CPU/WASM inference must use the ONNX Runtime proxy worker to keep the UI responsive.');
assert.match(ai, /WASM inference worker:/,
  'Browser diagnostics must report whether WASM inference is proxied.');
