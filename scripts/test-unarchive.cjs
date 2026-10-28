const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

function load(source) {
  const tree = ts.createSourceFile('native.js', source, 99, true, ts.ScriptKind.JS);
  const functions = tree.statements.filter(ts.isFunctionDeclaration);
  const workflow = functions.find(node => node.getText(tree).includes('Unarchive requested'));
  let request, notification;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'unarchiveThread' && node.getText(tree).includes('thread/unarchive')) request = node.initializer.getText(tree);
    if (ts.isMethodDeclaration(node) && node.name.getText(tree) === 'handleThreadUnarchived' && node.getText(tree).includes('isCatalogHistoryEnabled')) notification = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert(workflow && request && notification);
  const context = vm.createContext({console, Date});
  const run = vm.runInContext(`(${workflow.getText(tree)})`, context);
  const makeRequest = vm.runInContext(`e => (${request})`, context);
  const Manager = vm.runInContext(`(class { ${notification} })`, context);
  return {run, makeRequest, Manager};
}

(async () => {
  const {patchUnarchive} = await import('./unarchive-patch.mjs');
  for (const file of ['scratch/asar/.vite/build/src-BJv5Mk7n.js', 'scratch/asar/webview/assets/app-shared-8bd9d0399038.js']) {
    const before = fs.readFileSync(file, 'utf8'), after = patchUnarchive(before);
    assert.equal(patchUnarchive(after), after);
    const native = load(after), restored = {id: 'archived-thread', name: 'Restored title', status: {type: 'notLoaded'}, turns: []};
    const updates = [], broadcasts = [], suppressed = new Set([restored.id]);
    const request = native.makeRequest({
      manager: {async sendRequest(method, params) {
        assert.equal(method, 'thread/unarchive');
        assert.equal(params.threadId, restored.id);
        return {thread: restored};
      }},
      threadStore: {upsertConversationFromThread(thread, source) { updates.push({thread, source}); }},
    });
    // Supply a successful RPC with no subsequent notification, as can happen at
    // a connection boundary. Restoring metadata must not depend on that event.
    await native.run({
      hostId: 'local', logger: {info() {}, warning() {}, error() {}},
      prepareOwnedThreadForUnarchive: async () => {}, pendingThreadArchives: {remove: async () => {}},
      unarchiveThread: request,
      deleteSuppressedArchivedConversationId: id => suppressed.delete(id),
      archivedPinnedThreadPlacements: new Map(),
      broadcastThreadUnarchived: async value => broadcasts.push(value),
      loadUnarchivedThread: () => {throw Error('Unexpected second metadata read');},
    }, restored.id);
    assert.equal(suppressed.size, 0, 'The restored chat is no longer hidden without a notification');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].thread, restored, 'The actual RPC response supplies the restored metadata');
    assert.equal(updates[0].source, 'stored');
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].conversationId, restored.id);

    const manager = new native.Manager(), warnings = [];
    let invalidations = 0;
    Object.assign(manager, {
      events: {emitThreadListInvalidated: () => invalidations++, emitThreadUnarchived() {}},
      logger: {warning: (...args) => warnings.push(args)},
      threadStore: {unsuppressArchivedConversation() {}, isCatalogHistoryEnabled: true,
        upsertConversationFromThread() {throw Error('A failed read must not publish metadata');}},
      readThread: async () => {throw Error('thread not loaded: archived-thread');},
    });
    await manager.handleThreadUnarchived(restored.id);
    assert.equal(warnings.length, 1, 'Notification read failure is handled instead of rejecting into the process');
    assert(invalidations > 0, 'The failed refresh leaves the directory invalidated');
    manager.readThread = async () => ({thread: restored});
    let published;
    manager.threadStore.upsertConversationFromThread = thread => {published = thread;};
    await manager.handleThreadUnarchived(restored.id);
    assert.equal(published, restored, 'A later valid notification can refresh the chat');
  }
  console.log('Native and browser archive coordinators restore RPC metadata, notify peers, and contain refresh failures');
})().catch(error => {console.error(error); process.exitCode = 1;});
