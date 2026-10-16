import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export function patchBrowserView(source) {
  const from = 'm = document.createElement(`webview`);';
  const to = 'm = document.createElement(`codex-webview`);';
  if (source.includes(to)) return source;
  if (source.split(from).length !== 2) throw Error('Browser host creation changed');
  return source.replace(from, to);
}

export function patchBrowserToolbar(source) {
  if (source.includes('function Oo(e){return null}')) return source;
  const ast=ts.createSourceFile('toolbar.js',source,99,true,ts.ScriptKind.JS);
  const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='Oo');
  if(!node||!node.getText(ast).includes('annotationTarget'))throw Error('Browser annotation toolbar changed');
  return source.slice(0,node.getStart(ast))+'function Oo(e){return null}'+source.slice(node.end);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const root = 'scratch/asar/webview/assets';
  const name = (await fs.readdir(root)).find(name => /^app-initial-.*\.js$/.test(name));
  const file = path.join(root, name);
  await fs.writeFile(file, patchBrowserView(await fs.readFile(file, 'utf8')));
  const toolbar = path.join(root, 'tab-content-24fe1f531bbe.js');
  await fs.writeFile(toolbar, patchBrowserToolbar(await fs.readFile(toolbar, 'utf8')));
}
