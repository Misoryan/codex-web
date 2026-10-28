// Send lifecycle timings without application frames or error text.
(() => {
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    const visit = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const start = performance.now();
    const mode = /^\/lite(?:\/|$)/.test(location.pathname) ? 'lite' : 'full';
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    let session, documentId, attempt = 0, sent = 0, periodStart = start;
    const number = value => Math.min(2147483647, Math.max(0, Math.round(value || 0)));
    const network = () => {
      const c = navigator.connection;
      if (!c) return {};
      return {
        ...(['wifi', 'cellular', 'ethernet', 'none', 'unknown', 'other', 'bluetooth', 'wimax'].includes(c.type) ? {networkType: c.type} : {}),
        ...(['slow-2g', '2g', '3g', '4g'].includes(c.effectiveType) ? {effectiveType: c.effectiveType} : {}),
        ...(Number.isFinite(c.rtt) ? {rttMs: number(c.rtt)} : {}),
        ...(Number.isFinite(c.downlink) ? {downlinkKbps: number(c.downlink * 1000)} : {}),
      };
    };
    const report = (event, fields = {}) => {
      try {
        const now = performance.now();
        if (now - periodStart >= 60_000) { sent = 0; periodStart = now; }
        if (sent++ >= 60) return;
        const body = JSON.stringify({event, visit, mode, standalone, online: navigator.onLine,
          visible: document.visibilityState === 'visible', elapsedMs: Math.min(2147483647, Math.round(now - start)),
          build: window.__codexClientBuild, session, document: documentId, attempt, ...network(), ...fields});
        navigator.sendBeacon('/__backend/telemetry', new Blob([body], {type: 'application/json'}));
      } catch {}
    };
    const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
    addEventListener('codex-startup-connection', ({detail}) => {
      if (!detail) return;
      if (detail.event === 'connecting') {
        session = uuid(detail.session); documentId = uuid(detail.document); attempt = detail.attempt;
      } else if (['open', 'close', 'error', 'first_message'].includes(detail.event)) {
        report(detail.event, {session: uuid(detail.session), document: uuid(detail.document), attempt: detail.attempt,
          durationMs: detail.durationMs, ...(detail.event === 'close' ? {code: detail.code} : {})});
      }
    });
    let foregroundAt;
    addEventListener('codex-recovery', ({detail}) => {
      if (!detail || !['caught_up', 'recovery_paint'].includes(detail.event)) return;
      report(detail.event, {resumed: detail.resumed === true, durationMs: number(detail.durationMs),
        replayEvents: number(detail.replayEvents), replayBytes: number(detail.replayBytes),
        ...(detail.resumed && foregroundAt != null ? {foregroundMs: number(performance.now() - foregroundAt)} : {})});
    });
    // Resource Timing gives browser/cache observations without sending URLs.
    let resourcesReported = false, navigationReported = false, resourceObserver;
    const resources = () => {
      const plan = window.__codexStartupAssets || {};
      const names = Object.keys(plan);
      const entries = new Map(performance.getEntriesByType('resource').map(entry => [new URL(entry.name).pathname, entry]));
      const done = names.map(name => entries.get(name)).filter(entry => entry?.responseEnd > 0 && entry.decodedBodySize > 0);
      const fields = {assetCount: names.length, assetsComplete: done.length,
        assetTransferBytes: number(done.reduce((sum, entry) => sum + entry.transferSize, 0)),
        assetEncodedBytes: number(done.reduce((sum, entry) => sum + entry.encodedBodySize, 0)),
        assetsEndMs: number(Math.max(0, ...done.map(entry => entry.responseEnd)))};
      if (!resourcesReported && names.length && done.length === names.length) {
        resourcesReported = true;
        report('resources_ready', fields);
        resourceObserver?.disconnect();
      }
      return fields;
    };
    const navigation = () => {
      const nav = performance.getEntriesByType('navigation')[0];
      if (navigationReported || !nav?.responseEnd) return;
      navigationReported = true;
      report('navigation', {dnsMs: number(nav.domainLookupEnd - nav.domainLookupStart),
        connectMs: number(nav.connectEnd - nav.connectStart),
        tlsMs: nav.secureConnectionStart > 0 ? number(nav.connectEnd - nav.secureConnectionStart) : 0,
        ttfbMs: number(nav.responseStart - nav.requestStart), htmlEndMs: number(nav.responseEnd),
        domReadyMs: number(nav.domContentLoadedEventEnd), navigationTransferBytes: number(nav.transferSize)});
    };
    try {
      resourceObserver = new PerformanceObserver(resources);
      resourceObserver.observe({type: 'resource', buffered: true});
    } catch {}
    addEventListener('load', () => { navigation(); resources(); });
    let ready = false;
    addEventListener('codex-startup-rendered', () => {
      if (ready) return;
      ready = true;
      navigation();
      report('ready', {durationMs: number(performance.now() - start), navigationMs: number(performance.now()), ...resources()});
    });
    addEventListener('online', () => report('online'));
    addEventListener('offline', () => report('offline'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') foregroundAt = performance.now();
      else foregroundAt = undefined;
      report(document.visibilityState === 'visible' ? 'visible' : 'hidden');
    });
    navigator.connection?.addEventListener('change', () => report('network_change'));
    addEventListener('pagehide', () => report('pagehide'));
    let errors = 0;
    addEventListener('error', event => {
      if (errors++ < 5) report(event.target === window ? 'js_error' : 'resource_error');
    }, true);
    addEventListener('unhandledrejection', () => { if (errors++ < 5) report('js_error'); });
    report('visit');
  } catch {}
})();
