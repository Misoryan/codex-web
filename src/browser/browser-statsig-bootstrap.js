import {afterStartupPaint} from './after-startup-paint.js';

// Functional evaluation cache shared by Full and Lite. No tokens or chat data.
// Exact SDK user + SDK key is intentional: changed identity/version/plan must fetch.
const browserStatsigRefreshInterval = 10 * 60 * 1000;
const browserStatsigInitializations = new WeakMap();
async function browserStatsigStore(mode, value) {
 const db = await new Promise((resolve,reject)=>{
  const request=indexedDB.open('codex-browser-evaluations',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('snapshot');
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
  request.onblocked=()=>reject(Error('Evaluation cache blocked'));
 });
 try {
  return await new Promise((resolve,reject)=>{
   const tx=db.transaction('snapshot',mode),store=tx.objectStore('snapshot');
   const request=mode==='readonly'?store.get('current'):store.put(value,'current');
   tx.oncomplete=()=>resolve(request.result);
   tx.onerror=()=>reject(tx.error);
   tx.onabort=()=>reject(tx.error);
  });
 } finally {db.close();}
}
export function initializeBrowserStatsig(client, sdkKey) {
 let pending = browserStatsigInitializations.get(client);
 if (!pending) {
  pending = bootstrapBrowserStatsig(client, sdkKey);
  browserStatsigInitializations.set(client, pending);
  void pending.catch(() => browserStatsigInitializations.delete(client));
 }
 return pending;
}
async function bootstrapBrowserStatsig(client, sdkKey) {
 const identity=JSON.stringify([sdkKey,client.getContext().user]);
 let cached;
 try {cached=await browserStatsigStore('readonly');}catch {}
 const save=async()=>{
  const user=client.getContext().user;
  const currentIdentity=JSON.stringify([sdkKey,user]);
  const result=client.dataAdapter.getDataSync(user);
  if(!result||!['Network','NetworkNotModified','Prefetch'].includes(result.source)||typeof result.data!=='string'||result.data.length>16*1024*1024)return;
  try {await browserStatsigStore('readwrite',{identity:currentIdentity,data:result.data,savedAt:Date.now()});}catch {}
 };
 client.on('values_updated',()=>{void save();});
 const age=Date.now()-cached?.savedAt;
 let validPayload=false;
 try {validPayload=JSON.parse(cached?.data)?.has_updates===true;}catch {}
 const matching = validPayload&&cached?.identity===identity&&Number.isFinite(age)&&age>=0&&cached.data.length<=16*1024*1024;
 if(matching){
  // SDK public bootstrap API for a response without an embedded user.
  client.dataAdapter.setDataLegacy(cached.data,client.getContext().user);
 }
 // The SDK's synchronous mode renders with cached/default evaluations. Remote
 // configuration can refresh those values after the composer has painted.
 const result=client.initializeSync({disableBackgroundCacheRefresh:true});
 let timer, cancelPaint, stopped=false;
 const stop=()=>{stopped=true;clearTimeout(timer);cancelPaint?.();};
 const schedule=delay=>{
  timer=setTimeout(()=>{
   cancelPaint=afterStartupPaint(async()=>{
    if(stopped||JSON.stringify([sdkKey,client.getContext().user])!==identity)return;
    try {
     const update=await client.refreshValuesAsync();
     if(update?.success===false)throw Error('Evaluation refresh failed');
     await save();
    } catch {
     if(!stopped)schedule(browserStatsigRefreshInterval);
    }
   });
  },delay);
 };
 schedule(matching?Math.max(0,browserStatsigRefreshInterval-age):0);
 window.addEventListener('pagehide',stop,{once:true});
 return result;
}
