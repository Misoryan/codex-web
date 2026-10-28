const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {chromium} = require('@playwright/test');

const hash = data => createHash('sha256').update(data).digest('hex');
const oldCss = Buffer.from(':root { --style-update-fixture: previous-release; }');
const newHtml = fs.readFileSync('scratch/asar/webview/lite/index.html','utf8');
const href = newHtml.match(/href="([^"]*\/mobile\.css[^"]*)"/)[1];
const stylesheetPath = new URL(href, 'https://example.invalid').pathname;
const newCss = fs.readFileSync(path.join('scratch/asar/webview', stylesheetPath));

(async () => {
  assert.notEqual(hash(oldCss),hash(newCss),'This scenario requires an actual stylesheet change');
  let updated = false, cssRequests = 0;
  const server = http.createServer((req,res) => {
    if (req.url === '/lite/assets/mobile.css' || req.url === href) {
      res.setHeader('Cache-Control','private, max-age=31536000');
      cssRequests++;res.setHeader('Content-Type','text/css');res.end(updated && req.url === href ? newCss : oldCss);
    } else {
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Content-Type','text/html');
      res.end(`<html><head><link rel="stylesheet" href="${updated ? href : '/lite/assets/mobile.css'}"></head><body>Style update test</body></html>`);
    }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const context = await browser.newContext({serviceWorkers:'allow'}), page = await context.newPage();
  try {
    await page.goto(origin + '/lite/');
    await page.reload();
    assert.equal(hash(await page.evaluate(async () => [...new Uint8Array(await (await fetch('/lite/assets/mobile.css')).arrayBuffer())]).then(bytes=>Buffer.from(bytes))),hash(oldCss));
    updated = true;
    const before = cssRequests;
    await page.reload();
    const applied = await page.evaluate(async () => {
      const link = document.querySelector('link[rel=stylesheet]');
      return {href:new URL(link.href).pathname + new URL(link.href).search,bytes:[...new Uint8Array(await (await fetch(link.href)).arrayBuffer())]};
    });
    assert.equal(applied.href,href,'The page requests the built stylesheet URL');
    assert.equal(hash(Buffer.from(applied.bytes)),hash(newCss),'New HTML receives the current CSS');
    assert(cssRequests > before,'The new stylesheet bypasses the old cached URL');
    const warm = cssRequests;
    await page.reload();
    assert.equal(cssRequests,warm,'Warm starts retain stylesheet caching');
    const result = {href,oldCssSha256:hash(oldCss),newCssSha256:hash(newCss),nativeHttpCache:true,warmCssRequests:cssRequests-warm};
    fs.mkdirSync('runtime/mobile-shell',{recursive:true});
    fs.writeFileSync('runtime/mobile-shell/pwa-style-update.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  } finally {await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e => {console.error(e);process.exitCode=1;});
