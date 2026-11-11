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
assert.match(ai, /candidate\('Hello\.'/,
  'A real generation smoke test must pass before a model is marked ready.');
assert.doesNotMatch(ai, /generateFallback|generateMemoryFallback/,
  'Model failures must not be replaced by simulated assistant responses.');

assert.match(app, /await registerSW\(\)/, 'Register the worker before runtime/model initialization.');
assert.match(app, /No AI response was generated/, 'Model-load failures must stop the current turn.');
assert.match(app, /model-cache-chip-actions/, 'Model library must expose download/use/remove controls.');

assert.match(worker, /lm-runtime-transformers-4-3-0/,
  'The pinned ONNX runtime cache must survive app deployments.');
assert.match(worker, /url\.hostname === 'cdn\.jsdelivr\.net'/,
  'Cache the full jsDelivr npm dependency graph for offline runtime startup.');

JSON.parse(vercel);
JSON.parse(manifest);
console.log(`LocalMind static checks passed: ${modelIds.length} model entries, selector parity, runtime lifecycle, offline cache, and JSON configuration.`);
