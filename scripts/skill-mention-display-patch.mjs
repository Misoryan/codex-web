import ts from 'typescript';

// Serialized Windows skill links can contain repeated separators. Compare the
// same path representation so the native chip can use interface.displayName.
export function patchSkillMentionDisplay(source) {
  if (source.includes('CODEX_WEB_SKILL_DISPLAY_PATH')) return source;
  const tree = ts.createSourceFile('skills.js', source, 99, true, ts.ScriptKind.JS);
  const components = tree.statements.filter(node => ts.isFunctionDeclaration(node) &&
    node.body?.getText(tree).includes('resolvedDisplayLabel:') &&
    node.body.getText(tree).includes('serializedPromptLinkLabel:') &&
    node.body.getText(tree).includes('.filter('));
  if (components.length !== 1) throw Error('Native skill mention component changed');
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(components[0]);
  const pathCalls = calls.filter(node => node.arguments.length === 1 &&
    ts.isPropertyAccessExpression(node.arguments[0]) && node.arguments[0].name.text === 'path');
  if (pathCalls.length !== 1) throw Error('Native skill path comparison changed');
  const normalize = pathCalls[0].expression.getText(tree);
  const matches = calls.filter(node => node.expression.getText(tree) === normalize);
  if (matches.length !== 2) throw Error('Native skill path normalization changed');
  for (const node of matches.sort((a, b) => b.end - a.end)) {
    source = source.slice(0, node.end) +
      '.replace(/([^/])\\/{2,}/g, "$1/") /* CODEX_WEB_SKILL_DISPLAY_PATH */' + source.slice(node.end);
  }
  return source;
}
