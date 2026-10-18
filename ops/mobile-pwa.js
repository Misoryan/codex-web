const mobile = matchMedia('(max-width: 768px)');
let pwaThemeFrame;
function schedulePwaThemeColor() {
  if (pwaThemeFrame) return;
  pwaThemeFrame = requestAnimationFrame(() => {
    pwaThemeFrame = undefined;
    const root = document.documentElement;
    const source = mobile.matches && root.dataset.theme === 'dark'
      ? document.querySelector('[data-app-shell-titlebar]')
      : root;
    if (!source) return;
    const color = getComputedStyle(source).backgroundColor;
    if (color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      if (meta.content !== color) meta.content = color;
    }
  });
}
schedulePwaThemeColor();
new MutationObserver(schedulePwaThemeColor).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['class', 'style', 'data-theme'],
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedulePwaThemeColor);
mobile.addEventListener('change', schedulePwaThemeColor);
window.addEventListener('load', schedulePwaThemeColor);

function resizeViewport() {
  document.documentElement.style.setProperty('--codex-web-viewport-height', `${window.visualViewport?.height ?? innerHeight}px`);
}
resizeViewport();
window.visualViewport?.addEventListener('resize', resizeViewport);
window.addEventListener('resize', resizeViewport);

function addRefreshAction(root) {
  if (!(root instanceof Element)) return;
  const menus = new Set(root.querySelectorAll('[data-radix-menu-content]'));
  const parentMenu = root.closest('[data-radix-menu-content]');
  if (parentMenu) menus.add(parentMenu);
  for (const menu of menus) {
    const item = menu.querySelector('[role="menuitem"][aria-keyshortcuts="Control+Alt+R"]');
    if (!item || menu.querySelector('[data-codex-web-refresh]')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = item.className;
    button.setAttribute('role', 'menuitem');
    button.setAttribute('data-codex-web-refresh', '');
    button.innerHTML = '<span class="flex w-full items-center gap-1.5"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 17.9 17"/></svg><span>刷新页面</span></span>';
    button.addEventListener('click', () => location.reload());
    menu.append(button);
  }
}
addRefreshAction(document.documentElement);

function markTerminalLauncher(root) {
  if (!(root instanceof Element)) return;
  const buttons = new Set(root.querySelectorAll('button, [role="menuitem"]'));
  const parentButton = root.closest('button, [role="menuitem"]');
  if (parentButton) buttons.add(parentButton);
  for (const button of buttons) {
    const menuItem = button.matches('[role="menuitem"]');
    if (!menuItem && !button.closest('aside[data-app-shell-focus-area="right-panel"]')) continue;
    const label = menuItem
      ? button.textContent.replace(button.querySelector('kbd')?.textContent ?? '', '').trim()
      : button.querySelector('span.truncate')?.textContent.trim();
    button.toggleAttribute('data-codex-web-terminal-launcher', ['Terminal', '终端', '終端', '終端機'].includes(label));
  }
}
markTerminalLauncher(document.documentElement);
new MutationObserver(records => {
  for (const record of records) {
    if (record.type === 'characterData') markTerminalLauncher(record.target.parentElement);
    else for (const node of record.addedNodes) {
      const root = node instanceof Element ? node : node.parentElement;
      markTerminalLauncher(root);
      addRefreshAction(root);
    }
  }
  schedulePwaThemeColor();
}).observe(document.documentElement, {subtree: true, childList: true, characterData: true});
document.addEventListener('click', event => {
  if (!mobile.matches || !(event.target instanceof Element)) return;
  const sidebar = document.querySelector('.app-shell-left-panel');
  if (sidebar?.querySelector('#settings-search')) return;
  if (document.querySelector('[data-app-shell-sidebar-trigger][aria-expanded="true"]') && event.target.closest('[class*="_MainContentClip_"]')) {
    event.preventDefault(); event.stopPropagation(); window.__ELECTRON_SHIM__?.closeSidebar?.();
  }
}, true);
if ('serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('/sw.js', {updateViaCache:'none'}).catch(console.error);
}
