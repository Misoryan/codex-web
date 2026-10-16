const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

async function main() {
  const {patchLatestHistoryTail} = await import('./history-tail-patch.mjs');
  const before = fs.readFileSync('scratch/asar/webview/assets/app-shared-8bd9d0399038.js', 'utf8');
  const after = patchLatestHistoryTail(before);
  assert.equal(patchLatestHistoryTail(after), after);
  function load(source) {
    const tree = ts.createSourceFile('shared.js', source, 99, true, ts.ScriptKind.JS);
    const functions = new Map(), methods = new Map();
    function visit(node) {
      if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(tree));
      if (ts.isMethodDeclaration(node) && ['listThreadTurns', 'readThreadTurnsPage'].includes(node.name.getText(tree)) && node.getText(tree).includes('this.client')) methods.set(node.name.getText(tree), node.getText(tree));
      ts.forEachChild(node, visit);
    }
    visit(tree);
    const code = ['Y', 'pz', 'mz', 'd3t', 'rB', 'nB', 'iB'].map(name => {
      assert(functions.has(name), name);
      return functions.get(name);
    }).join('\n');
    return vm.runInNewContext(`${code}\nclass Pagination {prefetchedPages = new Map(); ${[...methods.values()].join('\n')}}; Pagination`, {Map, Set, Date, Math, Promise, Error});
  }
  const PaginationBefore = load(before), PaginationAfter = load(after);
  const oldItem = {id: 'old-answer', type: 'agentMessage', text: 'Earlier answer'};
  const latestItem = {id: 'new-answer', type: 'agentMessage', text: 'Latest answer'};
  function fixture(Type) {
    const conversation = {historyMode: 'paginated', resumeState: 'resumed', paginatedHistory: {itemsBackwardsCursor: 'old-snapshot'}, turns: [], threadAccess: 'shared'};
    const calls = [];
    const client = {
      isCloudHost: false,
      getConversation: () => conversation,
      supportsPaginatedThreadHistory: () => true,
      getConversationTurnItemLimit: () => 100,
      async sendRequest(method, params) {
        calls.push({method, params});
        if (method === 'thread/turns/list') return {data: [{id: 'turn', status: 'completed'}], nextCursor: null};
        if (method === 'thread/items/list') return {data: [{turnId: 'turn', item: params.cursor == null ? latestItem : oldItem}], nextCursor: null};
        throw Error(`Unexpected request ${method}`);
      },
    };
    const pager = new Type();
    pager.client = client;
    pager.policy = {turnMergePolicy: null};
    return {pager, calls};
  }
  const itemIds = page => JSON.parse(JSON.stringify(page.response.data.flatMap(turn => turn.items.map(item => item.id))));
  if (!before.includes('CODEX_WEB_LATEST_TAIL')) assert.deepEqual(itemIds(await fixture(PaginationBefore).pager.listThreadTurns('thread')), ['old-answer'], 'The shipped initial-page path reproduces the old snapshot');
  const fresh = fixture(PaginationAfter);
  assert.deepEqual(itemIds(await fresh.pager.listThreadTurns('thread')), ['new-answer'], 'Opening the initial page must read the latest answer');
  assert.equal(fresh.calls.length, 2, 'Reading the latest tail adds no extra requests');
  const older = fixture(PaginationAfter);
  assert.deepEqual(itemIds(await older.pager.listThreadTurns('thread', {cursor: 'older-turns'})), ['old-answer'], 'Older pages retain the snapshot boundary');
  const ascending = fixture(PaginationAfter);
  assert.deepEqual(itemIds(await ascending.pager.listThreadTurns('thread', {sortDirection: 'asc'})), ['old-answer']);
  const cached = fixture(PaginationAfter);
  const tree = ts.createSourceFile('shared.js', before, 99, true, ts.ScriptKind.JS);
  const keyFunction = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'd3t');
  const key = vm.runInNewContext(`${keyFunction.getText(tree)}; d3t`)('thread', {}, 'shared');
  cached.pager.prefetchedPages.set(key, {expiresAt: Date.now() + 60000, result: {response: {data: [{id: 'turn', items: [oldItem]}]}}});
  assert.deepEqual(itemIds(await cached.pager.listThreadTurns('thread')), ['new-answer'], 'A saved initial preview cannot hide newer messages');
  fs.mkdirSync('runtime/public-connection', {recursive: true});
  fs.writeFileSync('runtime/public-connection/history-tests.json', JSON.stringify({passed: true, baselineReproduced: !before.includes('CODEX_WEB_LATEST_TAIL'), scenarios: ['initial page latest', 'older cursor retained', 'ascending history retained', 'stale preview bypassed'], addedRequests: 0}, null, 2));
  console.log('PASS: native pagination reads the latest initial tail, retains older boundaries and bypasses stale initial previews');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
