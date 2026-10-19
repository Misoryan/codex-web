const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const {WebSocketServer} = require('ws');

const modules = new Map();
function load(name) {
  const file = path.resolve('src/server/workflow', name + '.ts');
  if (modules.has(file)) return modules.get(file).exports;
  const item = new Module(file, module); item.filename = file; item.paths = Module._nodeModulePaths(path.dirname(file));
  const nativeRequire = item.require.bind(item);
  item.require = id => id.startsWith('./') ? load(id.slice(2)) : nativeRequire(id);
  modules.set(file, item);
  item._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText, file);
  return item.exports;
}
const {RuntimeReader} = load('runtime-reader');
const {workflowSnapshots, closeRuntimeObservers} = load('host');

async function bridge() {
  const server = new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise(resolve => server.on('listening', resolve));
  const fixture = {server, loaded:new Map(), calls:[], peers:new Set(), silent:false, delays:new Map(), closedReasons:[]};
  fixture.url = `ws://127.0.0.1:${server.address().port}/__backend/ipc`;
  server.on('connection',(socket,request)=>{
    fixture.peers.add(socket);
    const params = new URL(request.url,'http://localhost').searchParams;
    assert.equal(params.get('lifecycle'),'3'); assert(params.get('session')); assert(params.get('document'));
    socket.on('close',(_code,reason)=>{fixture.peers.delete(socket);fixture.closedReasons.push(reason.toString())});
    let seq=0;
    socket.send(JSON.stringify({type:'renderer-ready',epoch:'fixture',clientAck:0}));
    socket.on('message',raw=>{
      const frame=JSON.parse(raw.toString());
      if(frame.type==='renderer-ack')return;
      assert.equal(frame.type,'renderer-command');
      const payload=frame.payload;
      assert.equal(payload.type,'ipc-renderer-invoke'); assert.equal(payload.channel,'codex_desktop:message-from-view');
      const message=payload.args[0]; assert.equal(message.type,'mcp-request'); assert.equal(message.hostId,'local');
      const {id,method,params}=message.request; fixture.calls.push({method,params});
      assert(['thread/loaded/list','thread/read'].includes(method),'Observer must never resume, interrupt, acknowledge approval or send a turn');
      if(fixture.silent)return;
      let result;
      if(method==='thread/loaded/list')result={data:[...fixture.loaded.keys()],nextCursor:null};
      else {assert.equal(params.includeTurns,false); assert(fixture.loaded.has(params.threadId),'Only loaded relevant threads may be read');result={thread:{id:params.threadId,status:fixture.loaded.get(params.threadId)}}}
      const reply=()=>{if(socket.readyState===1)socket.send(JSON.stringify({type:'renderer-event',seq:++seq,payload:{type:'ipc-main-event',channel:'codex_desktop:message-for-view',args:[{type:'mcp-response',hostId:'local',message:{id,result}}]}}))};
      if(fixture.delays.has(params.threadId))setTimeout(reply,fixture.delays.get(params.threadId));else reply();
    });
  });
  fixture.close=async()=>{for(const socket of fixture.peers)socket.terminate();await new Promise(resolve=>server.close(resolve))};
  return fixture;
}

