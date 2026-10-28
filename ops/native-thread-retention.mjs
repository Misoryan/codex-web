import {pathToFileURL} from 'node:url';
import {RuntimeReader} from '../src/server/native-runtime-reader.js';

const terminal = new Set(['completed', 'failed']);
const inactive = new Set(['idle', 'notLoaded']);

export async function releaseIdleSubagents(reader, now = Date.now()) {
  const loaded = new Set();
  let cursor = null;
  do {
    const page = await reader.request('thread/loaded/list', {cursor, limit: 100});
    for (const id of page.data) loaded.add(id);
    cursor = page.nextCursor ?? null;
  } while (cursor);
  const result = {loaded: loaded.size, eligible: 0, released: 0, skipped: 0, errors: 0};
  const read = async id => (await reader.request('thread/read', {threadId: id, includeTurns: false})).thread;
  const parent = thread => thread.parentThreadId ?? thread.source?.subAgent?.thread_spawn?.parent_thread_id;
  const eligible = thread => thread?.source?.subAgent?.thread_spawn && parent(thread) &&
    ['idle', 'systemError'].includes(thread.status?.type) && !thread.ephemeral && thread.path;
  const ancestorsInactive = async thread => {
    const seen = new Set([thread.id]);
    for (let id = parent(thread); id; id = parent(thread)) {
      if (seen.has(id)) return false;
      seen.add(id);
      thread = await read(id);
      if (!inactive.has(thread?.status?.type)) return false;
    }
    return true;
  };
  for (const id of loaded) {
    try {
      const thread = await read(id);
      if (!eligible(thread)) continue;
      const page = await reader.request('thread/turns/list', {
        threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
      });
      const turn = page.data?.[0];
      if (!terminal.has(turn?.status) || !Number.isFinite(turn.completedAt) ||
          turn.completedAt * 1000 > now - 5 * 60_000) continue;
      result.eligible++;
      if (!await ancestorsInactive(thread)) { result.skipped++; continue; }
      const current = await read(id);
      if (!eligible(current) || current.updatedAt !== thread.updatedAt) { result.skipped++; continue; }
      const response = await reader.request('thread/unsubscribe', {threadId: id});
      if (response.status === 'unsubscribed') result.released++;
      else result.skipped++;
    } catch {
      result.errors++;
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = new URL(process.argv[2]);
  const url = new URL('/__backend/native/ipc', origin);
  url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  const reader = new RuntimeReader(url.href);
  try {
    const result = await releaseIdleSubagents(reader);
    console.log(JSON.stringify({time: new Date().toISOString(), ...result}));
    if (result.errors) process.exitCode = 1;
  } catch {
    console.error('Native thread retention could not read the runtime');
    process.exitCode = 1;
  } finally {
    reader.close();
  }
}
