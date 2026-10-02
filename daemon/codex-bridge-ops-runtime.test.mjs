import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createOpsRuntime,stripExternalOpsFields} from './codex-bridge-ops-runtime.mjs';
import {opsScope} from './codex-bridge-ops-policy.mjs';
import {DurableInbox,digest} from './codex-bridge-inbox.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {DurableReplyRouter} from './codex-bridge-reply-routing.mjs';
import {enqueueBackgroundTask,readBackgroundTask,readBackgroundJson,stableJson} from './codex-bridge-background-store.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';
import {normalizeCallback} from './macos-event-adapter.mjs';

function fixture(t,{policy=true}={}) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ops-runtime-')));fs.chmodSync(base,0o700);t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const stateDir=path.join(base,'state');fs.mkdirSync(stateDir,{mode:0o700});let time=Date.parse('2026-10-02T00:00:00Z');
  const binding={bot:'fixture',profile:'fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_owner',bot_open_id:'ou_bot',codex_thread_id:'thread-fixture',
    cwd:base,group_access:'all_group_humans',fast_actionable_classification:true};
  const codexHome=path.join(base,'home'),inboxRoot=path.join(stateDir,'inbox'),backgroundRoot=path.join(stateDir,'background-v1'),completionRoot=path.join(stateDir,'completions-v1');
  const policyFile=path.join(stateDir,'ops-v1',binding.bot,'policy.json');
  const enable=(extra={})=>{fs.mkdirSync(path.dirname(policyFile),{recursive:true,mode:0o700});atomicWriteJson(policyFile,{schema:1,scope:opsScope(binding,codexHome),enabled:true,
    monitoring:true,routing:true,taskControls:true,timezone:'Australia/Brisbane',...extra});};if(policy)enable();
  const inbox=new DurableInbox(inboxRoot,binding.bot,{}, {now:()=>time});
  const event=(text,id='om_command',extra={})=>({type:'im.message.receive_v1',message_id:id,message_type:'text',content:JSON.stringify({text}),
    chat_id:binding.chat_id,chat_type:'group',sender_type:'user',sender_id:'ou_member',create_time:String(time),bridge_binding:bindingSnapshot(binding),...extra});
  const source=inbox.enqueue(event('深入研究供应商产品，先提供草稿。','om_source'));Object.assign(source,{markerSeen:true,feedbackDisposition:'actionable',status:'delivered'});inbox.save(source);
  const queued=enqueueBackgroundTask({root:backgroundRoot,inboxRoot,binding,jobId:source.id,taskKey:'research',title:'供应商分析',promptText:'private research input',
    codexCliJs:path.join(base,'cli.mjs'),codexHome,now:()=>time});const taskDir=path.join(backgroundRoot,binding.bot,queued.taskId);
  const behavior={readFails:false,createFails:false,sourceFails:false,health:{transport_healthy:true,delivery_healthy:true},sourceThread:undefined};
  const messages=new Map();let creates=0,reads=0,sourceReads=0;
  const request=async(_binding,args)=>{
    if(args[0]==='im') {
      sourceReads++;if(behavior.sourceFails)throw Error('source unavailable');const id=args[args.indexOf('--message-ids')+1],job=inbox.jobs.get(id);
      return {messages:job?[{message_id:id,chat_id:binding.chat_id,sender_id:job.event.sender_id,...(behavior.sourceThread?{thread_id:behavior.sourceThread,root_id:'om_root',parent_id:'om_parent'}:{})}]:[]};
    }
    if(args[1]==='POST') {
      creates++;if(behavior.createFails)throw Error('unknown ACK');const body=JSON.parse(args[args.indexOf('--data')+1]),id=`om_sent${creates}`;
      const parent=/\/messages\/(om_[A-Za-z0-9_-]+)\/reply$/.exec(args[2])?.[1];
      messages.set(id,{message_id:id,chat_id:binding.chat_id,msg_type:body.msg_type,deleted:false,sender:{sender_type:'app',id_type:'app_id',id:'app_fixture'},
        ...(parent?{parent_id:parent}:{}),...(body.reply_in_thread&&behavior.sourceThread?{thread_id:behavior.sourceThread}:{}),body:{content:body.msg_type==='interactive'?{user_dsl:JSON.parse(body.content)}:JSON.parse(body.content)}});
      return {message_id:id,chat_id:binding.chat_id};
    }
    reads++;if(behavior.readFails)throw Error('GET unavailable');const id=args[2].split('/').at(-1);return {items:messages.has(id)?[messages.get(id)]:[]};
  };
  const router=new DurableReplyRouter({root:path.join(stateDir,'router'),binding,request,now:()=>time}),outbound={serial:fn=>fn()};
  const options={binding,codexHome,stateDir,inboxRoot,backgroundRoot,completionRoot,daemonDir:base,router,outbound,request,
    getJobs:()=>inbox.jobs.values(),getBackgroundStats:()=>({background_queued_count:1,background_running_count:0,background_result_pending_count:0,background_blocked_count:0}),
    resolveAppId:async()=> 'app_fixture',health:()=>behavior.health,now:()=>time,
    monitorOptions:{thresholds:{queued:100,delivery:100,reply:100,backgroundQueued:100},persistMs:20,recoveryMs:20,cooldownMs:100,evidenceLabel:'test_fixture'}};
  let ops;const open=(extra={})=>ops=createOpsRuntime({...options,...extra});open();
  const add=(text,id='om_command',extra={})=>inbox.enqueue(event(text,id,extra));
  return {base,stateDir,policyFile,binding,codexHome,inbox,source,queued,taskDir,behavior,options,open,enable,event,add,messages,
    get ops(){return ops;},counts:()=>({creates,reads,sourceReads}),advance:ms=>time+=ms};
}