(async()=>{
  const previousHost=global.__codexWorkflowHost, previousUrls=process.env.CODEX_WORKFLOW_OBSERVER_IPC_URLS;
  const remote=await bridge();
  const active=randomUUID(), wait=randomUUID(), idle=randomUUID(), unloaded=randomUUID(), unrelated=randomUUID();
  const local=new Map([[idle,{type:'idle'}]]), localCalls=[];
  remote.loaded.set(active,{type:'active',activeFlags:[]});
  remote.loaded.set(wait,{type:'active',activeFlags:['waitingOnApproval']});
  remote.loaded.set(unrelated,{type:'active',activeFlags:[]});
  global.__codexWorkflowHost={appServerManagersService:{},hostAppServerManagers:{getCurrent:()=>({resource:{manager:{getConversation:()=>undefined}}})},getLocalAppServerClient:()=>({async sendAppServerRequest(method,params){
    localCalls.push({method,params});
    if(method==='thread/loaded/list')return {data:[...local.keys()],nextCursor:null};
    assert.equal(method,'thread/read');assert.equal(params.includeTurns,false);assert(local.has(params.threadId));
    return {thread:{id:params.threadId,status:local.get(params.threadId)}};
  }})};
  process.env.CODEX_WORKFLOW_OBSERVER_IPC_URLS=remote.url;
  try {
    const before=[...remote.loaded.keys()];
    let snapshots=await workflowSnapshots([active,wait,idle,unloaded]);
    assert.equal(snapshots.get(active).runtime,'active','A running thread on another manager must remain running');
    assert.equal(snapshots.get(wait).runtime,'active');assert.equal(snapshots.get(wait).pending,1);assert.deepEqual(snapshots.get(wait).activeFlags,['waitingOnApproval']);
    assert.equal(snapshots.get(idle).runtime,'idle');assert.equal(snapshots.get(unloaded).runtime,'notLoaded');
    assert.deepEqual([...remote.loaded.keys()],before,'Read-only observation must not load or unload a thread');
    assert(!remote.calls.some(call=>call.params.threadId===unrelated));
    assert(!localCalls.some(call=>call.params.threadId===active));
    console.log('PASS: Cross-manager active and approval states, relevant loaded reads only, no history or ownership changes');

    remote.loaded.delete(active);local.set(active,{type:'active',activeFlags:['waitingOnUserInput']});
    snapshots=await workflowSnapshots([active]);
    assert.deepEqual(snapshots.get(active).activeFlags,['waitingOnUserInput']);assert.equal(snapshots.get(active).pending,1);
    local.set(active,{type:'idle'});snapshots=await workflowSnapshots([active]);assert.equal(snapshots.get(active).runtime,'idle');assert.equal(snapshots.get(active).pending,0);
    console.log('PASS: Subsequent resume, waiting input and idle transitions replace previous observations');

    await remote.close();snapshots=await workflowSnapshots([unloaded,idle]);assert.equal(snapshots.get(unloaded).runtime,'unknown');assert.equal(snapshots.get(idle).runtime,'unknown','An idle local manager cannot prove inactivity when another manager is unavailable');
    local.set(active,{type:'active',activeFlags:[]});snapshots=await workflowSnapshots([active]);assert.equal(snapshots.get(active).runtime,'active');
    console.log('PASS: Unavailable peer blocks idle confirmation while a directly observed active state remains active');

    const silent=await bridge(), reader=new RuntimeReader(silent.url,50);
    try{silent.loaded.set(active,{type:'active',activeFlags:[]});assert.equal((await reader.snapshot([active])).states.get(active).runtime,'active');silent.silent=true;const failed=await reader.snapshot([active]);assert.equal(failed.available,false);assert.equal(failed.states.has(active),false)}
    finally{reader.close();await silent.close()}
    console.log('PASS: Response timeout clears previous active observations');
    const delayed=await bridge(), concurrentReader=new RuntimeReader(delayed.url,150);
    try{
      delayed.loaded.set(active,{type:'active',activeFlags:[]});delayed.loaded.set(wait,{type:'active',activeFlags:['waitingOnApproval']});
      delayed.delays.set(active,180);delayed.delays.set(wait,100);
      const slow=concurrentReader.snapshot([active]);
      await new Promise(resolve=>setTimeout(resolve,80));
      const waiting=concurrentReader.snapshot([wait]);
      const [slowResult,waitingResult]=await Promise.all([slow,waiting]);
      assert.equal(slowResult.states.get(active).runtime,'unknown');
      assert.equal(waitingResult.states.get(wait).runtime,'active');assert.equal(waitingResult.states.get(wait).pending,1);
      assert.equal(delayed.peers.size,1,'A slow thread must not disconnect the observer and cancel other reads');
    }finally{concurrentReader.close();await delayed.close()}
    console.log('PASS: One slow thread does not cancel concurrent status reads or reconnect the renderer');
    assert.throws(()=>new RuntimeReader('ws://example.com/__backend/ipc'),/loopback/);
    assert.throws(()=>new RuntimeReader('wss://127.0.0.1/__backend/ipc'),/loopback/);
    console.log('PASS: Observer endpoints are restricted to loopback WebSockets');
  }finally{
    closeRuntimeObservers();for(const socket of remote.peers)socket.terminate();if(remote.server.address())await remote.close();
    global.__codexWorkflowHost=previousHost;
    if(previousUrls===undefined)delete process.env.CODEX_WORKFLOW_OBSERVER_IPC_URLS;else process.env.CODEX_WORKFLOW_OBSERVER_IPC_URLS=previousUrls;
  }
})().catch(error=>{console.error(error);process.exitCode=1});
