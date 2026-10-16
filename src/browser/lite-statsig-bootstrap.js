// Functional evaluation cache. One bounded snapshot; no tokens or chat data.
// Exact SDK user + SDK key is intentional: changed identity/version/plan must fetch.
const liteStatsigRefreshInterval = 10 * 60 * 1000;
async function liteStatsigStore(mode, value) {
 const db = await new Promise((resolve,reject)=>{
  const request=indexedDB.open('codex-lite-evaluations',1);
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
export async function initializeLiteStatsig(client, sdkKey) {
 const identity=JSON.stringify([sdkKey,client.getContext().user]);
 let cached;
 try {cached=await liteStatsigStore('readonly');}catch {}
 const save=async()=>{
  const user=client.getContext().user;
  if(JSON.stringify([sdkKey,user])!==identity)return;
  const result=client.dataAdapter.getDataSync(user);
  if(!result||!['Network','NetworkNotModified','Prefetch'].includes(result.source)||typeof result.data!=='string'||result.data.length>16*1024*1024)return;
  try {await liteStatsigStore('readwrite',{identity,data:result.data,savedAt:Date.now()});}catch {}
 };
 client.on('values_updated',()=>{void save();});
 const age=Date.now()-cached?.savedAt;
 let validPayload=false;
 try {validPayload=JSON.parse(cached?.data)?.has_updates===true;}catch {}
 if(validPayload&&cached?.identity===identity&&Number.isFinite(age)&&age>=0&&cached.data.length<=16*1024*1024){
  // SDK public bootstrap API for a response without an embedded user.
  client.dataAdapter.setDataLegacy(cached.data,client.getContext().user);
  const result=client.initializeSync({disableBackgroundCacheRefresh:true});
  // Age controls revalidation, not whether a matching snapshot can start the UI.
  // Yield two frames so cached initialization can render before network work.
  let timer,frame,observer,stopped=false;
  const stop=()=>{stopped=true;clearTimeout(timer);cancelAnimationFrame(frame);observer?.disconnect();};
  const schedule=delay=>{
   timer=setTimeout(()=>{
    const ready=()=>{
     const composer=document.querySelector('[contenteditable=true]');
     if(!composer||composer.getBoundingClientRect().height===0)return;
     observer?.disconnect();
     frame=requestAnimationFrame(()=>{
     frame=requestAnimationFrame(async()=>{
      if(stopped||JSON.stringify([sdkKey,client.getContext().user])!==identity)return;
      try {
       const update=await client.refreshValuesAsync();
       if(update?.success===false)throw Error('Evaluation refresh failed');
       await save();
      } catch {
       // Keep the usable snapshot. A failed refresh must not hold up startup.
       if(!stopped)schedule(liteStatsigRefreshInterval);
      }
     });
    });
    };
    observer=new MutationObserver(ready);
    observer.observe(document,{childList:true,subtree:true,attributes:true});
    ready();
   },delay);
  };
  schedule(Math.max(0,liteStatsigRefreshInterval-age));
  window.addEventListener('pagehide',stop,{once:true});
  return result;
 }
 const result=await client.initializeAsync();
 await save();
 return result;
}
