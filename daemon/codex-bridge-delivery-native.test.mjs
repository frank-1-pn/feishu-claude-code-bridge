import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createReplyDelivery} from './codex-bridge-delivery.mjs';
import {DurableInbox,digest} from './codex-bridge-inbox.mjs';
import {ActionStore} from './codex-bridge-actions.mjs';
import {FileOutbox} from './codex-bridge-files.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {chatReplyRoute} from './codex-bridge-reply-routing.mjs';

const longAnswer='结论：正文和原始报告保持一致。\n\n- 核验要点一\n- 核验要点二\n\n'+'中文正文😀，保留表格和代码。\n'.repeat(180);
function fixture(t,text=longAnswer){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-delivery-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',profile:'fixture-profile',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',codex_thread_id:'thread-fixture'};
  const reportOptions={reportRoot:path.join(root,'reports'),fileOutboxRoot:path.join(root,'files'),inboxRoot:path.join(root,'inbox')};
  const inbox=new DurableInbox(reportOptions.inboxRoot,binding.bot,{});
  const job=inbox.enqueue({message_id:'om_source',chat_id:binding.chat_id,sender_id:binding.allowed_sender_id,
    message_type:'text',content:'请求报告',bridge_binding:bindingSnapshot(binding)});
  Object.assign(job,{reply:text,replyKey:digest('final-answer'),status:'reply_pending'});inbox.save(job);
  const events=[],finals=[],logs=[];
  const files=new FileOutbox(reportOptions.fileOutboxRoot,binding,async(_,args)=>{
    events.push({type:'file',args});return {message_id:`om_file_${events.length}`};
  });
  const actions=new ActionStore({root:path.join(root,'actions'),bot:binding.bot});
  const options={binding,actions,files,reportOptions,outbound:{final:async(...args)=>{events.push({type:'final'});finals.push(args);}},
    log:(name,data)=>logs.push({name,data})};
  const context={jobId:job.id,jobs:[job]};
  return {root,binding,reportOptions,inbox,job,events,files,finals,logs,options,context};
}

test('native route metadata does not alter the immutable report; final and task controls do not wait for files',async t=>{
  const f=fixture(t),route={version:1,mode:'chat',reason:'mixed_topics',sourceCount:2};
  const cloud={status:'ready',url:'https://fixture.feishu.cn/docx/docFixture',title:'完整报告',replyKey:f.job.replyKey};
  const nativeElement={tag:'button',text:{tag:'plain_text',content:'转待办'},value:{context_id:'native-context'}};
  const deliver=createReplyDelivery({...f.options,
    getRoute:context=>{assert.equal(context,f.context);return route;},
    cloudDocs:{enqueue:request=>{assert.deepEqual(request,{jobId:f.job.id,replyKey:f.job.replyKey,text:longAnswer.trim()});f.events.push({type:'cloud'});},
      result:key=>{assert.equal(key,f.job.replyKey);return cloud;}},
    nativeInteractions:{taskButton:request=>{assert.deepEqual(request,{jobId:f.job.id,replyKey:f.job.replyKey,text:longAnswer.trim()});
      return {contextId:'native-context',element:nativeElement};}}
  });
  await deliver(f.job.reply,f.job.replyKey,['stream'],f.context);
  assert.deepEqual(f.events.map(x=>x.type),['cloud','final']);
  const [text,key,streams,p]=f.finals[0];assert.equal(text,longAnswer.trim());assert.equal(key,f.job.replyKey);assert.deepEqual(streams,['stream']);
  assert.deepEqual(p.replyRoute,route);assert.match(p.replyNotice,/不同话题/);assert.equal(p.cloudDoc,cloud);
  assert.equal(p.nativeContext,'native-context');assert.equal(p.interactions.at(-1),nativeElement);
  assert.match(JSON.stringify(p.interactions),/再简短一点/);assert.match(JSON.stringify(p.interactions),/补充依据/);
  assert.deepEqual(p.report,{fileName:'report.html',delivered:false,status:'pending'});
  assert.equal(f.files.stats().file_pending_count,2);
  const raw=fs.readFileSync(path.join(f.reportOptions.reportRoot,f.binding.bot,digest(key),'answer.md'),'utf8');
  assert.equal(raw,longAnswer.trim());assert.doesNotMatch(raw,/本次合并答复/);
});

test('short answers may offer task button but never enqueue cloud documents',async t=>{
  const f=fixture(t,'简短答复'),called=[];
  const deliver=createReplyDelivery({...f.options,cloudDocs:{enqueue:()=>called.push('cloud'),result:()=>({status:'queued',url:'must-not-display'})},
    nativeInteractions:{taskButton:()=>{called.push('task');return {contextId:'native',element:{tag:'button'}};}}});
  await deliver(f.job.reply,f.job.replyKey,[],f.context);
  assert.deepEqual(called,['task']);assert.equal(f.finals[0][3].cloudDoc,undefined);assert.equal(f.events.filter(x=>x.type==='file').length,0);
});

