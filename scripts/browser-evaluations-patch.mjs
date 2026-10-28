import fs from 'node:fs/promises';
import ts from 'typescript';

export async function patchBrowserEvaluations(source) {
 if (source.includes('function initializeBrowserStatsig(')) return source;
 const tree=ts.createSourceFile('shared.js',source,99,true,ts.ScriptKind.JS);
 const calls=[];
 function visit(node) {
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)
    &&node.expression.name.text==='initializeAsync')calls.push(node);
  ts.forEachChild(node,visit);
 }
 visit(tree);
 if(calls.length!==1)throw Error('Statsig initialization anchor changed');
 const call=calls[0],client=call.expression.expression.getText(tree);
 let factory=call.parent;
 while(factory&&!ts.isFunctionDeclaration(factory))factory=factory.parent;
 const options=factory?.parameters[1]?.name.getText(tree);
 if(!options||!factory.getText(tree).includes('loadingStatus'))throw Error('Pinned Statsig factory changed');
 source=source.slice(0,call.getStart(tree))+`initializeBrowserStatsig(${client}, ${options}.sdkKey)`+source.slice(call.end);
 const scheduler=(await fs.readFile(new URL('../src/browser/after-startup-paint.js',import.meta.url),'utf8')).replace('export function','function');
 const bootstrap=(await fs.readFile(new URL('../src/browser/browser-statsig-bootstrap.js',import.meta.url),'utf8'))
  .replace("import {afterStartupPaint} from './after-startup-paint.js';",'').replace('export function','function');
 return source+'\n'+scheduler+'\n'+bootstrap;
}
