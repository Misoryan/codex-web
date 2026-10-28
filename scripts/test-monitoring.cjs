const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {once, EventEmitter} = require('node:events');
const {WebSocket} = require('ws');
fs.mkdirSync('runtime/tmp', {recursive: true});
const candidate = fs.mkdtempSync(path.resolve('runtime/tmp/monitoring-'));
fs.mkdirSync(path.join(candidate, 'src'), {recursive: true});
fs.cpSync('src/server', path.join(candidate, 'src/server'), {recursive: true});
fs.cpSync('src/shared', path.join(candidate, 'src/shared'), {recursive: true});
const {createBridgeServer} = require(path.join(candidate, 'src/server/main.js'));
const {installBrowserGuestIpc} = require(path.join(candidate, 'src/server/browser-stream.js'));
const logs = path.join(candidate, 'logs-' + Date.now());
const secret = 'monitor-secret-message-file-token';

function connect(origin, params, options) {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/__backend/native/ipc?' + new URLSearchParams(params), options);
  const frames = [];
  socket.on('message', raw => { frames.push(JSON.parse(String(raw))); socket.emit('frame'); });
  socket.on('error', () => {});
  const wait = async type => {
    while (!frames.some(frame => frame.type === type)) {
      await Promise.race([once(socket, 'frame'), once(socket, 'close').then(() => { throw Error('Closed before ' + type); })]);
    }
    return frames.find(frame => frame.type === type);
  };
  return {socket, frames, wait};
}

