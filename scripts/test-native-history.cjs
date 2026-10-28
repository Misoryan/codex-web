const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const ts = require('typescript');
const plain = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');

function load(source) {
  const tree = ts.createSourceFile('native.js', source, 99, true, ts.ScriptKind.JS);
  const functions = tree.statements.filter(ts.isFunctionDeclaration);
  const page = functions.filter(node => node.getText(tree).includes('thread/items/list repeated cursor'));
  const item = functions.filter(node => node.getText(tree).includes('thread/items/list returned unchanged cursor'));
  assert.equal(page.length, 1);
  assert.equal(item.length, 1);
  const methods = [];
  function visit(node) {
    if (ts.isMethodDeclaration(node) && ['listThreadTurns', 'readThreadTurnsPage'].includes(node.name.getText(tree)) && node.getText(tree).includes('this.client')) methods.push(node.getText(tree));
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(methods.length, 2);
  // The external module only supplies the opaque thread-id conversion here.
  const context = vm.createContext({console, Error, n: {bs: value => value}});
  vm.runInContext(functions.map(node => node.getText(tree)).join('\n'), context);
  const Pager = vm.runInContext(`(class {prefetchedPages = new Map(); ${methods.join('\n')}})`, context);
  return {page: context[page[0].name.text], item: context[item[0].name.text], Pager};
}

function fixture() {
  const turns = Array.from({length: 8}, (_, turn) => ({id: 'turn-' + turn, status: 'completed', items: Array.from({length: 160}, (_, item) => ({id: `${turn}:${item}`, type: item ? 'agentMessage' : 'userMessage', ...(item ? {text: 'x'.repeat(1024)} : {content: [{type: 'text', text: 'Question ' + turn}]})}))}));
  const calls = [];
  let bytes = 0, pending = 0, peak = 0;
  const client = {getConversation: () => null, async sendRequest(method, params) {
    calls.push({method, params: plain(params)});
    const data = method === 'thread/turns/list' ? turns : turns.find(turn => turn.id === params.turnId).items;
    const ordered = params.sortDirection === 'asc' ? data : data.toReversed();
    const start = Number(params.cursor ?? 0), selected = ordered.slice(start, start + (params.limit ?? 5));
    const result = {data: method === 'thread/turns/list' ? selected.map(({items, ...turn}) => ({...turn, items: [], itemsView: 'notLoaded'})) : selected.map(item => ({turnId: params.turnId, item})), nextCursor: start + selected.length < ordered.length ? String(start + selected.length) : null};
    bytes += Buffer.byteLength(JSON.stringify(result));
    if (method === 'thread/items/list' && params.sortDirection === 'desc') peak = Math.max(peak, ++pending);
    await new Promise(resolve => setTimeout(resolve, 1));
    if (method === 'thread/items/list' && params.sortDirection === 'desc') pending--;
    return result;
  }};
  return {client, turns, calls, stats: () => ({bytes, peak})};
}

async function main() {
  const {patchNativeHistory} = await import('./patch-native-history.mjs');
  const before = fs.readFileSync(process.argv[2] || 'scratch/asar/.vite/build/src-BJv5Mk7n.js', 'utf8');
  const after = patchNativeHistory(before);
  assert.equal(patchNativeHistory(after), after);
  const native = load(after), history = fixture();
  const first = await native.page(history.client, 100, {}, 'thread', null, null, 5);
  assert.deepEqual(plain(first.response.data.map(turn => turn.id)), ['turn-7', 'turn-6']);
  assert.equal(first.response.data[0].items.at(-1).id, '7:159');
  assert.equal(first.itemsPaginationByTurnId['turn-7'].openingUserMessageId, '7:0');
  assert(history.stats().peak >= 2, 'Independent latest-turn bodies are fetched concurrently');
  const initial = history.stats();
  if (!before.includes('codexWebOpeningPage')) {
    const old = fixture();
    await load(before).page(old.client, 100, {}, 'thread', null, null, 5);
    assert(initial.bytes < old.stats().bytes / 2, 'The initial payload is reduced on the same supplied history');
  }
  const recovered = new Map();
  let page = first;
  for (;;) {
    for (const turn of page.response.data) {
      const items = [...turn.items];
      let {olderCursor: cursor, hasLoadedOldest: complete} = page.itemsPaginationByTurnId[turn.id];
      while (!complete) {
        const older = await native.item(history.client.sendRequest.bind(history.client), 'thread', turn.id, cursor, undefined, 100);
        items.unshift(...older.items);
        cursor = older.nextCursor;
        complete = cursor == null;
      }
      recovered.set(turn.id, plain(items));
    }
    if (page.response.nextCursor == null) break;
    page = await native.page(history.client, 200, {}, 'thread', page.response.nextCursor, null, 5);
  }
  for (const turn of history.turns) assert.deepEqual(recovered.get(turn.id), turn.items, 'All supplied history remains reachable without omissions or duplicates');
  const metadata = fixture();
  const headers = await native.page(metadata.client, 100, {}, 'thread', null, null, 5, undefined, 'desc', 'notLoaded');
  assert.equal(headers.response.data.length, 5);
  assert.equal(metadata.calls.length, 1);
  const requests = [];
  const pager = new native.Pager();
  pager.policy = {turnMergePolicy: {}};
  pager.client = {isCloudHost: false, getConversation: () => ({historyMode: 'paginated', resumeState: 'resumed', paginatedHistory: {itemsBackwardsCursor: 'snapshot'}, turns: []}), supportsPaginatedThreadHistory: () => true, getConversationTurnItemLimit: () => 100, async sendRequest(method, params) {
    requests.push(params);
    return method === 'thread/turns/list' ? {data: [{id: 'turn', status: 'completed'}], nextCursor: null} : {data: [{turnId: 'turn', item: {id: params.cursor == null ? 'latest' : 'snapshot', type: 'agentMessage', text: 'Answer'}}], nextCursor: null};
  }};
  assert.equal((await pager.listThreadTurns('thread')).response.data[0].items[0].id, 'latest');
  assert.equal((await pager.listThreadTurns('thread', {cursor: 'older'})).response.data[0].items[0].id, 'snapshot');
  const report = {passed: true, boundary: 'native history loader and pagination methods; not full browser resume', beforeSha256: hash(before), candidateSha256: hash(after), initial, all1280ItemsRecovered: true, latestSnapshotVerified: true};
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => {console.error(error.stack); process.exitCode = 1;});
