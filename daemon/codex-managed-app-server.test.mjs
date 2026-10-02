import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ManagedConnection,managedTurnRequest,verifyManagedDescriptor,withManagedThread,inspectManagedThread,submitManagedTurn} from './codex-managed-app-server.mjs';
import {DurableInbox} from './codex-bridge-inbox.mjs';
const binding={bot:'fixture',codex_thread_id:'root-thread',cwd:'/fixture/workspace'};
const target={socketPath:'/fixture/owned-socket'};
const active={id:'root-thread',cwd:binding.cwd,status:{type:'active'},turns:[{id:'current-turn',status:'inProgress'}]};
const idle={...active,status:{type:'idle'},turns:[]};
function fixture({thread=active,loaded=['root-thread'],mutationError=false,ack=true}={}){
 const requests=[],notifications=[];let verifies=0,closes=0;
 const client={request:async(method,params)=>{requests.push({method,params});if(method==='thread/loaded/list')return {data:loaded};if(method==='thread/read')return {thread};if(method==='initialize')return {};
 if(method.startsWith('turn/')){if(mutationError)throw Error('managed_rpc_rejected');if(!ack)throw Error('managed_rpc_timeout');return method==='turn/steer'?{turnId:'current-turn'}:{turn:{id:'new-turn'}};}throw Error('unexpected_method');},notify:(...args)=>notifications.push(args),close:()=>closes++};
 return {requests,notifications,options:{connect:async()=>client,verify:()=>verifies++},verifies:()=>verifies,closes:()=>closes};
}
test('active root steer uses exact expectedTurnId and idle starts inherit settings without overrides',async()=>{
 for(const thread of [active,idle]){const f=fixture({thread});await submitManagedTurn(target,binding,'original prompt',f.options);
 const request=f.requests.at(-1);assert.equal(request.method,thread===active?'turn/steer':'turn/start');
 assert.deepEqual(Object.keys(request.params).sort(),thread===active?['expectedTurnId','input','threadId']:['input','threadId']);
 assert.deepEqual(request.params.input,[{type:'text',text:'original prompt'}]);assert.equal(f.closes(),1);assert.equal(f.verifies(),3);
 assert.deepEqual(f.notifications,[['initialized',{}]]);assert.deepEqual(Object.keys(f.requests[0].params),['clientInfo']);}
});
test('unloaded, fork/wrong ID, wrong cwd, ambiguous/blank active turn and notLoaded refuse any mutation',async()=>{
 for(const patch of [{id:'fork-thread',forkedFromId:'root-thread'},{cwd:'/other'},{turns:[]},{turns:[{id:'',status:'inProgress'}]},{turns:[...active.turns,...active.turns]},{status:{type:'notLoaded'}},{status:{type:'systemError'}}]){
 const f=fixture({thread:{...active,...patch}});await assert.rejects(submitManagedTurn(target,binding,'input',f.options),/managed_/);assert.equal(f.requests.filter(r=>r.method.startsWith('turn/')).length,0);assert.equal(f.closes(),1);
 }
 const f=fixture({loaded:['fork-thread']});await assert.rejects(submitManagedTurn(target,binding,'input',f.options),/not_loaded/);assert.equal(f.requests.some(r=>r.method==='thread/read'),false);
});
test('active ended-before-steer and idle became-active-before-start reject one mutation without fallback',async()=>{
 for(const thread of [active,idle]){const f=fixture({thread,mutationError:true});await assert.rejects(submitManagedTurn(target,binding,'input',f.options),/rejected/);
 assert.equal(f.requests.filter(r=>r.method.startsWith('turn/')).length,1);assert.equal(f.closes(),1);}
});
test('read-only inspection and failed exact identity checks never mutate or reconnect to another target',async()=>{
 const f=fixture();assert.deepEqual(await inspectManagedThread(target,binding,f.options),{status:'active'});assert.equal(f.requests.some(r=>r.method.startsWith('turn/')),false);
 let connected=0;await assert.rejects(withManagedThread(target,binding,()=>assert.fail(),{connect:async()=>{connected++;},verify:()=>{throw Error('identity_changed');}}),/identity_changed/);assert.equal(connected,0);
});
test('prepared queue resumes through managed target and uncertain ACK persists submitted across restart without replay',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-inbox-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const rollout=path.join(root,'rollout.jsonl');fs.writeFileSync(rollout,'');let attempts=0;const f=fixture({ack:false});
 const io={prepare:async e=>e,target:async()=>{await inspectManagedThread(target,binding,f.options);return {rollout};},inject:async()=>{attempts++;await submitManagedTurn(target,binding,'prompt',f.options);},send:async()=>{}};
 const open=()=>new DurableInbox(root,'fixture',io);const inbox=open();const job=inbox.enqueue({message_id:'om_source',content:'original'});job.prepared=job.event;job.attempts=3;inbox.save(job);
 await inbox.dispatchOne();assert.equal(job.status,'submitted');assert.equal(job.transportUncertain,true);assert.equal(attempts,1);
 const restart=open();await restart.dispatchOne();assert.equal(attempts,1);
 fs.appendFileSync(rollout,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'[飞书消息｜fixture｜om_source] original'}]}})+'\n');await restart.watch();assert.equal(restart.jobs.get(job.id).status,'delivered');
});

