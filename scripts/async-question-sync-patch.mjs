import ts from 'typescript';

export function patchAsyncQuestionGroups(source) {
  if (source.includes('function codexWebLatestAsyncQuestion(')) return source;
  const tree = ts.createSourceFile('shared.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = tree.statements.filter(ts.isFunctionDeclaration);
  const matches = (node, predicate) => {
    const result = [];
    const visit = child => {
      if (predicate(child)) result.push(child);
      ts.forEachChild(child, visit);
    };
    visit(node);
    return result;
  };
  const one = (values, label) => {
    if (values.length !== 1) throw Error(`Native async question group changed: ${label} (${values.length})`);
    return values[0];
  };
  const status = one(matches(tree, node => ts.isPropertyAssignment(node) && node.name.getText(tree) === 'unansweredAsyncQuestions' && ts.isCallExpression(node.initializer)), 'status');
  const pending = one(functions.filter(fn => fn.name.text === status.initializer.expression.getText(tree)), 'pending');
  const scans = matches(pending, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'flatMap');
  if (scans.length === 1 && functions.some(fn => {
    const statement = fn.body.statements[0];
    return fn.body.statements.length === 1 && ts.isReturnStatement(statement) &&
      ts.isCallExpression(statement.expression) && ts.isPropertyAccessExpression(statement.expression.expression) &&
      statement.expression.expression.name.text === 'findLast' &&
      matches(pending, node => ts.isCallExpression(node) && node.expression.getText(tree) === fn.name.text).length === 1;
  })) return source;
  if (scans.length !== 2) throw Error('Native pending question scans changed');
  const scan = scans[0];
  if (!scan || !ts.isIdentifier(scan.arguments[0])) throw Error('Native pending question scan changed');
  const projection = one(functions.filter(fn => /sourceItemId\s*:/.test(fn.getText(tree)) && /questionIndex\s*:/.test(fn.getText(tree)) && fn.body.statements.length === 1), 'question projection');
  const collector = one(functions.filter(fn => {
    const statement = fn.body.statements[0];
    return fn.body.statements.length === 1 && ts.isReturnStatement(statement) &&
      ts.isCallExpression(statement.expression) && ts.isPropertyAccessExpression(statement.expression.expression) &&
      statement.expression.expression.name.text === 'flatMap' &&
      matches(fn, node => ts.isCallExpression(node) && node.expression.getText(tree) === projection.name.text).length === 1;
  }), 'question collector');
  const condition = one(matches(collector, ts.isConditionalExpression), 'question predicate').condition;
  if (!ts.isCallExpression(condition)) throw Error('Native question predicate changed');
  const edits = [
    {start: scan.getStart(tree), end: scan.end, body: `${scan.arguments[0].getText(tree)}(codexWebLatestAsyncQuestion(${pending.parameters[0].name.getText(tree)}.items))`},
    {start: collector.getStart(tree), end: collector.end, body: `function ${collector.name.text}(items) {
  const latest = codexWebLatestAsyncQuestion(items);
  return latest == null ? [] : ${projection.name.text}(latest);
}`},
  ];
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.body + source.slice(edit.end);
  }
  return source + `
function codexWebLatestAsyncQuestion(items) {
  // A later request replaces the earlier question group in the same turn.
  return items.findLast(${condition.expression.getText(tree)});
}
`;
}

export function patchAsyncQuestionSync(source) {
  const tree = ts.createSourceFile('initial.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'mIt');
  if (!fn) throw Error('Native async question reconciliation changed');
  let body = fn.getText(tree);
  if (body.includes('CODEX_WEB_QUESTION_SYNC')) return source;
  const filter = 's.questionIds.filter((e) => n.includes(e))';
  const clear = ': HS(e, o, null);';
  if (body.split(filter).length !== 2 || body.split(clear).length !== 2) throw Error('Native async question selection changed');
  body = body.replace(filter, 's.questionIds.filter((e) => n.includes(e) && !i.has(e)) /* CODEX_WEB_QUESTION_SYNC */');
  body = body.replace(clear, `: HS(e, o, t.length === 0 ? null : {
            ...s,
            questionIds: t,
            selectedQuestionKey: {...s.selectedQuestionKey, itemId: t[0]},
          });`);
  return source.slice(0, fn.getStart(tree)) + body + source.slice(fn.end);
}
