import fs from 'node:fs/promises';
import ts from 'typescript';

export async function patchStartupWork(source) {
 const tree = ts.createSourceFile('initial.js', source, 99, true, ts.ScriptKind.JS);
 const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'rml');
 if (!node || !node.getText(tree).includes('Qpl();')) throw Error('Audio warmup anchor changed');
 const body = node.getText(tree).replace('window.setTimeout(() => {', 'afterStartupPaint(() => {').replace('}, 0)', '})');
 source = source.slice(0, node.getStart(tree)) + body + source.slice(node.end);
 const anchor = '(document.documentElement.lang = S),';
 if (source.split(anchor).length !== 2) throw Error('Locale publication anchor changed');
 source = source.replace(anchor, anchor + '\n          (() => {try {localStorage.setItem("codex-preload-locale", S);} catch {}})(),');
 return source + '\n' + (await fs.readFile(new URL('../src/browser/after-startup-paint.js', import.meta.url), 'utf8')).replace('export function', 'function');
}
