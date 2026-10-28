import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import {chromium} from '@playwright/test';

// Run the pinned application's real Statsig SDK with an external evaluation
// service fixture. Persistence, SDK bootstrap and user updates are not mocked.
const root = path.resolve('scratch/asar/webview');
const shared = await fs.readFile(path.join(root,'assets/app-shared-8bd9d0399038.js'),'utf8');
assert(shared.includes('Qvn ='), 'Pinned Statsig SDK export changed');
const bootstrap = await fs.readFile('src/browser/browser-statsig-bootstrap.js','utf8');
const app = Fastify();
await app.register(staticFiles, {root});
app.get('/assets/sdk-fixture.js', (_req, reply) => reply.type('application/javascript').send(shared+'\nexport {Qvn as fixtureSDK};'));
app.get('/bootstrap.js', (_req, reply) => reply.type('application/javascript').send(bootstrap));
app.get('/after-startup-paint.js', async (_req, reply) => reply.type('application/javascript').send(await fs.readFile('src/browser/after-startup-paint.js','utf8')));
app.get('/fixture', (_req, reply) => reply.type('text/html').send('<html><head></head><body></body></html>'));
await app.listen({host:'127.0.0.1',port:0});
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
 const page = await browser.newPage();
 await page.goto(`http://127.0.0.1:${app.server.address().port}/fixture`);
 const result = await page.evaluate(async()=>{
  const {fixtureSDK} = await import('/assets/sdk-fixture.js');
  const {StatsigClient} = fixtureSDK();
  const {initializeBrowserStatsig} = await import('/bootstrap.js');
  const key='client-startup-fixture', calls=[];
  const read = () => new Promise((resolve,reject)=>{
   const r=indexedDB.open('codex-browser-evaluations',1);
   r.onerror=()=>reject(r.error);
   r.onsuccess=()=>{const db=r.result;const q=db.transaction('snapshot','readonly').objectStore('snapshot').get('current');q.onsuccess=()=>{db.close();resolve(q.result);};};
  });
  const waitSaved = async userID => {
   for(let i=0;i<100;i++){const data=await read();if(data&&JSON.parse(data.identity)[1].userID===userID)return data;await new Promise(r=>setTimeout(r,10));}
   throw Error('Current user evaluation not persisted');
  };
  const options={disableStorage:true,loggingEnabled:'disabled',networkConfig:{networkOverrideFunc:async(url,request)=>{
   calls.push(String(url));
   return Response.json({has_updates:true,hash_used:'none',time:Date.now(),feature_gates:{startup_fixture:{name:'startup_fixture',value:true,rule_id:'fixture'}},dynamic_configs:{},layer_configs:{}});
  }}};
  const cold=new StatsigClient(key,{userID:'fixture-a'},options);
  const first=initializeBrowserStatsig(cold,key), second=initializeBrowserStatsig(cold,key);
  const samePromise=first===second;
  await Promise.race([Promise.all([first,second]),new Promise((_,reject)=>setTimeout(()=>reject(Error('Cold start waited for remote evaluations')),1000))]);
  const beforeComposer=calls.length;
  document.body.innerHTML='<div contenteditable="true">fixture composer</div>';
  await waitSaved('fixture-a');
  const coldCalls=calls.length,coldGate=cold.checkGate('startup_fixture');
  await cold.updateUserAsync({userID:'fixture-b'});
  await waitSaved('fixture-b');
  const afterUpdate=calls.length;
  const warm=new StatsigClient(key,{userID:'fixture-b'},options);
  await initializeBrowserStatsig(warm,key);
  const warmCalls=calls.length-afterUpdate, warmGate=warm.checkGate('startup_fixture');
  document.body.innerHTML='';
  const changed=new StatsigClient(key,{userID:'fixture-c'},options);
  await initializeBrowserStatsig(changed,key);
  const changedGateBeforeRefresh=changed.checkGate('startup_fixture');
  const beforeChangedRefresh=calls.length;
  document.body.innerHTML='<div contenteditable="true">fixture composer</div>';
  await waitSaved('fixture-c');
  return {samePromise,beforeComposer,coldCalls,coldGate,warmCalls,warmGate,changedGateBeforeRefresh,beforeChangedRefresh,afterUpdate,changedCalls:calls.length-afterUpdate-warmCalls};
 });
 assert.equal(result.samePromise,true);
 assert.equal(result.beforeComposer,0,'A cold start renders before remote evaluations');
 assert.equal(result.coldCalls,1);assert.equal(result.coldGate,true);
 assert.equal(result.warmCalls,0);assert.equal(result.warmGate,true);
 assert.equal(result.changedGateBeforeRefresh,false,'A new identity cannot inherit another user\'s evaluations');
 assert.equal(result.beforeChangedRefresh,result.afterUpdate);
 assert.equal(result.changedCalls,1);
 console.log('Real Statsig SDK bootstrap passed: cold render before network, duplicate init, persisted targeting update, zero-request warm start, changed identity separation');
} finally {await browser.close();await app.close();}
