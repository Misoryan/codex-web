import assert from 'node:assert/strict';
import {subscribeSidebarSummary, subscribeSidebarListState, subscribeSidebarRpcListState} from '../src/browser/sidebar-status.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function createClient() {
  const summaries = new Map(), conversations = new Map(), subscribers = new Set(), reads = [], states = new Map();
  let failure = false;
  const client = {
    getThreadSummary: id => summaries.get(id),
    getConversation: id => conversations.get(id),
    subscribe(subscription) {
      subscribers.add(subscription);
      subscription.listener(subscription.field === 'listState' ? states.get(subscription.key.threadId) ?? null : subscription.field === 'summary'
        ? summaries.get(subscription.key.threadId)
        : conversations.get(subscription.key.threadId)?.threadRuntimeStatus);
      return () => subscribers.delete(subscription);
    },
    async readThread(id, options) {
      reads.push({id, options});
      if (failure) throw Error('Metadata unavailable');
      return {thread:{id,status:{type:'active',activeFlags:[]}}};
    },
  };
  return {client, reads, subscribers, summaries, conversations,
    state(id,value){states.set(id,value);for(const sub of subscribers)if(sub.field==='listState'&&sub.key.threadId===id)sub.listener(value);},
    fail(value) {failure=value;},
    summary(id, status) {
      const summary={title:'Unopened task',threadRuntimeStatus:{type:status}};
      summaries.set(id,summary);
      for(const sub of subscribers) if(sub.field==='summary'&&sub.key.threadId===id) sub.listener(summary);
    },
    runtime(id, status) {
      const value={type:status};
      conversations.set(id,{threadRuntimeStatus:value});
      for(const sub of subscribers) if(sub.field==='runtimeStatus'&&sub.key.threadId===id) sub.listener(value);
    },
  };
}

const f=createClient(), values=[];
f.summary('task','notLoaded');
const stop=subscribeSidebarSummary(f.client,{hostId:'local',threadId:'task'},v=>values.push(v));
await flush();
assert.equal(values.at(-1).threadRuntimeStatus.type,'active','An unopened task displays the metadata result');
f.runtime('task','idle');
assert.equal(values.at(-1).threadRuntimeStatus.type,'idle','Runtime changes clear the spinner without a summary change');
f.runtime('task','active');
assert.equal(values.at(-1).threadRuntimeStatus.type,'active','A new run updates an unopened row');
assert.equal(f.reads.length,1,'Runtime notifications do not reread history or metadata');
stop();
const count=values.length;
f.runtime('task','idle');
assert.equal(values.length,count);
assert.equal(f.subscribers.size,0,'Both subscriptions are released');

const retry=createClient(), retryValues=[];
retry.summary('task','notLoaded');retry.fail(true);
const warn=console.warn;console.warn=()=>{};
const retryStop=subscribeSidebarSummary(retry.client,{hostId:'local',threadId:'task'},v=>retryValues.push(v));
await flush();console.warn=warn;
retry.fail(false);retry.summary('task','notLoaded');await flush();
assert.equal(retryValues.at(-1).threadRuntimeStatus.type,'active','A failed initial read must not disable later hydration');
assert.equal(retry.reads.length,2);
assert(retry.reads.every(read=>read.options.includeTurns===false&&read.options.requestOptions.priority==='background'));
retryStop();

const batch=createClient();batch.summary('a','notLoaded');
const a=subscribeSidebarSummary(batch.client,{hostId:'local',threadId:'a'},()=>{});
const b=subscribeSidebarSummary(batch.client,{hostId:'local',threadId:'a'},()=>{});
await flush();assert.equal(batch.reads.length,1);a();b();

