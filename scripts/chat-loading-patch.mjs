import ts from 'typescript';

function visitAll(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  ts.forEachChild(node, child => {visitAll(child, predicate, found);});
  return found;
}

function editFunction(source, marker, edit) {
  const tree = ts.createSourceFile('chat-loading.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.getText(tree).includes(marker));
  if (matches.length !== 1) throw Error('Chat loading function changed: ' + marker);
  const node = matches[0];
  return source.slice(0, node.getStart(tree)) + edit(node, tree) + source.slice(node.end);
}

export function patchUnreadCatalogState(source) {
  const tree = ts.createSourceFile('unread.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const states = visitAll(tree, node => ts.isConditionalExpression(node) && node.whenTrue.text === 'unavailable' && node.whenFalse.text === 'empty');
  if (states.length !== 1) throw Error('Unread catalog state changed');
  let callback = states[0];
  while (callback && !ts.isArrowFunction(callback)) callback = callback.parent;
  if (!callback) throw Error('Unread catalog selector changed');
  if (visitAll(callback, node => ts.isPropertyAccessExpression(node) && node.name.text === 'hasMore').length) return source;
  const empty = visitAll(callback, node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    node.right.text === '0' && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'length' &&
    ts.isPropertyAccessExpression(node.left.expression) && node.left.expression.name.text === 'entries');
  if (empty.length !== 1) throw Error('Unread catalog empty check changed');
  const node = empty[0];
  const page = node.left.expression.expression.getText(tree);
  return source.slice(0, node.getStart(tree)) + `(${node.getText(tree)} && ${page}.pageState.hasMore)` + source.slice(node.end);
}

export function patchConversationOpening(source) {
  return editFunction(source, 'thread/items/list repeated cursor', (node, tree) => {
    if (node.parameters.length !== 12) throw Error('Native conversation opening parameters changed');
    const params = node.parameters.map(parameter => parameter.name.getText(tree));
    const [, itemLimit, , , cursor, , turnLimit, , direction, itemsView, parallel] = params;
    const limits = visitAll(node, child => ts.isCallExpression(child) && child.expression.getText(tree) === 'Math.min' && child.arguments.length === 2 &&
      child.arguments[0].getText(tree).replace(/\s/g, '') === `${turnLimit}??5` && child.arguments[1].text === '2');
    if (limits.length) return node.getText(tree);
    const conditionals = visitAll(node, child => ts.isConditionalExpression(child) && ts.isAwaitExpression(child.whenTrue) &&
      child.whenTrue.expression.expression?.getText(tree) === 'Promise.all' && child.whenFalse.kind === ts.SyntaxKind.NullKeyword);
    if (conditionals.length !== 1) throw Error('Native parallel item loading changed');
    const condition = conditionals[0].condition;
    const start = node.getStart(tree), at = node.body.getStart(tree) + 1;
    let body = node.getText(tree);
    body = body.slice(0, condition.getStart(tree) - start) + `(${parallel} || codexWebOpeningPage${condition.getText(tree) === parallel ? '' : ' || (' + condition.getText(tree) + ')'})` + body.slice(condition.end - start);
    return body.slice(0, at - start) + `
  const codexWebOpeningPage = ${cursor} == null && (${direction} ?? 'desc') === 'desc' && ${itemsView} !== 'notLoaded';
  if (codexWebOpeningPage) {
    ${turnLimit} = Math.min(${turnLimit} ?? 5, 2);
    ${itemLimit} = Math.min(${itemLimit}, 40);
  }
` + body.slice(at - start);
  });
}
