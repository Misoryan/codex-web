// Installable app shell only. Application pages, assets and APIs always use the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('codex-web')) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex 暂时无法连接</title><body style="font:16px system-ui;padding:24px"><h1>暂时无法连接</h1><p>请确认电脑在线及网络可用，再重新打开 Codex。</p><button onclick="location.reload()">重新加载</button></body></html>',
    {status:503,headers:{'Content-Type':'text/html; charset=utf-8'}},
  )));
});