const slow=createClient(), slowValues=[];
slow.summary('slow','notLoaded');slow.summary('running','notLoaded');
const read=slow.client.readThread;
let finish;
slow.client.readThread=(id,options)=>id==='slow'?new Promise(resolve=>{finish=resolve;}):read(id,options);
const s=subscribeSidebarSummary(slow.client,{hostId:'local',threadId:'slow'},()=>{});
const r=subscribeSidebarSummary(slow.client,{hostId:'local',threadId:'running'},v=>slowValues.push(v));
await flush();
assert.equal(slowValues.at(-1).threadRuntimeStatus.type,'active','An unrelated unresolved read cannot delay a running row');
s();r();finish({thread:{status:{type:'idle'}}});await flush();

const race=createClient(), raceValues=[];
race.summary('task','notLoaded');
let resolveRead;
race.client.readThread=()=>new Promise(resolve=>{resolveRead=resolve;});
const raceStop=subscribeSidebarSummary(race.client,{hostId:'local',threadId:'task'},v=>raceValues.push(v));
await flush();race.runtime('task','idle');resolveRead({thread:{status:{type:'active',activeFlags:[]}}});await flush();
assert.equal(raceValues.at(-1).threadRuntimeStatus.type,'idle','A late metadata response cannot overwrite a newer notification');raceStop();
console.log('PASS: unopened row metadata, live runtime changes, failed-read recovery, deduplication, slow-read isolation, stale-response fencing and cleanup');

const row=createClient(), rowValues=[];
row.summary('task','notLoaded');
const rowStop=subscribeSidebarListState(row.client,{hostId:'local',threadId:'task'},v=>rowValues.push(v));
await flush();
assert.equal(rowValues.at(-1).isConversationInProgress,true,'The current listState path displays an unopened running task');
assert.equal(rowValues.at(-1).resumeState,'needs_resume');
row.runtime('task','idle');assert.equal(rowValues.at(-1).isConversationInProgress,false);
const resumed={summary:{title:'Loaded task'},resumeState:'resumed',isConversationInProgress:false,requests:[{id:'pending-request'}]};
row.state('task',resumed);assert.equal(rowValues.at(-1),resumed,'A resumed task keeps its complete native state');
row.state('task',{...resumed,resumeState:'needs_resume'});
row.runtime('task','active');
assert.equal(rowValues.at(-1).isConversationInProgress,true);
assert.equal(rowValues.at(-1).requests,resumed.requests);
rowStop();assert.equal(row.subscribers.size,0);
console.log('PASS: listState entry point, metadata projection, runtime updates, resumed state and pending requests preserved');

const rpcReads=[], rpcValues=[], rpcListeners=new Set();
const resource={};
const remote={rpc:{
  subscribe({listener}){rpcListeners.add(listener);listener(null);return resource;},
  async hydrateBackgroundThreads(ids,options){
    rpcReads.push({ids,options});
    for(const listener of rpcListeners)listener({summary:{threadRuntimeStatus:{type:'active'}},isConversationInProgress:true,resumeState:'needs_resume'});
  },
}};
assert.equal(subscribeSidebarRpcListState(remote,{hostId:'local',threadId:'rpc-task'},v=>rpcValues.push(v)),resource,'RPC retains its native disposable subscription resource');
subscribeSidebarRpcListState(remote,{hostId:'local',threadId:'rpc-task'},()=>{});
await flush();
assert.equal(rpcValues.at(-1).isConversationInProgress,true,'An unloaded RPC sidebar row receives hydrated runtime state');
assert.deepEqual(rpcReads,[{ids:['rpc-task'],options:{includeTurns:false,refreshExisting:true}}],'Concurrent RPC rows share one metadata-only hydration');
for(const listener of rpcListeners)listener({summary:{threadRuntimeStatus:{type:'idle'}},isConversationInProgress:false});
assert.equal(rpcValues.at(-1).isConversationInProgress,false);
assert.equal(rpcReads.length,1,'Known runtime notifications do not restart hydration');
console.log('PASS: native RPC sidebar subscription, metadata hydration, deduplication, runtime delivery and disposable resource preserved');
