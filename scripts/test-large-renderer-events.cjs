const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {buildSync} = require('esbuild');
const {chromium} = require('@playwright/test');

// Use the production server and browser bridge with isolated native windows.
// No installed backend, user profile or real conversation is involved.
fs.mkdirSync('runtime/tmp', {recursive: true});
const candidate = fs.mkdtempSync(path.resolve('runtime/tmp/large-renderer-'));
fs.mkdirSync(path.join(candidate, 'src'), {recursive: true});
fs.cpSync('src/server', path.join(candidate, 'src/server'), {recursive: true});
fs.cpSync('src/shared', path.join(candidate, 'src/shared'), {recursive: true});
const {createBridgeServer} = require(path.join(candidate, 'src/server/main.js'));
const bridgeSource = fs.readFileSync('src/browser/resumable-bridge.ts', 'utf8');
const bundle = buildSync({stdin: {contents: `${bridgeSource}
window.received=[];window.states=[];window.identity=crypto.randomUUID();
window.bridge=new ResumableBridge(crypto.randomUUID(),'',event=>{
  const text=event.data;
  received.push({id:event.id,length:text.length,first:text.slice(0,4),last:text.slice(-4)});
},value=>value,(state,reason)=>{states.push(state);showConnectionState(state,reason)});`, loader: 'ts'},
  bundle: true, write: false, format: 'iife', target: 'es2022'}).outputFiles[0].text;
const web = path.join(candidate, 'scratch/asar/webview');
fs.mkdirSync(path.join(web, 'lite'), {recursive: true});
const html = `<div id="root"><textarea aria-label="draft"></textarea></div><script>${bundle}</script>`;
for (const file of ['index.html', 'lite/index.html']) fs.writeFileSync(path.join(web, file), html);

async function main() {
  // Exercise environment wiring as well as the larger default tested in units.
  const names = ['CODEX_WEB_RENDERER_SESSION_MIB', 'CODEX_WEB_RENDERER_TOTAL_MIB'];
  const previous = names.map(name => process.env[name]);
  let app;
  try {
    process.env[names[0]] = '64'; process.env[names[1]] = '128';
    app = await createBridgeServer(path.join(candidate, 'logs'));
  } finally {
    names.forEach((name, index) => previous[index] === undefined ? delete process.env[name] : process.env[name] = previous[index]);
  }
  const state = globalThis.__codexElectronIpcBridge;
  let created = 0;
  const destroyed = new Set();
  state.setRendererWindowFactory(async () => {
    const id = ++created;
    return {id, webContents: {id}, destroy() {destroyed.add(id);}};
  });
  await app.listen({host: '127.0.0.1', port: 0});
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  let browser;
  const results = [], errors = [];
  try {
    assert.deepEqual((await (await fetch(origin + '/__backend/health')).json()).rendererBufferLimits,
      {sessionBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024});
    browser = await chromium.launch({channel: 'chrome', headless: true});
    const text = '历史🙂'.repeat(4 * 1024 * 1024);
    assert.equal(Buffer.byteLength(text), 40 * 1024 * 1024);
    for (const route of ['/', '/lite/']) {
      const page = await browser.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 500));
      await page.goto(origin + route);
      await page.waitForFunction(() => states.at(-1) === 'ready');
      const windowId = created;
      const identity = await page.evaluate(() => identity);
      await page.getByRole('textbox').fill('fixture draft');
      const send = id => state.sendToRenderer(windowId, {type: 'message-port-message', id, data: text});
      send('live');
      await page.waitForFunction(() => received.length === 1, null, {timeout: 60_000});
      assert.equal(await page.evaluate(() => states.at(-1)), 'ready');
      await page.evaluate(() => bridge.socket.close(1000, 'Fixture disconnect'));
      await page.waitForFunction(() => states.at(-1) === 'offline');
      send('offline');
      await page.clock.runFor(1000);
      await page.waitForFunction(() => states.at(-1) === 'ready' && received.length === 2, null, {timeout: 60_000});
      const received = await page.evaluate(() => received);
      assert.deepEqual(received.map(event => event.id), ['live', 'offline'], 'Large output replays in order without duplicating acknowledged output');
      for (const event of received) assert.deepEqual({...event, id: undefined},
        {id: undefined, length: text.length, first: '历史🙂', last: '历史🙂'});
      assert.equal(created, windowId, 'Reconnect reuses the original native window');
      assert(!destroyed.has(windowId));
      assert.equal(await page.evaluate(() => identity), identity);
      assert.equal(await page.getByRole('textbox').inputValue(), 'fixture draft');
      assert.equal(await page.locator('#codex-connection-status').count(), 0);
      results.push({route, responseBytes: Buffer.byteLength(text), live: true, replay: true, draftRetained: true});
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({passed: true, results}));
  } finally {
    await browser?.close();
    await app.close();
    fs.rmSync(candidate, {recursive: true, force: true});
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
