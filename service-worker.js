/**
 * LocalMind service worker
 *
 * Each deployment receives a unique worker URL (?v=<commit SHA>) and therefore
 * an isolated static/runtime cache namespace. This prevents an installing worker
 * from overwriting assets still being served by the currently active worker.
 * The Transformers.js model cache is deliberately left untouched.
 */

const VER = new URL(self.location.href).searchParams.get('v') || 'local';
const CACHE_VERSION = VER.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'local';
const STATIC = `lm-static-${CACHE_VERSION}`;
const RUNTIME = `lm-rt-${CACHE_VERSION}`;
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

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
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
