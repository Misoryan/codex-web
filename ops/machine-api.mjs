import Fastify from 'fastify';
import WebSocket from 'ws';
import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {AssistantState, registerStateRoutes} from './machine-state.mjs';

// This service has no static files, browser session, approval or management API.
export class NativeBridge {
  constructor(url, timeoutMs = 60000) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname))
      throw Error('Native bridge must use loopback');
    this.url = parsed;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.events = [];
    this.epoch = randomUUID();
    this.eventSeq = 0;
  }

  async connect() {
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const url = new URL(this.url);
    for (const [key, value] of Object.entries({lifecycle: '3', session: randomUUID(), document: randomUUID(), ack: '0'}))
      url.searchParams.set(key, value);
    const socket = new WebSocket(url, {maxPayload: 32 * 1024 * 1024});
    this.socket = socket;
    this.commandSeq = 0;
    this.epoch = randomUUID();
    this.events = [];
    this.eventSeq = 0;
    const promise = new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => fail(Error('Native handshake timed out')), this.timeoutMs);
      const fail = error => {
        clearTimeout(timer);
        reject(error);
        if (this.socket !== socket) return;
        this.socket = undefined;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.pending.clear();
        socket.terminate();
      };
      socket.on('error', () => fail(Error('Native connection unavailable')));
      socket.on('close', () => fail(Error('Native connection closed; delivery may be unknown')));
      socket.on('message', raw => {
        try {
          const frame = JSON.parse(raw.toString());
          if (frame.type === 'renderer-reset') throw Error('Native session reset');
          if (frame.type === 'renderer-ready') { ready = true; clearTimeout(timer); resolve(); return; }
          if (frame.type !== 'renderer-event') return;
          socket.send(JSON.stringify({type: 'renderer-ack', seq: frame.seq}));
          if (frame.payload?.type !== 'ipc-main-event') return;
          for (const arg of frame.payload.args ?? []) {
            if (arg?.type === 'mcp-response') {
              const waiter = this.pending.get(arg.message?.id);
              if (!waiter) continue;
              this.pending.delete(arg.message.id);
              clearTimeout(waiter.timer);
              if (arg.message.error) {
                const error = Error(arg.message.error.message);
                error.nativeCode = arg.message.error.code;
                waiter.reject(error);
              } else waiter.resolve(arg.message.result);
            } else if (arg?.type === 'mcp-notification' && typeof arg.method === 'string') {
              const threadId = arg.params?.threadId ?? arg.params?.thread?.id;
              if (typeof threadId !== 'string') continue;
              this.events.push({seq: ++this.eventSeq, time: new Date().toISOString(), threadId, method: arg.method, params: arg.params});
              if (this.events.length > 4000) this.events.shift();
            }
          }
        } catch { fail(Error(ready ? 'Invalid native event' : 'Invalid native handshake')); }
      });
    });
    this.connecting = promise;
    try { await promise; } finally { if (this.connecting === promise) this.connecting = undefined; }
  }

  async request(method, params) {
    await this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('Native request timed out; delivery may be unknown'));
      }, this.timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      this.socket.send(JSON.stringify({type: 'renderer-command', seq: ++this.commandSeq, payload: {
        type: 'ipc-renderer-invoke', requestId: randomUUID(), channel: 'codex_desktop:message-from-view',
        args: [{type: 'mcp-request', hostId: 'local', request: {id, method, params}}],
        sourceUrl: this.url.origin.replace('ws:', 'http:'),
      }}), error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(Error('Native send failed; delivery may be unknown'));
      });
    });
  }

  close() { this.socket?.terminate(); }
}

