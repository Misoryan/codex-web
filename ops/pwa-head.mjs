export const pwaBackgrounds = {light: '#f3f3f4', dark: '#0f0f11'};

export function withPwaHead(html) {
  html = html.replace(/<meta\b[^>]*name="theme-color"[^>]*>\s*/g, '');
  const viewport = /<meta\b[^>]*name="viewport"[^>]*>/;
  if (!viewport.test(html)) throw Error('Viewport metadata missing');
  return html.replace(viewport, `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="${pwaBackgrounds.light}" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="${pwaBackgrounds.dark}" media="(prefers-color-scheme: dark)" />`);
}
