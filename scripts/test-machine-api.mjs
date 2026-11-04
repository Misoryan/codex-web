import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {WebSocketServer} from 'ws';
import {NativeBridge, createMachineApi} from '../ops/machine-api.mjs';

// External native-peer fixture. HTTP authentication, validation, locking,
// bridge framing, error propagation and event handling run production code.
const directory = await mkdtemp(path.resolve('runtime/tmp/machine-api-'));
const hashFile = path.join(directory, 'hash');
const token = randomBytes(32).toString('base64url');
await writeFile(hashFile, createHash('sha256').update(token).digest('hex'));
const server = new WebSocketServer({host: '127.0.0.1', port: 0});
await new Promise(resolve => server.once('listening', resolve));
const calls = [];
let status = 'idle', failTurn = false, notifications;
server.on('connection', socket => {
  let seq = 0;
  const send = argument => socket.send(JSON.stringify({type: 'renderer-event', seq: ++seq,
    payload: {type: 'ipc-main-event', args: [argument]}}));
  notifications = (method, params) => send({type: 'mcp-notification', method, params});
  socket.send(JSON.stringify({type: 'renderer-ready'}));
  socket.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame.type !== 'renderer-command') return;
    assert.equal(frame.payload.channel, 'codex_desktop:message-from-view');
    const {id, method, params} = frame.payload.args[0].request;
    calls.push({method, params});
    let result, error;
    if (method === 'config/read') result = {config: {model: 'fixture-model', profiles: {inspection: {sandbox_mode: 'read-only'}}}};
    else if (method === 'thread/start') result = {thread: {id: 'fixture-thread', cwd: '/fixture', status: {type: 'idle'}}, model: 'fixture-model'};
    else if (method === 'thread/name/set') result = {};
    else if (method === 'turn/start') {
      if (failTurn) error = {code: -32000, message: 'Upstream 503: quota exhausted'};
      else result = {turn: {id: 'fixture-turn', status: 'inProgress', items: []}};
    } else if (method === 'thread/read') result = {thread: {id: params.threadId, status: {type: status}}};
    else if (method === 'turn/steer') {
      if (params.expectedTurnId !== 'fixture-turn') error = {code: -32602, message: 'Expected turn does not match active turn'};
      else result = {turnId: 'fixture-turn'};
    } else if (method === 'thread/turns/list') result = {data: [{id: 'fixture-turn', status: 'completed'}], nextCursor: null};
    else if (method === 'thread/items/list') result = {data: [{turnId: 'fixture-turn', item: {type: 'agentMessage', text: 'hello', phase: 'final_answer'}}], nextCursor: null};
    else if (['thread/archive', 'thread/unarchive', 'turn/interrupt'].includes(method)) result = {};
    else assert.fail('Unexpected native method ' + method);
    send({type: 'mcp-response', message: {id, ...(error ? {error} : {result})}});
  });
});
const bridge = new NativeBridge(`ws://127.0.0.1:${server.address().port}/__backend/native/ipc`, 2000);
const app = await createMachineApi({bridge, tokenHashFile: hashFile, requestsPerMinute: 60});
const call = (method, url, payload, auth = token) => app.inject({method, url: '/codex/api/v1' + url,
  headers: auth === null ? {} : {authorization: 'Bearer ' + auth}, ...(payload === undefined ? {} : {payload})});
