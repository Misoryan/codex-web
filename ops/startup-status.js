// Record startup timing without reading messages or drafts.
(() => {
  const state = window.__codexStartupDiagnostics = {version: 2, phase: '加载页面', errors: [], receivedBytes: 0, connections: []};
  const now = () => Math.round(performance.now());
  if ('serviceWorker' in navigator && isSecureContext && location.pathname.startsWith('/lite/')) {
    const controller = navigator.serviceWorker.controller;
    navigator.serviceWorker.getRegistration('/lite/')
      .then(async registration => {
        if (registration?.scope !== new URL('/lite/', location.href).href) return;
        const removed = await registration.unregister();
        state.workerRemoved = removed;
        // A new document releases requests held by the retired worker.
        if (removed && controller && !document.querySelector('[contenteditable="true"]')) location.reload();
      })
      .catch(() => { state.workerRemoved = false; });
  }
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      if (new URL(args[0], location.href).pathname !== '/__backend/ipc') return;
      const connection = {connectMs: now(), receivedBytes: 0};
      state.connections.push(connection);
      state.attempts = (state.attempts || 0) + 1;
      if (state.connections.length > 5) state.connections.shift();
      for (const key of ['openMs', 'handshakeMs', 'firstMessageMs', 'lastMessageMs', 'closeCode', 'closeReason', 'readyMs']) delete state[key];
      state.connectMs = connection.connectMs;
      state.phase = '正在连接电脑';
      this.addEventListener('open', () => {
        connection.openMs = now();
        connection.handshakeMs = connection.openMs - connection.connectMs;
        if (state.connections.at(-1) === connection) {
          state.openMs = connection.openMs;
          state.handshakeMs = connection.handshakeMs;
          state.phase = '等待界面初始化';
        }
      });
      this.addEventListener('message', event => {
        const messageMs = now();
        connection.firstMessageMs ??= messageMs;
        connection.lastMessageMs = messageMs;
        if (state.connections.at(-1) === connection) {
          state.firstMessageMs = connection.firstMessageMs;
          state.lastMessageMs = messageMs;
        }
        const bytes = typeof event.data === 'string' ? new TextEncoder().encode(event.data).byteLength : event.data.byteLength || event.data.size || 0;
        connection.receivedBytes += bytes;
        state.receivedBytes += bytes;
      });
      this.addEventListener('close', event => {
        Object.assign(connection, {closeMs: now(), closeCode: event.code, closeReason: event.reason, wasClean: event.wasClean});
        if (state.connections.at(-1) !== connection) return;
        state.closeCode = event.code;
        state.closeReason = event.reason;
        state.phase = '连接已断开';
      });
      this.addEventListener('error', () => { if (state.connections.at(-1) === connection) state.phase = '后端连接失败'; });
    }
  };
  addEventListener('codex-connection-state', event => {
    state.connectionState = event.detail.state;
    if (event.detail.state === 'ready') {
      state.readyMs ??= now();
      const latest = state.connections.at(-1);
      if (latest) latest.readyMs ??= state.readyMs;
      state.phase = '正在初始化界面';
    } else if (event.detail.reason) state.phase = event.detail.reason;
  });
  addEventListener('error', event => {
    const source = event.target?.src || event.target?.href;
    // Keep filenames only, never error text containing application data.
    state.errors.push(source ? new URL(source, location.href).pathname.split('/').pop() : '脚本执行错误');
    state.errors = state.errors.slice(-5);
  }, true);
  let panel, progressPanel;
  const timer = setInterval(() => {
    if (!document.body) return;
    if (document.querySelector('[contenteditable="true"]')) {
      state.composerMs = now();
      clearInterval(timer); panel?.remove(); progressPanel?.remove(); return;
    }
    if (!progressPanel) {
      progressPanel = document.createElement('div');
      progressPanel.dataset.startupProgress = '';
      progressPanel.setAttribute('role', 'status');
      progressPanel.style.cssText = 'position:fixed;left:20px;right:20px;bottom:max(24px,env(safe-area-inset-bottom));z-index:1000;text-align:center;font:13px/1.6 system-ui;color:#777;pointer-events:none';
      progressPanel.style.maxWidth = '420px';
      progressPanel.style.margin = 'auto';
      progressPanel.innerHTML = '<style>[data-startup-progress] progress{appearance:none;-webkit-appearance:none;border:0;border-radius:99px;overflow:hidden;background:#8883}[data-startup-progress] progress::-webkit-progress-bar{background:#8883;border-radius:99px}[data-startup-progress] progress::-webkit-progress-value{background:#888;border-radius:99px}[data-startup-progress] progress::-moz-progress-bar{background:#888;border-radius:99px}</style><div data-phase></div><progress aria-label="启动资源加载进度" max="1" value="0" style="display:block;width:100%;height:10px;margin:10px 0;accent-color:#777"></progress><div style="display:flex;justify-content:space-between;gap:10px"><span data-count></span><span data-speed></span></div><div data-bytes style="font-size:12px;margin-top:3px"></div>';
      document.body.append(progressPanel);
    }
    const resources = performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname.includes('/assets/'));
    const plan = window.__codexStartupAssets || {};
    const entries = new Map(resources.map(entry => [new URL(entry.name).pathname, entry]));
    let loaded = 0, total = 0, complete = 0, networkBytes = 0;
    for (const [pathname, size] of Object.entries(plan)) {
      const entry = entries.get(pathname);
      const done = entry?.responseEnd > 0 && entry.decodedBodySize > 0 && !state.errors.includes(pathname.split('/').pop());
      total += size;
      loaded += done ? size : 0;
      if (done) complete++;
    }
    for (const entry of entries.values()) if (entry.transferSize > 0) networkBytes += entry.encodedBodySize;
    const count = Object.keys(plan).length;
    const ready = count > 0 && complete === count;
    const percent = total ? Math.min(100, Math.floor(100 * loaded / total)) : 0;
    const configPhase = {fingerprinting:'正在校验运行配置',checking:'正在确认配置缓存',uploading:'正在同步新的运行配置'}[window.__codexLiteConfigState];
    const phase = state.errors.length ? '界面资源加载失败，请重新加载' : !ready ? '正在加载界面资源' : !state.openMs ? '正在连接电脑' : configPhase || '正在初始化界面';
    state.configuration = window.__codexLiteConfigState;
    const extra = [...entries.keys()].filter(pathname => !(pathname in plan)).length;
    const firstStart = resources.length ? Math.min(...resources.map(entry => entry.startTime)) : 0;
    const speed = networkBytes / Math.max(0.1, (now() - firstStart) / 1000);
    const formatSpeed = speed >= 1048576 ? (speed / 1048576).toFixed(1) + ' MB/s' : Math.round(speed / 1024) + ' KB/s';
    state.resources = resources.length;
    state.startupResources = {complete, total: count, loadedBytes: loaded, totalBytes: total, percent};
    state.pendingResources = Object.keys(plan).filter(pathname => !entries.get(pathname)?.decodedBodySize || state.errors.includes(pathname.split('/').pop())).map(pathname => pathname.split('/').pop());
    state.networkBytesEstimate = Math.round(networkBytes);
    progressPanel.querySelector('[data-phase]').textContent = `${phase} · ${(now() / 1000).toFixed(1)} 秒`;
    const bar = progressPanel.querySelector('progress');
    bar.value = loaded; bar.max = total || 1;
    bar.setAttribute('aria-valuetext', `启动资源 ${complete}/${count}，${percent}%`);
    progressPanel.querySelector('[data-count]').textContent = `启动资源 ${complete} / ${count} · ${percent}%`;
    progressPanel.querySelector('[data-speed]').textContent = ready ? '资源已就绪' : networkBytes > 0 ? `平均下载约 ${formatSpeed}` : complete > 0 ? '正在读取资源' : '等待资源响应';
    progressPanel.querySelector('[data-bytes]').textContent = `已读取 ${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB${extra ? ` · 另已加载 ${extra} 个按需资源` : ''}`;
    if (now() < 12000) return;
    progressPanel.style.bottom = '210px';
    if (!panel) {
      panel = document.createElement('aside');
      panel.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;max-width:520px;margin:auto;z-index:2147483647;padding:16px;background:#fff;color:#222;border:1px solid #bbb;border-radius:12px;font:14px/1.5 system-ui;box-shadow:0 4px 24px #0002';
      panel.innerHTML = '<strong>启动时间较长</strong><pre style="white-space:pre-wrap;font:inherit"></pre><button type="button">重新加载静态资源</button> <button type="button">复制诊断</button>';
      const buttons = panel.querySelectorAll('button');
      buttons[0].onclick = () => {
        buttons[0].disabled = true;
        location.reload();
      };
      buttons[1].onclick = () => navigator.clipboard.writeText(JSON.stringify(state, null, 2)).then(() => { buttons[1].textContent = '已复制'; });
      document.body.append(panel);
    }
    const latest = state.connections.at(-1);
    panel.querySelector('pre').textContent = `${state.phase}（${Math.round(now() / 1000)} 秒）\n连接尝试：${state.attempts || 0} 次；最近握手：${latest?.handshakeMs ?? '未建立'} ms\n最近连接首条响应：${latest?.firstMessageMs == null ? '未收到' : latest.firstMessageMs - latest.connectMs} ms\n断开原因：${latest?.closeReason || (latest?.closeCode == null ? '无' : String(latest.closeCode))}\n等待资源：${state.pendingResources.join('、') || '无'}\n资源错误：${state.errors.join('、') || '无'}`;
  }, 500);
})();
