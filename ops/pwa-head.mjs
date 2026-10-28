import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export const pwaBackgrounds = {light: '#f3f3f4', dark: '#0f0f11'};

export function withConnectionTelemetry(html) {
  const source = readFileSync(new URL('./connection-telemetry.js', import.meta.url), 'utf8');
  const startup = readFileSync(new URL('./startup-status.js', import.meta.url));
  const version = createHash('sha256').update(source).update(startup).digest('hex').slice(0, 12);
  html = html.replace(/<script data-connection-telemetry>[\s\S]*?<\/script>/g, '');
  if (!html.includes('<head>')) throw Error('Document head missing');
  return html.replace('<head>', `<head><script data-connection-telemetry>window.__codexClientBuild='${version}';\n${source}</script>`);
}

export function withPwaHead(html) {
  html = html.replace(/<meta\b[^>]*name="theme-color"[^>]*>\s*/g, '');
  const viewport = /<meta\b[^>]*name="viewport"[^>]*>/;
  if (!viewport.test(html)) throw Error('Viewport metadata missing');
  return withConnectionTelemetry(html.replace(viewport, `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="${pwaBackgrounds.light}" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="${pwaBackgrounds.dark}" media="(prefers-color-scheme: dark)" />`));
}
