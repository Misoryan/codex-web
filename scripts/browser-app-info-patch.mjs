export function patchBrowserAppInfo(source) {
  if (source.includes('CODEX_WEB_APP_INFO')) return source;
  const anchor = 'queryFn: () => e6.appInfo.get(),';
  if(source.split(anchor).length !== 2) throw Error('Native application info query changed');
  return source.replace(anchor,'queryFn: async () => window.codexBrowserAppInfo, /* CODEX_WEB_APP_INFO */');
}
