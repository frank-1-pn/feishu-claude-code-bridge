import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableInbox, digest } from './codex-bridge-inbox.mjs';
import { TaskResultStore } from './codex-bridge-task-results.mjs';
import { bindingSnapshot } from './codex-bridge-ux.mjs';

const marker=id=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`[飞书消息｜fixture｜om_${id}] 正文`}]}});
const message=(text,phase='final')=>({type:'response_item',payload:{type:'message',role:'assistant',phase,content:[{type:'output_text',text}]}});
const proof={schema:1,at:1000,source:'send_response'};
function fixture(t,overrides={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'task-routing-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const rollout=path.join(root,'rollout.jsonl');fs.writeFileSync(rollout,'');
  const results=new Map(),links=new Map(),sent=[],progress=[],closed=[],injected=[];let now=1000;
  const io={perTaskResults:true,taskResultScope:{cwd:root,codexHome:root},classifiedFeedback:true,initialFeedbackCard:true,
    prepare:async e=>e,target:async()=>({rollout}),inject:async j=>injected.push(j.id),classification:()=> 'actionable',
    taskResults:{get:job=>links.has(job.id)?{linked:true,sourceJobId:job.id,ownerJobId:links.get(job.id),revision:0}:results.get(job.id)??null},
    progress:async(text,key,context)=>progress.push({text,key,...context}),
    final:async(text,key,keys,context)=>{sent.push({text,key,keys,context});return proof;},
    closeReplyCards:async(key,keys,context)=>closed.push({key,keys,...context}),...overrides};
  const open=()=>new DurableInbox(root,'fixture',io,{now:()=>now,timeoutMs:1000});const q=open();
  const append=(...items)=>fs.appendFileSync(rollout,items.map(i=>JSON.stringify(i)+'\n').join(''));
  const add=id=>q.enqueue({message_id:`om_${id}`,message_type:'text',content:id});
  const result=(id,text,status='complete',revision=1)=>{
    const value=Object.freeze({text,status,replyKey:digest(`result:${id}:${revision}`),ownerJobId:`om_${id}`,
      sourceJobId:`om_${id}`,resultKey:`result-${revision}`,linked:false,revision});results.set(`om_${id}`,value);return value;
  };
  return {root,rollout,io,q,open,append,add,result,results,links,sent,progress,closed,injected,setNow:value=>{now=value;}};
}
async function dispatch(f,ids){for(const id of ids)f.add(id);for(const _ of ids)await f.q.dispatchOne();f.append(...ids.map(marker));await f.q.watch();}

test('three same-turn structured results update only their original stable cards and use independent receipts',async t=>{
  const f=fixture(t);await dispatch(f,['a','b','c']);
  const keys=['a','b','c'].map(id=>f.q.jobs.get(`om_${id}`).streamKey);
  f.result('a','A');f.result('b','B');f.result('c','C');f.append(message('Unscoped combined answer'));
  await f.q.watch();await f.q.deliverReplies();
  assert.deepEqual(f.sent.map(s=>s.text),['A','B','C']);assert.equal(new Set(f.sent.map(s=>s.key)).size,3);
  assert.deepEqual(f.sent.map(s=>s.keys),keys.map(key=>[key]));
  for(const s of f.sent){assert.deepEqual(s.context.jobs.map(j=>j.id),[s.context.jobId]);assert.equal(s.context.taskResult.ownerJobId,s.context.jobId);}
  assert.equal(f.q.stats().completed_count,3);assert.equal(f.injected.length,3);
});

test('reverse completion order cannot cause an earlier task to consume a later task result or natural completion',async t=>{
  const f=fixture(t);await dispatch(f,['a','b','c']);
  f.result('c','C');f.append(message('C natural'),{type:'event_msg',payload:{type:'task_complete',last_agent_message:'C natural'}});
  await f.q.watch();await f.q.deliverReplies();assert.deepEqual(f.sent.map(s=>s.text),['C']);
  assert.equal(f.q.jobs.get('om_a').status,'delivered');assert.equal(f.q.jobs.get('om_b').status,'delivered');
  f.result('b','B');await f.q.deliverReplies();f.result('a','A');await f.q.deliverReplies();
  assert.deepEqual(f.sent.map(s=>s.text),['C','B','A']);
});

test('missing structured outputs and task_complete error leave v1 private diagnostics and continue watching without replay',async t=>{
  const f=fixture(t);await dispatch(f,['a','b']);
  f.append(message('unrelated final'),{type:'event_msg',payload:{type:'task_complete',error:{message:'Bad request'}}});
  await f.q.watch();await f.q.deliverReplies();assert.equal(f.sent.length,0);
  for(const j of f.q.jobs.values()){assert.equal(j.status,'delivered');assert.equal(j.taskResultProtocolBlocked,'turn_ended_without_task_result');assert.equal(j.notice,undefined);}
  assert.equal(f.q.stats().task_result_protocol_blocked_count,2);
  const q=f.open();f.result('a','late A');await q.watch();await q.deliverReplies();
  assert.deepEqual(f.sent.map(s=>s.text),['late A']);assert.equal(q.jobs.get('om_b').status,'delivered');assert.equal(f.injected.length,2);
});

test('legacy accepted jobs retain shared final behavior and never group with new v1 jobs after restart',async t=>{
  const f=fixture(t,{perTaskResults:false});f.add('old_a');f.add('old_b');f.io.perTaskResults=true;f.add('new');
  for(let i=0;i<3;i++)await f.q.dispatchOne();f.append(marker('old_a'),marker('old_b'),marker('new'),message('legacy shared'));
  const q=f.open();await q.watch();f.result('new','new only');await q.watch();await q.deliverReplies();
  assert.deepEqual(f.sent.map(s=>s.text),['legacy shared','new only']);
  assert.deepEqual(f.sent[0].context.jobs.map(j=>j.id),['om_old_a','om_old_b']);assert.deepEqual(f.sent[1].context.jobs.map(j=>j.id),['om_new']);
  assert.equal(q.jobs.get('om_old_a').taskResultProtocolVersion,undefined);assert.equal(q.jobs.get('om_new').taskResultProtocolVersion,1);
});

test('marker turn remains immutable across restart and later unrelated legacy finals or errors cannot retire it',async t=>{
  const f=fixture(t,{perTaskResults:false});f.add('a');await f.q.dispatchOne();
  f.append({type:'turn_context',payload:{turn_id:'owner-turn'}},marker('a'));await f.q.watch();
  const key=f.q.jobs.get('om_a').streamKey;
  f.append({type:'turn_context',payload:{turn_id:'unrelated-turn'}},message('Unrelated answer'),
    {type:'event_msg',payload:{type:'task_complete',error:{message:'Bad request'}}});await f.q.watch();await f.q.deliverReplies();
  const original=f.q.jobs.get('om_a');assert.equal(original.status,'delivered');assert.equal(original.markerTurnId,'owner-turn');
  assert.equal(original.turnId,'owner-turn');assert.equal(original.observedTurnId,'unrelated-turn');assert.equal(f.sent.length,0);
  const q=f.open();f.append({type:'turn_context',payload:{turn_id:'owner-turn'}},message('Owner answer'));
  await q.watch();await q.deliverReplies();assert.equal(q.jobs.get('om_a').status,'done');assert.deepEqual(f.sent[0].keys,[key]);
  assert.equal(f.sent[0].text,'Owner answer');
});

test('legacy upgrade captures existing marker turn before scanning a new context and v1 diagnostics ignore unrelated turns',async t=>{
  const f=fixture(t,{perTaskResults:false});f.add('legacy');await f.q.dispatchOne();f.append(marker('legacy'));await f.q.watch();
  const legacy=f.q.jobs.get('om_legacy');legacy.turnId='legacy-owner';delete legacy.markerTurnId;f.q.save(legacy);
  f.io.perTaskResults=true;f.add('new');await f.q.dispatchOne();f.append({type:'turn_context',payload:{turn_id:'new-owner'}},marker('new'));
  const q=f.open();await q.watch();f.append({type:'turn_context',payload:{turn_id:'other'}},message('Unrelated final'));
  await q.watch();await q.deliverReplies();assert.equal(q.jobs.get('om_legacy').markerTurnId,'legacy-owner');
  assert.equal(q.jobs.get('om_legacy').status,'delivered');assert.equal(q.jobs.get('om_new').taskResultProtocolBlocked,undefined);
  f.append({type:'turn_context',payload:{turn_id:'new-owner'}},message('Own final without protocol'));await q.watch();
  assert.equal(q.jobs.get('om_new').taskResultProtocolBlocked,'turn_ended_without_task_result');assert.equal(f.sent.length,0);
});

test('structured failure and success are independently delivered with explicit business statuses',async t=>{
  const f=fixture(t);await dispatch(f,['a','b']);f.result('a','Cannot complete','failed');f.result('b','Completed');
  await f.q.deliverReplies();assert.deepEqual(f.sent.map(s=>s.context.taskResult.status),['failed','complete']);
  assert.equal(f.q.jobs.get('om_a').taskBusinessStatus,'failed');assert.equal(f.q.jobs.get('om_a').status,'done');
  assert.equal(f.q.jobs.get('om_b').taskBusinessStatus,'complete');assert.equal(f.q.jobs.get('om_a').notice,undefined);
});

test('waiting and background results remain refreshable after restart and late progress cannot regress a delivered result',async t=>{
  const f=fixture(t);await dispatch(f,['a','b']);const key=f.q.jobs.get('om_a').streamKey;
  f.result('a','Need a date','waiting');f.result('b','Queued research','background');await f.q.deliverReplies();
  assert.equal(f.q.stats().task_result_waiting_count,1);assert.equal(f.q.stats().task_result_background_count,1);
  assert.equal(f.q.stats().reply_pending_count,0);
  const q=f.open();f.append(message('[飞书进度｜om_a] stale progress','commentary'),message('Natural all done'));
  const previousProgress=f.progress.length;await q.watch();await q.deliverReplies();assert.equal(f.progress.length,previousProgress);assert.equal(f.sent.length,2);
  f.result('a','Finished','complete',2);await q.watch();const pending=q.jobs.get('om_a');assert.equal(pending.status,'done');assert.equal(pending.taskResultPending,true);
  assert.equal(q.stats().reply_pending_count,1);await q.deliverReplies();
  assert.deepEqual(f.sent[2].keys,[key]);assert.equal(q.jobs.get('om_a').taskBusinessStatus,'complete');assert.equal(f.injected.length,2);
  assert.equal(q.stats().task_result_waiting_count,0);assert.equal(q.stats().task_result_background_count,1);
});

test('linked card cleanup failure persists a blocked retry across restart without another result send or execution',async t=>{
  let closeCalls=0;const f=fixture(t,{closeLinkedTaskCard:async()=>{closeCalls++;throw Object.assign(Error('permanent close error'),{permanent:true});}});
  await dispatch(f,['a','supplement']);f.links.set('om_supplement','om_a');await f.q.watch();
  const value=f.result('a','Owner final');f.results.set('om_a',{...value,sourceJobId:'om_supplement',resultSourceJobId:'om_supplement'});
  await f.q.deliverReplies();assert.equal(f.q.jobs.get('om_supplement').linkedTaskCardRetry.blocked,true);
  assert.equal(f.q.stats().outbound_blocked_count,1);assert.equal(f.q.jobs.get('om_supplement').status,'delivered');
  const q=f.open();await q.watch();await q.deliverReplies();assert.equal(closeCalls,1);assert.equal(f.sent.length,1);
  assert.equal(f.injected.length,2);assert.equal(q.stats().outbound_blocked_count,1);
});

test('restart after durable send proof closes the owner card without sending or executing again',async t=>{
  const f=fixture(t);await dispatch(f,['a']);f.result('a','A');await f.q.watch();
  const save=f.q.save.bind(f.q);let crash=true;
  f.q.save=j=>{if(crash && j.status==='done'){crash=false;throw Error('crash after receipt');}return save(j);};
  await assert.rejects(f.q.deliverReplies(),/crash after receipt/);const q=f.open();await q.watch();await q.deliverReplies();
  assert.equal(f.sent.length,1);assert.equal(f.injected.length,1);assert.equal(q.jobs.get('om_a').status,'done');
  assert.deepEqual(q.jobs.get('om_a').finalDeliveryEvidence,proof);
});

test('delivery before inbox receipt crash reconciles the same owner result key with one physical send',async t=>{
  const delivered=new Map();let physicalSends=0;
  const f=fixture(t,{final:async(_text,key)=>{if(delivered.has(key))return {...proof,source:'reconciled_observation'};physicalSends++;delivered.set(key,true);return proof;}});
  await dispatch(f,['a']);const result=f.result('a','A');await f.q.watch();const rename=fs.renameSync;let crash=true;
  t.mock.method(fs,'renameSync',(from,to)=>{if(crash && path.basename(to)===`sent-${result.replyKey}.json`){crash=false;throw Error('receipt crash');}return rename(from,to);});
  await f.q.deliverReplies();const q=f.open();f.setNow(10000);await q.deliverReplies();
  assert.equal(physicalSends,1);assert.equal(q.jobs.get('om_a').status,'done');assert.equal(q.jobs.get('om_a').finalDeliveryEvidence.source,'reconciled_observation');
});

test('unproven final send cannot checkpoint a successful structured delivery',async t=>{
  const f=fixture(t,{final:async()=>null});await dispatch(f,['a']);const result=f.result('a','A');await f.q.deliverReplies();
  assert.equal(f.q.jobs.get('om_a').status,'reply_pending');assert.equal(fs.existsSync(path.join(f.q.dir,`sent-${result.replyKey}.json`)),false);
});

test('explicit linked supplement keeps actionable classification and updates only the verified owner card',async t=>{
  const f=fixture(t);await dispatch(f,['a']);f.links.set('om_supplement','om_a');f.add('supplement');await f.q.dispatchOne();f.append(marker('supplement'));
  await f.q.watch();assert.equal(f.q.jobs.get('om_supplement').feedbackDisposition,'actionable');
  assert.equal(f.progress.filter(p=>p.jobId==='om_supplement').length,0);
  const value=f.result('a','Owner final');f.results.set('om_a',{...value,sourceJobId:'om_supplement',resultSourceJobId:'om_supplement'});await f.q.deliverReplies();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].context.jobId,'om_a');assert.equal(f.q.jobs.get('om_supplement').status,'done');
  assert.equal(f.q.jobs.get('om_supplement').completionDisposition,undefined);assert.equal(f.q.jobs.get('om_supplement').replyKey,undefined);
});

