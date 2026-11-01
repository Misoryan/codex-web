const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function coordinator(source) {
  const tree = ts.createSourceFile('queue.js', source, 99, true, ts.ScriptKind.JS);
  const matches = [];
  function visit(node) {
    if (ts.isClassExpression(node) && node.members.some(member => ts.isConstructorDeclaration(member) && member.getText(tree).includes('Failed to initialize queued message execution'))) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(matches.length, 1);
  const node = matches[0];
  const constructor = node.members.find(ts.isConstructorDeclaration);
  let factory;
  function find(child) {
    if (ts.isBinaryExpression(child) && child.left.getText(tree) === 'this.submission' && ts.isCallExpression(child.right)) factory = child.right;
    ts.forEachChild(child, find);
  }
  find(constructor);
  assert(factory);
  let text = node.getText(tree), start = node.getStart(tree);
  text = text.slice(0, factory.getStart(tree) - start) + '({})' + text.slice(factory.end - start);
  text = text.replace(/^class extends [^{]+\{/, 'class extends FixtureBase {');
  const read = node.members.find(member => member.name?.getText(tree) === 'read');
  const empty = read.getText(tree).match(/messages:\s*\w+\s*\?\?\s*([\w$]+)/)?.[1];
  assert(empty);
  return vm.runInNewContext(`(${text})`, {FixtureBase:class{},[empty]: [], Y: value => value, n:{bs:value=>value}, console});
}
function fixture(Queue) {
  const threadId = 'fixture-thread';
  let state = {}, broadcast;
  const timeline = [], warnings = [];
  const value = {role:{role:'follower',ownerClientId:'desktop-owner'}, failRead:false, failWrite:false, afterRead:null, loads:0};
  let queue;
  const options = {
    hostId:'local', getStreamRole:()=>value.role,
    storage:{read:()=>({isLoading:false,value:state}),load:async()=>{value.loads++;if(value.failRead)throw Error('fixture unavailable');const result=plain(state);if(value.afterRead){const fn=value.afterRead;value.afterRead=null;await fn();}return result;}},
    coordination:{registerBroadcastHandler:callback=>(broadcast=callback,()=>{})},
    execution:()=>({subscribe:()=>()=>{}}),
    logger:{error:(_message,details)=>{throw details.sensitive.error;},warning:message=>warnings.push(message)},
    onQueueChanged:()=>{if(queue)timeline.push(plain(queue.read(threadId).messages));},
    requestFollower:async(id,next)=>{
      if(value.failWrite)return{resultType:'error',error:'fixture write failed'};
      state=plain(next);
      // A snapshot emitted before this write can arrive before its response.
      broadcast({params:{conversationId:id,messages:[]},sourceClientId:'desktop-owner'});
      return{resultType:'success'};
    },
  };
  queue = new Queue(options);
  const emit = (messages=[],sourceClientId='desktop-owner',conversationId=threadId) => broadcast({params:{conversationId,messages},sourceClientId});
  return {queue,options,value,timeline,warnings,emit,threadId,
    get state(){return state;},set state(next){state=plain(next);},
    async append(message){queue.mutate(threadId,items=>[...items,message]);await queue.pendingQueueWrites;await tick();},
    async settle(){await tick();await Promise.all(queue.codexWebFollowerReads?.values()??[]);await tick();},
    messages:()=>plain(queue.read(threadId).messages),
  };
}
async function verify(Queue) {
  const f = fixture(Queue), first={id:'first',text:'queued fixture'}, second={id:'second',text:'second fixture'};
  await f.queue.executionReady;
  await f.append(first);
  assert.deepEqual(f.messages(),[first],'An accepted queue entry cannot disappear when an old empty broadcast arrives during its write');
  assert(f.timeline.every(messages=>messages.some(item=>item.id===first.id)),'No empty frame after optimistic acceptance');
  f.emit([]);await f.settle();assert.deepEqual(f.messages(),[first],'A delayed old broadcast after acknowledgement rereads durable state');
  const reloaded=new Queue({...f.options,execution:undefined});assert.deepEqual(plain(reloaded.read(f.threadId).messages),f.messages(),'Refreshing shows the same queue');reloaded.dispose();
  f.queue.mutate(f.threadId,items=>[...items,second]);
  f.queue.mutate(f.threadId,items=>[...items,{id:'third',text:'rapid follow-up'}]);
  await f.queue.pendingQueueWrites;await tick();assert.equal(f.messages().length,3,'Rapid writes retain every accepted message');
  f.state={[f.threadId]:[second]};f.emit([first]);await f.settle();assert.deepEqual(f.messages(),[second],'Another client edit is reflected from committed state');
  f.value.afterRead=async()=>{f.state={[f.threadId]:[second,first]};f.emit([]);};
  f.emit([]);await f.settle();assert.deepEqual(f.messages(),[second,first],'A queue change while reading invalidates the earlier snapshot');
  f.value.failRead=true;f.emit([]);await f.settle();assert.deepEqual(f.messages(),[second,first],'A read failure preserves visible messages');
  f.value.failRead=false;f.state={};f.emit([first]);await f.settle();assert.deepEqual(f.messages(),[],'Executed or deleted queue entries still disappear');
  f.value.failRead=true;await f.append(first);assert.deepEqual(f.messages(),[first],'Readback failure cannot roll back an owner-accepted write');
  assert(f.warnings.length>=2);f.value.failRead=false;
  f.state={};f.emit([], 'unrelated-owner');await f.settle();assert.deepEqual(f.messages(),[first],'Broadcasts from a non-owner are ignored');
  f.state={[f.threadId]:[first]};f.value.failWrite=true;await f.append(second);assert.deepEqual(f.messages(),[first],'A rejected owner write rolls back only the rejected optimistic message');f.value.failWrite=false;
  f.value.afterRead=async()=>{f.value.role={role:'follower',ownerClientId:'new-owner'};};f.emit([]);await f.settle();assert.deepEqual(f.messages(),[first],'An old owner cannot change the queue after ownership changes');
  f.value.role={role:'follower',ownerClientId:'desktop-owner'};
  f.value.afterRead=async()=>{f.value.role={role:'follower',ownerClientId:'new-owner'};f.state={[f.threadId]:[second]};f.emit([], 'new-owner');};f.emit([]);await f.settle();assert.deepEqual(f.messages(),[second],'An old in-flight read cannot suppress a new owner broadcast');
  f.value.role={role:'follower',ownerClientId:'desktop-owner'};
  const beforeRead=f.value.loads;
  f.value.afterRead=async()=>f.emit([], 'desktop-owner', 'another-thread');
  const snapshot=await f.queue.codexWebReadFollowerQueue(f.threadId,'desktop-owner');
  assert(snapshot);await f.settle();assert.equal(f.value.loads-beforeRead,2,'Another thread notification cannot invalidate this thread readback');
  let reads=0;
  const prior=f.messages(), load=f.options.storage.load;
  f.options.storage.load=async()=>{reads++;await tick();f.emit([]);return plain(f.state);};
  await assert.rejects(f.queue.codexWebReadFollowerQueue(f.threadId,'desktop-owner'),/kept changing/);
  await f.settle();f.options.storage.load=load;assert(reads>=3);assert(reads<=6,'Continuous changes cannot cause unbounded readback attempts');assert.deepEqual(f.messages(),prior,'Readback contention preserves the confirmed queue');
  f.value.afterRead=async()=>f.queue.dispose();f.emit([]);await f.settle();assert.equal(f.queue.messages.size,0,'A read cannot restore a disposed coordinator');
  assert.equal(f.queue.codexWebQueueRevisions.size,0);assert.equal(f.queue.codexWebFollowerReads.size,0);
}
(async()=>{
  const {patchFollowerQueueSync}=await import('./follower-queue-sync-patch.mjs');
  for(const file of ['scratch/asar/webview/assets/app-shared-8bd9d0399038.js','scratch/asar/.vite/build/src-BJv5Mk7n.js']){
    const source=fs.readFileSync(file,'utf8');
    if(!source.includes('codexWebReadFollowerQueue')){
      const old=fixture(coordinator(source));await old.queue.executionReady;await old.append({id:'fixture',text:'queued'});
      assert.deepEqual(old.timeline.map(items=>items.length),[1,0]);assert.equal(old.messages().length,0);assert.equal(old.state[old.threadId].length,1);old.queue.dispose();
    }
    const patched=patchFollowerQueueSync(source);assert.equal(patchFollowerQueueSync(patched),patched);
    await verify(coordinator(patched));
    console.log(`PASS ${file}: stale broadcasts, rapid writes, peer edits/deletion, rejected writes, read races/failure, per-thread isolation, bounded retries, owner changes and disposal`);
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
