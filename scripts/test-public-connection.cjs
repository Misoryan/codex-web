const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
const {buildSync} = require('esbuild');
const {WebSocketServer} = require('ws');
const {chromium} = require('@playwright/test');

const baseline = process.argv.includes('--baseline');
const bridgeSource = baseline ? execFileSync('git', ['show', 'HEAD:src/browser/resumable-bridge.ts'], {encoding: 'utf8', windowsHide: true}) : fs.readFileSync('src/browser/resumable-bridge.ts', 'utf8');
const bundle = buildSync({stdin: {contents: `${bridgeSource}
window.events=[]; window.states=[]; window.identity=crypto.randomUUID();
window.bridge=new ResumableBridge(crypto.randomUUID(),'',event=>events.push(event),value=>value,(state,reason)=>{states.push(state);showConnectionState(state,reason)});`, loader: 'ts'}, bundle: true, write: false, format: 'iife', target: 'es2022'}).outputFiles[0].text;
const moduleUnderTest = new Module(__filename);
moduleUnderTest.paths = module.paths;
moduleUnderTest._compile(ts.transpileModule(fs.readFileSync('src/server/renderer-sessions.ts', 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, __filename);
const {RendererSessions} = moduleUnderTest.exports;
let created = 0, connections = 0, calls = 0, holdPongs = false, replay = false;
const live = new Set(), delayedPongs = [], replayFrames = [];
const sessions = new RendererSessions(async () => ({id: ++created}), () => {});
const diagnostics = fs.readFileSync('ops/startup-status.js', 'utf8');
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html;charset=utf-8');
  response.end(`<div id="root"><textarea aria-label="draft"></textarea></div><script>${diagnostics}</script><script>${bundle}</script>`);
});
const wss = new WebSocketServer({server});
wss.on('connection', (socket, request) => {
  if (!request.url.startsWith('/__backend/ipc')) {socket.send('unrelated'); socket.close(1000, 'Unrelated socket'); return;}
  connections++;
  live.add(socket);
  socket.on('close', () => live.delete(socket));
  const params = new URL(request.url, 'http://fixture').searchParams;
  const send = frame => {if (socket.readyState === 1) socket.send(JSON.stringify(frame));};
  const lease = sessions.attach(params.get('session'), params.get('document'), params.get('epoch'), Number(params.get('ack')), socket, {
    send: frame => {
      if (replay && ['renderer-event', 'renderer-caught-up'].includes(frame.type)) replayFrames.push(() => send(frame));
      else send(frame);
    }, close: () => socket.close(4001, 'Replaced'),
  });
  socket.lease = lease;
  socket.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame.type === 'renderer-ping') {
      const pong = () => send({type: 'renderer-pong', id: frame.id});
      holdPongs ? delayedPongs.push(pong) : pong();
    } else if (frame.type === 'renderer-ack') lease.acknowledge(frame.seq);
    else lease.accept(frame.seq, () => {calls++; lease.send({accepted: frame.payload.id});});
  });
  socket.on('close', (code, reason) => code === 1000 && reason.toString() === 'Document closed' ? lease.expire('Document closed') : lease.release());
  if (replay) for (let part = 0; part < 5; part++) lease.send({part, text: '中文历史'});
  lease.ready();
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  const url = `http://127.0.0.1:${server.address().port}/lite/`;
  const scenarios = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 500));
    await page.goto(url);
    await page.waitForFunction(() => states.at(-1) === 'ready');
    const identity = await page.evaluate(() => identity);
    await page.getByRole('textbox').fill('保留的草稿');
    holdPongs = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => true);
    await page.clock.runFor(6000);
    assert.equal(await page.evaluate(() => states.at(-1)), 'ready', 'A delayed heartbeat must not interrupt startup after five seconds');
    assert.equal(connections, 1);
    scenarios.push('delayed heartbeat survives old deadline');
    for (let part = 0; part < 5; part++) {
      [...live][0].lease.send({part});
      await page.waitForFunction(part => events.some(event => event.part === part), part);
      await page.clock.runFor(8000);
      assert.equal(connections, 1, 'Incoming history progress keeps the original transport');
    }
    delayedPongs.splice(0).forEach(send => send());
    holdPongs = false;
    await page.evaluate(() => bridge.send({id: 'one-command'}));
    await page.waitForFunction(() => events.some(event => event.accepted === 'one-command'));
    assert.equal(calls, 1);
    assert.equal(created, 1);
    scenarios.push('ongoing history progress preserves session and one command');
    await page.evaluate(() => {window.otherSocket = new WebSocket(`ws://${location.host}/unrelated`);});
    await page.waitForFunction(() => otherSocket.readyState === 3);
    assert.equal(await page.evaluate(() => __codexStartupDiagnostics.attempts), 1, 'Unrelated sockets cannot overwrite IPC diagnostics');
    assert.equal(await page.evaluate(() => __codexStartupDiagnostics.version), 2);
    scenarios.push('diagnostics identify only IPC attempts');
    holdPongs = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.clock.runFor(30000);
    await page.waitForFunction(() => states.at(-1) === 'offline');
    await page.clock.runFor(1000);
    await page.waitForFunction(() => states.at(-1) === 'ready');
    assert.equal(created, 1, 'A stalled transport reconnects to the same native renderer');
    assert.equal(await page.evaluate(() => identity), identity);
    assert.equal(await page.getByRole('textbox').inputValue(), '保留的草稿');
    const snapshot = await page.evaluate(() => __codexStartupDiagnostics);
    assert.equal(snapshot.connections.length, 2);
    assert.equal(snapshot.connections[0].closeReason, 'Heartbeat timeout');
    assert.equal(snapshot.connections[0].closeCode, 1000);
    assert.equal(snapshot.attempts, 2);
    assert.equal(snapshot.firstMessageMs, snapshot.connections[1].firstMessageMs, 'Summary times must describe the latest connection');
    assert.equal(snapshot.closeCode, undefined, 'A previous close cannot mark the new connection closed');
    scenarios.push('silent connection reconnects with reason and retained draft');
    holdPongs = false;
    delayedPongs.splice(0).forEach(send => send());
    await page.close();
    replay = true;
    const replayPage = await context.newPage();
    replayPage.on('pageerror', error => errors.push(error.message));
    await replayPage.clock.install();
    await replayPage.clock.pauseAt(new Date(Date.now() + 500));
    await replayPage.goto(url);
    await replayPage.waitForFunction(() => states.at(-1) === 'connecting');
    for (let part = 0; part < 5; part++) {
      replayFrames.shift()();
      await replayPage.waitForFunction(part => events.some(event => event.part === part), part);
      await replayPage.clock.runFor(8000);
    }
    assert.equal(await replayPage.evaluate(() => __codexStartupDiagnostics.attempts), 1, 'A replay that keeps progressing can take more than fifteen seconds');
    replay = false;
    replayFrames.splice(0).forEach(send => send());
    await replayPage.waitForFunction(() => states.at(-1) === 'ready');
    assert.deepEqual(await replayPage.evaluate(() => events.map(event => event.part)), [0, 1, 2, 3, 4]);
    scenarios.push('slow ordered replay survives old handshake deadline');
    assert.deepEqual(errors, []);
    await context.close();
    fs.mkdirSync('runtime/public-connection', {recursive: true});
    fs.writeFileSync('runtime/public-connection/transport-tests.json', JSON.stringify({passed: true, sourceHash: createHash('sha256').update(bridgeSource).digest('hex'), scenarios, created, connections, calls, errors}, null, 2));
    console.log(JSON.stringify({passed: true, scenarios, created, connections, calls}));
  } finally {
    await browser.close();
    for (const socket of live) socket.terminate();
    wss.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
