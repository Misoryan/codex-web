import ts from 'typescript';

export function patchFeatureConfigTransport(source) {
  const tree = ts.createSourceFile('initial.js', source, 99, true, ts.ScriptKind.JS);
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'iQs');
  if (!node?.body || !node.getText(tree).includes('Statsig transport failed')) throw Error('Feature transport anchor changed');
  const at = node.body.getStart(tree) + 1;
  return source.slice(0, at) + `
  const featureUrl = new URL(e);
  if (featureUrl.origin === 'https://ab.chatgpt.com' && featureUrl.pathname === '/v1/initialize') {
    return fetch('/__backend/feature-config' + featureUrl.search, {
      ...t, credentials: 'same-origin', cache: 'no-store',
      headers: {'content-type': 'application/json', ...Object.fromEntries(new Headers(t.headers).entries())},
    });
  }
` + source.slice(at);
}