const string = {type: 'string', minLength: 1, maxLength: 32000};
const object = (properties, required = []) => ({type: 'object', additionalProperties: false, properties, required});
const page = {cursor: string, limit: {type: 'integer', minimum: 1, maximum: 100}};
const message = {message: string, model: string, effort: {type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']}};
const input = text => [{type: 'text', text, text_elements: []}];
const problem = (statusCode, message) => Object.assign(Error(message), {statusCode});

export async function createMachineApi({bridge, tokenHashFile, state, requestsPerMinute = 120}) {
  const app = Fastify({logger: false, bodyLimit: 65536, ajv: {customOptions: {removeAdditional: false}}});
  let windowStart = 0, authorized = 0, anonymous = 0, inflight = 0;
  const locks = new Set();
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!request.url.startsWith('/codex/api/v1/')) return reply.code(404).send({error: 'Not found'});
    const now = Date.now();
    if (now - windowStart >= 60000) { windowStart = now; authorized = 0; anonymous = 0; }
    const candidate = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
    let expected;
    try { expected = (await readFile(tokenHashFile, 'utf8')).trim(); } catch { /* Missing secret revokes access. */ }
    const actual = createHash('sha256').update(candidate ?? '').digest('hex');
    const valid = candidate && /^[a-f0-9]{64}$/.test(expected ?? '') && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
    if (!valid) {
      if (++anonymous > 240) return reply.header('Retry-After', '60').code(429).send({error: 'Authentication rate limit'});
      return reply.header('WWW-Authenticate', 'Bearer').code(401).send({error: 'Invalid API token'});
    }
    if (++authorized > requestsPerMinute || inflight >= 8)
      return reply.header('Retry-After', '60').code(429).send({error: 'API rate limit'});
    inflight++;
    request.machineCounted = true;
  });
  app.addHook('onResponse', async request => { if (request.machineCounted) inflight--; });
  app.addHook('onClose', async () => bridge.close());
  app.setErrorHandler((error, request, reply) => {
    const code = error.statusCode ?? (error.nativeCode === -32602 ? 400 : /\b503\b/.test(error.message) ? 503 : error.nativeCode ? 502 : 503);
    reply.code(code).send({error: error.message, ...(error.nativeCode ? {nativeCode: error.nativeCode} : {}),
      ...(request.machineThreadId ? {threadId: request.machineThreadId} : {})});
  });
  if (state) registerStateRoutes(app, state);
  const root = '/codex/api/v1';
  const rpc = (method, params) => bridge.request(method, params);
  const metadata = async id => (await rpc('thread/read', {threadId: id, includeTurns: false})).thread;
  const locked = async (id, work) => {
    if (locks.has(id)) throw problem(409, 'Another mutation is in progress for this thread');
    locks.add(id);
    try { return await work(); } finally { locks.delete(id); }
  };
  const idle = async id => {
    let thread = await metadata(id);
    if (thread.status?.type === 'notLoaded') {
      await rpc('thread/resume', {threadId: id, excludeTurns: true});
      thread = await metadata(id);
    }
    if (thread.status?.type !== 'idle') throw problem(409, 'Thread must be idle; use steer for an active turn');
    return thread;
  };
  app.get(root + '/health', async () => { await bridge.connect(); return {ok: true, epoch: bridge.epoch}; });
  app.get(root + '/models', async () => rpc('model/list', {}));
  app.get(root + '/profiles', async () => {
    const {config} = await rpc('config/read', {includeLayers: false});
    return {defaultModel: config.model, profiles: ['default', ...Object.keys(config.profiles ?? {}).filter(name => name !== 'default')]};
  });
  app.post(root + '/threads', {schema: {body: object({cwd: string, profile: string, title: string, ...message}, ['cwd', 'message'])}}, async request => {
    const {cwd, profile = 'default', title, message: text, model, effort} = request.body;
    if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(cwd)) throw problem(400, 'cwd must be absolute on the Codex host');
    const {config} = await rpc('config/read', {includeLayers: false});
    const overrides = profile === 'default' ? {} : config.profiles?.[profile];
    if (!overrides) throw problem(400, 'Unknown profile; query /profiles');
    const started = await rpc('thread/start', {cwd, ...(model ? {model} : {}), ...(profile !== 'default' ? {config: overrides} : {})});
    const threadId = started.thread.id;
    request.machineThreadId = threadId;
    if (title) await rpc('thread/name/set', {threadId, name: title});
    const {turn} = await rpc('turn/start', {threadId, input: input(text), ...(model ? {model} : {}), ...(effort ? {effort} : {})});
    return {threadId, turnId: turn.id, thread: started.thread, turn, profile, model: started.model};
  });
  app.get(root + '/threads', {schema: {querystring: object({...page, archived: {type: 'boolean'}, cwd: string, searchTerm: string})}}, async request =>
    rpc('thread/list', {limit: 20, archived: false, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'], ...request.query}));
  app.get(root + '/threads/:id', async request => ({thread: await metadata(request.params.id)}));
  app.get(root + '/threads/:id/turns', {schema: {querystring: object({...page, itemsView: {type: 'string', enum: ['notLoaded', 'summary', 'full']}})}}, async request =>
    rpc('thread/turns/list', {threadId: request.params.id, limit: 20, sortDirection: 'desc', itemsView: 'notLoaded', ...request.query}));
  app.get(root + '/threads/:id/items', {schema: {querystring: object({...page, turnId: string}, ['turnId'])}}, async request =>
    rpc('thread/items/list', {threadId: request.params.id, limit: 100, sortDirection: 'asc', ...request.query}));
  app.post(root + '/threads/:id/messages', {schema: {body: object(message, ['message'])}}, async request => locked(request.params.id, async () => {
    const threadId = request.params.id;
    await idle(threadId);
    const {message: text, ...options} = request.body;
    return rpc('turn/start', {threadId, input: input(text), ...options});
  }));
  app.post(root + '/threads/:id/steer', {schema: {body: object({message: string, expectedTurnId: string}, ['message', 'expectedTurnId'])}}, async request =>
    locked(request.params.id, () => rpc('turn/steer', {threadId: request.params.id, expectedTurnId: request.body.expectedTurnId, input: input(request.body.message)})));
  app.post(root + '/threads/:id/interrupt', {schema: {body: object({turnId: string}, ['turnId'])}}, async request =>
    locked(request.params.id, () => rpc('turn/interrupt', {threadId: request.params.id, turnId: request.body.turnId})));
  for (const action of ['archive', 'unarchive']) app.post(root + '/threads/:id/' + action,
    {schema: {body: object({})}}, async request => locked(request.params.id, async () => {
      if (action === 'archive' && (await metadata(request.params.id)).status?.type === 'active')
        throw problem(409, 'Interrupt the active turn before archiving');
      await rpc('thread/' + action, {threadId: request.params.id});
      return {ok: true, threadId: request.params.id, archived: action === 'archive'};
    }));
  app.get(root + '/threads/:id/events', {schema: {querystring: object({after: {type: 'integer', minimum: 0}, epoch: string})}}, async request => {
    await bridge.connect();
    const {after = 0, epoch} = request.query;
    const changed = epoch !== undefined && epoch !== bridge.epoch;
    const first = bridge.events[0]?.seq ?? bridge.eventSeq + 1;
    return {epoch: bridge.epoch, nextAfter: bridge.eventSeq, gap: changed || after < first - 1 || after > bridge.eventSeq,
      data: bridge.events.filter(event => event.threadId === request.params.id && (changed || event.seq > after))};
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.CODEX_API_TOKEN_HASH_FILE || !process.env.CODEX_API_NATIVE_URL) throw Error('Missing API service configuration');
  const bridge = new NativeBridge(process.env.CODEX_API_NATIVE_URL);
  const state = process.env.CODEX_API_STATE_ROOT ? new AssistantState({root: process.env.CODEX_API_STATE_ROOT,
    pwsh: process.env.CODEX_API_PWSH, stateScript: process.env.CODEX_API_STATE_SCRIPT,
    pythonScript: process.env.CODEX_API_PYTHON_SCRIPT, ticketScript: process.env.CODEX_API_TICKET_SCRIPT}) : undefined;
  const app = await createMachineApi({bridge, tokenHashFile: process.env.CODEX_API_TOKEN_HASH_FILE, state});
  await app.listen({host: '127.0.0.1', port: Number(process.env.CODEX_API_PORT ?? 8231)});
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void app.close(); });
}
