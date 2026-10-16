import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export function patchNativeOpen(source) {
  if(source.includes('window.codexNativeOpenIn'))return source;
  const pattern=/([\w$]+)\s*=\s*await\s+([\w$]+)\.services/g;
  const matches=[...source.matchAll(pattern)];
  if(matches.length!==1)throw Error('Desktop host service initialization changed');
  const name=matches[0][1];
  return source.replace(pattern, `${name}=await $2.services,window.codexNativeOpenIn&&(${name}=new Proxy(${name},{get(target,key){return key==="openIn"?window.codexNativeOpenIn(target.openIn):Reflect.get(target,key)}}))`);
}

if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]){
  const file='scratch/asar/webview/assets/app-shared-8bd9d0399038.js';
  await fs.writeFile(file,patchNativeOpen(await fs.readFile(file,'utf8')));
}
