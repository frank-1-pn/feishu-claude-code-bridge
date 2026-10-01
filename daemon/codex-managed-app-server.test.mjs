import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {managedTurnRequest,verifyManagedDescriptor,withManagedThread,inspectManagedThread,submitManagedTurn} from './codex-managed-app-server.mjs';
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