test('changed daemon record, writer identity or socket inode fails before a new transport is used',()=>{
 const scope={transport:'managed_app_server',home:'/fixture/home',threadId:binding.codex_thread_id,writer_pid:42,socketPath:'/fixture/socket',socketDev:1,socketIno:2,record:{pid:42,processIdentity:{uniqueId:7}}};
 assert.doesNotThrow(()=>verifyManagedDescriptor(scope,binding,()=>structuredClone(scope)));
 for(const patch of [{writer_pid:43},{socketIno:3},{home:'/other-home'},{socketPath:'/other-socket'},{record:{pid:42,processIdentity:{uniqueId:8}}}])assert.throws(()=>verifyManagedDescriptor(scope,binding,()=>({...scope,...patch})),/changed/);
 assert.throws(()=>verifyManagedDescriptor({...scope,threadId:'fork'},binding,()=>scope),/scope/);
});
test('identity changing after read cannot permit a mutation even on the same connection',async()=>{
 const f=fixture();let count=0;await assert.rejects(submitManagedTurn(target,binding,'input',{...f.options,verify:()=>{if(++count===3)throw Error('identity_changed');}}),/identity_changed/);
 assert.equal(f.requests.filter(r=>r.method.startsWith('turn/')).length,0);assert.equal(f.closes(),1);
});

