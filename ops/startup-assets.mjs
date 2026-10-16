import fs from 'node:fs/promises';
import path from 'node:path';

// Count the actual entrypoint resources, not optional lazy-loaded panels.
export async function withStartupAssets(html, webRoot, basePath, entryRoot) {
  html = html.replace(/<script data-startup-assets>[\s\S]*?<\/script>/, '');
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match => new URL(match[1], 'https://local' + basePath))
    .filter(url => url.origin === 'https://local' && url.pathname.includes('/assets/') && /\.(js|css)$/.test(url.pathname));
  const assets = Object.fromEntries(await Promise.all([...new Set(urls.map(url => url.pathname))].map(async pathname =>
    [pathname, (await fs.stat(entryRoot ? path.join(entryRoot, pathname.slice(basePath.length)) : path.join(webRoot, pathname))).size])));
  return html.replace('<head>', '<head><script data-startup-assets>window.__codexStartupAssets=' + JSON.stringify(assets) + ';</script>');
}