async function main() {
  fs.writeFileSync(path.join(candidate, 'acceptance.json'), JSON.stringify({passed: false}));
  const web = path.join(candidate, 'scratch/asar/webview');
  fs.mkdirSync(path.join(web, 'lite'), {recursive: true});
  fs.writeFileSync(path.join(web, 'index.html'), '<p>full monitoring fixture</p>');
  fs.writeFileSync(path.join(web, 'lite/index.html'), '<p>lite monitoring fixture</p>');
  const app = await createBridgeServer(logs);
  const state = globalThis.__codexElectronIpcBridge;
  let windowId = 0, dispatched = 0;
  state.setRendererWindowFactory(async () => ({id: ++windowId, webContents: {id: windowId}, destroy() {}}));
  state.handleRendererSend = () => dispatched++;
  await app.listen({host: '127.0.0.1', port: 0});
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const sockets = [];
  const open = (params, options) => { const result = connect(origin, params, options); sockets.push(result.socket); return result; };
  const id = () => ({lifecycle: '3', session: randomUUID(), document: randomUUID(), ack: '0'});
  try {
    assert.match(await (await fetch(origin + '/?token=' + secret)).text(), /full monitoring fixture/);
    assert.match(await (await fetch(origin + '/lite/')).text(), /lite monitoring fixture/);
    assert.equal((await fetch(origin + '/assets/missing.js?token=' + secret)).status, 404);
    assert.equal((await fetch(origin + '/__backend/upload', {method: 'POST', body: secret})).status, 400);
    assert.equal((await fetch(origin + '/__backend/health')).status, 200);
    assert.equal((await fetch(origin + '/__backend/telemetry', {method: 'POST', headers: {'content-type': 'application/json'}, body: secret})).status, 400);
    const visit = randomUUID();
    assert.equal((await fetch(origin + '/__backend/telemetry', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({event: 'ready', visit, durationMs: 123, mode: 'lite', standalone: true, message: secret})})).status, 204);
    assert.equal((await fetch(origin + '/__backend/telemetry', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({event: secret, visit})})).status, 400);
    for(const event of ['navigation','resources_ready','first_message','caught_up','recovery_paint','network_change']) {
      assert.equal((await fetch(origin+'/__backend/telemetry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event,visit,resumed:true,replayBytes:1234,replayEvents:12,foregroundMs:321,networkType:'cellular',effectiveType:'4g',rttMs:150,downlinkKbps:1800,assetCount:2,assetsComplete:2,assetTransferBytes:456,assetsEndMs:789,message:secret})})).status,204);
    }
    assert.equal((await fetch(origin+'/__backend/telemetry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'network_change',visit,networkType:secret})})).status,400);
    const params = id();
    const first = open(params);
    const ready = await first.wait('renderer-ready');
    await first.wait('renderer-caught-up');
    state.sendToRenderer(1,{type:'ipc-main-event',channel:secret,args:[{type:'fetch-response',body:secret}]});
    first.socket.send(JSON.stringify({type: 'renderer-ping', id: 42}));
    assert.equal((await first.wait('renderer-pong')).id, 42);
    first.socket.send(JSON.stringify({type: 'renderer-command', seq: 1, payload: {type: 'ipc-renderer-send', channel: secret, args: [secret]}}));
    await first.wait('renderer-command-ack');
    const closed = once(first.socket, 'close');
    first.socket.terminate();
    await closed;
    const second = open({...params, epoch: ready.epoch});
    assert.equal((await second.wait('renderer-ready')).epoch, ready.epoch);
    await second.wait('renderer-caught-up');
    second.socket.send(JSON.stringify({type: 'renderer-command', seq: 1, payload: {type: 'ipc-renderer-send', channel: secret, args: [secret]}}));
    await second.wait('renderer-command-ack');
    assert.equal(dispatched, 1, 'Logging must preserve command deduplication after reconnect');
    second.socket.close(1000, 'Document closed');
    await once(second.socket, 'close');
    for (const bad of [{...id(), lifecycle: '0'}, {...id(), session: secret}]) {
      const client = open(bad);
      await client.wait('renderer-reset');
      assert.equal((await once(client.socket, 'close'))[0], 4001);
    }
    const invalid = open(id());
    await invalid.wait('renderer-caught-up');
    invalid.socket.send(secret);
    assert.equal((await once(invalid.socket, 'close'))[0], 4001);

    const handlers = new Map();
    installBrowserGuestIpc({handle: (key, handler) => handlers.set(key, handler)});
    const owner = new EventEmitter();
    owner.isDestroyed = () => false;
    owner.on('will-attach-webview', (_event, preferences) => { preferences.session = {}; });
    const guest = await handlers.get('codex-web:attach-browser')({sender: owner}, {partition: 'monitor-fixture', 'data-browser-sidebar-browser-tab-id': 'fixture', 'data-browser-sidebar-conversation-id': 'fixture'});
    const stream = new WebSocket(origin.replace('http:', 'ws:') + '/__backend/native/browser-stream?token=' + guest.token);
    sockets.push(stream);
    await once(stream, 'message');
    stream.send(JSON.stringify({type: 'view', visible: true, width: 320, height: 240}));
    const [frame, binary] = await once(stream, 'message');
    assert(binary && frame.length > 100, 'The real Chromium guest must still stream frames');
    stream.close(1000, 'Document closed');
    await once(stream, 'close');
    handlers.get('codex-web:close-browser')({sender: owner}, guest.token);
    const rejectedStream = new WebSocket(origin.replace('http:', 'ws:') + '/__backend/native/browser-stream?token=' + secret);
    rejectedStream.on('error', () => {});
    await new Promise(resolve => rejectedStream.once('close', resolve));

    // A real client that declines control-frame pongs exercises server timeout.
    const unresponsive = open(id(), {autoPong: false});
    await unresponsive.wait('renderer-caught-up');
    await Promise.race([once(unresponsive.socket, 'close'), new Promise((_, reject) => setTimeout(() => reject(Error('Heartbeat did not close the silent peer')), 65_000).unref())]);
  } finally {
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    await app.close();
  }
  const lines = fs.readdirSync(logs).filter(name => name.endsWith('.jsonl')).flatMap(name => fs.readFileSync(path.join(logs, name), 'utf8').split('\n').filter(line => line.trim()));
  assert(!lines.join('\n').includes(secret), 'Secrets must never reach structured monitoring files');
  const records = lines.map(JSON.parse);
  const events = records.map(record => record.event);
  for (const expected of ['http.start', 'http.complete', 'http.error', 'client.ready', 'ipc.open', 'ipc.attached', 'ipc.ready', 'ipc.close', 'ipc.rejected', 'ipc.invalid_frame', 'ipc.heartbeat_timeout', 'session.create', 'session.attach', 'session.release', 'session.discard', 'session.replay', 'stream.open', 'stream.cdp_attached', 'stream.frames', 'stream.close', 'stream.rejected', 'guest.create', 'guest.destroy']) assert(events.includes(expected), 'Missing ' + expected);
  assert(records.some(record => record.event === 'ipc.attached' && record.reused === true));
  assert(records.filter(record => record.event === 'ipc.open').every(record => !Object.hasOwn(record, 'mode')), 'A handshake without a page referrer must not be assigned to Full or Lite');
  assert(records.some(record => record.event === 'ipc.close' && record.code === 1006));
  assert(records.some(record => record.event === 'ipc.close' && record.code === 1000 && record.reason === 'Document closed'));
  assert(records.some(record => record.event === 'http.complete' && record.status === 404));
  assert(records.some(record => record.event === 'client.ready' && record.durationMs === 123 && record.standalone === true));
  assert(records.some(r=>r.event==='client.recovery_paint'&&r.replayBytes===1234&&r.foregroundMs===321&&r.networkType==='cellular'));
  assert(records.some(r=>r.event==='session.buffer_profile'&&r.category==='fetch-response'&&r.events===1&&r.bytes>0));
  const artifacts = Object.fromEntries(['main', 'browser-stream', 'renderer-sessions', 'observability'].map(name => {const file = `src/server/${name}.js`;return [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(candidate, file))).digest('hex')];}));
  const report = {passed: true, artifacts, logDirectory: logs, events: [...new Set(events)].filter(Boolean), records: records.length, reconnectPreserved: true, secretsExcluded: true, realBrowserStream: true, heartbeatTimeout: true};
  fs.writeFileSync(path.join(candidate, 'acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