test('actual immutable store keeps newly linked supplements active until that source authors a verified result',async t=>{
  const f=fixture(t),binding={bot:'fixture',profile:'fixture',chat_id:'ocFixture',allowed_sender_id:'ou_Owner',bot_open_id:'ou_Bot',
    group_access:'all_group_humans',codex_thread_id:'fixture-thread',cwd:f.root};
  const store=new TaskResultStore({root:path.join(f.root,'task-results'),inboxRoot:f.root,completionRoot:path.join(f.root,'completions'),
    binding,codexHome:f.root});f.io.taskResults=store;
  const add=(id,extra={})=>f.q.enqueue({type:'im.message.receive_v1',message_id:`om_${id}`,message_type:'text',content:id,
    chat_id:binding.chat_id,chat_type:'group',sender_id:'ou_Member',sender_type:'user',bridge_binding:bindingSnapshot(binding),...extra});
  add('a');await f.q.dispatchOne();f.append(marker('a'));await f.q.watch();
  const original=store.submit('om_a',{resultKey:'first',text:'Need a date',status:'waiting'});await f.q.deliverReplies();
  add('reply',{parent_id:'om_a'});await f.q.dispatchOne();f.append(marker('reply'));await f.q.watch();store.link('om_reply','om_a');
  await f.q.watch();await f.q.deliverReplies();assert.equal(f.q.jobs.get('om_reply').status,'delivered');
  assert.equal(f.q.jobs.get('om_reply').taskResultLinkedReplyKey,undefined);assert.equal(f.sent.length,1);
  const next=store.submit('om_reply',{resultKey:'second',text:'Completed with date',status:'complete'});
  assert.notEqual(original.replyKey,next.replyKey);await f.q.watch();assert.equal(f.q.jobs.get('om_a').status,'done');
  await f.q.deliverReplies();assert.equal(f.sent.length,2);assert.equal(f.sent[1].context.jobId,'om_a');
  assert.deepEqual(f.sent[0].keys,f.sent[1].keys);assert.equal(f.q.jobs.get('om_reply').status,'done');
  assert.equal(f.q.jobs.get('om_reply').taskResultLinkedReplyKey,next.replyKey);assert.equal(store.get(f.q.jobs.get('om_a')).sourceJobId,'om_reply');
});

test('function capability stamps only new selected jobs and snapshots scope independently of later configuration',t=>{
  const f=fixture(t,{perTaskResults:e=>e.content==='selected'});const legacy=f.add('legacy');const scoped=f.q.enqueue({message_id:'om_selected',content:'selected'});
  f.io.taskResultScope.cwd='changed';f.io.perTaskResults=true;assert.equal(f.q.enqueue(legacy.event).taskResultProtocolVersion,undefined);
  assert.equal(scoped.taskResultProtocolVersion,1);assert.equal(scoped.taskResultProtocolScope.cwd,f.root);
});
