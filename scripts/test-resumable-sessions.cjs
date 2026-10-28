const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  ts = require("typescript"),
  Module = require("node:module");
const m = new Module(__filename);
m.paths = module.paths;
m._compile(
  ts.transpileModule(
    fs.readFileSync("src/server/renderer-sessions.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
  __filename,
);
const { RendererSessions } = m.exports;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function setup(limits) {
  let created = 0,
    destroyed = [];
  const sessions = new RendererSessions(
    async () => ({ id: ++created }),
    (w) => destroyed.push(w.id),
    limits,
  );
  return {
    sessions,
    destroyed,
    get created() {
      return created;
    },
  };
}
function attach(s, id = "tab", doc = "document", epoch = null, ack = 0) {
  const frames = [];
  let closed = 0;
  const lease = s.attach(
    id,
    doc,
    epoch,
    ack,
    {},
    { send: (f) => frames.push(f), close: () => closed++ },
  );
  return {
    lease,
    frames,
    ready() {
      lease.ready();
      return frames.find((f) => f.type === "renderer-ready").epoch;
    },
    get closed() {
      return closed;
    },
  };
}
test("lost acknowledgement: native mutation executes exactly once; lost output replays in order", async () => {
  const t = setup(),
    a = attach(t.sessions);
  await a.lease.window;
  const epoch = a.ready();
  let sends = 0;
  a.lease.accept(1, () => {
    sends++;
    a.lease.send({ output: "one" });
  });
  a.lease.release();
  a.lease.send({ output: "two" });
  const b = attach(t.sessions, "tab", "document", epoch);
  b.ready();
  assert.equal(await b.lease.window, await a.lease.window);
  assert.equal(t.created, 1);
  assert.deepEqual(
    b.frames
      .filter((f) => f.type === "renderer-event")
      .map((f) => f.payload.output),
    ["one", "two"],
  );
  assert.equal(b.frames[0].clientAck, 1);
  b.lease.accept(1, () => sends++);
  assert.equal(sends, 1);
  b.lease.acknowledge(2);
  b.lease.release();
  const c = attach(t.sessions, "tab", "document", epoch, 2);
  c.ready();
  assert.equal(c.frames.filter((f) => f.type === "renderer-event").length, 0);
  c.lease.expire("done");
});
test("stale transports cannot dispatch, acknowledge, or expire the replacement", async () => {
  const t = setup(),
    a = attach(t.sessions);
  const epoch = a.ready();
  const b = attach(t.sessions, "tab", "document", epoch);
  b.ready();
  let calls = 0;
  a.lease.accept(1, () => calls++);
  a.lease.release();
  a.lease.expire("stale");
  assert.throws(() => a.lease.acknowledge(0));
  assert.equal(calls, 0);
  assert(b.lease.isCurrent());
  // Native asynchronous completion captured before transport loss remains valid.
  a.lease.send("late result");
  assert.equal(b.frames.at(-1).payload, "late result");
  b.lease.expire("done");
});
test("document reload replaces ports/window; separate tabs remain independent", async () => {
  const t = setup(),
    a = attach(t.sessions);
  await a.lease.window;
  const epoch = a.ready();
  const b = attach(t.sessions, "tab", "new-document");
  await b.lease.window;
  b.ready();
  const c = attach(t.sessions, "other");
  c.ready();
  await delay(0);
  assert.deepEqual(t.destroyed, [1]);
  assert.equal(t.created, 3);
  assert.equal(a.lease.isCurrent(), false);
  assert.throws(() => attach(t.sessions, "tab", "document", epoch), /过期/);
  b.lease.expire("done");
  c.lease.expire("done");
});
test("bounded retention expires; old epoch never creates a new session or replays commands", async () => {
  const t = setup({
      graceMs: 15,
      sessionBytes: 4096,
      totalBytes: 8192,
      sessions: 2,
    }),
    a = attach(t.sessions);
  await a.lease.window;
  const epoch = a.ready();
  a.lease.release();
  await delay(40);
  assert.deepEqual(t.destroyed, [1]);
  assert.throws(() => attach(t.sessions, "tab", "document", epoch), /过期/);
  assert.equal(t.created, 1);
});
test("overflow explicitly resets instead of silently dropping output; accounting recovers", async () => {
  const t = setup({
    graceMs: 15,
    sessionBytes: 150,
    totalBytes: 200,
    sessions: 2,
  });
  const a = attach(t.sessions);
  await a.lease.window;
  const epoch = a.ready();
  a.lease.send("x".repeat(200));
  assert(a.frames.some((f) => f.type === "renderer-reset"));
  assert.equal(a.closed, 1);
  assert.throws(() => attach(t.sessions, "tab", "document", epoch));
  const b = attach(t.sessions);
  b.ready();
  b.lease.send("ok");
  assert.equal(b.frames.at(-1).payload, "ok");
  b.lease.expire("done");
});
test("invalid sequence and ACK rejected without running native operations", async () => {
  const t = setup(),
    a = attach(t.sessions);
  a.ready();
  let calls = 0;
  for (const seq of [0, -1, 2, NaN, 1.5])
    assert.throws(() => a.lease.accept(seq, () => calls++));
  assert.equal(calls, 0);
  assert.throws(() => a.lease.acknowledge(1));
  a.lease.expire("done");
});
test("session count bounded; failed native creation releases its slot", async () => {
  let attempts = 0;
  const s = new RendererSessions(
    () =>
      ++attempts === 1 ? Promise.reject(Error("failure")) : Promise.resolve({}),
    () => {},
    { graceMs: 10, sessionBytes: 4096, totalBytes: 4096, sessions: 1 },
  );
  const a = attach(s);
  await assert.rejects(a.lease.window);
  await delay(0);
  const b = attach(s);
  b.ready();
  assert.throws(() => attach(s, "second"), /上限/);
  b.lease.expire("done");
});

test('shared cache pressure evicts oldest detached pages and preserves active replay', async () => {
  const t = setup({graceMs:7200000,sessionBytes:1000,totalBytes:1100,sessions:8});
  const old = attach(t.sessions,'old'), newer = attach(t.sessions,'newer'), active = attach(t.sessions,'active');
  const oldEpoch=old.ready();newer.ready();const activeEpoch=active.ready();
  old.lease.send('x'.repeat(250));old.lease.release();await delay(2);
  newer.lease.send('y'.repeat(250));newer.lease.release();
  active.lease.send('z'.repeat(500));
  assert(!old.lease.isCurrent());assert(newer.lease.isCurrent());assert(active.lease.isCurrent());
  assert(!active.frames.some(f=>f.type==='renderer-reset'));
  assert.throws(()=>attach(t.sessions,'old','document',oldEpoch));
  active.lease.release();const resumed=attach(t.sessions,'active','document',activeEpoch);resumed.ready();
  assert.equal(resumed.frames.find(f=>f.type==='renderer-event').payload,'z'.repeat(500));
  resumed.lease.acknowledge(1);resumed.lease.expire('done');newer.lease.expire('done');
});

test('detached emitter can be evicted without dropping another page output', () => {
 const t=setup({graceMs:7200000,sessionBytes:1000,totalBytes:600,sessions:8});
 const old=attach(t.sessions,'old'),active=attach(t.sessions,'active');old.ready();active.ready();
 old.lease.release();active.lease.send('a'.repeat(300));old.lease.send('b'.repeat(300));
 assert(!old.lease.isCurrent());assert(active.lease.isCurrent());
 assert.equal(active.frames.at(-1).payload,'a'.repeat(300));active.lease.expire('done');
});

test('session slots reclaim disconnected documents without evicting a connected page', () => {
 const t=setup({graceMs:7200000,sessionBytes:1000,totalBytes:2000,sessions:2});
 const old=attach(t.sessions,'old'),active=attach(t.sessions,'active');old.ready();active.ready();old.lease.release();
 const fresh=attach(t.sessions,'fresh');fresh.ready();assert(!old.lease.isCurrent());assert(active.lease.isCurrent());
 assert.throws(()=>attach(t.sessions,'fourth'),/上限/);fresh.lease.expire('done');active.lease.expire('done');
});

test('sustained stale-page notifications cannot reset an acknowledged active page', () => {
 const t=setup({graceMs:7200000,sessionBytes:4096,totalBytes:4096,sessions:64});
 const active=attach(t.sessions,'active');active.ready();
 const stale=Array.from({length:20},(_,i)=>{const c=attach(t.sessions,'stale'+i);c.ready();c.lease.release();return c});
 for(let i=0;i<1000;i++){
  for(const c of stale)c.lease.send({notification:i,data:'x'.repeat(200)});
  active.lease.send({reply:i});active.lease.acknowledge(i+1);
 }
 assert(active.lease.isCurrent());assert.equal(active.frames.filter(f=>f.type==='renderer-event').length,1000);
 assert.equal(active.frames.filter(f=>f.type==='renderer-reset').length,0);
 assert(t.sessions.bytes<=4096);active.lease.expire('done');for(const c of stale)c.lease.expire('done');
});

test('buffer diagnostics attribute retained bytes and overflow without recording payloads or arbitrary labels', () => {
 const records=[];
 const s=new RendererSessions(async()=>({}),()=>{}, {graceMs:7200000,sessionBytes:4096,totalBytes:8192,sessions:2},
  (event,id,document,fields)=>records.push({event,...fields}));
 const a=attach(s);const epoch=a.ready();
 a.lease.send({type:'ipc-main-event',channel:'private-channel',args:[{type:'fetch-response',body:'private-response'}]});
 a.lease.send({type:'ipc-main-event',channel:'private-channel',args:[{type:'private-type',body:'private-response'}]});
 const expectedBytes=Buffer.byteLength(JSON.stringify(a.frames.find(f=>f.type==='renderer-event')));
 a.lease.release();
 const profile=records.find(r=>r.event==='buffer_profile'&&r.phase==='release'&&r.category==='fetch-response');
 assert.equal(profile.bytes,expectedBytes);assert.equal(profile.events,1);assert.equal(profile.maxEventBytes,expectedBytes);
 assert(records.some(r=>r.category==='ipc-event-other'));
 const b=attach(s,'tab','document',epoch,1);b.ready();
 assert.equal(records.filter(r=>r.phase==='replay'&&r.category==='fetch-response').length,0,'Acknowledged bytes must be removed from the profile');
 b.lease.send({type:'message-port-message',data:'private-response'.repeat(1000)});
 assert(records.some(r=>r.event==='overflow'&&r.category==='message-port-message'&&r.incomingBytes>4096));
 assert(b.frames.some(f=>f.type==='renderer-reset'));
 assert(!JSON.stringify(records).includes('private-'),'Diagnostic output must exclude unknown types, channels and contents');
});
