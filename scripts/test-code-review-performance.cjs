const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');

// External CLI fixture. The real plugin executes its schemas, account checks,
// cache invalidation and mutation handler over the MCP stdio boundary.
if(process.argv[2]==='--gh-fixture') {
  const args=process.argv.slice(3),state=JSON.parse(fs.readFileSync(process.env.PR_FIXTURE_STATE));
  fs.appendFileSync(process.env.PR_FIXTURE_LOG,JSON.stringify(args)+'\n');
  const fail=message=>{process.stderr.write(message);process.exit(1)};
  if(args[0]==='--version')console.log('gh version 2.80.0');
  else if(args[0]==='auth')state.denied?fail('not logged in'):console.log('Logged in');
  else if(args[0]==='api'&&args[1]==='user') {
    if(state.denied)fail('HTTP 401: Bad credentials');
    setTimeout(()=>console.log(JSON.stringify({login:state.login})),80);
  } else if(args[0]==='api'&&args[1]==='graphql') {
    if(state.denied)fail('HTTP 401: Bad credentials');
    console.log(JSON.stringify({data:{viewer:{login:state.login},repository:{pullRequest:{headRefOid:'head-123',baseRefOid:'base-123',state:'OPEN',isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN'}}}}));
  } else if(args[0]==='pr'&&args[1]==='merge') {
    if(state.mergeError)fail(state.mergeError);
    if(args[args.indexOf('--match-head-commit')+1]!=='head-123')fail('head revision changed');
    console.log('Merged');
  } else fail('Unexpected fixture CLI command');
} else {
const {patchCodeReviewPerformance}=require('./code-review-performance-patch.cjs');
(async()=>{
  const root=process.cwd(),work=fs.mkdtempSync(path.join(root,'runtime/tmp/pr-performance-'));
  const stateFile=path.join(work,'state.json'),logFile=path.join(work,'gh.jsonl');
  let state={login:'FixtureUser',clockOffset:0};
  const update=patch=>{state={...state,...patch};fs.writeFileSync(stateFile,JSON.stringify(state))};update({});fs.writeFileSync(logFile,'');
  const plugin=path.join(root,'scratch/asar/plugins/openai-bundled/plugins/code-review');
  const original=fs.readFileSync(path.join(plugin,'server.mjs'),'utf8'),patched=patchCodeReviewPerformance(original);
  assert.equal(patchCodeReviewPerformance(patched),patched,'Patch is idempotent');
  fs.writeFileSync(path.join(work,'server.mjs'),patched);fs.cpSync(path.join(plugin,'assets'),path.join(work,'assets'),{recursive:true});
  const hook=path.join(work,'external-cli.cjs');
  fs.writeFileSync(hook,`const cp=require('node:child_process'),fs=require('node:fs'),original=cp.spawn;
cp.spawn=function(command,args,options){return command==='gh'?original(process.execPath,[${JSON.stringify(__filename)},'--gh-fixture',...args],options):original(command,args,options)};
require('node:module').syncBuiltinESMExports();
const now=Date.now;Date.now=()=>now()+JSON.parse(fs.readFileSync(process.env.PR_FIXTURE_STATE)).clockOffset;
`);
  const child=spawn(process.execPath,['--require',hook,path.join(work,'server.mjs')],{windowsHide:true,env:{...process.env,CODEX_HOME:path.join(work,'home'),PR_FIXTURE_STATE:stateFile,PR_FIXTURE_LOG:logFile},stdio:['pipe','pipe','pipe']});
  let buffer='',id=0,stderr='';const pending=new Map();child.stderr.on('data',d=>stderr+=d);
  child.stdout.on('data',d=>{buffer+=d;while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);const m=JSON.parse(line);pending.get(m.id)?.(m)}});
  function request(method,params){const requestId=++id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('MCP timeout: '+stderr))},15000);pending.set(requestId,m=>{clearTimeout(timer);pending.delete(requestId);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n')})}
  const account={hostId:'local',hostname:'github.com',login:'fixtureuser'};
  const pullRequest={hostname:'github.com',owner:'fixture',repository:'repo',number:42};
  const call=(name,args={})=>request('tools/call',{name,arguments:args,_meta:{'openai/github-provider':false}});
  const commands=()=>fs.readFileSync(logFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const users=()=>commands().filter(a=>a[0]==='api'&&a[1]==='user').length;
  const merges=()=>commands().filter(a=>a[0]==='pr'&&a[1]==='merge');
  const read=()=>call('pull_requests.mergeability',{account,pullRequest});
  const merge=()=>call('pull_requests.merge',{account,pullRequest,expectedHeadRevision:'head-123',mergeMethod:'squash'});
  try {
    await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'isolated-pr-acceptance',version:'1'}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const reads=await Promise.all(Array.from({length:5},read));
    for(const r of reads){assert.equal(r.structuredContent.status,'success');assert.equal(r.structuredContent.headRevision,'head-123');assert.equal(r.structuredContent.canMerge,true)}
    assert.equal(users(),1,'Concurrent reads share a single identity lookup');
    await read();assert.equal(users(),1,'A later read reuses the valid identity');
    update({clockOffset:31000});await read();assert.equal(users(),2,'Expired identity must be checked again');
    const before=commands().length;
    assert.equal((await merge()).structuredContent.status,'success');
    assert.equal(users(),3,'Every merge checks the live identity exactly once');
    assert.deepEqual(commands().slice(before).map(a=>a.slice(0,2)),[['api','user'],['pr','merge']]);
    assert.deepEqual(merges()[0],['pr','merge','42','--squash','--match-head-commit','head-123','--repo','github.com/fixture/repo']);
    update({mergeError:'head revision changed'});
    const rejected=await merge();assert.equal(rejected.structuredContent.status,'error');assert.match(rejected.structuredContent.error,/head revision changed/);assert.equal(users(),4);
    update({login:'DifferentUser',mergeError:null});
    const mismatch=await merge();assert.equal(mismatch.isError,true);assert.match(JSON.stringify(mismatch.content),/account changed/);assert.equal(merges().length,2,'Changed identity must prevent mutation');
    update({login:'FixtureUser',denied:true});const denied=await read();assert.equal(denied.isError,true);assert.equal(denied.structuredContent.readFailure.kind,'access');
    const failedUsers=users();await read();assert.equal(users(),failedUsers+1,'Failed authorization is not cached');
    update({denied:false});assert.equal((await read()).structuredContent.status,'success');
    const checked=await call('pull_requests.account');assert.equal(checked.structuredContent.currentUser.account.login,'fixtureuser');assert.equal(users(),failedUsers+3,'Manual account refresh checks live credentials');
    const beforeSequential=users();
    for(const number of [43,44,45])assert.equal((await call('pull_requests.merge',{account,pullRequest:{...pullRequest,number},expectedHeadRevision:'head-123',mergeMethod:'squash'})).structuredContent.status,'success');
    assert.equal(users(),beforeSequential+3,'Consecutive merges each verify the live identity');
    assert.deepEqual(merges().slice(-3).map(args=>args.slice(0,6)),[43,44,45].map(number=>['pr','merge',String(number),'--squash','--match-head-commit','head-123']));
    console.log('Code Review MCP: concurrent/repeated reads, expiration, fresh SHA-guarded merges, failed merge, changed identity, sign-out and recovery passed. No real GitHub writes.');
  } finally {child.kill();await new Promise(r=>child.once('exit',r));fs.rmSync(work,{recursive:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
}
