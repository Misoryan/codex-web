const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

const work = path.resolve('runtime/chat-loading');
const plain = value => JSON.parse(JSON.stringify(value));
function all(node, predicate, result = []) {
  if (predicate(node)) result.push(node);
  ts.forEachChild(node, child => {all(child, predicate, result);});
  return result;
}
function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}
function one(values, label) {
  assert.equal(values.length, 1, label);
  return values[0];
}
function selector(file) {
  const tree = parse(file);
  let node = one(all(tree, node => ts.isConditionalExpression(node) && node.whenTrue.text === 'unavailable' && node.whenFalse.text === 'empty'), 'unread result selector');
  while (!ts.isArrowFunction(node)) node = node.parent;
  const globals = {};
  for (const id of all(node, ts.isIdentifier)) globals[id.text] = id.text;
  const fn = vm.runInNewContext('(' + node.getText(tree) + ')', globals);
  return pages => fn('work', {get: (_atom, scope) => scope === 'work' ? pages.map((_, index) => index) : pages[scope]});
}
function loader(file) {
  const tree = parse(file);
  const functions = tree.statements.filter(ts.isFunctionDeclaration);
  const page = one(functions.filter(node => node.getText(tree).includes('thread/items/list repeated cursor')), 'conversation page loader');
  const item = one(functions.filter(node => node.getText(tree).includes('thread/items/list returned unchanged cursor')), 'item page loader');
  const opening = one(functions.filter(node => node.parameters.length === 4 && node.getText(tree).includes('oldestUserInput:') && node.getText(tree).includes('openingUserMessageClientId:')), 'opening user message loader');
  const context = vm.createContext({console});
  const lookup = one(all(page, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'getConversation'), 'conversation lookup');
  if (ts.isCallExpression(lookup.arguments[0])) context[lookup.arguments[0].expression.getText(tree)] = value => value;
  for (const node of [item, opening, page]) vm.runInContext(node.getText(tree), context);
  return context[page.name.text];
}
function historyFixture() {
  const turns = Array.from({length: 8}, (_, turn) => ({id: `turn-${turn}`, status: turn === 7 ? 'inProgress' : 'completed', error: null,
    items: Array.from({length: 160}, (_, item) => item === 0
      ? {id: `item-${turn}-${item}`, type: 'userMessage', content: [{type: 'text', text: `Question ${turn}`}]}
      : {id: `item-${turn}-${item}`, type: 'agentMessage', phase: 'commentary', text: `Answer ${turn}:${item} ` + 'x'.repeat(2048)})}));
  const calls = [];
  let bytes = 0, pending = 0, peak = 0, bodies = 0, peakBodies = 0;
  const client = {getConversation: () => null, async sendRequest(method, params) {
    calls.push({method, params: plain(params)});
    assert(['thread/turns/list', 'thread/items/list'].includes(method));
    const data = method === 'thread/turns/list' ? turns : turns.find(turn => turn.id === params.turnId).items;
    const ordered = params.sortDirection === 'asc' ? data : data.toReversed();
    const start = Number(params.cursor ?? 0);
    const slice = ordered.slice(start, start + (params.limit ?? 5));
    const result = {data: method === 'thread/turns/list' ? slice.map(({items, ...turn}) => ({...turn, items: [], itemsView: 'notLoaded'}))
      : slice.map(item => ({turnId: params.turnId, item})), nextCursor: start + slice.length < ordered.length ? String(start + slice.length) : null};
    bytes += Buffer.byteLength(JSON.stringify(result));
    peak = Math.max(peak, ++pending);
    const isBody = method === 'thread/items/list' && params.sortDirection === 'desc';
    if (isBody) peakBodies = Math.max(peakBodies, ++bodies);
    await new Promise(resolve => setTimeout(resolve, 120 + Buffer.byteLength(JSON.stringify(result)) / 1000));
    pending--;
    if (isBody) bodies--;
    return result;
  }};
  return {client, turns, calls, get stats() {return {calls: calls.length, bytes, peak, peakBodies};}};
}
async function measure(fn, itemLimit) {
  const fixture = historyFixture(), start = performance.now();
  const result = await fn(fixture.client, itemLimit, {}, 'selected', null, null, 5);
  return {fixture, result, metrics: {...fixture.stats, durationMs: Math.round(performance.now() - start)}};
}

