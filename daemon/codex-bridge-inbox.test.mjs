import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableInbox, normalizeEvent } from './codex-bridge-inbox.mjs';

function fixture(t, overrides={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const rollout=path.join(root,'rollout.jsonl'); fs.writeFileSync(rollout,'');
  const sent=[], injected=[]; let now=1000;
  const io={prepare:async e=>e,target:async()=>({rollout}),inject:async j=>{injected.push(j.id);},
    send:async(text,key)=>sent.push({text,key}),...overrides};
  const open=()=>new DurableInbox(root,'test',io,{now:()=>now,timeoutMs:1000});
  const append=(...items)=>fs.appendFileSync(rollout,items.map(i=>JSON.stringify(i)+'\n').join(''));
  return {root,rollout,sent,injected,open,append,setNow:v=>{now=v;},q:open()};
}
const event=(id,type='text',content='hello')=>({message_id:`om_${id}`,message_type:type,content});
const marker=id=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`[飞书消息｜test｜om_${id}] 正文`}]}});
const answer=(text='中文答复',phase='final_answer')=>({type:'response_item',payload:{type:'message',role:'assistant',phase,content:[{type:'output_text',text}]}});

test('three messages dispatch before first final; one combined response is sent once',async t=>{
  const f=fixture(t); for(const id of ['a','b','c'])f.q.enqueue(event(id));
  for(let i=0;i<3;i++)await f.q.dispatchOne();
  assert.deepEqual(f.injected,['om_a','om_b','om_c']); assert.equal(f.sent.length,0);
  f.append(marker('a'),marker('b'),marker('c'),answer()); await f.q.watch(); await f.q.deliverReplies();
  assert.equal(f.sent.length,1);assert.equal(f.q.stats().completed_count,3);
});
test('distinct turns receive distinct answers; unrelated early final is ignored',async t=>{
  const f=fixture(t); f.q.enqueue(event('a')); await f.q.dispatchOne();
  f.append(answer('unrelated'),marker('a'),answer('A'));
  f.q.enqueue(event('b'));await f.q.dispatchOne();f.append(marker('b'),answer('B'));
  await f.q.watch();await f.q.deliverReplies();assert.deepEqual(f.sent.map(x=>x.text),['A','B']);
});
test('restart reconciles submitted marker without reinjection and preserves queued next message',async t=>{
  const f=fixture(t);f.q.enqueue(event('a'));f.q.enqueue(event('b'));await f.q.dispatchOne();
  f.append(marker('a'));const q=f.open();await q.watch();await q.dispatchOne();
  assert.deepEqual(f.injected,['om_a','om_b']);f.append(marker('b'),answer());await q.watch();await q.deliverReplies();
  assert.equal(q.stats().completed_count,2);
});
test('duplicates remain deduplicated across restart',async t=>{
  const f=fixture(t);f.q.enqueue(event('a'));f.q.enqueue(event('a'));await f.q.dispatchOne();
  const q=f.open();q.enqueue(event('a'));await q.dispatchOne();assert.equal(f.injected.length,1);
});
test('restart preserves queued arrival order independent of hashed filenames',async t=>{
  const f=fixture(t);for(const id of ['z','a','x','b'])f.q.enqueue(event(id));
  const q=f.open();for(let i=0;i<4;i++)await q.dispatchOne();
  assert.deepEqual(f.injected,['om_z','om_a','om_x','om_b']);
});
test('uncertain submission never blindly retries but accepts late marker',async t=>{
  const f=fixture(t,{inject:async()=>{throw Error('CLI timed out after accepting');}});
  f.q.enqueue(event('a'));await f.q.dispatchOne();const q=f.open();await q.dispatchOne();
  assert.equal(q.jobs.get('om_a').transportUncertain,true);f.append(marker('a'),answer());await q.watch();await q.deliverReplies();
  assert.equal(q.stats().completed_count,1);
});
test('failed attachment does not block subsequent text',async t=>{
  const f=fixture(t,{prepare:async e=>{if(e.message_type==='image')throw Error('download');return e;}});
  f.q.enqueue(event('a','image'));f.q.enqueue(event('b'));await f.q.dispatchOne();await f.q.dispatchOne();
  assert.deepEqual(f.injected,['om_b']);assert.equal(f.q.jobs.get('om_a').status,'queued');
});
test('failed sends retry same outbox key without re-running model',async t=>{
  let count=0;const keys=[];const f=fixture(t,{send:async(_,key)=>{keys.push(key);if(++count===1)throw Error('network');}});
  f.q.enqueue(event('a'));await f.q.dispatchOne();f.append(marker('a'),answer());await f.q.watch();
  await f.q.deliverReplies();assert.equal(f.q.stats().reply_pending_count,1);
  const q=f.open();await q.deliverReplies();assert.equal(q.stats().completed_count,1);
  assert.equal(keys[0],keys[1]);assert.equal(f.injected.length,1);
});
test('partial UTF-8 JSONL writes are re-read without losing bytes',async t=>{
  const f=fixture(t);f.q.enqueue(event('a'));await f.q.dispatchOne();
  const data=Buffer.from(JSON.stringify(marker('a'))+'\n'+JSON.stringify(answer())+'\n');
  const cut=data.indexOf(Buffer.from('中文'))+1;fs.appendFileSync(f.rollout,data.subarray(0,cut));
  await f.q.watch();assert.equal(f.q.jobs.get('om_a').status,'delivered');
  fs.appendFileSync(f.rollout,data.subarray(cut));await f.q.watch();await f.q.deliverReplies();assert.equal(f.sent[0].text,'中文答复');
});
test('current final phase and task completion are supported without duplicate reply',async t=>{
  const f=fixture(t);f.q.enqueue(event('a'));await f.q.dispatchOne();
  f.append(marker('a'),answer('done','final'),{type:'event_msg',payload:{type:'task_complete',last_agent_message:'done'}});
  await f.q.watch();await f.q.deliverReplies();await f.q.watch();await f.q.deliverReplies();assert.equal(f.sent.length,1);
});
test('large screenshot/tool JSONL line cannot block markers and final after it',async t=>{
  const f=fixture(t);f.q.enqueue(event('a'));await f.q.dispatchOne();
  f.append({type:'response_item',payload:{type:'custom_tool_call_output',output:'x'.repeat(3*1024*1024)}},marker('a'),answer('after large tool'));
  await f.q.watch();await f.q.deliverReplies();assert.equal(f.q.stats().completed_count,1);assert.equal(f.sent[0].text,'after large tool');
});
test('timeout does not lose later reply or re-execute request',async t=>{
  const f=fixture(t);f.q.enqueue(event('a'));await f.q.dispatchOne();f.setNow(3000);await f.q.watch();await f.q.deliverReplies();
  assert.equal(f.q.jobs.get('om_a').status,'submitted');f.append(marker('a'),answer());await f.q.watch();await f.q.deliverReplies();
  assert.equal(f.injected.length,1);assert.equal(f.q.stats().completed_count,1);
});
test('delivery stall age measures submission rather than old queued or delivered work',async t=>{
  const f=fixture(t);f.q.enqueue(event('a'));await f.q.dispatchOne();f.append(marker('a'));await f.q.watch();
  f.q.enqueue(event('b'));f.setNow(200000);await f.q.dispatchOne();
  assert.ok(f.q.stats().oldest_pending_seconds>120);assert.equal(f.q.stats().oldest_undelivered_seconds,0);
});
test('normalizes compact images, JSON files and post images; does not fetch text resembling resource key',()=>{
  assert.equal(normalizeEvent(event('a','image','[Image: img_v3_hello-world]')).resources[0].key,'img_v3_hello-world');
  const n=normalizeEvent(event('a','file',JSON.stringify({file_key:'file_v3_key',file_name:'../../evil.exe'})));
  assert.equal(n.resources[0].kind,'file');assert.equal(n.resources[0].name,'../../evil.exe');
  assert.equal(normalizeEvent(event('a','post',JSON.stringify({content:[[{tag:'img',image_key:'img_v3_k'}]]}))).resources.length,1);
  assert.equal(normalizeEvent(event('a','text','img_v3_key')).resources.length,0);
});
test('rejects invalid IDs and preserves corrupt queue evidence instead of dropping it',t=>{
  const f=fixture(t);assert.throws(()=>f.q.enqueue({message_id:'../../evil'}));
  f.q.enqueue(event('a'));const file=fs.readdirSync(path.join(f.root,'test')).find(n=>n.startsWith('job-'));
  fs.writeFileSync(path.join(f.root,'test',file),'{');assert.throws(()=>f.open());
});
