/**
 * service-worker.js
 * Cache-First for static + CDN assets. Network-First for HTML.
 * Model files get their own long-lived cache bucket.
 *
 * ADR: We do NOT precache Transformers.js or model weights at install time —
 * they're too large and would block SW activation. Instead we cache them
 * lazily on first fetch. This trades slightly slower first-run offline for
 * a much faster install and no quota issues.
 */

const VER = 'v1.1.0';
const STATIC = `lm-static-${VER}`;
const MODELS = `lm-models-${VER}`;
const RUNTIME = `lm-rt-${VER}`;
const ALL = [STATIC, MODELS, RUNTIME];

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './ai.js',
  './db.js',
  './ui.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(STATIC)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(err => console.error('[SW] install failed:', err))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    Promise.all([
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => !ALL.includes(k)).map(k => caches.delete(k)))
      ),
      self.clients.claim(),
    ])
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (e.request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  if (isModel(url)) {
    e.respondWith(cacheFirst(e.request, MODELS));
  } else if (isCDN(url)) {
    e.respondWith(cacheFirst(e.request, RUNTIME));
  } else if (isStatic(url)) {
    e.respondWith(cacheFirst(e.request, STATIC));
  } else if (isHTML(e.request)) {
    e.respondWith(networkFirst(e.request, STATIC));
  }
});

async function cacheFirst(req, cacheName) {
  try {
    const c = await caches.open(cacheName);
    const hit = await c.match(req);
    if (hit) return hit;

    const res = await fetch(req.clone());
    if (res.ok && res.status === 200) {
      c.put(req, res.clone()); // async, don't await
    }
    return res;
  } catch (err) {
    return offline(req);
  }
}

async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req.clone());
    if (res.ok) {
      const c = await caches.open(cacheName);
      c.put(req, res.clone());
    }
    return res;
  } catch {
    const c = await caches.open(cacheName);
    return (await c.match(req)) || (await c.match('./index.html')) || offline(req);
  }
}

function offline(req) {
  if (req.headers.get('Accept')?.includes('text/html')) {
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

function isModel(url) {
  return url.hostname.includes('huggingface.co') || url.hostname.includes('hf.co') || url.pathname.includes('cdn-lfs');
}

function isCDN(url) {
  return url.href.includes('cdn.jsdelivr.net/npm/@huggingface');
}

function isStatic(url) {
  const ext = url.pathname.split('.').pop().toLowerCase();
  return url.origin === self.location.origin
    && ['css', 'js', 'png', 'jpg', 'svg', 'ico', 'json', 'woff', 'woff2'].includes(ext);
}

function isHTML(req) {
  return req.headers.get('Accept')?.includes('text/html') ?? false;
}

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data?.type === 'GET_VERSION') e.ports[0]?.postMessage({ version: VER });
});
