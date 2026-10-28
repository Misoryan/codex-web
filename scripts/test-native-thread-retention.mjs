import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {RuntimeReader} from '../src/server/native-runtime-reader.js';
import {releaseIdleSubagents} from '../ops/native-thread-retention.mjs';

const now = 1_800_000_000_000;
const threads = new Map();
const calls = [], released = [], readCounts = new Map();
const put = (id, options = {}) => threads.set(id, {
  id, path: `/fixture/${id}.jsonl`, ephemeral: false, updatedAt: now / 1000 - 600,
  status: {type: 'idle'}, source: 'appServer',
  turn: {id: `${id}-turn`, status: 'completed', completedAt: now / 1000 - 600},
  ...options,
});
const child = (id, parentThreadId = 'root', options = {}) => put(id, {
  parentThreadId, source: {subAgent: {thread_spawn: {parent_thread_id: parentThreadId}}}, ...options,
});
put('root');
put('active-parent', {status: {type: 'active', activeFlags: []}});
put('approval-parent', {status: {type: 'active', activeFlags: ['waitingOnApproval']}});
put('question-parent', {status: {type: 'active', activeFlags: ['waitingOnUserInput']}});
child('done');
child('failed', 'root', {status: {type: 'systemError'}, turn: {status: 'failed', completedAt: now / 1000 - 600}});
child('running', 'root', {status: {type: 'active', activeFlags: []}});
child('approval', 'root', {status: {type: 'active', activeFlags: ['waitingOnApproval']}});
child('parent-running', 'active-parent');
child('parent-approval', 'approval-parent');
child('parent-question', 'question-parent');
child('nested-parent', 'active-parent');
child('nested-child', 'nested-parent');
child('interrupted', 'root', {turn: {status: 'interrupted', completedAt: now / 1000 - 600}});
child('unfinished', 'root', {turn: {status: 'inProgress', completedAt: null}});
child('recent', 'root', {turn: {status: 'completed', completedAt: now / 1000 - 30}});
child('ephemeral', 'root', {ephemeral: true});
child('missing-parent', 'missing');
child('unreadable');
child('reactivated');
child('changed');
put('racing-parent');
child('parent-reactivated', 'racing-parent');
child('cycle', 'cycle');
const loaded = new Set(threads.keys());
const server = new WebSocketServer({host: '127.0.0.1', port: 0});
await new Promise(resolve => server.once('listening', resolve));
server.on('connection', socket => {
  let sequence = 0;
  socket.send(JSON.stringify({type: 'renderer-ready'}));
  socket.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame.type !== 'renderer-command') return;
    const message = frame.payload.args[0].request;
    const {id, method, params} = message;
    calls.push({method, params});
    let result, error;
    if (method === 'thread/loaded/list') {
      const offset = Number(params.cursor ?? 0), data = [...loaded].slice(offset, offset + 4);
      result = {data, nextCursor: offset + 4 < loaded.size ? String(offset + 4) : null};
    } else if (method === 'thread/read') {
      assert.equal(params.includeTurns, false);
      const count = (readCounts.get(params.threadId) ?? 0) + 1;
      readCounts.set(params.threadId, count);
      if (params.threadId === 'reactivated' && count === 2) threads.get(params.threadId).status = {type: 'active', activeFlags: []};
      if (params.threadId === 'changed' && count === 2) threads.get(params.threadId).updatedAt++;
      if (params.threadId === 'racing-parent' && count === 2) threads.get(params.threadId).status = {type: 'active', activeFlags: []};
      const thread = threads.get(params.threadId);
      if (!thread || params.threadId === 'unreadable') error = {message: 'Fixture metadata unavailable'};
      else result = {thread};
    } else if (method === 'thread/turns/list') {
      assert.deepEqual(params, {threadId: params.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded'});
      result = {data: [threads.get(params.threadId).turn], nextCursor: null};
    } else if (method === 'thread/unsubscribe') {
      released.push(params.threadId);
      loaded.delete(params.threadId);
      threads.get(params.threadId).status = {type: 'notLoaded'};
      result = {status: 'unsubscribed'};
    } else assert.fail(`Retention must not execute ${method}`);
    socket.send(JSON.stringify({type: 'renderer-event', seq: ++sequence, payload: {
      type: 'ipc-main-event', args: [{type: 'mcp-response', message: {id, result, error}}],
    }}));
  });
});
const reader = new RuntimeReader(`ws://127.0.0.1:${server.address().port}/__backend/native/ipc`, 1000);
try {
  const result = await releaseIdleSubagents(reader, now);
  assert.deepEqual(released, ['done', 'failed']);
  assert.equal(result.released, 2);
  assert.equal(result.errors, 2);
  assert(calls.filter(call => call.method === 'thread/loaded/list').length > 1);
  await releaseIdleSubagents(reader, now);
  assert.deepEqual(released, ['done', 'failed', 'changed']);
  await releaseIdleSubagents(reader, now);
  assert.deepEqual(released, ['done', 'failed', 'changed']);
  assert.equal(threads.get('root').status.type, 'idle');
  assert.equal(threads.get('running').status.type, 'active');
  assert.equal(threads.get('approval').status.activeFlags[0], 'waitingOnApproval');
  console.log('PASS: Native IPC retention releases only expired completed/failed subagents; preserves roots, active families, approvals, questions, interrupted work, races and unreadable metadata across pages and repeated sweeps');
} finally {
  reader.close();
  for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve));
}
