import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {digest,DurableInbox} from './codex-bridge-inbox.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';
import {enqueueBackgroundTask,readBackgroundJson,readBackgroundTask,stableJson} from './codex-bridge-background-store.mjs';
import {TaskControl,parseTaskControl,resolveTaskControl,taskShortId,safeTaskTitle,publicTask,backgroundControlApi,stripExternalTaskControlFields} from './codex-bridge-task-control.mjs';

function fixture(t,{api:override}={}) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'task-control-')));fs.chmodSync(base,0o700);
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  let time=Date.parse('2026-10-02T00:00:00Z'),calls=0;
  const binding={bot:'fixture',profile:'fixture',chat_id:'oc_Fixture',allowed_sender_id:'ou_Owner',bot_open_id:'ou_Bot',group_access:'all_group_humans',codex_thread_id:'fixture-thread',cwd:base};
  const task=(key='research',extra={})=>({id:digest(key),bot:binding.bot,chatId:binding.chat_id,codexThreadId:binding.codex_thread_id,
    sourceJobId:'om_original',sourceSenderId:'ou_Member',taskKey:key,title:'供应商方案研究',status:'running',notification:'pending',createdAt:time,...extra});
  const tasks=[task()];const root=path.join(base,'controls');
  const api={listTasks:()=>structuredClone(tasks),readTask:({taskId})=>structuredClone(tasks.find(task=>task.id===taskId)),
    cancelTask:target=>{calls++;tasks.find(t=>t.id===target.id).cancelRequested=true;return {cancelRequested:true};},...override};
  let control;const open=(options={})=>control=new TaskControl({root,binding,api,now:()=>time,...options});open();
  const event=(text='查一下进度',extra={})=>({type:'im.message.receive_v1',message_id:'om_command',message_type:'text',content:JSON.stringify({text}),
    chat_id:binding.chat_id,chat_type:'group',sender_id:'ou_Member',sender_type:'user',create_time:String(time),...extra});
  const record=e=>control.receipt(e),file=e=>control.file(e.message_id),callback=(contextId,action='status',extra={})=>({schema:'2.0',header:{event_type:'card.action.trigger',event_id:'fixture-event',app_id:'appFixture'},
    event:{host:'im_message',operator:{open_id:'ou_Member'},context:{open_chat_id:binding.chat_id,open_message_id:'om_card'},action:{tag:'button',value:{task_control:'v1',context_id:contextId,action}},...extra}});
  return {base,root,binding,tasks,task,api,event,record,file,callback,open,get control(){return control;},get calls(){return calls;},advance:ms=>time+=ms};
}

test('complete-text parser accepts list, source replies, stable identifiers and scoped task keys',()=>{
  const e=(content,extra={})=>({message_type:'text',content,...extra});
  assert.deepEqual(parseTaskControl(e('现在有哪些任务？')),{action:'list'});
  assert.deepEqual(parseTaskControl(e('查一下进度')),{action:'list'});
  assert.deepEqual(parseTaskControl(e('查一下进度',{parent_id:'om_source'})),{action:'status',sourceJobId:'om_source'});
  assert.deepEqual(parseTaskControl(e('这个分析取消',{reply_to:'om_source'})),{action:'cancel',sourceJobId:'om_source'});
  assert.deepEqual(parseTaskControl(e('取消这个任务',{parent_id:'om_source',root_id:'om_ancestor'})),{action:'cancel',sourceJobId:'om_source'});
  assert.deepEqual(parseTaskControl(e('查看 BG-123456ABCdef的进度')),{action:'status',shortId:'BG-123456ABCDEF'});
  assert.deepEqual(parseTaskControl(e('取消后台任务 BG-123456abcdef')),{action:'cancel',shortId:'BG-123456ABCDEF'});
  assert.deepEqual(parseTaskControl(e('取消任务 supplier-v1',{parent_id:'om_source'})),{action:'cancel',taskKey:'supplier-v1',sourceJobId:'om_source'});
});

