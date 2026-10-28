# Startup initialization

Full and Lite fetch feature evaluations through `POST /__backend/feature-config`.
The server forwards the SDK's request bytes and query flags to its fixed public
evaluation endpoint, retaining only Statsig request headers. Gateway cookies and
authorization headers are never forwarded. Responses use normal HTTP compression
and bypass the WebSocket RPC stream. Simultaneous requests with identical bodies,
URLs and relevant headers share an upstream operation; completed responses are
not cached by the server. The existing gateway authentication covers this route.

Full and Lite share one evaluation snapshot in IndexedDB, keyed by the exact SDK key and
user context. Concurrent initialization of one client shares a promise. Targeting
updates save the current user's snapshot, and persistence does not block initial
rendering. The SDK starts synchronously with a matching snapshot or its defaults;
remote evaluation begins after the composer paints. Identity changes never reuse
another user's snapshot. Evaluation outages cannot hold the initial screen open.

Startup access diagnostics request `/__backend/health` through the current gateway.
A forbidden response from a separate profile service is not evidence that Codex
login has expired. HTTP 401 reports an authentication failure; 403 reports access
denied. The diagnostic does not assume an OAuth login route exists.

The HTML builder discovers locale modules from the application's actual locale
loader. An early module preload uses the last rendered locale or the browser's
language. This is a loading hint; the application still decides the displayed
language. Locale URLs use the same immutable release prefix as other assets.

Lite conversation prefetch and Full/Lite dictation sound warmup run after a visible
composer, two animation frames and an idle callback. Route navigation and explicit
sound playback retain their normal demand-loading paths. Unmount/page exit cancels
pending warmups.

Validation:

- `npm test` includes the HTTP boundary: request coalescing, identity separation,
  encoded bodies, compression, gateway-secret isolation, rejection and recovery.
- `npm run test:desktop` exercises the pinned real Statsig SDK and IndexedDB,
  language preload selection, immutable URLs and browser scheduling.
- Deploy the backend endpoint before selecting its new frontend release. Backend
  activation must wait for idle sessions when that release policy is requested.
