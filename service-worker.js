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
// The Transformers.js version is pinned in ai.js, so keep its runtime cache
// stable across app deployments. Otherwise every update would delete the only
// offline copy of ONNX Runtime/WASM before the next page load can reuse it.
const RUNTIME = 'lm-runtime-transformers-4-3-0';
const PRECACHE = [
  './',
  './index.html',
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
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Keep the Transformers.js cache intact; only retire LocalMind's old app caches.
    await Promise.all(keys
      .filter(key => (
        (key.startsWith('lm-static-') && key !== STATIC)
        || (key.startsWith('lm-rt-') && key !== RUNTIME)
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
    event.respondWith(networkFirst(request, STATIC));
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

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cache = await caches.open(cacheName);
    return (await cache.match(request))
      || (await cache.match('./index.html'))
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
