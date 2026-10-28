import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {brotliCompressSync,brotliDecompressSync,gzipSync,gunzipSync,constants} from 'node:zlib';
import {withVersionedAssets} from '../ops/startup-preloads.mjs';

const [release,output]=process.argv.slice(2);
if(!release||!output)throw Error('Usage: build-static-release.mjs RELEASE OUTPUT_DIRECTORY');
withVersionedAssets('',release);
const source=path.resolve('scratch/asar/webview'),destination=path.resolve(output);
if(destination===source||destination.startsWith(source+path.sep))throw Error('Release output must be outside the build tree');
await fs.mkdir(destination,{recursive:false});
await fs.cp(source,destination,{recursive:true,filter:file=>!/(?:\.map|\.orig|\.rej)$/.test(file)&&path.basename(file)!=='codex-static'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const prefix of ['', 'lite/']) {
  const file=path.join(destination,prefix,'index.html');
  const html=withVersionedAssets(await fs.readFile(file,'utf8'),release);
  await fs.writeFile(file,html);
  await fs.writeFile(file+'.br',brotliCompressSync(Buffer.from(html),{params:{[constants.BROTLI_PARAM_QUALITY]:9}}));
  await fs.writeFile(file+'.gz',gzipSync(html,{level:9}));
  const resources=[...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match=>new URL(match[1],'https://local/'+prefix).pathname)
    .filter(name=>name.startsWith('/codex-static/'+release+'/')&&/\.(js|css)$/.test(name));
  for(const name of new Set(resources)) {
    const asset=path.join(destination,name.slice(('/codex-static/'+release+'/').length));
    const bytes=await fs.readFile(asset);
    const compressed=brotliCompressSync(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:9}});
    if(!brotliDecompressSync(compressed).equals(bytes))throw Error('Compressed resource differs: '+name);
    await fs.writeFile(asset+'.br',compressed);
  }
}
const files={};
async function visit(directory){
  const entries=await fs.readdir(directory,{withFileTypes:true});
  const regular=[];
  for(const entry of entries){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())await visit(file);
    else if(entry.isFile())regular.push(file);
    else throw Error('Unexpected non-file release entry');
  }
  for(let offset=0;offset<regular.length;offset+=32){
    await Promise.all(regular.slice(offset,offset+32).map(async file=>{
      const bytes=await fs.readFile(file);
      if(/\.(br|gz)$/.test(file)){
        const original=await fs.readFile(file.replace(/\.(br|gz)$/,''));
        const decoded=file.endsWith('.br')?brotliDecompressSync(bytes):gunzipSync(bytes);
        if(!decoded.equals(original))throw Error('Stale compressed resource: '+file);
      }
      files[path.relative(destination,file).replaceAll(path.sep,'/')]=hash(bytes);
    }));
  }
}
await visit(destination);
const manifest={release,source,destination,files};
await fs.writeFile(destination+'.manifest.json',JSON.stringify(manifest,null,2));
console.log(JSON.stringify({release,destination,files:Object.keys(files).length}));
