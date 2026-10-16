const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createUsageService, usageWindow, registerSub2ApiUsage} = require('../src/server/sub2api-usage.js');
const config={baseUrl:'https://example.invalid',adminKey:'test-secret',userId:15};
let now=Date.parse('2026-10-04T15:59:00Z'), calls=[], mode='ok';
const http=async(url,options)=>{
  const u=new URL(url);calls.push(u);assert.equal(options.headers['x-api-key'],'test-secret');assert.equal(options.redirect,'error');
  await new Promise(r=>setTimeout(r,10));
  if(mode==='fail')return new Response('',{status:503});
  if(mode==='429')return new Response('',{status:429,headers:{'retry-after':'300'}});
  if(u.pathname.endsWith('/api-keys')||u.pathname.endsWith('/accounts'))return Response.json({code:0,data:{items:[],total:0}});
  const users=Array.from({length:mode==='truncated'?200:15},(_,i)=>({user_id:i+1,input_tokens:(15-i)*100,output_tokens:0,cache_tokens:999999,actual_cost:mode==='zero-cost'?0:i+1,cost:999,account_cost:777,requests:1}));
  if(mode==='invalid')users[0].input_tokens=-1;
  if(mode==='missing-cost')delete users[0].actual_cost;
  if(mode==='negative-cost')users[0].actual_cost=-1;
  return Response.json({code:0,data:u.pathname.endsWith('/users')?{items:[{id:15,username:'本人',email:'never-return@example.invalid'}]}:{users:mode==='empty'?[]:users}});
};
(async()=>{
 assert.deepEqual(usageWindow('week',now),{startDate:'2026-09-28',endDate:'2026-10-04'});
 const service=createUsageService(config,http,()=>now);
 const results=await Promise.all(Array.from({length:10},()=>service.read('today')));
 assert.equal(calls.length,2,'concurrent readers share aggregate and names');
 const report=results[0].report;
 assert.equal(report.self.actualCost,15); assert(report.ranking.every(row=>!Object.hasOwn(row,'actualCost'))); assert.equal(report.self.rank,1);assert.equal(report.ranking.length,10);assert.equal(report.self.tokens,100);assert.equal(report.totalTokens,12000);
 assert.equal(report.self.share,15/120*100);assert.equal(report.self.name,'本人');
 assert(!JSON.stringify(results).includes('test-secret'));assert(!JSON.stringify(results).includes('never-return'));assert(!JSON.stringify(results).includes('cache_tokens'));
 assert.equal(report.shareBasis,'actual_cost');assert.equal(report.ranking[0].userId,15);
 function noAmounts(value){if(value&&typeof value==='object')for(const [key,v] of Object.entries(value)){assert(!['cost','actual_cost','account_cost','totalCost'].includes(key));noAmounts(v);}}noAmounts(report);
 const offChart=await createUsageService({...config,userId:1},http,()=>now).read('today');assert.equal(offChart.report.self.rank,15);assert(!offChart.report.ranking.some(row=>row.userId===1));
 const cachedCount=calls.length;await service.read('today');assert.equal(calls.length,cachedCount);
 now+=60_001; mode='fail';const stale=await service.read('today');assert.equal(stale.stale,true);assert.equal(stale.report.generatedAt,report.generatedAt);
 const before=calls.length; await service.read('today');assert.equal(calls.length,before,'backoff suppresses retries');
 now+=60_001;mode='ok';const recovered=await service.read('today');assert.equal(recovered.stale,false);assert.equal(recovered.report.startDate,'2026-10-05');assert.equal(calls.filter(x=>x.pathname.endsWith('/users')).length,2);
 mode='truncated'; const truncated=await createUsageService(config,http,()=>now).read('today');assert.equal(truncated.report,null);assert.equal(truncated.stale,true);
 mode='invalid';assert.equal((await createUsageService(config,http,()=>now).read('today')).report,null);
 mode='empty';const empty=await createUsageService(config,http,()=>now).read('today');assert.equal(empty.report.self.actualCost,0);assert.equal(empty.report.self.share,0);assert.equal(empty.report.self.rank,0);assert.equal(empty.stale,false);
 for(const invalid of ['missing-cost','negative-cost']){mode=invalid;assert.equal((await createUsageService(config,http,()=>now).read('today')).report,null);}
 mode='zero-cost';const zero=await createUsageService(config,http,()=>now).read('today');assert.equal(zero.report.self.actualCost,0);assert.equal(zero.report.self.share,0);assert.equal(zero.stale,false);
 mode='429';const limited=createUsageService(config,http,()=>now);await limited.read('today');const count=calls.length;await limited.read('week');assert.equal(calls.length,count,'429 backoff spans ranges');
 mode='ok';
 const readFile=fs.promises.readFile, originalFetch=global.fetch;
 const app=require('fastify')();
 try {
  fs.promises.readFile=async()=>JSON.stringify(config);global.fetch=http;
  await registerSub2ApiUsage(app);
  fs.promises.readFile=readFile;
  const result=await app.inject('/__backend/sub2api/usage?range=today');
  assert.equal(result.statusCode,200);assert.equal(result.headers['cache-control'],'private, no-store');assert.equal(result.json().report.self.userId,15);
  for(const headers of [{'sec-fetch-site':'cross-site'},{origin:'https://attacker.invalid'},{origin:'null'}])assert.equal((await app.inject({url:'/__backend/sub2api/usage',headers})).statusCode,403);
  assert.equal((await app.inject('/__backend/sub2api/usage?range=arbitrary')).statusCode,400);
  assert.equal((await app.inject({url:'/__backend/sub2api/usage',method:'POST'})).statusCode,404);
  assert(!result.body.includes('test-secret'));assert.equal(result.json().capacity.stale,false);assert.equal(result.json().capacity.report.proCount,0);
 } finally {fs.promises.readFile=readFile;global.fetch=originalFetch;await app.close();}
 console.log('PASS: request coalescing, cache, complete denominator, off-chart self, no secrets/emails, midnight, stale recovery, invalid/truncated/empty data, global 429 backoff');
 console.log('PASS: fixed read-only API, no-store, invalid ranges and cross-site requests rejected');
})().catch(e=>{console.error(e);process.exitCode=1});