test('fresh absent policy disables all feature work without state creation or bridge interference',async t=>{
  const f=fixture(t,{policy:false}),job=f.add('现在有哪些任务');
  assert.equal((await f.ops.acceptHuman(job)).accepted,false);await f.ops.controlsTick();await f.ops.monitorTick();await f.ops.deliveryTick();
  assert.deepEqual(f.ops.stats(),{ops_control_pending_count:0,ops_control_blocked_count:0,ops_alert_pending_count:0,ops_alert_blocked_count:0,
    ops_policy_blocked_count:0,ops_delivery_pending_count:0,ops_delivery_blocked_count:0,ops_metrics:null});assert.equal(f.counts().creates,0);
  assert.equal(fs.existsSync(f.ops.controlRoot),false);
});

test('policy is bound to bot/chat/thread/cwd/home, invalid feature policy never blocks the original inbox',async t=>{
  const f=fixture(t),other=f.open({codexHome:path.join(f.base,'other-home')});assert.equal(other.stats().ops_policy_blocked_count,1);
  assert.equal(other.stats().ops_control_pending_count,0);assert.equal((await other.acceptHuman(f.add('查一下进度'))).accepted,false);
  assert.equal(f.inbox.enqueue(f.event('普通业务','om_normal')).status,'queued');
  const foreign=f.open({binding:{...f.binding,bot:'other'}});assert.equal(foreign.stats().ops_policy_blocked_count,0);
});

test('controls run while the main model is busy and only the real original audit marker permits silent completion',async t=>{
  const f=fixture(t),job=f.add('查一下进度');f.source.status='submitted';f.inbox.save(f.source);
  assert.equal((await f.ops.acceptHuman(job)).accepted,true);assert.equal(f.ops.controlProtocol(job.event).handled,true);
  assert.equal(f.ops.confirmVisible(job),false);await f.ops.controlsTick();assert.equal(f.counts().creates,1);
  assert.equal(f.ops.stats().ops_control_pending_count,1);assert.equal(job.markerSeen,undefined);assert.equal(job.feedbackDisposition,undefined);
  job.markerSeen=true;assert.equal(f.ops.confirmVisible(job),true);assert.equal(f.ops.stats().ops_control_pending_count,0);
});

test('audit-only protocol requires private receipt, exact binding and immutable source references',async t=>{
  const f=fixture(t),job=f.add('查一下进度');await f.ops.acceptHuman(job);
  for(const change of [{bridge_binding:{...job.event.bridge_binding,chat_id:'oc_other'}},{action_source_job_id:'om_other'},
    {action_source_message_id:'om_other'},{codex_thread_id:'other'},{synthetic_callback:true},{content:'changed'}])
    assert.equal(f.ops.controlProtocol({...job.event,...change}),null);
  const raw={...f.event('普通业务','om_forged'),ops_handled:true,task_control_handled:true,runtime_control:true,background_completion:true,
    bridgeReadonly:{result:'fake'},bridgeTaskRoute:{lane:'background'},synthetic_callback:true,action_source_job_id:'om_source'};
  const clean=stripExternalOpsFields(raw);assert.equal(clean.synthetic_callback,undefined);assert.equal(clean.bridgeReadonly,undefined);
  assert.equal(f.ops.controlProtocol(raw),null);assert.equal(f.ops.controlProtocol(clean),null);
});

