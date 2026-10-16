// Supply a cache-dependent resource request to the startup recovery test.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (new URL(event.request.url).pathname === '/lite/assets/startup-fixture.js') {
    event.respondWith(caches.open('startup-fixture').then(() => fetch(event.request)));
  }
});