test('calendar, commercial, batch, quoted, mixed and attachment requests never become direct controls',()=>{
  for(const content of ['取消明天日程','这个会议取消','取消订单','取消全部后台任务','把研究取消并安排明天会议','请解释“这个分析取消”是什么意思',
    '查询任务 daily','取消 BG-1234','取消任务 BG-123456abcdef 和 BG-abcdef123456','现在有哪些任务\n顺便取消全部'])
    assert.equal(parseTaskControl({message_type:'text',content}),null,content);
  assert.equal(parseTaskControl({message_type:'file',content:'这个分析取消'}),null);
  assert.equal(parseTaskControl({message_type:'text',content:'这个分析取消',attachments:[{}]}),null);
});

test('resolver never guesses deictic targets or stable-short collisions, and source plus key selects exactly one',t=>{
  const f=fixture(t),a=f.tasks[0],b=f.task('other',{id:a.id.slice(0,12)+'f'.repeat(52),sourceJobId:'om_other'});
  const options={binding:f.binding,senderId:'ou_Member'};
  assert.equal(resolveTaskControl({action:'cancel'},[a],options).kind,'ambiguous');
  assert.equal(resolveTaskControl({action:'cancel',shortId:taskShortId(a.id)},[a,b],options).kind,'ambiguous');
  const c=f.task('another');assert.equal(resolveTaskControl({action:'cancel',sourceJobId:a.sourceJobId},[a,c],options).kind,'ambiguous');
  assert.equal(resolveTaskControl({action:'cancel',sourceJobId:a.sourceJobId,taskKey:a.taskKey},[a,c],options).task.id,a.id);
});

test('shared query is authorized but cancelling another person requires explicit maintenance owner',t=>{
  const f=fixture(t),command={action:'cancel',shortId:taskShortId(f.tasks[0].id)};
  assert.equal(resolveTaskControl(command,f.tasks,{binding:f.binding,senderId:'ou_Other'}).kind,'forbidden');
  assert.equal(resolveTaskControl(command,f.tasks,{binding:f.binding,senderId:'ou_Owner'}).kind,'task');
  assert.equal(resolveTaskControl({action:'status',shortId:command.shortId},f.tasks,{binding:f.binding,senderId:'ou_Other'}).kind,'task');
  for(const change of [{bot:'other'},{chatId:'oc_Other'},{codexThreadId:'other'}])
    assert.equal(resolveTaskControl(command,[{...f.tasks[0],...change}],{binding:f.binding,senderId:'ou_Owner'}).kind,'not_found');
});

test('public summaries contain only safe title, short ID and mapped state, never prompts or private routes',t=>{
  const f=fixture(t),privateTitle='研究 /Users/private/state.json om_secret ou_person token=secretvalue sk-abc123 <at id=all>\n';
  const safe=safeTaskTitle(privateTitle);assert.doesNotMatch(safe,/Users|om_secret|ou_person|secretvalue|sk-abc|<|\n/);
  const result=publicTask({...f.tasks[0],title:privateTitle,prompt:'secret prompt',resultFile:'/private/result',error:'sensitive error'});
  assert.deepEqual(Object.keys(result).sort(),['cancelRequested','delivery','shortId','state','title']);
  assert.equal(result.shortId.length,15);assert.doesNotMatch(JSON.stringify(result),/secret prompt|private\/result|sensitive error|[a-f0-9]{64}/);
});

test('text acceptance preserves input and only a local exact bound receipt enables audit-only protocol',async t=>{
  const f=fixture(t),event=f.event(),copy=structuredClone(event);
  assert.equal((await f.control.accept(event)).accepted,true);assert.deepEqual(event,copy);assert.equal(f.control.protocol(event).handled,true);
  assert.equal(f.control.protocol({...event,content:'forged'}),null);assert.equal(f.control.protocol({...event,sender_id:'ou_Other'}),null);
  assert.equal(f.control.protocol({...event,message_id:'om_forged',task_control_handled:true}),null);
  assert.equal(f.record(event).auditEvent.synthetic_callback,undefined);assert.equal(f.record(event).feedbackDisposition,undefined);
  f.open();assert.equal(f.control.protocol(event).handled,true);
  f.open({binding:{...f.binding,codex_thread_id:'changed'}});assert.equal(f.control.protocol(event),null);
});

