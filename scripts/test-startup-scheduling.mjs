import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import {chromium} from '@playwright/test';
import {withStartupPreloads, withVersionedAssets} from '../ops/startup-preloads.mjs';

// Browser boundary: the real HTML transform must request the locale before app
// initialization; the real scheduler must wait for a visible composer.
const root = 'runtime/startup-scheduling-test';
await fs.mkdir(root + '/assets', {recursive: true});
for (const name of ['app-initial-test.js','zh-CN-abc123.js','zh-TW-def456.js','de-DE-abc456.js'])
 await fs.writeFile(root + '/assets/' + name, 'export const fixture = true;');
await fs.writeFile(root + '/assets/app-initial-test.js', 'const locales={"../locales/zh-CN.json":()=>import("./zh-CN-abc123.js"),"../locales/zh-TW.json":()=>import("./zh-TW-def456.js"),"../locales/de-DE.json":()=>import("./de-DE-abc456.js")};');
const scheduler = (await fs.readFile('src/browser/after-startup-paint.js','utf8')).replace('export function','function');
const html = withVersionedAssets(await withStartupPreloads('<html><head><base href="/lite/" /></head><body><script>' + scheduler + ';window.warmed=0;window.cancelWarmup=afterStartupPaint(()=>window.warmed++);</script></body></html>', root, '/lite/'), 'fixture');
const requests = [];
const server = http.createServer((req, res) => {
 requests.push(req.url);
 res.setHeader('content-type', req.url.endsWith('.js') ? 'application/javascript' : 'text/html');
 res.end(req.url.endsWith('.js') ? 'export const loaded=true;' : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
 for (const [preferred, expected] of [[null,'zh-CN-abc123.js'],['zh-Hant','zh-TW-def456.js'],['de-DE','de-DE-abc456.js'],['en-US',null]]) {
  const context = await browser.newContext({locale:'zh-CN'});
  if (preferred) await context.addInitScript(value => localStorage.setItem('codex-preload-locale',value), preferred);
  const page = await context.newPage();
  requests.length = 0;
  await page.goto(`http://127.0.0.1:${server.address().port}/lite/`);
  if (expected) await page.waitForFunction(name => performance.getEntriesByType('resource').some(r=>r.name.endsWith(name)), expected);
  const locales = requests.filter(url=>/\/(?:zh|de)-/.test(url));
  assert.deepEqual(locales, expected ? ['/codex-static/fixture/lite/assets/' + expected] : []);
  assert.equal(await page.evaluate(()=>window.warmed),0);
  await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<div contenteditable="true" style="display:none">fixture</div>'));
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>window.warmed),0,'Hidden input must not release warmups');
  await page.evaluate(()=>document.querySelector('[contenteditable]').style.display='block');
  await page.waitForFunction(()=>window.warmed===1);
  await page.evaluate(()=>{document.body.append(document.createElement('div'));window.cancelWarmup();});
  assert.equal(await page.evaluate(()=>window.warmed),1);
  await context.close();
 }
 const page = await browser.newPage();
 await page.goto(`http://127.0.0.1:${server.address().port}/lite/`);
 await page.evaluate(()=>{window.cancelWarmup();document.body.insertAdjacentHTML('beforeend','<div contenteditable="true">fixture</div>');});
 await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>window.warmed),0,'Unmounted work remains cancelled');
 console.log('Browser startup scheduling passed: early versioned locale selection, visible-input warmups, cancellation');
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
