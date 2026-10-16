import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const start='\n/* CODEX_UNGROUPED_PINNED_START */\n',end='\n/* CODEX_UNGROUPED_PINNED_END */\n';
export async function patchUngroupedPinned(source){
 const a=source.indexOf(start);
 if(a>=0){const b=source.indexOf(end,a);if(b<0)throw Error('Folder marker missing');source=source.slice(0,a)+source.slice(b+end.length);}
 const anchor='(0, Y3.jsx)(TSs, {\n                  chatGptSource: St,';
 const patched='(0, Y3.jsx)(CodexUngroupedPinned, {\n                  chatGptSource: St,';
 if(source.includes(anchor)){
   if(source.split(anchor).length!==2)throw Error('Pinned list anchor changed');
   source=source.replace(anchor,patched);
 }else if(!source.includes(patched))throw Error('Pinned list missing');
 const helper=(await fs.readFile(new URL('../src/browser/ungrouped-pinned.js',import.meta.url),'utf8')).replace('export function','function');
 if(!source.includes('import CodexFolderClosed')) source=`import CodexFolderClosed from './folder-closed-CigqKhtt-c7962a469645.js';\nimport CodexFolderOpen from './folder-open-B_NJw1I2-6e2f03f94b20.js';\n`+source;
 return source+start+helper+'\nvar codexUngroupedPinnedComponent;\nfunction CodexUngroupedPinned(props){Q4o();codexUngroupedPinnedComponent ??= createUngroupedPinned(us(), TSs, Y4o, CodexFolderClosed, CodexFolderOpen);return us().createElement(codexUngroupedPinnedComponent,props); }\n'+end;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const file='scratch/asar/webview/assets/app-initial-6350d04672d0.js';await fs.writeFile(file,await patchUngroupedPinned(await fs.readFile(file,'utf8')));
}