function reusableFixture(t) {
 let thread=structuredClone(idle),loaded=['root-thread'],connections=0,closes=0,verifyCount=0,mutationError=null,readGate;
 const calls=[];
 const manager=new ManagedConnection({verify:()=>verifyCount++,connect:async()=>{
  connections++;let closed=false;
  return {get closed(){return closed;},close(){if(!closed){closed=true;closes++;}},notify:(method)=>calls.push({method}),request:async(method,params)=>{
   calls.push({method,params});if(method==='initialize')return {};
   if(method==='thread/loaded/list')return {data:loaded};
   if(method==='thread/read'){if(readGate)await readGate;return {thread:structuredClone(thread)};}
   if(mutationError)throw mutationError;
   return method==='turn/start'?{turn:{id:'new-turn'}}:{turnId:params.expectedTurnId};
  }};
 }});
 t.after(()=>manager.close());
 return {manager,calls,setThread:v=>thread=v,setLoaded:v=>loaded=v,setError:v=>mutationError=v,setGate:v=>readGate=v,
  connections:()=>connections,closes:()=>closes,verifies:()=>verifyCount};
}
test('managed connection reuses one initialize while every operation lists loaded and reads the latest turn',async t=>{
 const f=reusableFixture(t);await f.manager.inspect(target,binding);
 f.setThread(active);await f.manager.submit(target,binding,'first');
 f.setThread(idle);await f.manager.submit(target,binding,'second');
 assert.equal(f.connections(),1);assert.equal(f.calls.filter(c=>c.method==='initialize').length,1);
 assert.equal(f.calls.filter(c=>c.method==='thread/loaded/list').length,3);
 assert.equal(f.calls.filter(c=>c.method==='thread/read').length,3);
 assert.deepEqual(f.calls.filter(c=>c.method.startsWith('turn/')).map(c=>c.method),['turn/steer','turn/start']);
 assert.equal(f.verifies(),6);assert.equal(f.closes(),0);
});
test('unloaded cached thread with readable persisted history cannot mutate and discards the connection',async t=>{
 const f=reusableFixture(t);await f.manager.inspect(target,binding);f.setLoaded([]);
 await assert.rejects(f.manager.submit(target,binding,'input'),/not_loaded/);
 assert.equal(f.calls.filter(c=>c.method==='thread/read').length,1);
 assert.equal(f.calls.filter(c=>c.method.startsWith('turn/')).length,0);assert.equal(f.closes(),1);
 f.setLoaded(['root-thread']);await f.manager.inspect(target,binding);assert.equal(f.connections(),2);
});
test('descriptor or binding changes invalidate reusable transport; inspection reconnects with only reads',async t=>{
 const f=reusableFixture(t);await f.manager.inspect(target,binding);
 for(const patch of [{socketIno:8},{writerLock:{ino:9}},{record:{pid:42,processIdentity:{bootId:'changed',uniqueId:8,startSeconds:1}}},{home:'/other'}]) {
  await f.manager.inspect({...target,...patch},binding);
 }
 assert.equal(f.connections(),5);assert.equal(f.closes(),4);assert.equal(f.calls.some(c=>c.method.startsWith('turn/')),false);
});
test('full descriptor comparison includes boot/start, lock inode, record and socket metadata',()=>{
 const scope={home:'/fixture/home',threadId:binding.codex_thread_id,writer_pid:42,socketPath:'/fixture/socket',socketDev:1,socketIno:2,
  writerLock:{dev:1,ino:2,ctimeMs:3},record:{pid:42,processIdentity:{bootId:'boot',uniqueId:7,startSeconds:8,startMicroseconds:9}}};
 for(const patch of [{writerLock:{dev:1,ino:3,ctimeMs:3}},{socketDev:9},{record:{...scope.record,processIdentity:{...scope.record.processIdentity,bootId:'new'}}},
  {record:{...scope.record,processIdentity:{...scope.record.processIdentity,startMicroseconds:10}}}])assert.throws(()=>verifyManagedDescriptor(scope,binding,()=>({...scope,...patch})),/changed/);
});
test('warm connection repeats descriptor validation immediately before one mutation and fails closed',async t=>{
 const f=reusableFixture(t);await f.manager.inspect(target,binding);
 let verifies=0;f.manager.verify=()=>{if(++verifies===2)throw Error('identity_changed');};
 await assert.rejects(f.manager.submit(target,binding,'input'),/identity_changed/);
 assert.equal(f.calls.filter(c=>c.method.startsWith('turn/')).length,0);assert.equal(f.closes(),1);
});
test('unknown mutation ACK is not replayed or reconnected; next independent inspection is read only',async t=>{
 const f=reusableFixture(t);await f.manager.inspect(target,binding);f.setError(Error('managed_rpc_timeout'));
 await assert.rejects(f.manager.submit(target,binding,'input'),/timeout/);
 assert.equal(f.calls.filter(c=>c.method.startsWith('turn/')).length,1);assert.equal(f.connections(),1);assert.equal(f.closes(),1);
 f.setError(null);await f.manager.inspect(target,binding);
 assert.equal(f.connections(),2);assert.equal(f.calls.filter(c=>c.method.startsWith('turn/')).length,1);
});
test('parallel calls serialize read/mutation pairs and preserve a current expectedTurnId',async t=>{
 const f=reusableFixture(t);await f.manager.inspect(target,binding);let release;
 f.setGate(new Promise(resolve=>release=resolve));
 const first=f.manager.submit(target,binding,'first'),second=f.manager.submit(target,binding,'second');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.filter(c=>c.method==='thread/read').length,2);
 f.setThread(active);release();await Promise.all([first,second]);
 const mutations=f.calls.filter(c=>c.method.startsWith('turn/'));assert.equal(mutations.length,2);
 assert.ok(mutations.every(c=>c.params.expectedTurnId==='current-turn'));
 const tail=f.calls.slice(4).map(c=>c.method);assert.deepEqual(tail,['thread/loaded/list','thread/read','turn/steer','thread/loaded/list','thread/read','turn/steer']);
});
test('shutdown closes idle clients and a pending read cannot mutate or leave queued operations alive',async t=>{
 const f=reusableFixture(t);await f.manager.inspect(target,binding);let release;
 f.setGate(new Promise(resolve=>release=resolve));
 const pending=f.manager.submit(target,binding,'pending'),queued=f.manager.submit(target,binding,'queued');
 await new Promise(resolve=>setImmediate(resolve));f.manager.close();release();
 await assert.rejects(pending,/closed/);await assert.rejects(queued,/closed/);
 assert.equal(f.closes(),1);assert.equal(f.calls.filter(c=>c.method.startsWith('turn/')).length,0);
});
test('shutdown racing socket connect closes the late socket without initialization',async()=>{
 let release,closes=0;const manager=new ManagedConnection({verify:()=>{},connect:()=>new Promise(resolve=>release=resolve)});
 const pending=manager.inspect(target,binding);await new Promise(resolve=>setImmediate(resolve));manager.close();
 release({close:()=>closes++,request:()=>assert.fail('no initialize on late socket')});
 await assert.rejects(pending,/closed/);assert.equal(closes,1);
});
test('a failed current identity check evicts a warm connection before any read or reconnect',async t=>{
 const f=reusableFixture(t);await f.manager.inspect(target,binding);const before=f.calls.length;
 f.manager.verify=()=>{throw Error('managed_target_changed');};
 await assert.rejects(f.manager.inspect(target,binding),/changed/);
 assert.equal(f.calls.length,before);assert.equal(f.closes(),1);assert.equal(f.connections(),1);
});
test('warm latest read rejects changed cwd, fork and invalid active state before mutation',async t=>{
 for(const patch of [{id:'fork'},{cwd:'/other'},{turns:[]},{status:{type:'notLoaded'}}]) {
  const f=reusableFixture(t);await f.manager.inspect(target,binding);f.setThread({...active,...patch});
  await assert.rejects(f.manager.submit(target,binding,'input'),/managed_/);
  assert.equal(f.calls.some(c=>c.method.startsWith('turn/')),false);assert.equal(f.closes(),1);
 }
});
test('pooled unknown ACK remains submitted through durable restart and late marker without reexecution',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pool-inbox-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const rollout=path.join(root,'rollout');fs.writeFileSync(rollout,'');const f=reusableFixture(t);f.setError(Error('managed_rpc_timeout'));
 const io={prepare:async e=>e,target:async()=>{await f.manager.inspect(target,binding);return {rollout};},inject:()=>f.manager.submit(target,binding,'input')};
 const inbox=new DurableInbox(root,'fixture',io);const job=inbox.enqueue({message_id:'om_pool'});await inbox.dispatchOne();
 assert.equal(job.transportUncertain,true);assert.equal(job.status,'submitted');
 const restart=new DurableInbox(root,'fixture',io);assert.equal(await restart.dispatchOne(),false);
 assert.equal(f.calls.filter(c=>c.method.startsWith('turn/')).length,1);
 fs.appendFileSync(rollout,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'[飞书消息｜fixture｜om_pool]'}]}})+'\n');
 await restart.watch();assert.equal(restart.jobs.get(job.id).status,'delivered');
 assert.equal(f.calls.filter(c=>c.method.startsWith('turn/')).length,1);
});