test('waiting form preserves all existing fields and never creates a cloud report or task button',async t=>{
  const form={version:1,title:'补充条件',fields:[{name:'audience',label:'阅读对象',type:'text',required:true}]};
  const f=fixture(t,`${longAnswer}\n\`\`\`feishu-form\n${JSON.stringify(form)}\n\`\`\``),called=[];
  const deliver=createReplyDelivery({...f.options,
    cloudDocs:{enqueue:()=>called.push('cloud'),result:()=>called.push('result')},
    nativeInteractions:{taskButton:()=>called.push('task')},getRoute:()=>({sourceCount:1,mode:'quote'})});
  await deliver(f.job.reply,f.job.replyKey,[],f.context);
  const p=f.finals[0][3];assert.equal(p.status,'waiting');assert.deepEqual(called,[]);
  assert.equal(p.nativeContext,undefined);assert.equal(p.replyNotice,undefined);assert.match(JSON.stringify(p.interactions),/阅读对象/);
  assert.match(p.fallbackText,/阅读对象（必填）/);
});

test('optional feature failures cannot suppress final, existing controls or report files and never log raw errors',async t=>{
  const f=fixture(t),privateMessage='DO_NOT_LOG_private_payload';
  const fail=()=>{throw Error(privateMessage);};
  const deliver=createReplyDelivery({...f.options,getRoute:fail,cloudDocs:{enqueue:fail,result:fail},nativeInteractions:{taskButton:fail}});
  await deliver(f.job.reply,f.job.replyKey,[],f.context);
  const p=f.finals[0][3];assert.equal(f.finals[0][0],longAnswer.trim());assert.equal(p.report.delivered,false);
  assert.ok(p.actionContext);assert.equal(p.nativeContext,undefined);assert.equal(p.cloudDoc,undefined);
  assert.equal(f.events.filter(x=>x.type==='file').length,0);
  assert.equal(f.files.stats().file_pending_count,2);
  assert.deepEqual(new Set(f.logs.map(x=>x.name)),new Set(['reply_route_unavailable','reply_cloud_doc_unavailable','reply_native_actions_unavailable']));
  assert.doesNotMatch(JSON.stringify(f.logs),/DO_NOT_LOG|private_payload/);
  const loggerFails=createReplyDelivery({...f.options,getRoute:fail,log:fail});
  await loggerFails(f.job.reply,f.job.replyKey,[],f.context);assert.equal(f.finals.length,2);
});

test('report renderer failure does not suppress native task or the original answer',async t=>{
  const f=fixture(t),called=[];fs.writeFileSync(f.reportOptions.reportRoot,'not a directory');
  const deliver=createReplyDelivery({...f.options,cloudDocs:{enqueue:()=>called.push('cloud'),result:()=>({status:'missing'})},
    nativeInteractions:{taskButton:()=>{called.push('task');return {contextId:'native',element:{tag:'button'}};}}});
  await deliver(f.job.reply,f.job.replyKey,[],f.context);
  assert.deepEqual(called,['task']);assert.equal(f.finals[0][0],longAnswer.trim());assert.equal(f.finals[0][3].nativeContext,'native');
  assert.equal(f.logs[0].name,'reply_report_unavailable');
});

test('rebound origin is rejected before route or optional native features can run',async t=>{
  const f=fixture(t),called=[];f.binding.codex_thread_id='different-thread';
  const deliver=createReplyDelivery({...f.options,getRoute:()=>called.push('route'),
    cloudDocs:{enqueue:()=>called.push('cloud'),result:()=>called.push('result')},nativeInteractions:{taskButton:()=>called.push('task')}});
  await assert.rejects(deliver(f.job.reply,f.job.replyKey,[],f.context),error=>
    error.permanent===true && ['reply_binding_changed','attachment_binding_changed'].includes(error.message));
  assert.deepEqual(called,[]);assert.equal(f.finals.length,0);assert.equal(f.events.length,0);
});

test('disabling interactions suppresses both legacy and native action controls',async t=>{
  const f=fixture(t,'简单结果'),called=[];f.binding.interactions_enabled=false;
  const deliver=createReplyDelivery({...f.options,nativeInteractions:{taskButton:()=>called.push('task')}});
  await deliver(f.job.reply,f.job.replyKey,[],f.context);assert.deepEqual(called,[]);
  assert.equal(f.finals[0][3].interactions,undefined);assert.equal(f.finals[0][3].nativeContext,undefined);
});

