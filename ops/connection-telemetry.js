// Only connection metadata is sent. Application frames and error text stay local.
(() => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  const visit = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const start = performance.now();
  const mode = location.pathname.startsWith('/lite/') ? 'lite' : 'full';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let attempt = 0, session, documentId;
  const report = (event, fields = {}) => {
    const body = JSON.stringify({event, visit, mode, standalone, online: navigator.onLine,
      visible: document.visibilityState === 'visible', elapsedMs: Math.round(performance.now() - start),
      build: window.__codexClientBuild, session, document: documentId, attempt, ...fields});
    navigator.sendBeacon('/__backend/telemetry', new Blob([body], {type: 'application/json'}));
  };
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      const url = new URL(args[0], location.href);
      if (url.pathname !== '/__backend/ipc') return;
      session = url.searchParams.get('session') || undefined;
      documentId = url.searchParams.get('document') || undefined;
      const currentAttempt = ++attempt;
      const connectedAt = performance.now();
      this.addEventListener('open', () => report('open', {attempt: currentAttempt, durationMs: Math.round(performance.now() - connectedAt)}));
      this.addEventListener('close', event => report('close', {attempt: currentAttempt, code: event.code, durationMs: Math.round(performance.now() - connectedAt)}));
      this.addEventListener('error', () => report('error', {attempt: currentAttempt}));
    }
  };
  addEventListener('codex-connection-state', event => {
    if (event.detail?.state === 'ready') report('ready');
  });
  addEventListener('online', () => report('online'));
  addEventListener('offline', () => report('offline'));
  document.addEventListener('visibilitychange', () => report(document.visibilityState === 'visible' ? 'visible' : 'hidden'));
  addEventListener('pagehide', () => report('pagehide'));
  let errors = 0;
  addEventListener('error', event => {
    if (errors++ < 5) report(event.target === window ? 'js_error' : 'resource_error');
  }, true);
  addEventListener('unhandledrejection', () => { if (errors++ < 5) report('js_error'); });
  report('visit');
})();
