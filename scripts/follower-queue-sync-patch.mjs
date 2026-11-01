import fs from 'node:fs/promises';
import ts from 'typescript';

// Desktop and browser share durable queue storage. Broadcasts have no revision;
// an earlier broadcast may arrive during or after a follower's accepted write.
export function patchFollowerQueueSync(source) {
  if (source.includes('codexWebReadFollowerQueue')) return source;
  const tree = ts.createSourceFile('queue.js', source, 99, true, ts.ScriptKind.JS);
  const classes = [];
  function visit(node) {
    if (ts.isClassExpression(node) && node.members.some(member =>
      ts.isConstructorDeclaration(member) && member.getText(tree).includes('Failed to initialize queued message execution'))) classes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (classes.length !== 1) throw Error('Queued follower coordinator changed');
  const coordinator = classes[0], edits = [];
  const one = (values, label) => {
    if (values.length !== 1) throw Error(`Queued follower ${label} changed: ${values.length}`);
    return values[0];
  };
  function find(node, predicate) {
    const values = [];
    function walk(child) { if (predicate(child)) values.push(child); ts.forEachChild(child, walk); }
    walk(node); return values;
  }
  const constructor = one(coordinator.members.filter(ts.isConstructorDeclaration), 'constructor');
  const registration = one(find(constructor, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'registerBroadcastHandler'), 'broadcast registration');
  const callback = one(registration.arguments.filter(ts.isArrowFunction), 'broadcast callback');
  edits.push({start: callback.getStart(tree), end: callback.end, text: `({params, sourceClientId}) => {
    const role = this.options.getStreamRole(params.conversationId);
    if (this.disposed || role?.role !== 'follower' || role.ownerClientId !== sourceClientId) return;
    this.codexWebMarkQueueChanged(params.conversationId);
    if (!this.pending.has(params.conversationId)) this.codexWebRefreshFollowerQueue(params.conversationId, sourceClientId);
  }`});
  const mutation = one(coordinator.members.filter(member => member.getText(tree).includes('this.options.requestFollower(')), 'mutation');
  const request = one(find(mutation, node => ts.isCallExpression(node) && node.expression.getText(tree) === 'this.options.requestFollower'), 'owner request');
  let block = request.parent;
  while (block && !ts.isBlock(block)) block = block.parent;
  if (!block || !ts.isBlock(block) || block.statements.length !== 2 || !ts.isIfStatement(block.statements[1])) throw Error('Queued follower response changed');
  const thread = request.arguments[0].getText(tree);
  const state = request.arguments[1];
  if (!ts.isObjectLiteralExpression(state) || state.properties.length !== 1 || !ts.isPropertyAssignment(state.properties[0])) throw Error('Queued follower state changed');
  const messages = state.properties[0].initializer.getText(tree);
  const owner = request.arguments[2].getText(tree);
  edits.push({start: block.statements[1].end, end: block.statements[1].end, text: `
    try {
      const committed = await this.codexWebReadFollowerQueue(${thread}, ${owner});
      if (this.codexWebFollowerSnapshotIsCurrent(${thread}, ${owner}, committed)) ${messages} = committed.messages;
    } catch (error) {
      // The owner already acknowledged the write; retain the accepted prompt.
      this.options.logger.warning('Failed to read committed follower queue', {safe:{}, sensitive:{error}});
    }
  `});
  edits.push({start: mutation.body.getStart(tree) + 1, end: mutation.body.getStart(tree) + 1, text: `\nthis.codexWebMarkQueueChanged(${thread});\n`});
  const disposal = one(coordinator.members.filter(member => member.name?.getText(tree) === 'dispose'), 'disposal');
  const disposalBody = one(find(disposal, ts.isArrowFunction), 'disposal callback').body;
  if (!ts.isBlock(disposalBody)) throw Error('Queued follower disposal changed');
  edits.push({start: disposalBody.getStart(tree) + 1, end: disposalBody.getStart(tree) + 1, text: '\nthis.codexWebQueueRevisions.clear();\nthis.codexWebFollowerReads.clear();\n'});
  edits.push({start: coordinator.members.end, end: coordinator.members.end, text: `
  codexWebQueueRevisions = new Map();
  codexWebFollowerReads = new Map();
  codexWebMarkQueueChanged(threadId) {
    this.codexWebQueueRevisions.set(threadId, (this.codexWebQueueRevisions.get(threadId) ?? 0) + 1);
  }
  codexWebFollowerSnapshotIsCurrent(threadId, ownerClientId, snapshot) {
    const role = this.options.getStreamRole(threadId);
    return snapshot != null && !this.disposed && role?.role === 'follower' &&
      role.ownerClientId === ownerClientId && snapshot.revision === (this.codexWebQueueRevisions.get(threadId) ?? 0);
  }
  async codexWebReadFollowerQueue(threadId, ownerClientId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.disposed) return null;
      const revision = this.codexWebQueueRevisions.get(threadId) ?? 0;
      const state = await this.options.storage.load();
      const role = this.options.getStreamRole(threadId);
      if (this.disposed || role?.role !== 'follower' || role.ownerClientId !== ownerClientId) return null;
      if (revision === (this.codexWebQueueRevisions.get(threadId) ?? 0)) return {revision, messages:state?.[threadId] ?? []};
    }
    throw Error('Follower queue kept changing during readback');
  }
  codexWebRefreshFollowerQueue(threadId, ownerClientId) {
    const key = JSON.stringify([threadId, ownerClientId]);
    if (this.codexWebFollowerReads.has(key)) return;
    const reading = this.codexWebReadFollowerQueue(threadId, ownerClientId).then(snapshot => {
      if (!this.codexWebFollowerSnapshotIsCurrent(threadId, ownerClientId, snapshot) || this.pending.has(threadId)) return;
      this.messages.set(threadId, {messages:snapshot.messages, refreshing:false});
      this.options.onQueueChanged?.(threadId);
    }).catch(error => {
      if (!this.disposed) this.options.logger.warning('Failed to refresh follower queue', {safe:{}, sensitive:{error}});
    }).finally(() => {
      if (this.codexWebFollowerReads.get(key) === reading) this.codexWebFollowerReads.delete(key);
    });
    this.codexWebFollowerReads.set(key, reading);
  }
`});
  for (const edit of edits.sort((a,b) => b.start-a.start)) source = source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  return source;
}

export async function patchNativeFollowerQueueFile(file = 'scratch/asar/.vite/build/src-BJv5Mk7n.js') {
  const source = await fs.readFile(file, 'utf8');
  const result = patchFollowerQueueSync(source);
  if (result !== source) await fs.writeFile(file, result);
}
