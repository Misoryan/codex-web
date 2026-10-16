import ts from 'typescript';

export function patchLatestHistoryTail(source) {
  if (source.includes('CODEX_WEB_LATEST_TAIL')) return source;
  const tree = ts.createSourceFile('shared.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const methods = [];
  const snapshotPages = [];
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(tree) === 'listThreadTurns' && node.getText(tree).includes('this.prefetchedPages.get')) methods.push(node);
    if (ts.isCallExpression(node) && node.arguments[4]?.getText(tree).endsWith('.turnsBackwardsCursor') && node.arguments[5]?.getText(tree).endsWith('.itemsBackwardsCursor')) snapshotPages.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (methods.length !== 1) throw Error('Native history pagination entry changed');
  if (snapshotPages.length !== 1) throw Error('Native initial snapshot history entry changed');
  const method = methods[0];
  const options = method.parameters[1].name.getText(tree);
  const at = method.body.getStart(tree) + 1;
  const policy = `
    // CODEX_WEB_LATEST_TAIL: an initial page reads the current head. Older
    // pages keep their cursor so their existing history boundary stays stable.
    if (${options}.cursor == null && (${options}.sortDirection ?? 'desc') === 'desc' && ${options}.itemSnapshot == null)
      ${options} = {...${options}, itemSnapshot: 'latest'};
`;
  const page = snapshotPages[0];
  const edits = [
    {start: at, end: at, text: policy},
    {start: page.arguments[4].getStart(tree), end: page.arguments[4].end, text: 'null'},
    {start: page.arguments[5].getStart(tree), end: page.arguments[5].end, text: 'null'},
  ];
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}
