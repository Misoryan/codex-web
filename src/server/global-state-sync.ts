import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

type State = Map<string, unknown>;
type Store = {
  state: State; filePath: string;
  get: (...args: any[]) => unknown; getStored: (...args: any[]) => unknown;
  set: (...args: any[]) => unknown; update: (...args: any[]) => unknown; delete: (...args: any[]) => unknown;
  persistQueued: Promise<unknown>; persistScheduledForAtoms: boolean;
  persistScheduledForCustomRuntime: boolean; persistDebounced: { cancel(): void };
  queueGlobalStatePersistence(): void; flushWith(writer: unknown): Promise<unknown>;
};
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// Apply local edits to the latest Desktop snapshot. Independent entries in a
// project/title map must survive writes from either process. Arrays are atomic.
function merge(base: unknown, local: unknown, disk: unknown): unknown {
  if (isDeepStrictEqual(base, local)) return disk;
  if (!record(base) || !record(local) || !record(disk)) return local;
  const result = { ...disk };
  for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (isDeepStrictEqual(base[key], local[key])) continue;
    if (!Object.hasOwn(local, key)) delete result[key];
    else Object.defineProperty(result, key, {
      value: merge(base[key], local[key], disk[key]), enumerable: true,
      configurable: true, writable: true,
    });
  }
  return result;
}

export function synchronizeGlobalState(
  store: Store, write: (state: State) => void, notify: (keys: string[]) => void,
): () => void {
  let baseline = structuredClone(Object.fromEntries(store.state));
  let lastText = '';
  function refresh(): boolean {
    let text: string, disk: Record<string, unknown>;
    try {
      text = readFileSync(store.filePath, 'utf8');
      if (text === lastText) return true;
      disk = JSON.parse(text);
      if (!record(disk)) return false;
    } catch { return false; } // Atomic replacement or incomplete external write: retry next tick.
    const local = Object.fromEntries(store.state);
    const next = merge(baseline, local, disk) as Record<string, unknown>;
    const changed = [...new Set([...Object.keys(local), ...Object.keys(next)])]
      .filter(key => !isDeepStrictEqual(local[key], next[key]));
    store.state = new Map(Object.entries(next));
    baseline = structuredClone(disk);
    lastText = text;
    if (changed.length) notify(changed);
    return true;
  }
  for (const name of ['get', 'getStored', 'set', 'update', 'delete'] as const) {
    const original = store[name];
    store[name] = function (...args: any[]) { refresh(); return original.apply(store, args); };
  }
  // Refresh and serialize together; do not enqueue an already stale snapshot.
  store.queueGlobalStatePersistence = () => {
    store.persistQueued = store.persistQueued.catch(() => undefined).then(() => {
      if (!refresh()) throw new Error(`Cannot save global state while the Desktop state file is unreadable: ${store.filePath}`);
      write(store.state);
      baseline = structuredClone(Object.fromEntries(store.state));
      lastText = JSON.stringify(baseline);
    });
  };
  store.flushWith = () => {
    store.persistScheduledForCustomRuntime = false;
    store.persistScheduledForAtoms = false;
    store.persistDebounced.cancel();
    store.queueGlobalStatePersistence();
    return store.persistQueued;
  };
  refresh();
  watchFile(store.filePath, { interval: 1000, persistent: false }, refresh);
  return () => unwatchFile(store.filePath, refresh);
}
