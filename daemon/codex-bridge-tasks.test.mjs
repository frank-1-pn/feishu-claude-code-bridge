import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {NativeTasks,taskDue,taskPayload} from './codex-bridge-tasks.mjs';
const binding={bot:'test',profile:'chosen',chat_id:'oc_test',allowed_sender_id:'ou_test',codex_thread_id:'thread-test'};
const result={task:{guid:'12345678-1234-1234-1234-123456789abc',url:'https://applink.feishu.cn/client/todo/detail?guid=12345678-1234-1234-1234-123456789abc'}};
const input={key:'one',values:{summary:'Check report',due:'2026-09-28 18:30',reminder:'30'},answer:'An answer'};
function fixture(t,request){const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-tasks-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let clock=1000;return {root,advance:n=>clock+=n,open:()=>new NativeTasks({root,binding,request,now:()=>clock})};}
test('task dates are strict Beijing dates and reminders require a deadline',()=>{
 assert.deepEqual(taskDue('2026-09-28 18:30'),{timestamp:String(Date.UTC(2026,8,28,10,30)),is_all_day:false});
 assert.deepEqual(taskDue('2026-09-28'),{timestamp:String(Date.UTC(2026,8,28)),is_all_day:true});assert.equal(taskDue(''),undefined);
 assert.equal(taskDue('2024-02-29').timestamp,String(Date.UTC(2024,1,29)));
 assert.equal(taskDue('2026-09-28 00:00').timestamp,String(Date.UTC(2026,8,27,16)));
 for(const value of ['2026-02-30','2026-13-01','2026-01-01 24:00','tomorrow','2026-01-01Z'])assert.throws(()=>taskDue(value));
 assert.throws(()=>taskPayload(binding,{summary:'Task',reminder:'30'},'one'));
 assert.throws(()=>taskPayload(binding,{summary:'Task',assignee:'ou_other'},'one'));
 const p=taskPayload(binding,input.values,'one');assert.deepEqual(p.members,[{id:'ou_test',type:'user',role:'assignee'}]);assert.equal(p.reminders[0].relative_fire_minute,30);
 for(const value of [null,{},[],123])assert.throws(()=>taskDue(value),error=>error.permanent);
 for(const values of [{summary:7},{summary:'x',due:123},{summary:'x',reminder:15},{summary:'x',recipient:'ou_other'},{summary:'x',members:[]}])
  assert.throws(()=>taskPayload(binding,values,'one'),error=>error.permanent);
 assert.equal(taskPayload(binding,{summary:'x',due:'2026-09-28',reminder:'0'},'one').reminders[0].relative_fire_minute,0);
});
test('task create remains exactly one API call for concurrent, repeated and restarted operations',async t=>{
 let calls=0;const f=fixture(t,async(b,args)=>{calls++;assert.equal(b.profile,'chosen');const p=JSON.parse(args.at(-1));assert.equal(p.members[0].id,'ou_test');return result;});
 const tasks=f.open();const values=await Promise.all([tasks.create(input),tasks.create(input)]);assert.equal(values[0].status,'done');assert.equal(calls,1);
 await f.open().create(input);assert.equal(calls,1);
 await assert.rejects(()=>f.open().create({...input,values:{...input.values,summary:'changed'}}),/task_payload_changed/);
});
test('uncertain response retries identical payload only within five-minute server dedup window',async t=>{
 const bodies=[];const f=fixture(t,async(_b,args)=>{bodies.push(args.at(-1));if(bodies.length===1)throw Object.assign(Error('lost'),{code:'ETIMEDOUT'});return result;});
 assert.equal((await f.open().create(input)).status,'pending');f.advance(5000);
 assert.equal((await f.open().create(input)).status,'done');assert.equal(bodies[0],bodies[1]);
});
test('expired uncertain result does not create a duplicate on restart',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;throw Object.assign(Error('lost'),{code:'ECONNRESET'});});
 await f.open().create(input);f.advance(240000);const state=await f.open().create(input);
 assert.equal(state.status,'uncertain');assert.equal(calls,1);await f.open().create(input);assert.equal(calls,1);
});
test('permission failures are bounded and private error bodies never persist',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;throw Object.assign(Error('private-value-must-not-persist'),{apiCode:99991672,type:'permission'});});
 assert.equal((await f.open().create(input)).status,'blocked');await f.open().create(input);assert.equal(calls,1);
 const scan=d=>fs.readdirSync(d,{withFileTypes:true}).map(e=>e.isDirectory()?scan(path.join(d,e.name)):fs.readFileSync(path.join(d,e.name),'utf8')).join('');assert.ok(!scan(f.root).includes('private-value-must-not-persist'));
});

