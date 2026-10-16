import ts from 'typescript';

function treeFor(source) {
  return ts.createSourceFile('native.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function one(values, label) {
  if (values.length !== 1) throw Error(`Native activity anchor changed: ${label} (${values.length})`);
  return values[0];
}

function descendants(node, predicate) {
  const result = [];
  function visit(node) {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  }
  visit(node);
  return result;
}

function replaceFunction(source, select, marker, replace) {
  if (source.includes(marker)) return source;
  const tree = treeFor(source);
  const fn = one(tree.statements.filter(node => ts.isFunctionDeclaration(node) && select(node, tree)), marker);
  const body = fn.getText(tree);
  if (body.includes(marker)) return source;
  return source.slice(0, fn.getStart(tree)) + replace(body, fn, tree) + source.slice(fn.end);
}

export function patchActivityFreshnessInitial(source) {
  return replaceFunction(source, (node, tree) => node.getText(tree).includes('.hydrateBackgroundThreads(') && node.getText(tree).includes('threadEntry'), 'CODEX_WEB_ACTIVITY_REFRESH', (body, fn, tree) => {
    const call = one(descendants(fn, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'hydrateBackgroundThreads'), 'activity hydration');
    const options = call.arguments[1];
    if (!ts.isObjectLiteralExpression(options) || !options.properties.some(node => node.name?.getText(tree) === 'maxTurns')) throw Error('Native activity hydration options changed');
    if (options.properties.some(node => node.name?.getText(tree) === 'refreshExisting')) return body;
    const at = options.end - fn.getStart(tree) - 1;
    return body.slice(0, at) + ', refreshExisting: true /* CODEX_WEB_ACTIVITY_REFRESH */' + body.slice(at);
  });
}

export function patchActivityFreshnessShared(source) {
  source = replaceFunction(source, (node, tree) => node.parameters[0]?.name.getText(tree).includes('hydratedThread:'), 'CODEX_WEB_ACTIVITY_LATEST', (body, fn, tree) => {
    const call = one(descendants(fn, node => ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === 'thread/turns/list'), 'activity history');
    const options = call.arguments[1];
    if (!ts.isObjectLiteralExpression(options)) throw Error('Native activity history options changed');
    if (options.properties.some(node => node.name?.getText(tree) === 'itemSnapshot')) return body;
    const at = options.end - fn.getStart(tree) - 1;
    const comma = options.properties.hasTrailingComma ? '' : ',';
    return body.slice(0, at) + comma + ' itemSnapshot: `latest` /* CODEX_WEB_ACTIVITY_LATEST */' + body.slice(at);
  });
  if (source.includes('CODEX_WEB_CURRENT_QUESTIONS')) return source;
  const tree = treeFor(source);
  const status = one(descendants(tree, node => ts.isPropertyAssignment(node) && node.name.getText(tree) === 'unansweredAsyncQuestions' && ts.isCallExpression(node.initializer) && ts.isCallExpression(node.initializer.arguments[0])), 'async question status');
  const name = status.initializer.arguments[0].expression.getText(tree);
  return replaceFunction(source, node => node.name?.text === name, 'CODEX_WEB_CURRENT_QUESTIONS', (body, fn, tree) => {
    const initializer = fn.body.statements[0].declarationList?.declarations[0]?.initializer;
    if (ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression) && initializer.expression.name.text === 'at') return body;
    const history = fn.body.statements[0].declarationList?.declarations[0]?.initializer?.getText(tree);
    if (!history || !ts.isCallExpression(fn.body.statements[0].declarationList.declarations[0].initializer)) throw Error('Native question history selector changed');
    return `function ${name}(${fn.parameters[0].name.getText(tree)}) {
  // CODEX_WEB_CURRENT_QUESTIONS: older interrupted snapshots cannot request input for the current turn.
  let latest = ${history}.at(-1);
  return latest?.status === \`inProgress\` ? latest : null;
}`;
  });
}