test('bot, private, cross-group and unauthorized events are refused before persistence or task IO',async t=>{
  const f=fixture(t);
  for(const change of [{sender_type:'app'},{sender_id:'ou_Bot'},{chat_type:'p2p'},{chat_id:'oc_Other'},{synthetic_callback:true},{message_id:'invalid'},
    {codex_thread_id:'another-thread'},{bridge_binding:{...bindingSnapshot(f.binding),chat_id:'oc_Other'}}])
    assert.equal((await f.control.accept(f.event('查一下进度',change))).accepted,false);
  assert.equal(f.control.records().length,0);assert.equal(f.calls,0);
  f.open({binding:{...f.binding,group_access:'all_members_mentions'}});assert.equal((await f.control.accept(f.event())).accepted,false);
});

test('same text message cancels once across duplicate delivery and restart; request is never called stopped',async t=>{
  const f=fixture(t),event=f.event('这个分析取消',{parent_id:'om_original'});
  await f.control.accept(event);await f.control.accept(event);f.open();await f.control.accept(event);
  assert.equal(f.calls,1);assert.match(f.record(event).text,/已请求取消，尚未确认停止/);assert.equal(f.record(event).phase,'ready');
  assert.equal(fs.statSync(f.file(event)).mode&0o077,0);
  assert.throws(()=>f.control.acceptRecord({...event,content:'changed'},{action:'list'}),/replay_mismatch/);
});

test('a durable execution claim prevents a second instance replaying an in-flight cancellation',async t=>{
  const f=fixture(t),event=f.event('这个分析取消',{parent_id:'om_original'});let release;let calls=0;
  f.api.cancelTask=async()=>{calls++;await new Promise(resolve=>release=resolve);return {cancelRequested:true};};
  const first=f.control,second=f.open(),pending=first.accept(event);
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  await second.accept(event);release();await pending;assert.equal(calls,1);
});

test('restart after cancellation claim reconciles by reading and never reissues unknown side effects',async t=>{
  const f=fixture(t),event=f.event('这个分析取消',{parent_id:'om_original'}),record=f.control.acceptRecord(event,parseTaskControl(event));
  record.phase='executing';record.target={id:f.tasks[0].id,sourceJobId:'om_original',taskKey:'research'};f.control.save(record);
  f.open();await f.control.accept(event);assert.equal(f.calls,0);assert.match(f.record(event).text,/不会重复执行/);
  assert.equal(f.record(event).operation,'unknown');
  assert.match(JSON.stringify(f.record(event).card),/本次取消结果尚未确认/);
});

test('unknown cancellation failures are durable safe results and never expose raw error or retry',async t=>{
  const f=fixture(t),event=f.event('这个分析取消',{parent_id:'om_original'});let calls=0;
  f.api.cancelTask=()=>{calls++;throw Error('private token=/private/config');};
  await f.control.accept(event);f.open();await f.control.accept(event);assert.equal(calls,1);
  assert.match(f.record(event).text,/尚未确认/);assert.doesNotMatch(f.record(event).text,/private|token/);
});

test('ambiguous, unauthorized and already finished cancellation never invokes cancel helper',async t=>{
  const f=fixture(t);
  await f.control.accept(f.event('这个分析取消'));assert.equal(f.calls,0);assert.match(f.record(f.event('这个分析取消')).text,/指定一个/);
  await f.control.accept(f.event(`取消 BG-${f.tasks[0].id.slice(0,12)}`,{message_id:'om_other',sender_id:'ou_Other'}));assert.equal(f.calls,0);
  f.tasks[0].status='completed';await f.control.accept(f.event('这个分析取消',{parent_id:'om_original',message_id:'om_finished'}));assert.equal(f.calls,0);
});

