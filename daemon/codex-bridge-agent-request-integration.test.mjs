import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DurableInbox} from './codex-bridge-inbox.mjs';
import {TaskResultStore} from './codex-bridge-task-results.mjs';
import {AgentRequestDispatcher,enqueueAgentRequest} from './codex-bridge-agent-requests.mjs';
import {enqueueActionable,readDisposition} from './codex-bridge-completion.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';

function fixture(t) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agent-request-integration-')));fs.chmodSync(base,0o700);
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const stateRoot=path.join(base,'state'),inboxRoot=path.join(stateRoot,'codex-inbox-v2'),completionRoot=path.join(stateRoot,'completions-v1'),
    codexHome=path.join(base,'home'),configFile=path.join(base,'bindings.json'),rollout=path.join(base,'rollout.ndjson');
  fs.writeFileSync(rollout,'',{mode:0o600});const clock={now:Date.parse('2026-10-08T00:00:00Z')},sent=[],actionable=[];
  const binding={bot:'fixture',profile:'fixture',group_access:'all_group_humans',chat_id:'oc_Fixture',allowed_sender_id:'ou_Owner',bot_open_id:'ou_Bot',
    codex_thread_id:'fixture-thread',cwd:base};
  atomicWriteJson(configFile,{runtime:{codex_home:codexHome},bindings:{fixture:binding}});
  const store=new TaskResultStore({root:path.join(stateRoot,'task-results-v1'),inboxRoot,completionRoot,binding,codexHome});
  let inbox,dispatcher;
  const io={perTaskResults:true,taskResultScope:{cwd:base,codexHome},classifiedFeedback:true,taskResults:store,
    prepare:async event=>event,target:async()=>({rollout}),inject:async()=>{},
    classification:job=>readDisposition({root:completionRoot,binding,job}),
    onMarkerScanned:()=>dispatcher.drain(),onActionable:job=>actionable.push(job.id),
    final:async(text,key,keys,context)=>{sent.push({text,key,owner:context.jobId});return {schema:1,at:clock.now,source:'send_response'};},
    suppressNotices:()=>true};
  const opts={stateRoot,configFile,binding,codexHome,taskResults:store,now:()=>clock.now,onClassification:id=>{
    const job=inbox.jobs.get(id);if(job)inbox.completeSilently(job);
  }};
  const open=()=>{inbox=new DurableInbox(inboxRoot,binding.bot,io,{now:()=>clock.now,timeoutMs:1000});dispatcher=new AgentRequestDispatcher(opts);};open();
  const add=id=>inbox.enqueue({type:'im.message.receive_v1',message_id:id,message_type:'text',content:JSON.stringify({text:'查询最近邮件'}),
    chat_id:binding.chat_id,chat_type:'group',sender_type:'user',sender_id:'ou_Member',bridge_binding:bindingSnapshot(binding)});
  const append=(...items)=>fs.appendFileSync(rollout,items.map(v=>JSON.stringify(v)+'\n').join(''));
  const marker=id=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`[飞书消息｜fixture｜${id}]`} ]}});
  const context=id=>({type:'turn_context',payload:{turn_id:id}});
  const final=()=>({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'自然final不属于任何任务结果。'}]}});
  const queue=(job,kind,request)=>enqueueAgentRequest({...opts,jobId:job.id,kind,request});
  const output=r=>({type:'response_item',payload:{type:'custom_tool_call_output',call_id:'fixture-call',output:JSON.stringify({ok:true,...r})}});
  return {base,stateRoot,inboxRoot,completionRoot,binding,codexHome,rollout,clock,sent,actionable,opts,io,store,add,append,marker,context,final,queue,output,open,
    get inbox(){return inbox;},get dispatcher(){return dispatcher;}};
}

test('queued classification and per-source results are consumed at their own markers before a same-chunk final',async t=>{
  const f=fixture(t),a=f.add('om_mail'),b=f.add('om_calendar');await f.inbox.dispatchOne();await f.inbox.dispatchOne();
  const outputs=[];
  for(const [job,text] of [[a,'已核对原邮件读取结果。'],[b,'已核对原日程读取结果。']]) {
    const decision=f.queue(job,'actionable');assert.equal(decision.applied,false);outputs.push(f.output(decision));
    outputs.push(f.output(f.queue(job,'result',{resultKey:'answer-v1',text,status:'complete'})));
  }
  f.dispatcher.drain();assert.equal(f.dispatcher.stats().agent_request_pending_count,4);assert.equal(a.markerSeen,undefined);
  f.append(f.context('shared-turn'),f.marker(a.id),f.marker(b.id),...outputs,f.final(),{type:'event_msg',payload:{type:'task_complete',turn_id:'shared-turn'}});
  await f.inbox.watch();
  for(const job of [a,b]) {assert.equal(job.feedbackDisposition,'actionable');assert.equal(job.taskResultProtocolBlocked,undefined);assert.equal(job.status,'reply_pending');assert.ok(job.markerPosition>0);}
  assert.deepEqual(new Set(f.actionable),new Set([a.id,b.id]));assert.equal(f.dispatcher.stats().agent_request_pending_count,0);
  await f.inbox.deliverReplies();assert.deepEqual(f.sent.map(r=>r.text),['已核对原邮件读取结果。','已核对原日程读取结果。']);
  assert.equal(new Set(f.sent.map(r=>r.key)).size,2);assert.equal(f.sent.some(r=>r.text.includes('自然final')),false);
  f.open();f.dispatcher.drain();await f.inbox.watch();await f.inbox.deliverReplies();assert.equal(f.sent.length,2);
});

test('silent workspace request finishes only its own visible source and emits no result',async t=>{
  const f=fixture(t),job=f.add('om_thanks');await f.inbox.dispatchOne();const request=f.queue(job,'silent');
  f.append(f.context('thanks-turn'),f.marker(job.id),f.output(request),f.final());await f.inbox.watch();await f.inbox.deliverReplies();
  assert.equal(job.status,'done');assert.equal(job.completionDisposition,'silent');assert.equal(f.sent.length,0);
  assert.equal(f.dispatcher.stats().agent_request_pending_count,0);
});

test('unrelated later-turn tools, reasoning and file timestamps do not postpone an unresolved original task timeout',async t=>{
  const f=fixture(t),job=f.add('om_missing');await f.inbox.dispatchOne();
  enqueueActionable({root:f.completionRoot,inboxRoot:f.inboxRoot,binding:f.binding,jobId:job.id});
  f.append(f.context('original-turn'),f.marker(job.id),f.final());await f.inbox.watch();
  const originalActivity=job.lastActivityAt;assert.equal(job.taskResultProtocolBlocked,'turn_ended_without_task_result');
  f.clock.now+=600;f.append(f.context('unrelated-turn'),{type:'response_item',timestamp:new Date(f.clock.now).toISOString(),
    payload:{type:'custom_tool_call',name:'exec',input:'read-only unrelated work'}},
    {type:'response_item',payload:{type:'reasoning',text:'private reasoning'}});
  fs.utimesSync(f.rollout,new Date(f.clock.now),new Date(f.clock.now));await f.inbox.watch();assert.equal(job.lastActivityAt,originalActivity);
  f.clock.now+=600;f.append({type:'response_item',timestamp:new Date(f.clock.now).toISOString(),payload:{type:'custom_tool_call_output',output:'unrelated tool finished'}});
  await f.inbox.watch();assert.equal(job.lastActivityAt,originalActivity);assert.equal(job.timeoutNotified,true);
  assert.equal(f.sent.length,0);assert.equal(job.status,'delivered');assert.equal(job.markerTurnId,'original-turn');
});
