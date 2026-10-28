const assert = require('node:assert/strict');
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const {MessageChannel} = require('node:worker_threads');
const http = require('node:http');
const ts = require('typescript');

const hostFile = 'scratch/asar/.vite/build/src-BJv5Mk7n.js';
const rpcFile = 'scratch/asar/.vite/build/startup-requirements-C6B1x9gL.js';

function loadNative(source) {
  const bundledRpc = fs.readFileSync(rpcFile, 'utf8');
  const start = bundledRpc.indexOf('(Symbol.dispose');
  const end = bundledRpc.indexOf('var ut = D,', start);
  assert(start > 0 && end > start, 'Pinned native MessagePort RPC implementation must exist');
  // Execute the bundled serializer, stubs, sessions and native MessagePort
  // transport together. No fake transport or replacement serializer is used.
  const rpc = new Function(`const ce = Symbol('isolated-rpc');
    ${bundledRpc.slice(start, end)}
    return {RpcTarget: b, session: (port, main) => new qe(new Ye(port), main)};`)();
  const tree = ts.createSourceFile('native.js', source, 99, true, ts.ScriptKind.JS);
  let subscription;
  function visit(node) {
    if (ts.isClassExpression(node) && node.members.some(member =>
      ts.isMethodDeclaration(member) && member.name.getText(tree) === 'subscribeConversation'))
      subscription = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert(subscription, 'Pinned native subscription boundary must exist');
  const helpers = tree.statements.filter(node => ts.isFunctionDeclaration(node) &&
    ['bo', 'vo'].includes(node.name?.text)).map(node => node.getText(tree)).join('\n');
  const Subscription = new Function('s', `${helpers}; return (${subscription});`)({Pt: rpc.RpcTarget});
  return {rpc, Subscription};
}

async function child(mode, scenario) {
  const {patchNativeRpcSubscriptions} = await import('./native-rpc-subscription-patch.mjs');
  const before = fs.readFileSync(hostFile, 'utf8');
  const after = patchNativeRpcSubscriptions(before);
  assert.equal(patchNativeRpcSubscriptions(after), after, 'Patch is idempotent');
  const {rpc, Subscription} = loadNative(mode === 'before' ? before : after);
  const channel = new MessageChannel(), delivered = [];
  let deliveredResolve;
  const deliveredPromise = new Promise(resolve => {deliveredResolve = resolve;});
  const serverSession = rpc.session(channel.port1, value => {
    delivered.push(value);
    if (value === 'healthy-after-rejection') deliveredResolve();
  });
  const clientSession = rpc.session(channel.port2);
  const serverStub = serverSession.getRemoteMain();
  const callback = clientSession.getRemoteMain();
  const beforeStats = clientSession.getStats();
  let emit, cleaned = 0;
  let invalid;
  if (scenario === 'cycle' || scenario === 'initial') {
    invalid = {exportedCallback: () => 'temporary capability', privatePayload: 'must-not-be-logged'};
    invalid.self = invalid;
  } else if (scenario === 'depth') {
    invalid = {privatePayload: 'must-not-be-logged'};
    for (let i = 0; i < 256; i++) invalid = {child: invalid};
  } else invalid = Symbol('must-not-be-logged');
  const subscription = Subscription.subscribe(callback, listener => {
    emit = listener;
    if (scenario === 'initial') listener(invalid);
    return () => { cleaned++; };
  });
  const healthy = Subscription.subscribe(callback, listener => {
    globalThis.emitHealthy = listener;
    return () => {};
  });
  // Emit from a real asynchronous event boundary, where an uncaught exception
  // terminates Node. The assertions after this point cannot run on the defect.
  await new Promise(resolve => setImmediate(() => {
    if (scenario !== 'initial') emit(invalid);
    resolve();
  }));
  assert.equal(cleaned, 1, 'Only the rejected subscription must unsubscribe');
  assert.deepEqual(clientSession.getStats(), beforeStats,
    'Rejected serialization must release any capabilities exported before the cycle');
  for (let i = 0; i < 100; i++) emit('must-not-deliver-after-unsubscribe');
  globalThis.emitHealthy('healthy-after-rejection');
  await Promise.race([deliveredPromise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error('Healthy subscription stopped delivering')), 1000);
    timer.unref();
  })]);
  assert.deepEqual(delivered, ['healthy-after-rejection']);
  subscription.unsubscribe();
  assert.equal(cleaned, 1, 'Cleanup must run exactly once, including synchronous initial emissions');
  assert.throws(() => Subscription.subscribe(callback, () => { throw Error('registration failed'); }),
    /registration failed/, 'Registration failures must still reach their caller');
  const server = http.createServer((_request, response) => response.end('alive-after-rpc-rejection'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'alive-after-rpc-rejection');
  } finally {
    await new Promise(resolve => server.close(resolve));
    healthy.unsubscribe();
    callback[Symbol.dispose]();
    serverStub[Symbol.dispose]();
    channel.port1.close();
    channel.port2.close();
  }
  process.stdout.write('RPC_SUBSCRIPTION_ISOLATED');
}

(async () => {
  if (process.argv[2] === '--child') return child(process.argv[3], process.argv[4]);
  function run(mode, scenario) {
    const result = spawnSync(process.execPath, [__filename, '--child', mode, scenario], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    assert.ifError(result.error);
    return result;
  }
  if (!fs.readFileSync(hostFile, 'utf8').includes('codexWebSubscriptionFaultBoundary')) {
    const baseline = run('before', 'cycle');
    assert.notEqual(baseline.status, 0, 'The unpatched native callback must reproduce the process crash');
    assert.match(baseline.stderr, /Serialization exceeded maximum allowed depth/);
    assert(!baseline.stdout.includes('RPC_SUBSCRIPTION_ISOLATED'));
  }
  for (const scenario of ['cycle', 'depth', 'initial', 'unsupported']) {
    const result = run('after', scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RPC_SUBSCRIPTION_ISOLATED/);
    assert.match(result.stderr, /\[native-rpc\] subscription delivery failed/);
    assert.equal(result.stderr.match(/\[native-rpc\] subscription delivery failed/g).length, 1,
      'A stopped subscription must not retry or log on subsequent source emissions');
    assert.match(result.stderr, scenario === 'unsupported' ? /delivery_failed/ : /serialization_depth/);
    assert(!result.stderr.includes('must-not-be-logged'), 'Diagnostics must exclude notification payloads');
  }
  console.log('PASS: real native RPC rejects cyclic/deep/unsupported notifications, releases only the failing subscription and preserves healthy delivery and HTTP.');
})().catch(error => { console.error(error); process.exitCode = 1; });
