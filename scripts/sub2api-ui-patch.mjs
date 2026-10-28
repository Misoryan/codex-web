import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

export async function patchSub2ApiTrigger(source) {
  if (source.includes('CODEX_SUB2API_TRIGGER')) return source;
  const ast = ts.createSourceFile('initial.js', source, 99, true, ts.ScriptKind.JS);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'iPo');
  if (!fn) throw Error('Desktop profile trigger changed');
  let body = fn.getText(ast);
  for (const [from,to] of [
    ['let De = Ee,','let De = codexWebSavedProfile,'],
    ['let ke = Oe,','let ke = De,'],
    ['ke == null || j','ke == null'],
    ['src: ce ? null : me,','src: ke?.profileImageUrl,'],
  ]) {
    if (body.split(from).length !== 2) throw Error('Profile trigger anchor changed: '+from);
    body=body.replace(from,to);
  }
  body = body.replace('function iPo(e) {', 'function iPo(e) {\n  let codexWebSavedProfile = codexWebUsePlatformProfile();');
  const hook = (await fs.readFile(new URL('../src/browser/profile-identity.js',import.meta.url),'utf8')).replace('export function createPlatformProfileHook','function createPlatformProfileHook');
  return source.slice(0,fn.getStart(ast))+body+source.slice(fn.end)+`\n/* CODEX_SUB2API_TRIGGER */\n${hook}\nvar codexWebPlatformProfileHook;\nfunction codexWebUsePlatformProfile() {\n  codexWebPlatformProfileHook ??= createPlatformProfileHook(cPo);\n  return codexWebPlatformProfileHook();\n}\n`;
}

export async function patchSub2ApiUsage(source) {
  const component = (await fs.readFile(new URL('../src/browser/sub2api-usage.js',import.meta.url),'utf8')).replace('export function createSub2ApiUsage','function createSub2ApiUsage');
  const extension = `/* CODEX_SUB2API_USAGE_START */
${component}
var codexSub2ApiComponent;
function CodexSub2ApiUsage(props) {
  codexSub2ApiComponent ??= createSub2ApiUsage(na, q, CodexDisclosure, CodexUsageIcon);
  return na.createElement(codexSub2ApiComponent,props);
}
/* CODEX_SUB2API_USAGE_END */`;
  if (source.includes('CODEX_SUB2API_USAGE_START')) {
    const block = /\/\* CODEX_SUB2API_USAGE_START \*\/[\s\S]*?\/\* CODEX_SUB2API_USAGE_END \*\//g;
    if ([...source.matchAll(block)].length !== 1) throw Error('Usage component markers changed');
    const usages = /\(CodexSub2ApiUsage,\{[^{}]*\}\)/g;
    if ([...source.matchAll(usages)].length !== 2) throw Error('Usage menu adapters changed');
    return source.replace(block, () => extension).replace(usages, '(CodexSub2ApiUsage,{})');
  }
  const ast = ts.createSourceFile('profile.js', source, 99, true, ts.ScriptKind.JS);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'Yi');
  if (!fn) throw Error('Desktop profile menu changed');
  let body = fn.getText(ast);
  const once = (from, to) => {
    if (body.split(from).length !== 2) throw Error('Desktop profile anchor changed: ' + from);
    body = body.replace(from, to);
  };
  once('e == null || R', 'e == null');
  once('src: Kt,', 'src: e.profileImageUrl,');
  once('identityItems: y,', 'identityItems: null,');
  once('personalPlanLabel: d,', 'personalPlanLabel: null,');
  once('usageItems: k,', 'usageItems: (0,$.jsx)(CodexSub2ApiUsage,{}),');
  once('let ir = !l && Hn,', 'let ir = (0,$.jsx)(CodexSub2ApiUsage,{}),');
  source = source.slice(0,fn.getStart(ast)) + body + source.slice(fn.end);
  const layout = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'Wi');
  if (!layout) throw Error('Desktop profile menu layout changed');
  let layoutBody = layout.getText(ast);
  for (const [from, to] of [['let C = S,', 'let C = null,'], ['SubText: k,', 'SubText: null,']]) {
    if (layoutBody.split(from).length !== 2) throw Error('Desktop profile identity anchor changed: ' + from);
    layoutBody = layoutBody.replace(from, to);
  }
  source = source.slice(0,layout.getStart(ast)) + layoutBody + source.slice(layout.end);
  return `import CodexUsageIcon from './gauge-BbF64vwF-3da22a60689a.js';\nimport {KT as CodexDisclosure} from './app-shared-8bd9d0399038.js';\n` + source + '\n' + extension + '\n';
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.resolve(process.argv[2] ?? 'scratch/asar/webview/assets/profile-dropdown-items-d842ad78cd70.js');
  await fs.writeFile(file, await patchSub2ApiUsage(await fs.readFile(file,'utf8')));
}
