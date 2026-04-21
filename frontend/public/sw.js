/**
 * Zahran service worker — custom, no vite-plugin-pwa / Workbox.
 *
 * Strategy:
 *   • Navigations (HTML):     NetworkFirst with 3s timeout → cache fallback.
 *                             NEVER precached — a new deploy always serves
 *                             a fresh index.html when online.
 *   • /assets/* (hashed):     CacheFirst. Vite emits immutable hashes so
 *                             a cached asset is always correct.
 *   • /api/*:                 NetworkFirst with 4s timeout → cache fallback.
 *   • Everything else:        NetworkFirst with 4s timeout → cache fallback.
 *
 * On activation, every non-current cache bucket is wiped so old deploys
 * don't pile up. Bump CACHE_VERSION to force a full eviction.
 */

const CACHE_VERSION = 'v1-2026-04-21';
const RUNTIME_CACHE = `zahran-runtime-${CACHE_VERSION}`;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // On install, fetch the current index.html, parse out every asset
  // URL it references (JS bundle, CSS, icons, manifest, favicon…)
  // and precache them. This way the user can go offline immediately
  // after their first visit without having to browse around first.
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch('/', { cache: 'no-cache' });
        if (!res.ok) return;
        const html = await res.text();
        const urls = new Set();
        // <script src="...">  and  <link href="...">
        const rx = /(?:src|href)="([^"]+)"/g;
        let m;
        while ((m = rx.exec(html)) !== null) {
          const ref = m[1];
          if (
            ref.startsWith('/') ||
            ref.startsWith('./') ||
            (!ref.startsWith('http') && !ref.startsWith('data:'))
          ) {
            urls.add(new URL(ref, self.location.origin).pathname);
          }
        }
        // Add the icons + favicon explicitly — they may not be in
        // the HTML but are needed for the PWA shell.
        [
          '/favicon.svg',
          '/icons/icon-192.png',
          '/icons/icon-512.png',
          '/icons/icon-512-maskable.png',
        ].forEach((u) => urls.add(u));
        const cache = await caches.open(RUNTIME_CACHE);
        await Promise.all(
          Array.from(urls).map((u) =>
            fetch(u, { cache: 'no-cache' })
              .then((r) => (r.ok ? cache.put(u, r) : null))
              .catch(() => {}),
          ),
        );
      } catch {
        /* precache best-effort — runtime caching still kicks in */
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('network timeout')), ms),
    ),
  ]);
}

async function cachePut(req, res) {
  if (!res || !res.ok) return;
  // Don't cache partial / streaming / opaque-range responses.
  if (res.status !== 200) return;
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.put(req, res.clone());
  } catch {
    /* quota / storage pressure — ignore */
  }
}

async function cacheMatch(req) {
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    return await cache.match(req);
  } catch {
    return undefined;
  }
}

async function navigationFirst(req) {
  try {
    const res = await withTimeout(fetch(req), 3000);
    cachePut(req, res);
    return res;
  } catch {
    const cached = await cacheMatch(req);
    if (cached) return cached;
    const fallback = await cacheMatch('/');
    if (fallback) return fallback;
    return new Response(
      '<h1 style="font-family:sans-serif;text-align:center;margin-top:4rem">الموقع غير متاح حاليًا — تحقق من الاتصال ثم أعد المحاولة.</h1>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

async function cacheFirstAsset(req) {
  const cached = await cacheMatch(req);
  if (cached) return cached;
  const res = await fetch(req);
  cachePut(req, res);
  return res;
}

async function networkFirstWithCache(req, timeoutMs = 4000) {
  try {
    const res = await withTimeout(fetch(req), timeoutMs);
    cachePut(req, res);
    return res;
  } catch {
    const cached = await cacheMatch(req);
    if (cached) return cached;
    throw new Error('offline and not cached');
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(navigationFirst(req));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(req));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstWithCache(req, 4000));
    return;
  }

  event.respondWith(networkFirstWithCache(req, 4000));
});
