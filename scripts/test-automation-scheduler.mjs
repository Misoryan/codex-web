import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {patchAutomationScheduler} from './automation-scheduler-patch.mjs';
import {patchLiteInitial} from './lite-startup-patches.mjs';

const original = await fs.readFile(process.argv[2] ?? 'scratch/asar/.vite/build/main-CqEoQDOU.js', 'utf8');
const source = patchAutomationScheduler(original);
assert.equal(patchAutomationScheduler(source), source);
const tree = ts.createSourceFile('main.js', source, 99, true, ts.ScriptKind.JS);
const names = ['Pl', 'Ul', 'Gl', 'Kl', 'El', 'Dl', 'Bl', 'Jl', 'Ml', 'Il', 'Tl', 'wl', 'Xl', 'Ql', '$l', 'eu', 'Yl', 'ql', 'tu', 'nu', 'iu'];
const functions = names.map(name => {
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(node, name);
  return node.getText(tree);
}).join('\n');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

// The real scheduler and heartbeat pipeline run here. Only the clock, storage,
// account policy and app-server transport are fixtures; no real tasks are sent.
function fixture(rows = [{id: 'daily', targetThreadId: 'thread-1'}]) {
  let now = Date.parse('2026-10-22T06:00:00+08:00');
  const records = rows.map(row => ({kind: 'heartbeat', status: 'ACTIVE', prompt: 'Isolated scheduled check', rrule: 'daily', nextRunAt: now, nextRunNominalAt: now, lastRunAt: null, ...row}));
  const sends = [], resumes = [], logs = [], timers = new Set(), notifications = new Set();
  const statuses = new Map(), modes = new Map();
  const savedMode = {mode: 'default', settings: {model: 'fixture-model', reasoning_effort: 'high', developer_instructions: 'Saved instructions'}};
  let ready = true, resumed = false;
  const permissions = {approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: {type: 'workspaceWrite', writableRoots: ['/fixture'], networkAccess: false}};
  const client = {
    hostConfig: {id: 'local', kind: 'local'}, appServerVersion: '0.162.0',
    async ensureReady() { if (!ready) throw Error('transport offline'); },
    async readThread(id) { return {id, cwd: '/fixture', path: 'fixture.jsonl', modelProvider: 'fixture', status: statuses.get(id) ?? {type: 'idle'}, turns: [{status: 'inProgress'}]}; },
    async resumeThread(id) {
      resumes.push(id); resumed = true;
      return {thread: await this.readThread(id), collaborationMode: modes.has(id) ? modes.get(id) : savedMode, cwd: '/fixture'};
    },
    async listModels() { return {data: [{model: 'fixture-model'}], nextCursor: null}; },
    async getUserSavedConfiguration() { return {}; },
    async getConfigRequirements() { return {requirements: null}; },
    registerInternalNotificationHandler(fn) { notifications.add(fn); return () => notifications.delete(fn); },
    registerInternalAuthenticatedPrincipalChangeHandler() { return () => {}; },
    registerInternalConnectionStateHandler() { return () => {}; },
    notifyAutomationRunsUpdated() {}, notifyAutomationRunTriggered() {},
    async startTurn(params, context) { sends.push(plain({params, context})); return {turn: {id: 'turn-' + sends.length}}; },
  };
  const storage = {
    Rn: (at, limit) => records.filter(row => row.status === 'ACTIVE' && row.nextRunAt != null && row.nextRunAt <= at).slice(0, limit),
    Vn: (id, next, nominal) => Object.assign(records.find(row => row.id === id), {lastRunAt: now, nextRunAt: next, nextRunNominalAt: nominal}),
    Kn: (id, next) => { records.find(row => row.id === id).nextRunAt = next; },
    On: id => records.find(row => row.id === id),
    Wr: () => false, wn: () => {}, Mn: () => null, In: () => false,
    Nn: () => now + 86400000,
    kn: () => ({nextRunAt: now + 86400000, nextRunNominalAt: now + 86400000}),
    jn: () => [1], Ut: ({baseInstructions}) => baseInstructions,
    Sr: class extends Error {},
  };
  const modelsAndPolicy = {
    ba: row => row.kind === 'heartbeat', Ti: () => false, Oi: () => false,
    _a: () => null, va: ({automation}) => ({model: automation.model, reasoningEffort: automation.reasoningEffort}),
    Va: () => ['auto'], Na: () => ({}), Ra: () => false, Aa: () => permissions,
  };
  const timer = (fn, ms) => { const token = {fn, at: now + ms, unref() {}}; timers.add(token); return token; };
  const sandbox = {
    console, AbortController, AbortSignal, DOMException, Error,
    Date: class extends Date {constructor(...args) {super(...(args.length ? args : [now]));} static now() {return now;}},
    setTimeout: timer, clearTimeout: token => timers.delete(token),
    setInterval: (fn, ms) => Object.assign(timer(fn, ms), {interval: ms}), clearInterval: token => timers.delete(token),
    i: storage, r: modelsAndPolicy, c: {Yt: () => null},
    dl: 30000, fl: 60000, pl: 300000, ml: 3, hl: 120000, gl: 60000, _l: 30000, vl: 600000,
    Sl: async () => [], Cl: async () => false, bi: {},
    ol: '<heartbeat><automation_id>{{AUTOMATION_ID}}</automation_id>{{NOW_ISO}} {{AUTOMATION_PROMPT}}</heartbeat>',
    xl: () => ({debug: (...args) => logs.push(args), warning: (...args) => logs.push(args)}),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(functions, context);
  const options = {appServerConnectionRegistry: {getConnection: () => client}, appServerClient: client, isOnline: () => false, repoRoot: '/fixture'};
  function create() { return context.Pl(options); }
  const scheduler = create();
  function complete() { for (let i = 0; i < sends.length; i++) for (const fn of [...notifications]) fn({method: 'turn/completed', params: {threadId: sends[i].params.threadId, turn: {id: 'turn-' + (i + 1), status: 'completed'}}}); }
  return {
    scheduler, create, records, sends, resumes, logs, statuses, modes, permissions, savedMode,
    setReady(value) {ready = value;}, wasResumed: () => resumed,
    async advance(ms) {now += ms; for (const token of [...timers]) if (token.at <= now) {if (token.interval) token.at = now + token.interval; else timers.delete(token); token.fn();} await flush();},
    async close() {complete(); await flush(); scheduler.dispose();},
  };
}

// Execute the actual startup expression, without reporting any renderer phase.
const startupBegin = source.indexOf('(G.getMessageHandler().setAutomationSchedulerController(_t),');
assert(startupBegin >= 0);
const startupEnd = source.indexOf('    B.add(\n      yte(', startupBegin);
assert(startupEnd > startupBegin);
const startup = source.slice(startupBegin, startupEnd).replace(/,\s*$/, ');');
let started = 0;
vm.runInNewContext(startup, {G: {getMessageHandler: () => ({setAutomationSchedulerController() {}})}, B: {add() {}}, _t: {start() {started++;}}, xl: () => ({info() {}}), dl: 30000, oi() {throw Error('Renderer-dependent startup');}});
assert.equal(started, 1, 'The server starts scheduling without a renderer event');

{
  const f = fixture();
  f.records[0].nextRunAt += 60000;
  f.scheduler.start(); await flush();
  assert.equal(f.sends.length, 0, 'Never execute before due time');
  f.scheduler.setLocalAutomationsCapability(false);
  await f.advance(60000);
  assert.equal(f.sends.length, 1, 'A due heartbeat runs with no browser or capability message');
  assert.deepEqual(f.sends[0].params.collaborationMode, f.savedMode);
  assert.equal(f.sends[0].params.approvalPolicy, f.permissions.approvalPolicy);
  assert.deepEqual(f.sends[0].params.sandboxPolicy, f.permissions.sandboxPolicy);
  assert.equal(f.sends[0].params.turnTrigger, 'automation_heartbeat_scheduled');
  assert(f.sends[0].params.input[0].text.includes('Isolated scheduled check'));
  await f.advance(30000); f.scheduler.setLocalAutomationsCapability(true); await flush();
  assert.equal(f.sends.length, 1, 'Page connection and repeated ticks never duplicate a run');
  await f.close();
  const restarted = f.create(); restarted.start(); await flush();
  assert.equal(f.sends.length, 1, 'Persisted next-run state prevents restart duplicates');
  restarted.dispose();
}
for (const status of [{type: 'active', activeFlags: ['waitingOnApproval']}, {type: 'active', activeFlags: ['waitingOnUserInput']}, {type: 'active', activeFlags: []}]) {
  const f = fixture(); f.statuses.set('thread-1', status);
  f.scheduler.start(); await flush();
  assert.equal(f.sends.length, 0, 'Busy, approval and input states block automated execution');
  assert.equal(f.resumes.length, 0, 'Busy conversations must not be resumed for settings');
  assert.equal(f.records[0].lastRunAt, null);
  f.statuses.set('thread-1', {type: 'idle'}); await f.advance(60000);
  assert.equal(f.sends.length, 1, 'A deferred task runs after its thread becomes idle');
  await f.close();
}
{
  const f = fixture(); f.setReady(false); f.scheduler.start(); await flush();
  assert.equal(f.sends.length, 0); assert.equal(f.records[0].lastRunAt, null);
  f.setReady(true); await f.advance(30000);
  assert.equal(f.sends.length, 1, 'Transport recovery retries without opening a page');
  await f.close();
}
{
  const f = fixture(); f.modes.set('thread-1', null); f.scheduler.start(); await flush();
  assert.equal(f.sends.length, 0); assert.equal(f.records[0].lastRunAt, null);
  f.modes.delete('thread-1'); await f.advance(60000);
  assert.equal(f.sends.length, 1, 'Missing saved settings defer the run without consuming it');
  await f.close();
}
{
  const f = fixture([{id: 'daily', targetThreadId: 'thread-1'}, {id: 'other', targetThreadId: 'thread-1'}]);
  f.scheduler.start(); await flush();
  assert.equal(f.sends.length, 1, 'Two automations must not concurrently run on one thread');
  await f.close();
}
{
  const initial = await fs.readFile('scratch/asar/webview/assets/app-initial-6350d04672d0.js', 'utf8');
  const lite = await patchLiteInitial(initial);
  const component = input => {
    const ast = ts.createSourceFile('initial.js', input, 99, true, ts.ScriptKind.JS);
    return ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'YUs').getText(ast);
  };
  assert.equal(component(lite), component(initial), 'Lite must preserve the native heartbeat hydration and state publication component');
}
console.log('PASS: Headless scheduler startup, due-time execution, persisted model and permissions, no duplicates, busy/approval/input deferral, transport recovery, saved-state retry, Lite parity');
