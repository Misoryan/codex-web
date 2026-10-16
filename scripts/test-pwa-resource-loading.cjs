const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, devices} = require('@playwright/test');

const oldWorker = fs.readFileSync('scripts/fixtures/stalled-worker.js', 'utf8');
const observerSource = fs.readFileSync('ops/startup-status.js', 'utf8');
const fixtureScript = 'window.resourceExecuted = true; document.body.append(Object.assign(document.createElement("textarea"), {id: "loaded"}));';

async function main() {
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  const reports = [];
  let passed = false;
  try {
    for (const fault of ['none', 'cache-rejected', 'cache-stalled', 'worker-update', 'draft-open', 'manual-refresh']) {
      let updated = fault !== 'worker-update', assetRequests = 0, documentRequests = 0;
      let failResource = fault === 'manual-refresh';
      const injection = fault === 'cache-rejected'
        ? 'caches.open = () => Promise.reject(new DOMException("Storage unavailable", "SecurityError"));\n'
        : ['cache-stalled', 'worker-update'].includes(fault) ? 'caches.open = () => new Promise(() => {});\n' : '';
      const server = http.createServer((request, response) => {
        response.setHeader('cache-control', 'no-store');
        if (request.url === '/lite/sw.js') {
          response.setHeader('content-type', 'text/javascript');
          response.end(injection + oldWorker);
        } else if (request.url === '/lite/assets/startup-fixture.js') {
          assetRequests++;
          response.setHeader('content-type', 'text/javascript');
          response.statusCode = failResource ? 503 : 200;
          response.end(failResource ? '' : fixtureScript);
        } else {
          response.setHeader('content-type', 'text/html; charset=utf-8');
          if (request.url !== '/lite/') return response.end('<!doctype html><title>Worker registration</title>');
          documentRequests++;
          const draft = fault === 'draft-open' ? '<div contenteditable="true" id="draft">未发送的草稿</div>' : '';
          response.end(`<!doctype html><head><meta charset="utf-8"></head><body>${draft}
            <script>window.__codexStartupAssets={"/lite/assets/startup-fixture.js":${Buffer.byteLength(fixtureScript)}};</script>
            <script>${updated ? observerSource : ''}</script>
            <script defer src="/lite/assets/startup-fixture.js"></script></body>`);
        }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext({...devices['Pixel 7'], serviceWorkers: 'allow'});
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(origin + '/lite/setup');
        if (!['none', 'manual-refresh'].includes(fault)) {
          await page.evaluate(async () => {
            await navigator.serviceWorker.register('/lite/sw.js', {scope: '/lite/', updateViaCache: 'none'});
            await navigator.serviceWorker.ready;
            if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once: true}));
          });
        }
        if (fault === 'manual-refresh') await context.addInitScript(() => {
          caches.keys = () => new Promise(() => {});
          caches.delete = () => new Promise(() => {});
        });
        await page.goto(origin + '/lite/', {waitUntil: 'commit'});
        if (fault === 'worker-update') {
          await page.waitForTimeout(300);
          assert.equal(assetRequests, 0, 'The previous worker must reproduce a blocked origin request');
          assert.equal(await page.evaluate(() => !!window.resourceExecuted), false);
          updated = true;
          await page.reload({waitUntil: 'commit'});
        }
        if (fault === 'manual-refresh') {
          await page.getByRole('button', {name: '重新加载静态资源', exact: true}).waitFor({timeout: 16000});
          const state = await page.evaluate(() => window.__codexStartupDiagnostics);
          assert.equal(state.startupResources.complete, 0, 'A failed resource cannot be counted as ready');
          assert(state.errors.includes('startup-fixture.js'));
          failResource = false;
          await page.getByRole('button', {name: '重新加载静态资源', exact: true}).click();
        }
        await page.locator('#loaded').waitFor({timeout: 7000});
        await page.waitForTimeout(600);
        if (fault === 'draft-open') {
          assert.equal(documentRequests, 1, 'Worker removal must preserve a running page');
          assert.equal(await page.locator('#draft').textContent(), '未发送的草稿');
        }
        const report = {fault, assetRequests, documentRequests, errors, metadata: await page.evaluate(() => ({
          executed: window.resourceExecuted === true,
          diagnostics: window.__codexStartupDiagnostics,
          speed: document.querySelector('[data-speed]')?.textContent,
        }))};
        reports.push(report);
        assert.equal(report.metadata.executed, true, 'The startup resource must actually execute');
        assert.deepEqual(errors, []);
        assert(assetRequests >= 1);
        assert(!String(report.metadata.speed).includes('正在统计速度'));
        console.log(JSON.stringify({fault, passed: true, assetRequests, documentRequests}));
      } catch (error) {
        reports.push({fault, assetRequests, documentRequests, error: error.message,
          diagnostics: await page.evaluate(() => window.__codexStartupDiagnostics).catch(() => null)});
        throw error;
      } finally {
        await context.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }
    passed = true;
  } finally {
    await browser.close();
    const directory = 'runtime/pwa-resource-loading';
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify({passed, reports}, null, 2));
  }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