test('outbox requires actual message ID, stops on unknown creation and can reconcile a verified private readback',async t=>{
  const f=fixture(t),event=f.event();await f.control.accept(event);let sends=0;
  await f.control.drain(async()=>{sends++;return {queued:true};});assert.equal(f.record(event).delivery.state,'unknown');
  f.open();await f.control.drain(async()=>{sends++;return {delivered:true,messageId:'om_sent'};});assert.equal(sends,1);
  assert.equal(f.control.reconcileDelivery(event,{delivered:true,messageId:'om_sent'}),false);
  assert.equal(f.control.reconcileDelivery(event.message_id,{verified:true,messageId:'om_sent'}),true);
  assert.equal(f.record(event).delivery.state,'delivered');assert.equal(f.control.stats().task_control_pending_count,1);
  assert.equal(f.control.confirmVisible({id:event.message_id,event,markerSeen:false}),false);
  assert.equal(f.control.confirmVisible({id:event.message_id,event,markerSeen:true}),true);assert.equal(f.control.stats().task_control_pending_count,0);
});

test('definitely failed sends retry a bounded number with the same key; unspecified throws stay unknown',async t=>{
  const f=fixture(t),event=f.event();await f.control.accept(event);const keys=[];
  const send=async(_text,key)=>{keys.push(key);return {definitelyFailed:true};};
  await f.control.drain(send);f.advance(1000);await f.control.drain(send);f.advance(2000);await f.control.drain(send);f.advance(10000);await f.control.drain(send);
  assert.equal(keys.length,3);assert.equal(new Set(keys).size,1);assert.equal(f.record(event).delivery.state,'failed');
  const other=f.event('查一下进度',{message_id:'om_throw'});await f.control.accept(other);await f.control.drain(async()=>{throw Error('timeout');});
  assert.equal(f.record(other).delivery.state,'unknown');assert.ok(f.control.stats().task_control_blocked_count>0);
});

test('crash after send claim remains unknown and definite readback failure may resume bounded delivery',async t=>{
  const f=fixture(t),event=f.event();await f.control.accept(event);const record=f.record(event);
  record.delivery.state='sending';record.delivery.attempts=1;f.control.save(record);f.open();let sends=0;
  await f.control.drain(async()=>{sends++;return {delivered:true,messageId:'om_sent'};});assert.equal(sends,0);
  assert.equal(f.control.reconcileDelivery(event,{definitelyFailed:true,key:'wrong'}),false);
  assert.equal(f.control.reconcileDelivery(event,{definitelyFailed:true,key:record.delivery.key}),true);
  f.advance(1000);await f.control.drain(async()=>{sends++;return {delivered:true,messageId:'om_sent'};});assert.equal(sends,1);
});

test('delivered historical receipts cannot starve new controls behind a drain limit',async t=>{
  const f=fixture(t);for(let i=0;i<25;i++){await f.control.accept(f.event('查一下进度',{message_id:`om_${i}`}));}
  let sends=0;const send=async()=>({delivered:true,messageId:`om_sent${++sends}`});
  await f.control.drain(send,{limit:20});await f.control.drain(send,{limit:20});assert.equal(sends,25);
});

