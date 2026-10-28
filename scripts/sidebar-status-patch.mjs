import fs from 'node:fs/promises';
import ts from 'typescript';
export async function patchSidebarStatus(source){
  if(source.includes('[sidebar-status] Could not read task metadata (runtime-v7)'))return source;
  const rpcPattern=/([\w$]+)\.rpc\.subscribe\(\{\s*type:\s*[`"]thread[`"],\s*key:\s*([\w$]+),\s*field:\s*[`"]listState[`"],\s*listener:\s*([\w$]+),?\s*\}\)/g;
  const rpcMatches=[...source.matchAll(rpcPattern)];
  if(rpcMatches.length!==1)throw Error('Sidebar RPC list state subscription anchor changed');
  const nativeTree=ts.createSourceFile('native.js',source,99,true,ts.ScriptKind.JS);
  const factory=nativeTree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.getStart(nativeTree)<=rpcMatches[0].index&&node.end>rpcMatches[0].index);
  if(!factory)throw Error('Sidebar list state factory changed');
  const listPattern=/(?<![\w$.])([\w$]+)\.subscribe\(\{\s*type:\s*[`"]thread[`"],\s*key:\s*([\w$]+),\s*field:\s*[`"]listState[`"],\s*listener:\s*([\w$]+),?\s*\}\)/g;
  const listMatches=[...source.matchAll(listPattern)].filter(match=>match.index>=factory.getStart(nativeTree)&&match.index<factory.end);
  if(listMatches.length!==1)throw Error('Sidebar list state subscription anchor changed: '+listMatches.length);
  const local=listMatches[0];
  source=source.slice(0,local.index)+`subscribeSidebarListState(${local[1]},${local[2]},${local[3]})`+source.slice(local.index+local[0].length);
  source=source.replace(rpcPattern,(_,client,key,listener)=>`subscribeSidebarRpcListState(${client},${key},${listener})`);
  const helper=await fs.readFile(new URL('../src/browser/sidebar-status.js',import.meta.url),'utf8');
  if(source.includes('[sidebar-status]')){
    const tree=ts.createSourceFile('native.js',source,99,true,ts.ScriptKind.JS);
    const functions=tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.getText(tree).includes('[sidebar-status]'));
    if(functions.length!==1)throw Error('Sidebar hydration function changed: '+functions.length);
    const fn=functions[0];
    if(!fn)throw Error('Sidebar hydration function changed');
    let hydrationMap;
    function visit(node){
      if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='get'&&ts.isIdentifier(node.expression.expression)&&node.arguments.length===1&&node.arguments[0].getText(tree)===fn.parameters[0].name.getText(tree))hydrationMap=node.expression.expression.text;
      ts.forEachChild(node,visit);
    }
    visit(fn);
    if(!hydrationMap)throw Error('Sidebar hydration map changed');
    const replacement=helper.slice(helper.indexOf('export function')).replace('export function subscribeSidebarSummary','function '+fn.name.text).replaceAll('export function','function').replaceAll('sidebarHydration',hydrationMap).replaceAll('subscribeSidebarSummary',fn.name.text).trim();
    return source.slice(0,fn.getStart(tree))+replacement+source.slice(fn.end);
  }
  const pattern=/return ([\w$]+)\.subscribe\(\{\s*type:\s*[`"]thread[`"],\s*key:\s*\{\s*hostId:\s*([\w$]+),\s*threadId:\s*([\w$]+)\s*\},\s*field:\s*[`"]summary[`"],\s*listener:\s*([\w$]+),?\s*\}\);?/g;
  const matches=[...source.matchAll(pattern)];
  if(matches.length!==1)throw Error('Sidebar summary subscription anchor changed: '+matches.length);
  source=source.replace(pattern,(_,client,host,id,listener)=>`return subscribeSidebarSummary(${client},{hostId:${host},threadId:${id}},${listener});`);
  return source+'\n'+helper.replaceAll('export function','function');
}
