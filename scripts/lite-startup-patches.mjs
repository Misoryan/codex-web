import fs from 'node:fs/promises';import ts from 'typescript';
import {patchLiteHistory} from './lite-history-patches.mjs';
function once(source,a,b){if(source.split(a).length!==2)throw Error('Lite startup anchor changed: '+a);return source.replace(a,b)}
function replaceFunction(source,name,edit){const ast=ts.createSourceFile('lite.js',source,99,true,ts.ScriptKind.JS),node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(!node)throw Error('Lite component changed: '+name);return source.slice(0,node.getStart(ast))+edit(node.getText(ast))+source.slice(node.end)}
export async function patchLiteInitial(source){
 const ast=ts.createSourceFile('lite.js',source,99,true,ts.ScriptKind.JS),edits=[];
 const change=(name,edit)=>{const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(!node)throw Error('Lite component changed: '+name);edits.push({start:node.getStart(ast),end:node.end,text:edit(node.getText(ast))})};
 change('ZZs',body=>{
  body=once(body,'[, a] = nn(`statsig_evaluations`),','liteStatsigPublication = tQs.useRef(), a = tQs.useCallback(value => {liteStatsigPublication.current=value;window.electronBridge.sendMessageFromView({type:`shared-object-set`,key:`statsig_evaluations`,value});},[]),');
  return once(body,'zc(r.get, `statsig_evaluations`)','liteStatsigPublication.current');
 });
 change('jUa',body=>{if(!body.includes('requestIdleCallback'))throw Error('Prefetch scheduler changed');return 'function jUa(){NUa.useEffect(()=>afterStartupPaint(()=>{import("./local-conversation-page-a83a1af2c24b.js").catch(error=>console.warn("Lite chat preload failed",error));}),[]);return null}'});
 for(const [name,evidence] of [['k_c','global-dictation-enabled-changed'],['ptc','mac-menu-bar-enabled-changed'],['I_c','hotkeyWindowHotkeys'],['Cmc','remote-hosted-pip-task-state-changed'],['Xhc','tray-menu-threads-changed'],['Hcc','electron-set-badge-count'],['Ouc','rawConfig']]){
  change(name,body=>{if(!body.includes(evidence))throw Error('Lite shell effect changed: '+name);return `function ${name}(){return null}`});
 }
 for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
 source=once(source,'this.service.readPage(e)','liteReadPage(this.service,e)');
 source+='\n'+(await fs.readFile(new URL('../src/browser/lite-read-page.js',import.meta.url),'utf8')).replace('export function liteReadPage','function liteReadPage');
 return source;
}
export async function patchLiteShared(source){
 const subscription = 'e.watch(({ get: e }) => {\n              (e(NI, `statsig_evaluations`),\n                e(XU),\n                e(e(xF, t).appServerVersion$),\n                n());\n            })';
 source=once(source,subscription,'liteSubscribeExecutionSettings(e, t, n)');
 source += `\nfunction liteSubscribeExecutionSettings(store, hostId, notify) {
  let client;
  const unsubscribe = store.watch(({get}) => {
    const next = get(XU);
    if (next !== client) {
      client?.off('values_updated', notify);
      client = next;
      client?.on('values_updated', notify);
    }
    get(get(xF, hostId).appServerVersion$);
    notify();
  });
  return () => {unsubscribe();client?.off('values_updated', notify);};
}\n`;
 source=once(source,'r = this.refreshes.get(n);','r = this.refreshes.get(n) ?? (e === `routine` ? this.refreshes.get(`expanded:${this.params.requestClient.getCompatibleThreadSortKey(t ?? this.recentConversationSortKey)}`) : void 0);');
 return patchLiteHistory(source);
}