test('card snapshots use Card2 default width, grouped safe state and only narrow query/cancel callbacks',async t=>{
  const f=fixture(t),event=f.event('查一下进度',{parent_id:'om_original'});await f.control.accept(event);const record=f.record(event),card=record.card;
  assert.equal(card.schema,'2.0');assert.equal(card.config.width_mode,'default');assert.equal(card.body.elements.length,3);
  assert.equal(card.body.elements[1].columns[0].background_style,'grey-50');assert.equal(card.body.elements[2].flex_mode,'none');
  const buttons=card.body.elements[2].columns.map(c=>c.elements[0]);assert.equal(buttons[0].type,'primary_filled');assert.equal(buttons[1].type,'danger');
  for(const b of buttons)assert.deepEqual(Object.keys(b.behaviors[0].value).sort(),['action','context_id','task_control']);
  assert.doesNotMatch(JSON.stringify(card),new RegExp(f.tasks[0].id));assert.doesNotMatch(JSON.stringify(card),/om_original|ou_Member/);
  const old=JSON.stringify(card);f.tasks[0].title='changed';f.tasks[0].status='completed';let passed;
  await f.control.drain(async(_text,_key,context)=>{passed=context;return {definitelyFailed:true};});f.advance(1000);
  await f.control.drain(async(_text,_key,context)=>{assert.equal(JSON.stringify(context.card),old);return {delivered:true,messageId:'om_card'};});
  assert.equal(passed.receiptId,event.message_id);assert.equal(passed.sourceTask.id,f.tasks[0].id);
  assert.equal(readBackgroundJson(f.control.cardFile(record.contextId)).messageId,'om_card');
});

test('callbacks require authenticated bot, exact card/chat, private context and live cancellation authorization',async t=>{
  const f=fixture(t),{contextId}=await f.control.createTaskCard({taskId:f.tasks[0].id,key:'card'});
  let callback=f.callback(contextId);
  assert.equal((await f.control.acceptCallback(callback,{authenticatedBot:f.binding.bot,appId:'appFixture'})).accepted,false);
  f.control.bindCard(contextId,'om_card');
  for(const options of [{authenticatedBot:'wrong'},{authenticatedBot:f.binding.bot,appId:'wrong'}])assert.equal((await f.control.acceptCallback(callback,options)).accepted,false);
  for(const extra of [{host:'im_top_notice'},{host:undefined},{context:{open_chat_id:'oc_Other',open_message_id:'om_card'}},
    {context:{open_chat_id:f.binding.chat_id,open_message_id:'om_other'}},{operator:{open_id:'ou_Bot'}},
    {action:{tag:'button',value:{task_control:'v1',context_id:contextId,action:'status',task_id:f.tasks[0].id}}}])
    assert.equal((await f.control.acceptCallback(f.callback(contextId,'status',extra),{authenticatedBot:f.binding.bot})).accepted,false);
  const result=await f.control.acceptCallback(callback,{authenticatedBot:f.binding.bot,appId:'appFixture'});
  assert.equal(result.accepted,true);assert.equal(result.auditEvent.synthetic_callback,true);assert.equal(f.control.protocol(result.auditEvent).handled,true);
  assert.deepEqual(result.auditEvent.bridge_binding,bindingSnapshot(f.binding));
  assert.equal(result.auditEvent.action_source_job_id,'om_original');assert.equal(result.auditEvent.action_source_message_id,'om_card');
  for(const change of [{bridge_binding:{...result.auditEvent.bridge_binding,chat_id:'oc_foreign'}},{codex_thread_id:'changed'},
    {action_source_job_id:'om_foreign'},{action_source_message_id:'om_foreign'},{parent_id:'om_foreign'}])
    assert.equal(f.control.protocol({...result.auditEvent,...change}),null);
  callback=f.callback(contextId,'cancel',{operator:{open_id:'ou_Other'}});callback.header.event_id='other';
  assert.equal((await f.control.acceptCallback(callback,{authenticatedBot:f.binding.bot})).accepted,false);assert.equal(f.calls,0);
});

