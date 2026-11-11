/**
 * LocalMind service worker
 *
 * Each deployment receives a unique worker URL (?v=<commit SHA>) and an isolated
 * static-asset cache. The pinned ONNX runtime dependency cache survives app updates,
 * while Transformers.js manages the large model-weight cache separately.
 */

const VER = new URL(self.location.href).searchParams.get('v') || 'local';
const CACHE_VERSION = VER.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'local';
const STATIC = `lm-static-${CACHE_VERSION}`;
// The Transformers.js version is pinned in ai.js (TRANSFORMERS_VERSION), so keep its
// runtime cache stable across app deployments. Otherwise every update would delete
// the only offline copy of ONNX Runtime/WASM before the next page load can reuse it.
// Keep this name in sync with ai.js (scripts/verify-model-library.mjs checks it).
const RUNTIME_PREFIX = 'lm-runtime-';
const RUNTIME = `${RUNTIME_PREFIX}transformers-4-3-2`;
// './index.html' is deliberately absent: with cleanUrls it redirects to './', and a
// redirected response must not be served back for a navigation request.
const PRECACHE = [
  './',
  './styles.css',
  './app.js',
  './ai.js',
  './db.js',
  './ui.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC);
    // `reload` bypasses the HTTP cache so a host that sends max-age (GitHub Pages)
    // cannot leave this version's cache holding files from the previous deployment.
    await cache.addAll(PRECACHE.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    // After a Transformers.js version bump, carry over the files that do not change
    // with it (ONNX Runtime / WASM helpers) so a device that updates and then goes
    // offline can still start a model. Only the old Transformers bundle is dropped.
    const oldRuntimes = keys.filter(key => key.startsWith(RUNTIME_PREFIX) && key !== RUNTIME);
    if (oldRuntimes.length) {
      const next = await caches.open(RUNTIME);
      for (const name of oldRuntimes) {
        try {
          const old = await caches.open(name);
          for (const request of await old.keys()) {
            if (request.url.includes('/@huggingface/transformers@')) continue;
            if (await next.match(request)) continue;
            const response = await old.match(request);
            if (response) await next.put(request, response).catch(() => {});
          }
        } catch { /* a cache that cannot be read is simply rebuilt online */ }
      }
    }

    // Keep the Transformers.js model cache intact; only retire LocalMind's own caches.
    await Promise.all(keys
      .filter(key => (
        (key.startsWith('lm-static-') && key !== STATIC)
        || (key.startsWith('lm-rt-') && key !== RUNTIME)
        || oldRuntimes.includes(key)
        || key.startsWith('lm-models-')
      ))
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  // Keep the Transformers.js runtime available offline after it has been fetched.
  if (isCDN(url)) {
    event.respondWith(cacheFirst(request, RUNTIME));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // Version metadata must always reach the deployment endpoint, never a stale SW cache.
  if (url.pathname.includes('/api/')) return;

  if (isHTML(request)) {
    // A deployment-versioned worker owns an immutable, fully precached shell, so serve
    // it straight from cache: repeat loads need no network round trip, and the HTML can
    // never disagree with the cached JS/CSS. Updates still arrive through the new worker.
    // The unversioned fallback worker cannot make that guarantee, so it stays network-first,
    // but with a timeout so a flaky connection cannot hold the page hostage.
    event.respondWith(VER === 'local' ? networkFirst(request, STATIC, 3000) : shellFirst(request));
  } else if (isStatic(url)) {
    event.respondWith(cacheFirst(request, STATIC));
  }
});

async function cacheFirst(request, cacheName) {
  try {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;

    const response = await fetch(request);
    if (response.ok && response.status === 200) {
      await cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return offline(request);
  }
}

async function shellFirst(request) {
  const cache = await caches.open(STATIC);
  return (await cache.match(request, { ignoreSearch: true }))
    || (await cache.match('./'))
    || networkFirst(request, STATIC, 3000);
}

async function networkFirst(request, cacheName, timeoutMs = 0) {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : 0;
  try {
    const response = await fetch(request, { cache: 'no-store', signal: controller?.signal });
    clearTimeout(timer);
    // Never cache a redirected response: it cannot be served back for a navigation.
    if (response.ok && !response.redirected) {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    clearTimeout(timer);
    const cache = await caches.open(cacheName);
    return (await cache.match(request))
      || (await cache.match('./'))
      || offline(request);
  }
}

function offline(request) {
  if (request.headers.get('Accept')?.includes('text/html')) {
    return new Response(
      `<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px;color:#888">
        <h2>You're offline</h2>
        <p>Open LocalMind once while online to cache the app for offline use.</p>
      </body></html>`,
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
  return new Response('Offline', { status: 503 });
}

function isStatic(url) {
  const extension = url.pathname.split('.').pop().toLowerCase();
  return ['css', 'js', 'png', 'jpg', 'svg', 'ico', 'json', 'woff', 'woff2'].includes(extension);
}

function isHTML(request) {
  return request.headers.get('Accept')?.includes('text/html') ?? false;
}

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({
      version: VER,
      shortVersion: VER.slice(0, 12),
    });
  }
});

function isCDN(url) {
  // Transformers.js pulls ONNX Runtime and WASM helpers from sibling npm
  // packages on jsDelivr. Cache the full npm dependency graph, not only the
  // top-level Hugging Face package, so the runtime can boot offline later.
  return url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('/npm/');
}