test('concurrent changed payload is rejected rather than falsely sharing another callers success',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;return result;});const tasks=f.open();
 const outcomes=await Promise.allSettled([tasks.create(input),tasks.create({...input,values:{...input.values,summary:'another task'}})]);
 assert.equal(outcomes[0].status,'fulfilled');assert.equal(outcomes[1].status,'rejected');assert.match(outcomes[1].reason.message,/payload_changed/);assert.equal(calls,1);
});

test('full confirmed source input remains immutable even when the generated description truncates it',async t=>{
 const f=fixture(t,async()=>result),long='a'.repeat(5000);await f.open().create({...input,answer:long+'first'});
 await assert.rejects(f.open().create({...input,answer:long+'changed'}),/task_payload_changed/);
});

test('invalid stored state cannot send again or falsely claim a completed task',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;return result;});const tasks=f.open();await tasks.create(input);
 const file=path.join(tasks.root,fs.readdirSync(tasks.root)[0]),original=JSON.parse(fs.readFileSync(file,'utf8'));
 for(const patch of [{schema:0},{scope:'other'},{keyHash:'other'},{status:'unknown'},{firstAttemptAt:undefined},
  {firstAttemptAt:'1000'},{firstAttemptAt:NaN},{createdAt:9999999},{retryAt:'now'},{guid:'-'.repeat(36)},
  {url:'https://applink.feishu.cn/client/todo/task?guid=another'}]){
  fs.writeFileSync(file,JSON.stringify({...original,...patch}));await assert.rejects(f.open().create(input),/task_state_invalid/);
 }
 fs.writeFileSync(file,'{');await assert.rejects(f.open().create(input),/task_state_corrupt/);assert.equal(calls,1);
});

test('binding mutation and transplanted journals never retarget a confirmed operation',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;return result;});const tasks=f.open();await tasks.create(input);
 tasks.binding={...binding,allowed_sender_id:'ou_other'};await assert.rejects(tasks.create(input),/task_binding_changed/);
 const other=new NativeTasks({root:f.root,binding:{...binding,profile:'another'},request:async()=>{calls++;return result;},now:()=>1000});
 const name=fs.readdirSync(tasks.root)[0];fs.copyFileSync(path.join(tasks.root,name),path.join(other.root,name));
 await assert.rejects(other.create(input),/task_state_invalid/);assert.equal(calls,1);
 assert.throws(()=>new NativeTasks({root:f.root,binding:{...binding,bot:'../escape'},request:async()=>result}),/invalid_task_binding/);
});

test('invalid acknowledgement remains pending and expires without creating another task',async t=>{
 const responses=[{task:{...result.task,guid:'-'.repeat(36)}},{task:{...result.task,url:'https://applink.feishu.cn.evil.invalid/client/todo/task'}},
  {task:{...result.task,url:'https://user:pass@applink.feishu.cn/client/todo/task?guid='+result.task.guid}},
  {task:{...result.task,url:'https://applink.feishu.cn/client/todo/task?guid=other'}}];
 for(let i=0;i<responses.length;i++){
  let calls=0;const f=fixture(t,async()=>{calls++;return responses[i];});assert.equal((await f.open().create(input)).status,'pending');
  f.advance(240000);assert.equal((await f.open().create(input)).status,'uncertain');assert.equal(calls,1);
 }
});

test('source links reject credentials and deceptive hosts while preserving a real Feishu source',()=>{
 for(const sourceUrl of ['https://x.feishu.cn@evil.invalid/report','https://user:pass@docs.feishu.cn/report','https://docs.feishu.cn.evil.invalid/report'])
  assert.ok(!taskPayload(binding,input.values,'one',{sourceUrl}).description.includes(sourceUrl));
 assert.ok(taskPayload(binding,input.values,'one',{sourceUrl:'https://docs.feishu.cn/docx/fixture'}).description.includes('https://docs.feishu.cn/docx/fixture'));
 const long=taskPayload(binding,input.values,'one',{answer:'a'.repeat(5000),sourceUrl:'https://docs.feishu.cn/docx/fixture'}).description;
 assert.ok(Array.from(long).length<=2900);assert.ok(long.endsWith('https://docs.feishu.cn/docx/fixture'));
});
