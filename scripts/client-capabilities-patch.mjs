import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/browser/client-capabilities.js', import.meta.url), 'utf8');
const functions = ts.createSourceFile('client.js', source, 99, true, ts.ScriptKind.JS).statements;
const inline = names => functions.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name.text))
  .map(node => node.getText().replace(/^export /, '')).join('\n');

export function patchClientServices(input) {
  if (input.includes('function codexWebClientServices(')) return input;
  const initialization = /([\w$]+)\s*=\s*await\s+([\w$]+)\.services/g;
  if ([...input.matchAll(initialization)].length !== 1) throw Error('App services initialization changed');
  let result = input.replace(initialization, '$1=codexWebClientServices(await $2.services)');
  const tree = ts.createSourceFile('shared.js', result, 99, true, ts.ScriptKind.JS);
  const copy = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.getText(tree).includes('Clipboard write failed'));
  if (!copy) throw Error('Clipboard action changed');
  const text = copy.getText(tree);
  const start = text.indexOf('if (o) {'), end = text.indexOf(' else if (e instanceof Promise)', start);
  if (start < 0 || end < 0 || !text.slice(start, end).includes('clipboard.writeText(n)')) throw Error('Clipboard text branch changed');
  const replacement = text.slice(0, start) + 'if (o) { c = codexWebWriteText(e); }' + text.slice(end);
  result = result.slice(0, copy.getStart(tree)) + replacement + result.slice(copy.end);
  const error = 'id: `clipboard.copyError.description`,\n          defaultMessage: `The content wasn’t copied. Try again while ChatGPT is focused`';
  if (!result.includes(error)) throw Error('Clipboard error message changed');
  result = result.replace(error, 'id: `codexWeb.clipboard.error`,\n          defaultMessage: codexWebClipboardError()');
  return result + '\n' + inline(['codexWebClipboardError', 'codexWebWriteText', 'codexWebClientServices']) + '\n';
}

// Used for static-only deployments against the current built preload.
export function patchClientPreload(input) {
  if (input.includes('function codexWebInstallClientBridge(')) return input;
  const platform = /arch: "arm64",\s*platform: "darwin",\s*versions: \{\s*electron: "41\.2\.0"\s*\}/;
  if (!platform.test(input)) throw Error('Browser process shim changed');
  let result = input.replace(platform, 'platform: codexWebClientPlatform(), versions: {}');
  const menu = 'delete _api.showContextMenu;';
  if (result.split(menu).length !== 2) throw Error('Browser bridge installation changed');
  result = result.replace(menu, menu + '\n codexWebInstallClientBridge(_api);');
  return result + '\n' + inline(['codexWebClientPlatform', 'codexWebInstallClientBridge']) + '\n';
}
