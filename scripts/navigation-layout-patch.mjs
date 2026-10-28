import ts from 'typescript';

// The self-hosted client ships one navigation layout, independent of rollout.
export function patchNavigationLayout(source) {
  if (source.includes('CODEX_WEB_STABLE_NAVIGATION')) return source;
  const tree = ts.createSourceFile('navigation.js', source, 99, true, ts.ScriptKind.JS);
  const candidates = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments.length === 3) {
      const [, resolve, options] = node.arguments;
      if (ts.isArrowFunction(resolve) && resolve.body.getText(tree).includes('getFeatureGate(') &&
          ts.isObjectLiteralExpression(options) && options.properties.some(p => p.name?.getText(tree) === 'onMount'))
        candidates.push({resolve, options});
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (candidates.length !== 1) throw Error('Native feature gate atom changed');
  const {resolve, options} = candidates[0];
  const snapshot = options.properties.find(p => p.name?.getText(tree) === 'getServerSnapshot')?.initializer;
  const mount = options.properties.find(p => p.name?.getText(tree) === 'onMount')?.initializer;
  if (!ts.isArrowFunction(snapshot) || !ts.isArrowFunction(mount) || !ts.isBlock(mount.body))
    throw Error('Native feature gate lifecycle changed');
  const writes = [];
  function findWrites(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'set' && node.arguments.length === 3) writes.push(node);
    ts.forEachChild(node, findWrites);
  }
  findWrites(mount.body);
  if (writes.length !== 1) throw Error('Native feature gate readiness publication changed');
  const key = resolve.parameters[0].getText(tree), publish = mount.parameters[0].getText(tree);
  const scope = mount.parameters[1].getText(tree), ready = writes[0].arguments[0].getText(tree);
  const changes = [
    {start: resolve.body.getStart(tree), end: resolve.body.end,
      text: `${key} === '3085093835' || (${resolve.body.getText(tree)}) /* CODEX_WEB_STABLE_NAVIGATION */`},
    {start: snapshot.body.getStart(tree), end: snapshot.body.end,
      text: `${snapshot.parameters[0].getText(tree)} === '3085093835'`},
    {start: mount.body.getStart(tree) + 1, end: mount.body.getStart(tree) + 1,
      text: `if (${scope}.key === '3085093835') {${publish}(true); ${scope}.set(${ready}, ${scope}.key, true); return;}`},
  ];
  for (const change of changes.sort((a,b) => b.start - a.start))
    source = source.slice(0, change.start) + change.text + source.slice(change.end);
  return source;
}