test('button duplicate transport is idempotent and altered replay, context tamper or expiry is rejected',async t=>{
  const f=fixture(t),{contextId}=await f.control.createTaskCard({taskId:f.tasks[0].id,key:'card'});f.control.bindCard(contextId,'om_card');
  const callback=f.callback(contextId,'cancel');await f.control.acceptCallback(callback,{authenticatedBot:f.binding.bot});f.open();
  assert.equal((await f.control.acceptCallback(callback,{authenticatedBot:f.binding.bot})).accepted,true);assert.equal(f.calls,1);
  assert.equal((await f.control.acceptCallback(f.callback(contextId,'status'),{authenticatedBot:f.binding.bot})).accepted,false);
  const context=readBackgroundJson(f.control.cardFile(contextId));context.taskId='f'.repeat(64);atomicWriteJson(f.control.cardFile(contextId),context);
  assert.equal((await f.control.acceptCallback(callback,{authenticatedBot:f.binding.bot})).accepted,false);
  context.taskId=f.tasks[0].id;atomicWriteJson(f.control.cardFile(contextId),context);f.advance(24*60*60*1000);
  assert.equal((await f.control.acceptCallback(callback,{authenticatedBot:f.binding.bot})).accepted,false);
});

test('external control claims are removed on a copy and cannot forge a locally verified audit receipt',t=>{
  const f=fixture(t),event=f.event(),raw={...event,task_control_handled:true,task_control_receipt:'fake',control_handled:true,taskControlReceipt:{handled:true}};
  assert.deepEqual(stripExternalTaskControlFields(raw),event);assert.equal(raw.task_control_handled,true);assert.equal(f.control.protocol(raw),null);
});

test('default adapter validates immutable source and reads durable cancellation without leaking result files',async t=>{
  const f=fixture(t),stateRoot=path.join(f.base,'state'),backgroundRoot=path.join(stateRoot,'background-v1'),inboxRoot=path.join(stateRoot,'inbox');
  const inbox=new DurableInbox(inboxRoot,f.binding.bot,{}),source=inbox.enqueue(f.event('研究供应商方案',{message_id:'om_original',bridge_binding:bindingSnapshot(f.binding)}));
  Object.assign(source,{status:'delivered',markerSeen:true,feedbackDisposition:'actionable'});inbox.save(source);
  const promptFile=path.join(f.base,'prompt.txt');fs.writeFileSync(promptFile,'private task prompt',{mode:0o600});
  const queued=enqueueBackgroundTask({root:backgroundRoot,inboxRoot,binding:f.binding,jobId:source.id,taskKey:'research',title:'供应商方案',promptFile,
    codexCliJs:path.join(f.base,'cli.mjs'),codexHome:path.join(f.base,'home')});
  const api=backgroundControlApi({root:backgroundRoot,inboxRoot,binding:f.binding});const [task]=api.listTasks();
  assert.equal(task.id,queued.taskId);assert.equal(task.sourceSenderId,'ou_Member');assert.equal(task.status,'queued');assert.equal(task.prompt,undefined);
  assert.equal(api.cancelTask(task).cancelRequested,true);assert.equal(api.readTask({taskId:task.id}).cancelRequested,true);
  source.event.sender_id='ou_Other';inbox.save(source);assert.throws(()=>api.listTasks(),/background_source_changed/);
});

test('corrupt state reads fail safely instead of claiming an empty list or executing cancellation',async t=>{
  const f=fixture(t);f.api.listTasks=()=>{throw Error('/private/token');};const event=f.event();await f.control.accept(event);
  assert.match(f.record(event).text,/无法核验/);assert.doesNotMatch(f.record(event).text,/private|token|没有可查询/);assert.equal(f.calls,0);
});

test('corrupt control receipts reserve a blocked pending count and private symlink directories are rejected',async t=>{
  const f=fixture(t),event=f.event();await f.control.accept(event);
  fs.writeFileSync(f.file(event),'{broken',{mode:0o600});assert.equal(f.control.protocol(event),null);
  assert.equal(f.control.stats().task_control_pending_count,1);assert.equal(f.control.stats().task_control_blocked_count,1);
  await f.control.drain(async()=>{assert.fail('corrupt receipts must never send');});
  const dir=f.control.receipts;fs.renameSync(dir,dir+'-old');fs.symlinkSync(dir+'-old',dir);
  assert.throws(()=>f.control.records(),/private_path_invalid/);
});

