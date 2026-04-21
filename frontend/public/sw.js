// Kill-switch service worker.
//
// Any browser that previously registered a Workbox-based SW still sends
// a periodic update check to /sw.js. When it sees THIS file, it installs
// it and activates it — which immediately deletes every Cache-Storage
// entry this origin ever created and unregisters itself. On the next
// navigation the browser runs with no SW, no stale precache, no weird
// "refresh → white screen" behaviour.
//
// Keep this file in place for a few days so every client has a chance to
// update. Remove (or replace with a fresh Workbox SW) after that.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      } catch (_) {
        // ignore — we still want to unregister
      }
      try {
        await self.registration.unregister();
      } catch (_) {
        // ignore
      }
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        // Navigate clients so they boot a fresh, SW-less page.
        client.navigate(client.url);
      }
    })(),
  );
});