test('report upload waits for the durable final receipt and survives delayed card update without resending files',async t=>{
  const f=fixture(t);
  let finalStarted,releaseFinal,uploadStarted,releaseUpload;
  const awaitingFinal=new Promise(resolve=>{finalStarted=resolve;});
  const finalGate=new Promise(resolve=>{releaseFinal=resolve;});
  const awaitingUpload=new Promise(resolve=>{uploadStarted=resolve;});
  const uploadGate=new Promise(resolve=>{releaseUpload=resolve;});
  f.inbox.io.final=createReplyDelivery({...f.options,outbound:{final:async(...args)=>{
    f.finals.push(args);
    if(args[1]===f.job.replyKey){finalStarted();await finalGate;}
  }}});
  let clock=Date.now(),attempts=0,patchAccepted=false;
  const patches=[];
  const open=()=>new FileOutbox(f.reportOptions.fileOutboxRoot,f.binding,async(_,args)=>{
    const id=++attempts;
    if(id===1){uploadStarted();await uploadGate;}
    assert.ok(args.includes('--file'));
    return {message_id:`om_verified_${id}`,chat_id:f.binding.chat_id};
  },{
    inboxRoot:f.reportOptions.inboxRoot,now:()=>clock,getRoute:()=>chatReplyRoute(f.binding),
    reportUpdate:async update=>{patches.push(update);return patchAccepted;},
  });
  let outbox=open();
  const final=f.inbox.deliverReplies();
  await awaitingFinal;
  assert.equal(f.finals[0][3].report.status,'pending');
  await outbox.flush();
  assert.equal(attempts,0,'queued report waits for final delivery receipt');
  releaseFinal();await final;
  assert.equal(f.job.status,'done');
  const upload=outbox.flush();await awaitingUpload;
  const second=f.inbox.enqueue({...f.job.event,message_id:'om_other'});
  Object.assign(second,{reply:'另一条简短答复。',replyKey:digest('second'),status:'reply_pending'});f.inbox.save(second);
  await f.inbox.deliverReplies();
  assert.equal(second.status,'done','a stalled upload does not block an unrelated final');
  assert.equal(outbox.stats().file_pending_count,2);
  releaseUpload();await upload;
  assert.equal(attempts,2);
  assert.equal(outbox.stats().file_report_update_pending_count,1);
  await outbox.flushReportUpdates();
  assert.equal(patches.length,1);
  assert.equal(patches[0].status,'done');
  assert.equal(patches[0].done,2);
  assert.equal(patches[0].delivered,true);
  assert.match(patches[0].messageId,/^om_verified_/);
  outbox=open();
  await outbox.flush();await outbox.flushReportUpdates();
  assert.equal(attempts,2);
  assert.equal(patches.length,1,'persisted retry timing survives restart');
  clock+=2000;patchAccepted=true;
  await outbox.flushReportUpdates();
  assert.deepEqual(patches[1],patches[0]);
  assert.equal(outbox.stats().file_report_update_pending_count,0);
  await open().flushReportUpdates();
  assert.equal(patches.length,2,'acknowledged report update never replays');
});

test('report permission failure sends one truthful update and no duplicate notice',async t=>{
  const f=fixture(t);let network=0,notices=0;
  const patches=[];
  f.inbox.io.final=createReplyDelivery(f.options);
  await f.inbox.deliverReplies();
  const outbox=new FileOutbox(f.reportOptions.fileOutboxRoot,f.binding,async()=>{
    network++;throw Object.assign(Error('forbidden'),{type:'permission'});
  },{
    inboxRoot:f.reportOptions.inboxRoot,getRoute:()=>chatReplyRoute(f.binding),
    notify:async()=>{notices++;},
    reportUpdate:async update=>{patches.push(update);return true;},
  });
  await outbox.flush();await outbox.flush();await outbox.flushReportUpdates();await outbox.flushReportUpdates();
  assert.equal(network,2);assert.equal(notices,0);
  assert.equal(patches.length,1);
  assert.equal(patches[0].status,'blocked');
  assert.equal(patches[0].delivered,false);
  assert.equal(patches[0].messageId,undefined);
  assert.equal(outbox.stats().file_active_failed_count,2);
  assert.equal(outbox.stats().file_historical_unresolved_count,0);
  const afterRebind=new FileOutbox(f.reportOptions.fileOutboxRoot,{...f.binding,codex_thread_id:'rebound'},async()=>{network++;},
    {reportUpdate:async()=>{assert.fail('stale report tried to update a different binding');}});
  await afterRebind.flushReportUpdates();
  assert.equal(network,2);
});