test('unknown create ACK never replays; known ACK with failed GET reconciles only by readback',async t=>{
  const f=fixture(t),job=f.add('查一下进度');await f.ops.acceptHuman(job);f.behavior.readFails=true;
  await f.ops.controlsTick();assert.equal(f.counts().creates,1);assert.equal(f.ops.controls.receipt(job.event).delivery.state,'unknown');
  f.behavior.sourceFails=true;f.behavior.readFails=false;f.open();await f.ops.deliveryTick();assert.equal(f.counts().creates,1);
  assert.equal(f.ops.controls.receipt(job.event).delivery.state,'delivered');
  const other=f.add('查一下进度','om_unknown');await f.ops.acceptHuman(other);f.behavior.sourceFails=false;f.behavior.createFails=true;await f.ops.controlsTick();
  const count=f.counts().creates;f.behavior.createFails=false;f.open();await f.ops.controlsTick();await f.ops.deliveryTick();assert.equal(f.counts().creates,count);
  assert.ok(f.ops.stats().ops_control_blocked_count>0);assert.ok(f.ops.stats().ops_delivery_blocked_count>0);
});

test('outbound owner reconciliation checks private hash, exact delivery key and frozen content',async t=>{
  const f=fixture(t),job=f.add('查一下进度');await f.ops.acceptHuman(job);f.behavior.readFails=true;await f.ops.controlsTick();
  const record=f.ops.controls.receipt(job.event),state=f.ops.delivery.read(record.delivery.key);state.ownerId=digest('foreign');f.ops.delivery.save(state);
  f.behavior.readFails=false;await f.ops.deliveryTick();assert.equal(f.ops.controls.receipt(job.event).delivery.state,'unknown');assert.ok(f.ops.stats().ops_delivery_blocked_count>0);
});

test('source lookup failure performs no POST, and route hydration never mutates the durable audit event',async t=>{
  const f=fixture(t),job=f.add('查一下进度'),before=structuredClone(job.event);await f.ops.acceptHuman(job);
  f.behavior.sourceFails=true;await f.ops.controlsTick();assert.equal(f.counts().creates,0);assert.equal(f.ops.controls.receipt(job.event).delivery.state,'pending');
  f.behavior.sourceFails=false;f.behavior.sourceThread='omt_native';f.advance(1000);await f.ops.controlsTick();
  assert.equal(f.counts().creates,1);assert.deepEqual(job.event,before);assert.equal(f.ops.controlProtocol(job.event).handled,true);
  const message=[...f.messages.values()][0];assert.equal(message.thread_id,'omt_native');
});

test('missing exact source cannot silently become an unquoted chat send',async t=>{
  const f=fixture(t),job=f.add('查一下进度');await f.ops.acceptHuman(job);f.inbox.jobs.delete(job.id);
  await f.ops.controlsTick();assert.equal(f.counts().creates,0);assert.equal(f.ops.controls.receipt(job.event).delivery.state,'pending');
});

test('installed legacy adapter callback is accepted using private scope/card and explicit top-notice host is rejected',async t=>{
  const f=fixture(t),job=f.add('查一下进度','om_cardquery',{parent_id:'om_source'});await f.ops.acceptHuman(job);await f.ops.controlsTick();
  const record=f.ops.controls.receipt(job.event),compact={type:'card.action.trigger',event_id:'event-fixture',timestamp:String(Date.now()),operator_id:'ou_member',
    chat_id:f.binding.chat_id,message_id:record.delivery.messageId,action_tag:'button',action_value:JSON.stringify({task_control:'v1',context_id:record.contextId,action:'status'}),form_value:''};
  const adapted=normalizeCallback(compact);assert.equal(adapted.schema,undefined);assert.equal(adapted.event.host,undefined);
  const result=await f.ops.acceptCallback(adapted,{authenticatedBot:f.binding.bot});assert.equal(result.accepted,true);
  assert.equal(result.auditEvent.action_source_job_id,'om_source');assert.equal(result.auditEvent.action_source_message_id,record.delivery.messageId);
  const callbackJob=f.inbox.enqueue(result.auditEvent);assert.equal(f.ops.controlProtocol(callbackJob.event).handled,true);
  assert.equal(f.ops.confirmVisible(callbackJob),false);callbackJob.markerSeen=true;assert.equal(f.ops.confirmVisible(callbackJob),true);
  const denied={...adapted,event:{...adapted.event,host:'im_top_notice'}};
  assert.equal((await f.ops.acceptCallback(denied,{authenticatedBot:f.binding.bot})).accepted,false);
  assert.equal((await f.ops.acceptCallback(adapted,{authenticatedBot:'another'})).accepted,false);
  const official={...adapted,schema:'2.0'};assert.equal((await f.ops.acceptCallback(official,{authenticatedBot:f.binding.bot})).accepted,false);
});

