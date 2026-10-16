import ts from 'typescript';

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