async function main() {
  fs.mkdirSync(work, {recursive: true});
  const results = [];
  for (const prefix of ['', 'lite/']) {
    const app = path.join('scratch/asar/webview', prefix, 'assets');
    const initial = 'app-initial-6350d04672d0.js', shared = 'app-shared-8bd9d0399038.js';
    const afterState = selector(path.join(app, initial));
    const page = (entries, hasMore = false, isLoading = false) => ({entries, pageState: {hasMore, isLoading}});
    assert.equal(afterState([page([])]), 'empty', 'an exhausted empty read does not report unavailability');
    assert.equal(afterState([page([], true)]), 'unavailable', 'an incomplete or failed read remains visible');
    assert.equal(afterState([page(undefined, true)]), 'unavailable', 'missing materialization remains visible');
    assert.equal(afterState([page([], true, true)]), 'loading', 'an active request keeps its loading state');
    assert.equal(afterState([page([]), page([{threadId: 'valid-unread'}])]), 'empty', 'a successful second host does not produce an unavailable warning');
    const fn = loader(path.join(app, shared));
    const after = await measure(fn, prefix ? 100 : 50);
    const data = plain(after.result.response.data);
    assert.deepEqual(data.map(turn => turn.id), ['turn-7', 'turn-6'], 'the opening contains the two latest turns');
    assert(data[0].items.some(item => item.id === 'item-7-159'), 'the newest output remains in the opening');
    assert.equal(after.result.itemsPaginationByTurnId['turn-7'].openingUserMessageId, 'item-7-0', 'a partial turn retains its opening prompt');
    assert(after.metrics.peakBodies >= 2, 'independent recent turn bodies load in parallel');
    const recovered = new Map();
    const recoverItems = async page => {
      for (const turn of plain(page.response.data)) {
        const items = turn.items;
        let {olderCursor: cursor, hasLoadedOldest: complete} = page.itemsPaginationByTurnId[turn.id];
        while (!complete) {
        const response = await after.fixture.client.sendRequest('thread/items/list', {threadId: 'selected', turnId: turn.id, cursor, limit: 100, sortDirection: 'desc'});
        items.unshift(...response.data.map(entry => entry.item).reverse());
        cursor = response.nextCursor;
        complete = cursor == null;
        }
        recovered.set(turn.id, items);
      }
    };
    await recoverItems(after.result);
    let cursor = after.result.response.nextCursor;
    while (cursor != null) {
      const page = await fn(after.fixture.client, 200, {}, 'selected', cursor, null, 5);
      await recoverItems(page);
      cursor = page.response.nextCursor;
    }
    for (const turn of after.fixture.turns) assert.deepEqual(recovered.get(turn.id), turn.items, 'all earlier turns and item pages remain recoverable');
    const headers = historyFixture();
    const headerPage = await fn(headers.client, 50, {}, 'selected', null, null, 5, undefined, 'desc', 'notLoaded');
    assert.equal(headerPage.response.data.length, 5, 'metadata-only reads keep their existing page size');
    assert.equal(headers.calls.length, 1, 'metadata-only reads do not fetch item bodies');
    results.push({entry: prefix || 'full', passed: true, unreadStates: 5, metrics: after.metrics, allHistoryRecovered: true});
    console.log(JSON.stringify(results.at(-1)));
  }
  fs.writeFileSync(path.join(work, 'loader-tests.json'), JSON.stringify({passed: true, results, fixtureLink: {roundTripMs: 120, bytesPerMs: 1000}}, null, 2));
}
main().catch(error => {console.error(error); process.exitCode = 1;});