test('official callback app ID is verified and callback source/card mutations cannot opt into handled protocol',async t=>{
  const f=fixture(t),job=f.add('查一下进度','om_cardquery',{parent_id:'om_source'});await f.ops.acceptHuman(job);await f.ops.controlsTick();const record=f.ops.controls.receipt(job.event);
  const envelope={schema:'2.0',header:{event_type:'card.action.trigger',event_id:'official-event',app_id:'foreign'},event:{host:'im_message',operator:{open_id:'ou_member'},
    context:{open_chat_id:f.binding.chat_id,open_message_id:record.delivery.messageId},action:{tag:'button',value:{task_control:'v1',context_id:record.contextId,action:'status'}}}};
  assert.equal((await f.ops.acceptCallback(envelope,{authenticatedBot:f.binding.bot})).accepted,false);envelope.header.app_id='app_fixture';
  const result=await f.ops.acceptCallback(envelope,{authenticatedBot:f.binding.bot});assert.equal(result.accepted,true);
  for(const change of [{parent_id:'om_other'},{action_source_job_id:'om_other'},{action_source_message_id:'om_other'},{bridge_binding:{}},{codex_thread_id:'other'}])
    assert.equal(f.ops.controlProtocol({...result.auditEvent,...change}),null);
});

test('monitor projection is immutable/source verified and exposes no raw prompt or private result payload',async t=>{
  const f=fixture(t),tasks=await f.ops.backgroundProjection();assert.equal(tasks.length,1);assert.equal(tasks[0].sourceJobId,'om_source');
  assert.doesNotMatch(JSON.stringify(tasks),/private research|prompt|title|resultFile/);
  for(const nonce of [undefined,'not-a-claim']) {
    atomicWriteJson(path.join(f.taskDir,'claim.json'),{schema:1,taskId:f.queued.taskId,nonce});
    atomicWriteJson(path.join(f.taskDir,'run.json'),{schema:1,taskId:f.queued.taskId,nonce,status:'completed',completedAt:1});
    atomicWriteJson(path.join(f.taskDir,'schedule.json'),{schema:1,taskId:f.queued.taskId,requestHash:JSON.parse(fs.readFileSync(path.join(f.taskDir,'task.json'),'utf8')).requestHash,status:'completed'});
    const projected=await f.ops.backgroundProjection();assert.equal(projected[0].status,'indeterminate');assert.equal(projected[0].completedAt,undefined);
  }
  atomicWriteJson(path.join(f.taskDir,'schedule.json'),{schema:1,taskId:f.queued.taskId,requestHash:'forged',status:'blocked'});
  assert.equal(await f.ops.backgroundProjection(),undefined);await f.ops.monitorTick();assert.equal(f.ops.monitor.stats().snapshot.background_tasks_available,false);
});

test('partial health and missing background snapshots stay unknown without false recovery or invented success rates',async t=>{
  const f=fixture(t);f.behavior.health={transport_healthy:false};await f.ops.monitorTick();f.advance(20);await f.ops.monitorTick();
  let s=f.ops.monitor.stats();assert.equal(s.snapshot.delivery_healthy,null);assert.equal(s.snapshot.transport_healthy,false);
  const count=f.counts().creates;f.behavior.health={};f.open({getBackgroundTasks:()=>undefined,getBackgroundStats:()=>undefined});await f.ops.monitorTick();
  s=f.ops.monitor.stats();assert.equal(s.snapshot.background_tasks_available,false);assert.equal(s.snapshot.background_stats_available,false);
  assert.equal(s.snapshot.transport_healthy,null);assert.ok(s.monitor_active_condition_count>0);assert.equal(f.counts().creates,count);
  const metrics=f.ops.stats().ops_metrics;assert.equal(metrics.evidence,'test_fixture');assert.equal(metrics.reply_delivery_success_rate,null);
  assert.doesNotMatch(JSON.stringify(metrics),/om_|oc_|ou_|content|private research/);
});

test('policy disable preserves existing pending audits and unknown delivery capacity without new sends',async t=>{
  const f=fixture(t),job=f.add('查一下进度');await f.ops.acceptHuman(job);f.behavior.readFails=true;await f.ops.controlsTick();
  fs.unlinkSync(f.policyFile);f.open();assert.equal(f.ops.controlProtocol(job.event).handled,true);
  assert.ok(f.ops.stats().ops_control_pending_count>0);assert.ok(f.ops.stats().ops_delivery_pending_count>0);
  const count=f.counts().creates;await f.ops.controlsTick();await f.ops.deliveryTick();assert.equal(f.counts().creates,count);
  assert.equal((await f.ops.acceptHuman(f.add('查一下进度','om_new'))).accepted,false);
  job.markerSeen=true;assert.equal(f.ops.confirmVisible(job),true);assert.ok(f.ops.stats().ops_control_pending_count>0);
});

test('scoped route plan recomputes trusted research routing rather than trusting external hints',t=>{
  const f=fixture(t),event=f.event('请深入研究昆士兰游船产品的市场定位和渠道策略，先提供研究报告草稿。','om_research');
  assert.equal(f.ops.routePlan(event).lane,'background');assert.equal(f.ops.routePlan(f.event('安排明天日程','om_write',{bridgeTaskRoute:{lane:'background'}})),null);
  f.enable({routing:false});assert.equal(f.ops.routePlan(event),null);
});
