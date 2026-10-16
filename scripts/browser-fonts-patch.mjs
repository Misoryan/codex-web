import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

export function patchBrowserFonts(source) {
  if (source.includes('window.codexBrowserSystemFonts')) return source;
  const pattern = /([\w$]+)\s*=\s*await\s+([\w$]+)\.services/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw Error('Desktop host service initialization changed');
  const name = matches[0][1];
  return source.replace(pattern, `${name}=await $2.services,${name}=new Proxy(${name},{get(target,key){return key==="systemFonts"?window.codexBrowserSystemFonts:Reflect.get(target,key)}})`);
}

export function patchFontMenu(source) {
  if (source.includes('codexWebFontMenu')) return source;
  const ast = ts.createSourceFile('settings.js', source, 99, true, ts.ScriptKind.JS);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'Wa');
  if (!fn) throw Error('Desktop font selector changed');
  const edits = [];
  const visit = node => {
    if (ts.isIfStatement(node) && node.expression.getText(ast) === 'p' && node.elseStatement?.getText(ast).includes('Ga(e, a)')) {
      edits.push({start: node.getStart(ast), end: node.end, text: `{
        ${node.thenStatement.getText(ast)}
        if (_) j = (0,Y.jsxs)(Y.Fragment, {children: [j, f?.filter(e=>Ga(e,a)).map(e=>(0,Y.jsx)(z.Item, {rightIconAsset:e.family===i?.family?xn:void 0,onSelect:()=>{if(e.family!==i?.family)O(e,e.faces[0]);},children:e.family},e.family))]});
      }`});
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  if (edits.length !== 1) throw Error('Desktop font menu changed');
  const edit = edits[0];
  return 'const codexWebFontMenu = true;\n' + source.slice(0, edit.start) + edit.text + source.slice(edit.end);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = 'scratch/asar/webview/assets/app-shared-8bd9d0399038.js';
  await fs.writeFile(file, patchBrowserFonts(await fs.readFile(file, 'utf8')));
  const settings = 'scratch/asar/webview/assets/general-settings-65e65871cdcd.js';
  await fs.writeFile(settings, patchFontMenu(await fs.readFile(settings, 'utf8')));
}
