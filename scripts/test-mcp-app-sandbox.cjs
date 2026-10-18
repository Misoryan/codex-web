const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { build } = require('esbuild');
const { chromium } = require('playwright-core');

(async () => {
  const options = { bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', nodePaths: process.env.NODE_PATH?.split(path.delimiter) };
  const host = await build({ ...options, entryPoints: ['src/browser/mcp-app-sandbox.ts'] });
  const app = await build({ ...options, stdin: { resolveDir: process.cwd(), contents: `
    import { App } from '@modelcontextprotocol/ext-apps';
    const app = new App({name:'fixture',version:'1.0.0'},{});
    app.addEventListener('hostcontextchanged', c => document.body.dataset.theme=c.theme);
    await app.connect();
    const result = await app.callServerTool({name:'read_fixture',arguments:{id:42}});
    document.querySelector('#result').textContent=result.content[0].text;
    document.querySelector('button').onclick=()=>app.openLink({url:'codex://threads/00000000-0000-4000-8000-000000000042'});
  ` } });
  const server = http.createServer((req, res) => {
    if (req.url === '/host.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(host.outputFiles[0].text); }
    res.setHeader('Content-Type', 'text/html'); res.end('<html><body><iframe title="fixture"></iframe></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port);
    const appHtml = '<main id="result">Loading</main><button>Open conversation</button><script type="module">' + app.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>';
    await page.evaluate(async html => {
      const { connect } = await import('/host.js');
      const controller = new AbortController();
      window.fixtureController = controller;
      window.addEventListener('message', event => { if (event.data?.type === 'navigate-to-route') window.fixtureNavigation = event.data.path; });
      const frame = document.querySelector('iframe');
      window.fixtureApi = connect({ webview: frame, signal: controller.signal, hostApiHandlers: {
        callMcp: async request => {
          window.fixtureRequest = request;
          return { content: [{ type: 'text', text: 'Fixture item 42' }] };
        },
        initializeMcpApp: async () => {}, notifyIntrinsicHeight: () => {}, notifyIntrinsicWidth: () => {},
        notifyEnvironmentError: error => { window.fixtureError = error.message; },
      } });
      window.fixtureRunning = (async () => {
        for await (const status of window.fixtureApi.runWidgetCode({ html, csp: { resourceDomains: [], connectDomains: [] }, toolInput: {}, mcpApps: { hostInfo: { name: 'Browser fixture', version: '1.0.0' }, hostCapabilities: { serverTools: {}, openLinks: {} }, hostContext: { theme: 'light', displayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] } } })) window.fixtureStatus = status;
      })();
    }, appHtml);
    const frame = page.frameLocator('iframe');
    await frame.locator('#result').filter({ hasText: 'Fixture item 42' }).waitFor();
    await page.waitForFunction(() => window.fixtureStatus?.status === 2);
    const request = await page.evaluate(() => window.fixtureRequest);
    assert.equal(request.method, 'tools/call');
    assert.equal(request.params.name, 'read_fixture');
    assert.deepEqual(request.params.arguments, { id: 42 });
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await frame.locator('body').evaluate(() => { try { return window.parent.document.body.tagName; } catch { return 'isolated'; } }), 'isolated');
    await page.evaluate(() => window.fixtureApi.setTheme({ theme: 'dark' }));
    await frame.locator('body[data-theme="dark"]').waitFor();
    await frame.getByRole('button', { name: 'Open conversation' }).click();
    await page.waitForFunction(() => window.fixtureNavigation === '/local/00000000-0000-4000-8000-000000000042');
    await page.evaluate(() => window.fixtureController.abort());
    assert.equal(await page.locator('iframe').getAttribute('srcdoc'), null);
    console.log('MCP app browser boundary: SDK tool call, opaque isolation, host theme, native conversation navigation and teardown passed');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