try {
  for (const auth of [null, 'incorrect', token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')]) {
    assert.equal((await call('POST', '/threads', {cwd: '/fixture', message: 'hello'}, auth)).statusCode, 401);
    assert.equal(calls.length, 0, 'Rejected credentials must not reach native Codex');
  }
  for (const url of ['/', '/lite/', '/__backend/native/ipc', '/maa/api/auth/me'])
    assert.equal((await app.inject({url, headers: {authorization: 'Bearer ' + token}})).statusCode, 404);
  assert.equal((await call('GET', '/health')).json().ok, true);
  assert.deepEqual((await call('GET', '/profiles')).json(), {defaultModel: 'fixture-model', profiles: ['default', 'inspection']});
  assert.equal((await call('POST', '/threads', {cwd: '/fixture', message: 'hello', sandbox: 'danger-full-access'})).statusCode, 400);
  assert.equal((await call('POST', '/threads', {cwd: '/fixture', message: 'hello', profile: 'unknown'})).statusCode, 400);
  const created = await call('POST', '/threads', {cwd: '/fixture', message: 'hello', title: 'fixture-title', model: 'fixture-model', profile: 'inspection'});
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().threadId, 'fixture-thread');
  assert.equal(created.json().turnId, 'fixture-turn');
  assert.deepEqual(calls.find(c => c.method === 'thread/start').params, {cwd: '/fixture', model: 'fixture-model', config: {sandbox_mode: 'read-only'}});
  assert.deepEqual(calls.find(c => c.method === 'turn/start').params, {threadId: 'fixture-thread', model: 'fixture-model', input: [{type: 'text', text: 'hello', text_elements: []}]});
  status = 'active';
  const starts = calls.filter(c => c.method === 'turn/start').length;
  assert.equal((await call('POST', '/threads/fixture-thread/messages', {message: 'follow-up'})).statusCode, 409);
  assert.equal(calls.filter(c => c.method === 'turn/start').length, starts, 'Busy thread must not receive a new turn');
  assert.equal((await call('POST', '/threads/fixture-thread/archive', {})).statusCode, 409);
  assert.equal((await call('POST', '/threads/fixture-thread/steer', {message: 'correction', expectedTurnId: 'stale'})).statusCode, 400);
  assert.equal((await call('POST', '/threads/fixture-thread/steer', {message: 'correction', expectedTurnId: 'fixture-turn'})).json().turnId, 'fixture-turn');
  assert.equal((await call('POST', '/threads/fixture-thread/interrupt', {turnId: 'fixture-turn'})).statusCode, 200);
  status = 'idle';
  assert.equal((await call('GET', '/threads/fixture-thread/turns?limit=1')).json().data[0].status, 'completed');
  assert.equal((await call('GET', '/threads/fixture-thread/items?turnId=fixture-turn')).json().data[0].item.text, 'hello');
  notifications('turn/completed', {threadId: 'fixture-thread', turn: {id: 'fixture-turn', status: 'completed'}});
  notifications('item/completed', {threadId: 'another-thread', item: {text: 'private to another thread'}});
  await new Promise(resolve => setTimeout(resolve, 30));
  const events = (await call('GET', '/threads/fixture-thread/events')).json();
  assert.deepEqual(events.data.map(event => event.method), ['turn/completed']);
  assert.equal(events.nextAfter, 2);
  assert.deepEqual((await call('GET', `/threads/fixture-thread/events?after=${events.nextAfter}&epoch=${events.epoch}`)).json().data, []);
  assert.equal((await call('GET', '/threads/fixture-thread/events?epoch=previous')).json().gap, true);
  assert.equal((await call('POST', '/threads/fixture-thread/archive', {})).json().archived, true);
  assert.equal((await call('POST', '/threads/fixture-thread/unarchive', {})).json().archived, false);
  failTurn = true;
  const failed = await call('POST', '/threads', {cwd: '/fixture', message: 'hello'});
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().threadId, 'fixture-thread', 'Partial creation must retain the thread receipt');
  assert.match(failed.json().error, /503.*quota/);
  await writeFile(hashFile, '');
  assert.equal((await call('GET', '/health')).statusCode, 401, 'Revocation must apply without restarting');
  await writeFile(hashFile, createHash('sha256').update(token).digest('hex'));
  let limited;
  for (let i = 0; i < 61; i++) limited = await call('GET', '/health');
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'], '60');
  console.log('PASS: token rejection/revocation, API-only scope, limits, native send receipt, active-turn protection, steer, interrupt, history, event cursor and partial failure');
} finally {
  await app.close();
  for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve));
  console.log('Task fixture to remove: ' + directory);
}
