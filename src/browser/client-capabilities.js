// These services belong to the viewing device, never the remote app host.
export function codexWebClientPlatform() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (/Win/i.test(platform)) return 'win32';
  if (/Android/i.test(navigator.userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(platform) || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Mac/i.test(platform)) return 'darwin';
  if (/Linux/i.test(platform)) return 'linux';
  return 'unknown';
}

export function codexWebInstallClientBridge(api) {
  window.codexWebClient = Object.freeze({
    kind: window.codexElectron ? 'electron' : 'browser',
    platform: codexWebClientPlatform(),
  });
  // Keep windowType for the app-host transport, but do not advertise Desktop APIs.
  delete api.startFileDrag;
  delete api.startLinkDrag;
  api.getDesktopUserAgent = () => null;
  api.isIntelMacBuild = () => false;
}

export function codexWebClipboardError() {
  const zh = /^zh\b/i.test(navigator.language);
  if (!window.isSecureContext || !navigator.clipboard)
    return zh ? '复制需要 HTTPS 安全连接。' : 'Copying requires a secure HTTPS connection.';
  if (!document.hasFocus())
    return zh ? '请回到当前页面或客户端窗口后重试复制。' : 'Focus this page or client window and try copying again.';
  return zh ? '复制失败，请检查当前浏览器或客户端的剪贴板权限。' : 'Copy failed. Check clipboard permissions for this browser or client.';
}

export function codexWebWriteText(value) {
  if (!navigator.clipboard) return Promise.reject(new Error(codexWebClipboardError()));
  if (typeof value === 'string') return navigator.clipboard.writeText(value);
  // Begin writing during the click, before asynchronous content loses activation.
  const blob = Promise.resolve(value).then(text => new Blob([text], {type: 'text/plain'}));
  blob.catch(() => {});
  return navigator.clipboard.write([new ClipboardItem({'text/plain': blob})]);
}

export function codexWebClientServices(services) {
  const clipboard = {
    bookmark: undefined,
    readText: () => navigator.clipboard.readText(),
    writeText: codexWebWriteText,
  };
  return new Proxy(services, {
    get(target, key) {
      return key === 'clipboard' ? clipboard : Reflect.get(target, key);
    },
  });
}
