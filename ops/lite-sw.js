// Retire this worker. Resource caching belongs to the browser's HTTP cache.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.registration.unregister()));
