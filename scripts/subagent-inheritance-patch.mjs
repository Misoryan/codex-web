import ts from 'typescript';

const parentIdsProperty = 'codexWebParentTurnIds';
const parentIdsAtom = 'codexWebSubagentParentTurnIdsAtom';

function fail(message) {
  throw Error('Subagent inheritance patch: ' + message);
}

function one(values, label) {
  if (values.length !== 1) fail(`${label}: expected one match, found ${values.length}`);
  return values[0];
}

function propertyName(node) {
  return node.propertyName?.text ?? node.name?.text;
}

function binding(pattern, property) {
  const node = one(pattern.elements.filter(element => propertyName(element) === property), property);
  if (!ts.isIdentifier(node.name)) fail(`${property} binding changed`);
  return node.name.text;
}

function unwrap(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

export function patchSubagentInheritance(source) {
  const ast = ts.createSourceFile('app-initial.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) fail('input has syntax errors');
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);

  const render = one(nodes.filter(node =>
    ts.isFunctionDeclaration(node) && node.name && node.body &&
    node.parameters.length === 1 && ts.isObjectBindingPattern(node.parameters[0].name) &&
    ['conversationTurns', 'inheritedHistoryPositionKeys', 'parentConversationTurns', 'historyEntriesByTurnIndex']
      .every(name => node.parameters[0].name.elements.some(element => propertyName(element) === name))
  ), 'native visible-turn renderer');
  const parameter = render.parameters[0].name;
  const renderCall = one(nodes.filter(node =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === render.name.text && node.arguments.length === 1 &&
    ts.isObjectLiteralExpression(node.arguments[0]) && (()=>{let p=node.parent;while(p&&!ts.isArrowFunction(p)&&!ts.isFunctionDeclaration(p))p=p.parent;return p&&ts.isArrowFunction(p)})()
  ), 'native visible-turn selector call');
  const argument = renderCall.arguments[0];
  const patchedBinding = parameter.elements.some(element => propertyName(element) === parentIdsProperty);
  const patchedProperty = argument.properties.some(property => propertyName(property) === parentIdsProperty);
  if (patchedBinding || patchedProperty) {
    if (!patchedBinding || !patchedProperty) fail('partially patched renderer');
    const renderText = render.getText(ast);
    if (!renderText.includes('.positionKey') || !renderText.includes('.turnId') || !renderText.includes('new Set')) {
      fail('patched renderer changed');
    }
    return source;
  }
  if (source.includes(parentIdsAtom)) fail('unexpected existing parent-id selector');

  let selector = renderCall.parent;
  while (selector && !ts.isArrowFunction(selector)) selector = selector.parent;
  if (!selector || selector.parameters.length !== 2 ||
      !ts.isObjectBindingPattern(selector.parameters[0].name) ||
      !ts.isObjectBindingPattern(selector.parameters[1].name)) fail('visible-turn selector signature changed');
  const conversationId = binding(selector.parameters[0].name, 'conversationId');
  const get = binding(selector.parameters[1].name, 'get');

  const requests = one(argument.properties.filter(property =>
    ts.isPropertyAssignment(property) && propertyName(property) === 'conversationRequests'
  ), 'conversation request input');
  if (!ts.isIdentifier(requests.initializer)) fail('conversation request input changed');
  if (!ts.isBlock(selector.body)) fail('visible-turn selector body changed');
  const requestVariable = one(selector.body.statements
    .filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .filter(node => ts.isIdentifier(node.name) && node.name.text === requests.initializer.text),
  'conversation request selector binding');
  let requestRead = unwrap(requestVariable.initializer);
  if (ts.isBinaryExpression(requestRead) && requestRead.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    requestRead = unwrap(requestRead.left);
  }
  if (!ts.isCallExpression(requestRead) || requestRead.expression.getText(ast) !== get ||
      requestRead.arguments.length !== 2 || !ts.isIdentifier(requestRead.arguments[0])) {
    fail('conversation request selector read changed');
  }
  const requestAtomName = requestRead.arguments[0].text;
  if(requestAtomName!=='zCe')fail('conversation request selector changed');

  let selectorAssignment = selector.parent;
  while (selectorAssignment && !(ts.isBinaryExpression(selectorAssignment) &&
      selectorAssignment.operatorToken.kind === ts.SyntaxKind.EqualsToken)) selectorAssignment = selectorAssignment.parent;
  if (!selectorAssignment || !ts.isIdentifier(selectorAssignment.left)) fail('visible-turn selector initialization changed');

  const turns = binding(parameter, 'conversationTurns');
  const positions = binding(parameter, 'inheritedHistoryPositionKeys');
  const entries = binding(parameter, 'historyEntriesByTurnIndex');
  const parentTurns = binding(parameter, 'parentConversationTurns');
  const inheritedBody = `
  if (codexWebParentTurnIds?.length) {
    const codexWebParentIds = new Set(codexWebParentTurnIds);
    if (${positions} != null) {
      ${positions} = new Set(${positions});
      for (let codexWebIndex = 0; codexWebIndex < ${turns}.length; codexWebIndex++) {
        const codexWebEntry = ${entries}?.[codexWebIndex];
        if (codexWebEntry != null && codexWebParentIds.has(${turns}[codexWebIndex].turnId)) {
          ${positions}.add(codexWebEntry.positionKey);
        }
      }
    } else {
      ${parentTurns} = [...${parentTurns}, ...${turns}
        .filter(turn => codexWebParentIds.has(turn.turnId))
        .map(turn => ({turnId: turn.turnId, items: []}))];
    }
  }
`;
  const edits = [
    {at: parameter.getStart(ast) + 1, text: 'codexWebParentTurnIds,'},
    {at: render.body.getStart(ast) + 1, text: inheritedBody},
    {at: argument.getStart(ast) + 1, text: `${parentIdsProperty}:${get}(${parentIdsAtom},${conversationId}),`},
    {at: selectorAssignment.getStart(ast), text: `(${parentIdsAtom}=codexWebConversationField(conversation=>conversation.codexWebSubagentPreview===true?conversation.codexWebParentTurnIds:void 0),`},
    {at: selectorAssignment.end, text: ')'},
    {at: source.length, text: `\nvar ${parentIdsAtom};\n`},
    {at: 0, text: `import {codexWebConversationField} from './app-shared-8bd9d0399038.js';\n`},
  ];
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    source = source.slice(0, edit.at) + edit.text + source.slice(edit.at);
  }
  const result = ts.createSourceFile('app-initial.js', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  if (result.parseDiagnostics.length) fail('patch produced syntax errors');
  return source;
}
