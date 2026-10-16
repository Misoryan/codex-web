import ts from 'typescript';

function one(values, label) {
  if (values.length !== 1) throw Error(`Native activity question anchor changed: ${label} (${values.length})`);
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

export function patchActivityQuestionAnswers(source) {
  if (source.includes('activity_question_replies')) return source;
  const tree = ts.createSourceFile('shared.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = tree.statements.filter(ts.isFunctionDeclaration);
  const status = one(descendants(tree, node => ts.isPropertyAssignment(node) && node.name.getText(tree) === 'unansweredAsyncQuestions' && ts.isCallExpression(node.initializer) && ts.isCallExpression(node.initializer.arguments[0])), 'question status');
  const pendingName = status.initializer.expression.getText(tree);
  const pending = one(functions.filter(node => node.name?.text === pendingName), 'pending questions');
  const scans = descendants(pending, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'flatMap');
  if (scans.length !== 2) throw Error('Native question and reply scans changed');
  const questionName = scans[0].arguments[0].getText(tree);
  const replyName = scans[1].arguments[0].getText(tree);
  const hydrate = one(functions.filter(node => node.parameters[0]?.name.getText(tree).includes('hydratedThread:')), 'background history');
  const bindings = new Map(hydrate.parameters[0].name.elements.map(element => [element.propertyName?.getText(tree), element.name.getText(tree)]));
  const response = hydrate.body.statements[0].declarationList?.declarations[0]?.name.getText(tree);
  const returns = hydrate.body.statements.filter(ts.isReturnStatement);
  const at = one(returns, 'background result').getStart(tree);
  if (!response || !['threadId', 'isCloudHost', 'requestClient', 'requestOptions'].every(key => bindings.has(key))) throw Error('Native background history parameters changed');
  const call = `if (!${bindings.get('isCloudHost')}) ${response} = await codexWebActivityQuestionReplies(${response}, ${bindings.get('threadId')}, ${bindings.get('requestClient')}, ${bindings.get('requestOptions')});\n  `;
  const helper = `
async function codexWebActivityQuestionReplies(result, threadId, requestClient, requestOptions) {
  const turn = result.response.data[0];
  const pending = ${pendingName}(turn == null ? null : {...turn, turnId: turn.id});
  if (pending == null) return result;
  const unanswered = new Set(pending.questionIds);
  const sources = new Set(turn.items.filter(item => ${questionName}(item).some(id => unanswered.has(id))).map(item => item.id));
  const items = [];
  let cursor = null;
  // Summary pages can omit accepted replies from a still running turn.
  do {
    const page = await requestClient.sendRequest('thread/items/list', {
      threadId, turnId: turn.id, cursor, limit: 100, sortDirection: 'desc', itemSnapshot: 'latest',
    }, requestOptions ?? {priority: 'background', source: 'activity_question_replies'});
    for (const entry of page.data) {
      const item = entry.item;
      if (item.type === 'agentMessage' || item.type === 'userMessage' || item.type === 'steeringUserMessage') items.push(item);
      for (const id of ${replyName}(item)) unanswered.delete(id);
      sources.delete(item.id);
    }
    cursor = page.nextCursor;
  } while (unanswered.size > 0 && sources.size > 0 && cursor != null);
  const ids = new Set(items.map(item => item.id));
  const refreshed = {...turn, items: [...turn.items.filter(item => !ids.has(item.id)), ...items.reverse()]};
  return {...result, response: {...result.response, data: [refreshed, ...result.response.data.slice(1)]}};
}
`;
  return source.slice(0, at) + call + source.slice(at) + helper;
}