test('confirmed cancellation is stopped while a persisted cancel request on a running task stays pending',t=>{
  const f=fixture(t);
  assert.equal(publicTask({...f.tasks[0],cancelRequested:true}).cancelRequested,true);
  const stopped=publicTask({...f.tasks[0],status:'cancelled',cancelRequested:true});
  assert.equal(stopped.state,'已停止');assert.equal(stopped.cancelRequested,false);
});

test('late completed run cannot reuse an old unknown outcome notification as delivered',t=>{
  const f=fixture(t),stateRoot=path.join(f.base,'state'),root=path.join(stateRoot,'background-v1'),inboxRoot=path.join(stateRoot,'inbox');
  const inbox=new DurableInbox(inboxRoot,f.binding.bot,{}),source=inbox.enqueue(f.event('研究方案',{message_id:'om_original',bridge_binding:bindingSnapshot(f.binding)}));
  Object.assign(source,{status:'delivered',markerSeen:true,feedbackDisposition:'actionable'});inbox.save(source);
  const promptFile=path.join(f.base,'prompt.txt');fs.writeFileSync(promptFile,'draft input',{mode:0o600});
  const queued=enqueueBackgroundTask({root,inboxRoot,binding:f.binding,jobId:source.id,taskKey:'research',title:'研究草稿',promptFile,
    codexCliJs:path.join(f.base,'cli.mjs'),codexHome:path.join(f.base,'home')}),task=readBackgroundTask(root,f.binding,queued.taskId),dir=path.join(root,f.binding.bot,task.id);
  const nonce='00000000-0000-4000-8000-000000000001',result=Buffer.from('草稿，待审查');
  atomicWriteJson(path.join(dir,'claim.json'),{schema:1,taskId:task.id,nonce});fs.writeFileSync(path.join(dir,'result.txt'),result,{mode:0o600});
  atomicWriteJson(path.join(dir,'run.json'),{schema:1,taskId:task.id,nonce,taskSha256:digest(fs.readFileSync(path.join(dir,'task.json'))),status:'completed',exitCode:0,resultBytes:result.length,resultSha256:digest(result)});
  const notification=outcome=>({status:'notified',outcome,outcomeKey:digest(stableJson(outcome))});
  const old=notification({nonce,status:'indeterminate',resultSha256:null,errorCategory:'runner_lost'});
  const schedule={schema:1,taskId:task.id,requestHash:task.requestHash,status:'indeterminate',nonce,notification:old,notifications:[old]};
  atomicWriteJson(path.join(dir,'schedule.json'),schedule);const api=backgroundControlApi({root,inboxRoot,binding:f.binding});
  assert.equal(api.readTask({taskId:task.id}).status,'completed');assert.equal(api.readTask({taskId:task.id}).notification,'pending');
  const latest=notification({nonce,status:'completed',resultSha256:digest(result),errorCategory:null});
  atomicWriteJson(path.join(dir,'schedule.json'),{...schedule,status:'completed',resultSha256:digest(result),notification:latest,notifications:[old,latest]});
  assert.equal(api.readTask({taskId:task.id}).notification,'notified');
  for(const badNonce of [undefined,'not-a-claim']) {
    atomicWriteJson(path.join(dir,'claim.json'),{schema:1,taskId:task.id,nonce:badNonce});
    const run=JSON.parse(fs.readFileSync(path.join(dir,'run.json'),'utf8'));atomicWriteJson(path.join(dir,'run.json'),{...run,nonce:badNonce});
    assert.equal(api.readTask({taskId:task.id}).status,'indeterminate');assert.equal(api.readTask({taskId:task.id}).notification,'pending');
  }
  atomicWriteJson(path.join(dir,'claim.json'),{schema:1,taskId:task.id,nonce});
  const restored=JSON.parse(fs.readFileSync(path.join(dir,'run.json'),'utf8'));atomicWriteJson(path.join(dir,'run.json'),{...restored,nonce});
  fs.writeFileSync(path.join(dir,'result.txt'),'tampered',{mode:0o600});assert.throws(()=>api.readTask({taskId:task.id}),/task_control_result_invalid/);
});
