(() => {
 const bundles = window.__codexLocaleAssets;
 let preferred;
 try { preferred = localStorage.getItem('codex-preload-locale'); } catch {}
 preferred ||= navigator.language;
 try {
  const locale = new Intl.Locale(preferred).maximize();
  const entries = Object.entries(bundles);
  const match = entries.find(([tag]) => tag.toLowerCase() === preferred.toLowerCase()) ||
   entries.find(([tag]) => {
    const candidate = new Intl.Locale(tag).maximize();
    return candidate.language === locale.language && candidate.script === locale.script && candidate.region === locale.region;
   }) || entries.find(([tag]) => {
    const candidate = new Intl.Locale(tag).maximize();
    return candidate.language === locale.language && candidate.script === locale.script;
   });
  if (!match) return;
  const link = document.createElement('link');
  link.rel = 'modulepreload';
  link.crossOrigin = 'anonymous';
  link.href = match[1];
  document.head.append(link);
 } catch {}
})();
