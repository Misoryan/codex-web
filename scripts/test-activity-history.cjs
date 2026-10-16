const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');

async function main() {
  const work = 'runtime/sidebar-stale';
  fs.mkdirSync(work, {recursive: true});
  const assets = path.resolve('scratch/asar/webview');
  const results = [];
  for (const prefix of ['', 'lite/']) {
    const source = fs.readFileSync(path.join(assets, prefix, 'assets/app-shared-8bd9d0399038.js'), 'utf8');
    const tree = ts.createSourceFile('shared.js', source, 99, true, ts.ScriptKind.JS);
    const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.parameters[0]?.name.getText(tree).includes('hydratedThread:'));
    assert.equal(functions.length, 1);
    const fn = functions[0];
    const nativeFunctions = tree.statements.filter(node => ts.isFunctionDeclaration(node) && !node.getText(tree).includes('import.meta'));
    const hydrate = vm.runInNewContext(`${nativeFunctions.map(node => node.getText(tree)).join('\n')}\n${fn.name.text}`);
    const calls = [];
    const older = {id: 'older-turn', status: 'completed', items: [{id: 'older-answer', type: 'agentMessage', text: 'Previous answer'}]};
    const latest = {id: 'latest-turn', status: 'inProgress', items: [{id: 'latest-message', type: 'agentMessage', text: 'Current progress'}]};
    const response = await hydrate({
      hydratedThread: {response: {thread: {id: 'fixture-thread', turns: []}}},
      threadId: 'fixture-thread', maxTurns: 5, isCloudHost: false,
      requestClient: {async sendRequest(method, params) {
        calls.push({method, params});
        return {data: params.itemSnapshot === 'latest' ? [latest, older] : [older], nextCursor: 'older-page'};
      }},
    });
    assert.deepEqual(Array.from(response.response.thread.turns, turn => turn.id), ['older-turn', 'latest-turn'], 'Activity hydration must include current progress from the latest snapshot');
    assert.equal(response.response.thread.turns[1].items[0].text, 'Current progress');
    assert.equal(response.turnsPagination.olderCursor, 'older-page');
    assert.equal(response.turnsPagination.oldestLoadedTurnId, 'older-turn');
    assert.equal(response.turnsPagination.hasLoadedOldest, false);
    assert.equal(calls.length, 1, 'Refreshing the snapshot must not add history round trips');
    assert.equal(calls[0].method, 'thread/turns/list');
    assert.equal(calls[0].params.limit, 5);
    results.push({entry: prefix || 'full', passed: true, sha256: createHash('sha256').update(source).digest('hex'), requests: calls.length});
  }
  const report = {passed: true, boundary: 'native activity history hydration', results};
  fs.writeFileSync(`${work}/history-acceptance.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => {console.error(error); process.exitCode = 1;});
