const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const file = path.resolve('src/server/workflow/store.ts');
const item = new Module(file, module);
item.filename = file;
item.paths = Module._nodeModulePaths(path.dirname(file));
item._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
}).outputText, file);
fs.mkdirSync('runtime/tmp', {recursive: true});
const directory = fs.mkdtempSync(path.resolve('runtime/tmp/workflow-activity-'));
const store = new item.exports.WorkflowStore(directory);
try {
  const {task} = store.create('activity-fixture', {title: 'Activity fixture', kind: 'fix', prompt: 'Fixture', cwd: directory});
  const remote = {
    host: 'bbdev', task: 'fixture', path: '/fixture/worktree', branch: 'fix/fixture', head: 'a'.repeat(40),
    cleanup: {state: 'retained', reason: 'PR is open', checkedAt: '2026-01-01T00:00:00Z'},
  };
  const sync = checkedAt => ({checkedAt, error: null});
  store.update(task.id, {remoteWorktrees: [remote], remoteWorktreesSync: sync(remote.cleanup.checkedAt)}, 'remote-worktrees.checked');
  const initialActivity = store.events(task.id);
  const updatedAt = store.get(task.id).updatedAt;
  for (let index = 1; index <= 150; index++) {
    const checkedAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    store.update(task.id, {remoteWorktrees: [{...remote, cleanup: {...remote.cleanup, checkedAt}}], remoteWorktreesSync: sync(checkedAt)}, 'remote-worktrees.checked');
  }
  assert.deepEqual(store.events(task.id), initialActivity, 'Identical polls must not add activity');
  assert.equal(store.get(task.id).updatedAt, updatedAt, 'Polling must not reorder tasks as newly updated');
  assert.equal(store.get(task.id).remoteWorktreesSync.checkedAt, '2026-01-01T02:30:00.000Z', 'Fresh inspection time must still be saved');
  store.update(task.id, {remoteWorktrees: [{...remote, branch: 'fix/reviewed', cleanup: {state: 'cleaned', reason: '', checkedAt: '2026-01-01T03:00:00Z'}}]}, 'remote-worktrees.checked');
  assert.equal(store.events(task.id)[0].kind, 'remote-worktrees.updated');
  assert.equal(store.events(task.id)[0].data.remoteWorktrees[0].cleanup.state, 'cleaned');
  assert.equal(store.events(task.id).length, initialActivity.length + 1, 'Actual worktree changes must remain visible');

  const pr = {repo: 'example/server', pr: 1, url: 'https://github.com/example/server/pull/1', base: 'dev', release: 'master', state: 'OPEN', isDraft: false, checkedAt: '2026-01-01T03:00:00Z'};
  store.update(task.id, {deliveries: [pr]}, 'delivery.checked');
  const beforePoll = store.events(task.id).length;
  store.update(task.id, {deliveries: [{...pr, checkedAt: '2026-01-01T03:01:00Z'}]}, 'delivery.checked');
  assert.equal(store.events(task.id).length, beforePoll);
  store.update(task.id, {deliveries: [{...pr, state: 'MERGED', devMergedAt: '2026-01-01T03:02:00Z'}]}, 'delivery.checked');
  assert.equal(store.events(task.id)[0].kind, 'delivery.updated');
  assert.equal(store.events(task.id)[0].data.deliveries[0].state, 'MERGED');
  store.update(task.id, {deliveries: [{...pr, error: 'Inspection unavailable'}]}, 'delivery.checked');
  assert.equal(store.events(task.id)[0].data.deliveries[0].error, 'Inspection unavailable', 'Inspection failures must be visible when the result changes');

  store.update(task.id, {summary: 'Client acceptance passed'}, 'progress');
  for (let index = 0; index < 250; index++) store.event(task.id, index % 2 ? 'remote-worktrees.checked' : 'delivery.checked', {checkedAt: index});
  const visible = store.events(task.id);
  assert.equal(visible[0].data.summary, 'Client acceptance passed', 'Historical polling noise must not consume the activity limit');
  assert(visible.some(event => event.kind === 'created'));
  assert(visible.some(event => event.kind === 'remote-worktrees.updated'));
  assert(!visible.some(event => event.kind.endsWith('.checked')));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind IN ('remote-worktrees.checked','delivery.checked')").get().count, 250, 'Historical records must remain intact');
  console.log('PASS: Repeated inspections stay quiet; worktree, PR and failure changes remain visible; old polling records do not hide progress');
} finally {
  store.close();
  fs.rmSync(directory, {recursive: true});
}
