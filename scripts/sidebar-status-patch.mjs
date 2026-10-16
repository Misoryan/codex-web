import fs from 'node:fs/promises';
import ts from 'typescript';
export async function patchSidebarStatus(source){
  const helper=await fs.readFile(new URL('../src/browser/sidebar-status.js',import.meta.url),'utf8');
  if(source.includes('function subscribeSidebarSummary(')){
    const tree=ts.createSourceFile('native.js',source,99,true,ts.ScriptKind.JS);
    const fn=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='subscribeSidebarSummary');
    if(!fn)throw Error('Sidebar hydration function changed');
    const replacement=helper.slice(helper.indexOf('export function')).replace('export function','function').trim();
    return source.slice(0,fn.getStart(tree))+replacement+source.slice(fn.end);
  }
  const pattern=/return ([\w$]+)\.subscribe\(\{\s*type:\s*[`"]thread[`"],\s*key:\s*\{\s*hostId:\s*([\w$]+),\s*threadId:\s*([\w$]+)\s*\},\s*field:\s*[`"]summary[`"],\s*listener:\s*([\w$]+),?\s*\}\);?/g;
  const matches=[...source.matchAll(pattern)];
  if(matches.length!==1)throw Error('Sidebar summary subscription anchor changed: '+matches.length);
  source=source.replace(pattern,(_,client,host,id,listener)=>`return subscribeSidebarSummary(${client},{hostId:${host},threadId:${id}},${listener});`);
  return source+'\n'+helper.replace('export function','function');
}
