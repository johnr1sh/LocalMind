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

const VER = 'v1.5.0';
const STATIC = `lm-static-${VER}`;
// Keep the model cache stable across app releases: model files are large and
// should not be downloaded again just because the UI or controller changed.
// NOTE: model weights are NOT cached here any more. Transformers.js already stores
// them in its own Cache Storage bucket ('transformers-cache'); also caching them in
// the service worker doubled disk usage and buffered hundreds of MB of tee'd stream
// in memory during download (a common cause of "Array buffer allocation failed").
const RUNTIME = `lm-rt-${VER}`;
const ALL = [STATIC, RUNTIME];

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
        // Drops old app/runtime buckets AND the old duplicate lm-models-* copies.
        Promise.all(keys.filter(k => k.startsWith('lm-') && !ALL.includes(k)).map(k => caches.delete(k)))
      ),
      self.clients.claim(),
    ])
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (e.request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // Let model downloads (huggingface.co, hf.co, xet/cdn-lfs) go straight to the
  // network so Transformers.js can stream, range-request and cache them itself.
  if (isModel(url)) return;

  if (isCDN(url)) {
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
      c.put(req, res.clone()).catch(() => {}); // async; ignore quota errors
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
  const h = url.hostname;
  return h === 'huggingface.co' || h.endsWith('.huggingface.co') || h === 'hf.co' || h.endsWith('.hf.co')
    || url.pathname.includes('cdn-lfs');
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
