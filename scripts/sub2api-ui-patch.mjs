import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const profile = {displayName: 'Codex', isProfileAvailable: false, profileImageUrl: null};

export async function patchSub2ApiTrigger(source) {
  if (source.includes('CODEX_SUB2API_TRIGGER')) return source;
  const ast = ts.createSourceFile('initial.js', source, 99, true, ts.ScriptKind.JS);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'iPo');
  if (!fn) throw Error('Desktop profile trigger changed');
  let body = fn.getText(ast);
  for (const [from,to] of [
    ['let De = Ee,','let De = codexWebSavedProfile,'],
    ['let ke = Oe,','let ke = codexWebSavedProfile,'],
    ['ke == null || j','ke == null'],
    ['src: ce ? null : me,','src: codexWebSavedProfile.profileImageUrl,'],
    ['ce = !1;','ce = !1;'],
  ]) {
    if (body.split(from).length !== 2) throw Error('Profile trigger anchor changed: '+from);
    body=body.replace(from,to);
  }
  return source.slice(0,fn.getStart(ast))+body+source.slice(fn.end)+`\n/* CODEX_SUB2API_TRIGGER */\nvar codexWebSavedProfile=${JSON.stringify(profile)};\n`;
}

export async function patchSub2ApiUsage(source) {
  if (source.includes('CODEX_SUB2API_USAGE_START')) return source.replace('personalPlanLabel: n.modelProviderName,', 'personalPlanLabel: null,');
  const ast = ts.createSourceFile('profile.js', source, 99, true, ts.ScriptKind.JS);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'Yi');
  if (!fn) throw Error('Desktop profile menu changed');
  let body = fn.getText(ast);
  const once = (from, to) => {
    if (body.split(from).length !== 2) throw Error('Desktop profile anchor changed: ' + from);
    body = body.replace(from, to);
  };
  once('let e = n.profileIdentity,', 'let e = codexSub2ApiProfile,');
  once('e == null || R', 'e == null');
  once('src: Kt,', 'src: codexSub2ApiProfile.profileImageUrl,');
  once('accountIcon: o,', 'accountIcon: (0,$.jsx)(En,{alt:``,name:codexSub2ApiProfile.displayName,size:`xs`,src:codexSub2ApiProfile.profileImageUrl}),');
  once('displayName: v,', 'displayName: codexSub2ApiProfile.displayName,');
  once('identityItems: y,', 'identityItems: null,');
  once('personalPlanLabel: d,', 'personalPlanLabel: null,');
  once('usageItems: k,', 'usageItems: (0,$.jsx)(CodexSub2ApiUsage,{active:a}),');
  once('let ir = !l && Hn,', 'let ir = (0,$.jsx)(CodexSub2ApiUsage,{active:a}),');
  source = source.slice(0,fn.getStart(ast)) + body + source.slice(fn.end);
  const component = (await fs.readFile(new URL('../src/browser/sub2api-usage.js',import.meta.url),'utf8')).replace('export function createSub2ApiUsage','function createSub2ApiUsage');
  return `import CodexUsageIcon from './gauge-BbF64vwF-3da22a60689a.js';\nimport {KT as CodexDisclosure} from './app-shared-8bd9d0399038.js';\n` + source + `
/* CODEX_SUB2API_USAGE_START */
var codexSub2ApiProfile=${JSON.stringify(profile)};
${component}
var codexSub2ApiComponent;
function CodexSub2ApiUsage(props) {
  codexSub2ApiComponent ??= createSub2ApiUsage(na, q, CodexDisclosure, CodexUsageIcon);
  return na.createElement(codexSub2ApiComponent,props);
}
/* CODEX_SUB2API_USAGE_END */
`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.resolve(process.argv[2] ?? 'scratch/asar/webview/assets/profile-dropdown-items-d842ad78cd70.js');
  await fs.writeFile(file, await patchSub2ApiUsage(await fs.readFile(file,'utf8')));
}
