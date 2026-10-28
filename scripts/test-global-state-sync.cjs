const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const {
  synchronizeGlobalState,
} = require("../src/server/global-state-sync.js");
fs.mkdirSync("runtime/tmp", { recursive: true });
const root = fs.mkdtempSync(path.resolve("runtime/tmp/state-sync-"));
const file = path.join(root, "state.json");
const write = (state) => {
  fs.writeFileSync(file + ".new", JSON.stringify(Object.fromEntries(state)));
  fs.renameSync(file + ".new", file);
};
const createStore = (filePath = file) => ({
  state: new Map(),
  filePath,
  persistQueued: Promise.resolve(),
  persistDebounced: { cancel() {} },
  get(k) {
    return this.state.get(k);
  },
  getStored(k) {
    return this.state.get(k);
  },
  set(k, v) {
    this.state.set(k, v);
  },
  update(k, f) {
    this.state.set(k, f(this.state.get(k)));
  },
  delete(k) {
    this.state.delete(k);
  },
});
const store = createStore();
const notices = [];
const dispose = synchronizeGlobalState(store, write, (keys) =>
  notices.push(keys),
);
(async () => {
  try {
    store.set("settings", { local: 1, external: 1 });
    await store.queueGlobalStatePersistence();
    await store.persistQueued;
    assert.deepEqual(
      JSON.parse(fs.readFileSync(file)),
      { settings: { local: 1, external: 1 } },
      "A new store can persist its first value",
    );
    store.get("settings");
    const originalRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function (p, ...args) {
      if (p === file) reads++;
      return originalRead.call(this, p, ...args);
    };
    try {
      for (let i = 0; i < 2000; i++)
        assert.equal(store.get("settings").local, 1);
    } finally {
      fs.readFileSync = originalRead;
    }
    assert.equal(
      reads,
      0,
      "Repeated unchanged reads must not reopen the state contents",
    );
    const old = fs.statSync(file);
    fs.writeFileSync(
      file,
      JSON.stringify({ settings: { local: 1, external: 2 } }),
    );
    fs.utimesSync(file, old.atime, old.mtime);
    assert.equal(
      store.get("settings").external,
      2,
      "In-place same-size updates with restored mtime are visible",
    );
    store.set("settings", { local: 3, external: 2 });
    write(
      new Map([
        ["settings", { local: 1, external: 4 }],
        ["otherClient", "kept"],
      ]),
    );
    await store.queueGlobalStatePersistence();
    await store.persistQueued;
    assert.deepEqual(
      JSON.parse(fs.readFileSync(file)),
      { settings: { local: 3, external: 4 }, otherClient: "kept" },
      "Pending local changes and external edits merge on persistence",
    );
    write(new Map([["settings", { local: 5, external: 4 }]]));
    assert.equal(
      store.get("settings").local,
      5,
      "Atomic replacement is visible immediately",
    );
    const before = notices.length;
    write(new Map([["settings", { local: 6, external: 4 }]]));
    for (let i = 0; i < 30 && notices.length === before; i++)
      await new Promise((r) => setTimeout(r, 100));
    assert(
      notices.length > before,
      "External changes notify renderers without a foreground read",
    );
    fs.writeFileSync(file, "{");
    assert.equal(
      store.get("settings").local,
      6,
      "Incomplete external writes retain the last valid state",
    );
    await assert.rejects(
      store.flushWith(),
      /unreadable/,
      "Persistence cannot overwrite an unreadable external file",
    );
    fs.unlinkSync(file);
    await assert.rejects(
      store.flushWith(),
      /unreadable/,
      "A missing existing file is not treated as a new store",
    );
    const asyncFile = path.join(root, "async-state.json");
    const initial = { assignments: { task: "Alpha" }, title: "Original" };
    fs.writeFileSync(asyncFile, JSON.stringify(initial));
    const asyncStore = createStore(asyncFile);
    asyncStore.state = new Map(Object.entries(initial));
    let releaseWrite;
    const stopAsync = synchronizeGlobalState(asyncStore, async (snapshot) => {
      await new Promise(resolve => { releaseWrite = resolve; });
      await fs.promises.writeFile(asyncFile + ".new", JSON.stringify(Object.fromEntries(snapshot)));
      await fs.promises.rename(asyncFile + ".new", asyncFile);
    }, () => {});
    try {
      asyncStore.set("assignments", { task: "Beta" });
      const first = asyncStore.flushWith();
      let finished = false;
      first.then(() => { finished = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(finished, false, "Flush waits for the native asynchronous writer");
      assert.equal(asyncStore.get("assignments").task, "Beta", "Reading during an unfinished save cannot restore the old folder");
      asyncStore.set("title", "Edited during save");
      releaseWrite();
      await first;
      assert.deepEqual(JSON.parse(fs.readFileSync(asyncFile)), {
        assignments: { task: "Beta" }, title: "Original",
      }, "An in-flight write persists the captured snapshot");
      assert.equal(asyncStore.get("title"), "Edited during save", "Completing a write must not mark newer edits as already saved");
      const second = asyncStore.flushWith();
      await new Promise(resolve => setImmediate(resolve));
      releaseWrite();
      await second;
      assert.deepEqual(JSON.parse(fs.readFileSync(asyncFile)), {
        assignments: { task: "Beta" }, title: "Edited during save",
      }, "The next save retains the folder move and newer edits");
    } finally {
      stopAsync();
    }
    console.log(
      "PASS: new store, read cache, external edits, async folder persistence, edits during save, notifications and invalid-write protection",
    );
  } finally {
    dispose();
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
