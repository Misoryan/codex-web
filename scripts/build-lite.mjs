import {withStartupPreloads} from '../ops/startup-preloads.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {transform} from 'esbuild';
import {build as viteBuild} from 'vite';
import {withStartupAssets} from '../ops/startup-assets.mjs';
import {pwaBackgrounds, withPwaHead} from '../ops/pwa-head.mjs';
import {createHash} from 'node:crypto';
import {brotliCompressSync,gzipSync,constants} from 'node:zlib';
import {patchLiteInitial,patchLiteShared} from './lite-startup-patches.mjs';
const root=path.resolve('scratch/asar/webview'),dest=path.resolve(process.argv[2] ?? path.join(root,'lite'));
await fs.mkdir(path.join(dest,'assets'),{recursive:true});
await viteBuild({configFile:path.resolve('vite.browser.config.ts'),build:{outDir:path.join(dest,'assets'),sourcemap:false}});
const names=await fs.readdir(path.join(root,'assets'));
const primary=names.find(n=>/^app-primary-.*\.js$/.test(n)),initial=names.find(n=>/^app-initial-.*\.js$/.test(n)),shared=names.find(n=>/^app-shared-.*\.js$/.test(n));
if(!primary||!initial||!shared)throw Error('Desktop entrypoints missing');
const optimize=new Set([primary,initial,shared,'preload.js']),hash=createHash('sha256'),sizes=[];
for(let offset=0;offset<names.length;offset+=32){
 const buffers=await Promise.all(names.slice(offset,offset+32).map(async name=>{
 if(/\.(map|br|gz|orig|rej)$/.test(name))return;
 const src=path.join(root,'assets',name),target=path.join(dest,'assets',name);
 if(!(await fs.stat(src)).isFile())return;
 if(optimize.has(name)){
  let source=await fs.readFile(name==='preload.js'?target:src,'utf8');
  if(name===initial)source=await patchLiteInitial(source);
  if(name===shared)source=await patchLiteShared(source);
  if(name==='preload.js'){
   const marker='function mapBrowserPathToRoute(pathname) {';
   if(!source.includes(marker))throw Error('Desktop route shim changed');
   source=source.replace(marker,marker+'\n pathname = pathname.replace(/^\\/lite(?=\\/|$)/, "") || "/";');
   source=source.replace('path: `/thread/${encodeURIComponent(match[1])}`','path: `/lite/thread/${encodeURIComponent(match[1])}`');
   source=source.replace('path: "/automations"','path: "/lite/automations"');
   source=source.replace('if (pathname === "/") return {\n\t\tpath: "/",','if (pathname === "/") return {\n\t\tpath: "/lite/",');
  }
  const result=await transform(source,{loader:'js',minify:true,target:'es2022',legalComments:'none'});
  await fs.writeFile(target,result.code);sizes.push({name,before:Buffer.byteLength(source),after:Buffer.byteLength(result.code)});
 }else if(name==='mobile-pwa.js'){
  const source=await fs.readFile(src,'utf8');await fs.writeFile(target,source.replace(/if \('serviceWorker' in navigator && isSecureContext\) \{[\s\S]*?\n\}/,''));
 }else if(name==='realtime-voice-launch-surface-3d12ff1e0a65.js')await fs.writeFile(target,'export function i(){} export function n(){} export function r(){return null} export function t(){return null}\n');
 else {const sourceStat=await fs.stat(src),targetStat=await fs.stat(target).catch(()=>null);if(!targetStat||sourceStat.size!==targetStat.size||Math.abs(sourceStat.mtimeMs-targetStat.mtimeMs)>1){await fs.copyFile(src,target);await fs.utimes(target,sourceStat.atime,sourceStat.mtime);}}
 const data=(optimize.has(name)||/\.(js|css)$/.test(name))?await fs.readFile(target):null;
 if(optimize.has(name)||/\.css$/.test(name)){
  await fs.writeFile(target+'.br',brotliCompressSync(data,{params:{[constants.BROTLI_PARAM_QUALITY]:4}}));await fs.writeFile(target+'.gz',gzipSync(data,{level:6}));
 }
 return data;
 }));
 for(const data of buffers)if(data)hash.update(data);
}
sizes.sort((a,b)=>names.indexOf(a.name)-names.indexOf(b.name));
const visualizationSandbox=await fs.readFile(path.join(dest,'assets/visualization-sandbox.js'));
hash.update(visualizationSandbox);
await fs.writeFile(path.join(dest,'assets/visualization-sandbox.js.br'),brotliCompressSync(visualizationSandbox,{params:{[constants.BROTLI_PARAM_QUALITY]:4}}));
await fs.writeFile(path.join(dest,'assets/visualization-sandbox.js.gz'),gzipSync(visualizationSandbox,{level:6}));
let html=await fs.readFile(path.join(root,'index.html'),'utf8');
html=html.replace('<base href="/" />','<base href="/lite/" />').replaceAll('"/assets/','"/lite/assets/').replace('href="/manifest.json"','href="/lite/manifest.webmanifest"');
html=html.replace('</head>',`<link rel="modulepreload" href="/lite/assets/${primary}"><script defer src="/lite/desktop-lite.js"></script></head>`);
html=withPwaHead(html);
html=await withStartupPreloads(html,dest,'/lite/');
html=await withStartupAssets(html,root,'/lite/',dest);
await fs.writeFile(path.join(dest,'index.html'),html);
await fs.copyFile('ops/desktop-lite.js',path.join(dest,'desktop-lite.js'));
await fs.copyFile(path.join(root,'favicon.svg'),path.join(dest,'favicon.svg'));
const version=hash.digest('hex').slice(0,12);
await fs.writeFile(path.join(dest,'manifest.webmanifest'),JSON.stringify({id:'/lite/',name:'Codex Desktop 轻量模式',short_name:'Codex Lite',start_url:'/lite/',scope:'/lite/',display:'standalone',background_color:pwaBackgrounds.light,theme_color:pwaBackgrounds.light,icons:[{src:'/lite/assets/pwa-icon-192.png',sizes:'192x192',type:'image/png'},{src:'/lite/assets/pwa-icon-512.png',sizes:'512x512',type:'image/png'}]}));
const worker=await fs.readFile('ops/lite-sw.js','utf8');
await fs.writeFile(path.join(dest,'sw.js'),worker);
const report=process.argv[2]?path.join(dest,'build.json'):'runtime/measurements/desktop-lite-build.json';
await fs.mkdir(path.dirname(report),{recursive:true});await fs.writeFile(report,JSON.stringify({version,sizes},null,2));console.log(JSON.stringify({version,sizes},null,2));
