import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DurableInbox,digest} from './codex-bridge-inbox.mjs';
import {DurableOutbound} from './codex-bridge-outbound.mjs';
import {TaskResultStore} from './codex-bridge-task-results.mjs';
import {createReplyDelivery} from './codex-bridge-delivery.mjs';
import {FileOutbox} from './codex-bridge-files.mjs';
import {ActionStore} from './codex-bridge-actions.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {BackgroundScheduler,verifyBackgroundCompletion} from './codex-bridge-background.mjs';
import {enqueueBackgroundTask,readBackgroundJson} from './codex-bridge-background-store.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';

function fixture(t) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'task-integration-')));
  fs.chmodSync(base,0o700);t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const stateRoot=path.join(base,'state'),inboxRoot=path.join(stateRoot,'codex-inbox-v2'),
    backgroundRoot=path.join(stateRoot,'background-v1'),completionRoot=path.join(stateRoot,'completions-v1'),codexHome=path.join(base,'home'),
    rollout=path.join(base,'rollout.ndjson');fs.writeFileSync(rollout,'',{mode:0o600});
  const binding={bot:'fixture',profile:'fixture-profile',chat_id:'oc_fixture',allowed_sender_id:'ou_Owner',bot_open_id:'ou_Bot',
    group_access:'all_group_humans',codex_thread_id:'fixture-thread',cwd:base,cardkit_enabled:true,initial_feedback_card:true};
  const reportOptions={inboxRoot,reportRoot:path.join(stateRoot,'reports'),fileOutboxRoot:path.join(stateRoot,'files')};
  const clock={now:1000},server={calls:[],visible:new Map(),entities:0,after:null};
  const request=async (_binding,args)=> {
    const index=args.indexOf('--data'),call={args:[...args],method:args[1],url:args[2],data:index>=0?JSON.parse(args[index+1]):null};
    server.calls.push(call);let result={};
    if(args[0]==='im')result={message_id:`om_file_${server.calls.length}`};
    else if(call.method==='POST'&&call.url==='/open-apis/cardkit/v1/cards')result={card_id:`card_${++server.entities}`};
    else if(call.method==='POST'&&call.url==='/open-apis/im/v1/messages') {
      if(!server.visible.has(call.data.uuid))server.visible.set(call.data.uuid,{message_id:`om_card_${server.visible.size+1}`});
      result=server.visible.get(call.data.uuid);
    }
    await server.after?.(call,result);return result;
  };
  const actions=new ActionStore({root:path.join(stateRoot,'actions'),bot:binding.bot,now:()=>clock.now});
  let inbox,store,deliver;
  const outbound=new DurableOutbound(path.join(stateRoot,'outbound'),binding,request,{now:()=>clock.now,minIntervalMs:0,presentationEnabled:true,
    onCardMessage:(id,p)=>{if(p?.actionContext)actions.bindMessage(p.actionContext,id);}});
  const files=new FileOutbox(reportOptions.fileOutboxRoot,binding,(...args)=>outbound.serial(()=>request(...args)),{now:()=>clock.now});
  const io={perTaskResults:true,taskResultScope:{cwd:base,codexHome},classifiedFeedback:true,initialFeedbackCard:true,
    prepare:async event=>event,target:async()=>({rollout}),inject:async()=>{},
    classification:job=>job.event.synthetic_callback?null:'actionable',taskResults:{get:job=>store.get(job)},
    final:(...args)=>deliver(...args),closeReplyCards:(...args)=>deliver.closeCards(...args),
    closeLinkedTaskCard:(key,context)=>outbound.linkTaskCard(key,inbox.jobs.get(context.ownerJobId).streamKey,{jobId:context.jobId}),
    progress:(text,key,context)=>outbound.progress(text,key,undefined,context)};
  const open=()=> {
    inbox=new DurableInbox(inboxRoot,binding.bot,io,{now:()=>clock.now});
    store=new TaskResultStore({root:path.join(stateRoot,'task-results-v1'),inboxRoot,completionRoot,backgroundRoot,binding,codexHome,
      actionRoot:path.join(stateRoot,'actions'),outboundRoot:path.join(stateRoot,'outbound')});
    deliver=createReplyDelivery({binding,actions,outbound,files,reportOptions,taskResults:store});
  };
  open();
  const append=items=>fs.appendFileSync(rollout,items.map(item=>JSON.stringify(item)+'\n').join(''));
  const human=(id,extra={})=>inbox.enqueue({type:'im.message.receive_v1',message_id:id,message_type:'text',content:JSON.stringify({text:'请处理本项任务'}),
    chat_id:binding.chat_id,chat_type:'group',sender_id:binding.allowed_sender_id,sender_type:'user',bridge_binding:bindingSnapshot(binding),...extra});
  const admit=async(jobs,turnId='same-turn')=>{
    for(const job of jobs) {assert.equal(job.status,'queued');await inbox.dispatchOne();}
    append([{type:'turn_context',payload:{turn_id:turnId}},...jobs.map(job=>({type:'response_item',payload:{type:'message',role:'user',
      content:[{type:'input_text',text:`[飞书消息｜fixture｜${job.id}] 原始任务正文`}]}}))]);
    await inbox.watch();await outbound.flushCards();for(const job of jobs)assert.equal(job.markerSeen,true);
  };
  const finish=()=>{append([{type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'本轮自然final不承载任务结果。'}]}},
    {type:'event_msg',payload:{type:'task_complete',last_agent_message:'本轮自然final不承载任务结果。'}}]);};
  const pump=async()=>{await inbox.watch();await inbox.deliverReplies();};
  const submit=(job,key,status,text)=>store.submit(job.id,{resultKey:key,status,text});
  const card=job=>outbound.read(outbound.file('card',inbox.jobs.get(job.id).streamKey));
  const action=(owner,actionName,values)=>{
    const state=card(owner),envelope={type:'card.action.trigger',event_id:`event-${actionName}-${state.taskResult.revision}`,operator:{open_id:binding.allowed_sender_id},
      context:{open_chat_id:binding.chat_id,open_message_id:state.messageId},action:{tag:'button',value:{action:actionName,context_id:state.presentation.actionContext,
        version:state.taskResult.revision},...(values?{form_value:values}:{})}};
    const accepted=actions.acceptCallback(envelope,{binding,authenticatedBot:binding.bot});assert.equal(accepted.accepted,true);
    actions.drain({binding,inbox});const source=[...inbox.jobs.values()].find(job=>job.id===accepted.eventId);assert.ok(source);return source;
  };
  return {base,binding,stateRoot,inboxRoot,backgroundRoot,completionRoot,codexHome,reportOptions,rollout,clock,server,actions,outbound,files,open,human,admit,
    finish,pump,submit,card,action,append,get inbox(){return inbox;},get store(){return store;}};
}

test('one turn submits three independent results to three cards without natural-final fanout',async t=>{
  const f=fixture(t),jobs=[f.human('om_one'),f.human('om_two'),f.human('om_three')];await f.admit(jobs);
  const texts=['第一项独立完成。','第二项缺少日期，请补充。','第三项无法完成，原因已核对。'],statuses=['complete','waiting','failed'];
  jobs.forEach((job,i)=>f.submit(job,`result-${i}`,statuses[i],texts[i]));f.finish();await f.pump();
  assert.equal(f.server.visible.size,3);assert.equal(new Set(jobs.map(job=>f.card(job).messageId)).size,3);
  jobs.forEach((job,i)=>{assert.equal(job.status,'done');assert.equal(job.taskBusinessStatus,statuses[i]);assert.equal(f.card(job).text,texts[i]);
    assert.ok(job.finalDeliveryEvidence);assert.equal(f.card(job).text.includes('自然final'),false);});
  assert.deepEqual(jobs.map(job=>f.card(job).presentation.status),['complete','waiting','error']);
  const count=f.server.calls.length;await f.pump();assert.equal(f.server.calls.length,count);
});

test('an earlier legacy source cannot consume an unrelated later task-result turn completion',async t=>{
  const f=fixture(t),legacy=f.human('om_legacy_earlier');
  delete legacy.taskResultProtocolVersion;delete legacy.taskResultProtocolScope;f.inbox.save(legacy);
  await f.admit([legacy],'earlier-legacy-turn');
  const task=f.human('om_new_independent');await f.admit([task],'later-task-turn');
  f.submit(task,'new-task-only','complete','只属于后来独立任务的结论。');f.finish();await f.pump();
  assert.equal(task.status,'done');assert.equal(f.card(task).text,'只属于后来独立任务的结论。');
  assert.equal(legacy.replyKey,undefined,'a later turn final is not a receipt for the earlier source');
  assert.equal(legacy.status,'delivered');assert.equal(f.card(legacy).text.includes('自然final'),false);
});

test('active linked supplement completes original waiting card and report attachments keep original owner',async t=>{
  const f=fixture(t),owner=f.human('om_owner');await f.admit([owner]);
  const waiting='请补充日期。\n```feishu-form\n'+JSON.stringify({version:1,title:'补充日期',fields:[{name:'date',label:'日期',type:'text',required:true}]})+'\n```';
  f.submit(owner,'waiting-v1','waiting',waiting);f.finish();await f.pump();
  const first=f.card(owner),oldContext=first.presentation.actionContext;
  assert.equal(first.taskResult.status,'waiting');assert.equal(f.files.records().length,0);
  f.open();const currentOwner=f.inbox.jobs.get(owner.id),supplement=f.human('om_supplement',{parent_id:owner.id});
  await f.admit([supplement],'future-supplement-turn');f.store.link(supplement.id,owner.id);
  await f.inbox.watch();await f.inbox.deliverReplies();
  assert.equal(supplement.status,'delivered','linking alone does not complete the new source against the preceding waiting receipt');
  const answer='补充日期已经核对，完整方案如下。\n\n'+'实际结果与依据。\n'.repeat(450),result=f.submit(supplement,'complete-v2','complete',answer);
  f.finish();await f.pump();
  assert.equal(f.card(currentOwner).messageId,first.messageId);assert.equal(f.card(currentOwner).cardId,first.cardId);
  assert.equal(f.card(currentOwner).taskResult.revision,2);assert.equal(currentOwner.taskBusinessStatus,'complete');assert.equal(supplement.status,'done');
  assert.equal(supplement.taskResultLinkedReplyKey,result.replyKey);
  assert.ok(supplement.taskResultLinkedDeliveryEvidence);
  const reports=f.files.records();assert.equal(reports.length,2);assert.ok(reports.every(({s})=>s.jobId===owner.id&&s.status==='done'));
  const manifest=JSON.parse(fs.readFileSync(path.join(f.reportOptions.reportRoot,f.binding.bot,digest(result.replyKey),'manifest.json')));
  assert.equal(manifest.jobId,owner.id);assert.equal(manifest.replyKey,result.replyKey);assert.equal(manifest.answerHash,digest(answer.trim()));
  assert.equal(f.card(currentOwner).presentation.report.delivered,true);
  const oldForm={type:'card.action.trigger',event_id:'old-form',operator:{open_id:f.binding.allowed_sender_id},
    context:{open_chat_id:f.binding.chat_id,open_message_id:first.messageId},action:{tag:'button',value:{action:'conditions',context_id:oldContext,version:1},form_value:{date:'2026-10-10'}}};
  assert.equal(f.actions.acceptCallback(oldForm,{binding:f.binding,authenticatedBot:f.binding.bot}).reason,'stale_context');
  assert.equal(f.server.visible.size,2,'the original owner and pre-link supplement feedback are the only visible messages');
});

test('authentic background callback stays active until reviewed result updates the original working card',async t=>{
  const f=fixture(t),owner=f.human('om_research');await f.admit([owner]);
  const cli=path.join(f.base,'fixture-cli.mjs'),promptFile=path.join(f.base,'prompt.txt');fs.writeFileSync(promptFile,'只读整理给定资料。',{mode:0o600});
  const queued=enqueueBackgroundTask({root:f.backgroundRoot,inboxRoot:f.inboxRoot,completionRoot:f.completionRoot,binding:f.binding,codexHome:f.codexHome,
    codexCliJs:cli,jobId:owner.id,taskKey:'research',title:'后台研究',promptFile,now:()=>f.clock.now});
  f.submit(owner,'queued-v1','background','已安排后台研究，正在执行。');f.finish();await f.pump();
  const first=f.card(owner);assert.equal(first.presentation.status,'working');assert.equal(owner.status,'done');
  const scheduler=new BackgroundScheduler({root:f.backgroundRoot,inboxRoot:f.inboxRoot,completionRoot:f.completionRoot,binding:f.binding,codexHome:f.codexHome,
    codexCliJs:cli,inbox:f.inbox,launch:()=>({unref(){},once(){}}),probe:async()=>true,now:()=>f.clock.now});
  await scheduler.tick();const dir=path.join(f.backgroundRoot,f.binding.bot,queued.taskId),claim=readBackgroundJson(path.join(dir,'claim.json')),
    bytes=Buffer.from('经过审查的真实后台研究结果。');
  fs.writeFileSync(path.join(dir,'result.txt'),bytes,{mode:0o600});atomicWriteJson(path.join(dir,'run.json'),{schema:1,taskId:queued.taskId,nonce:claim.nonce,pid:12345,
    processIdentity:{bootId:'fixture',startSeconds:1},heartbeatAt:f.clock.now,status:'completed',exitCode:0,resultBytes:bytes.length,resultSha256:digest(bytes),
    taskSha256:digest(fs.readFileSync(path.join(dir,'task.json')))});
  await scheduler.tick();const callback=[...f.inbox.jobs.values()].find(job=>job.event.background_completion);
  assert.ok(callback);assert.equal(verifyBackgroundCompletion(f.binding,callback.event,f.backgroundRoot),true);
  await f.admit([callback],'future-background-review-turn');await f.inbox.deliverReplies();
  assert.equal(callback.status,'delivered','prior background acknowledgment is not the callback result');
  await scheduler.tick();assert.equal(readBackgroundJson(path.join(dir,'schedule.json')).notification.status,'queued');
  const reviewed=f.submit(callback,'reviewed-v2','complete',bytes.toString());await f.inbox.watch();
  assert.equal(owner.status,'done','the acknowledged original transport source remains done during revised card delivery');
  assert.equal(owner.taskResultPending,true);assert.equal(verifyBackgroundCompletion(f.binding,callback.event,f.backgroundRoot),true);
  assert.equal(f.store.get(owner).replyKey,reviewed.replyKey);f.finish();await f.pump();await scheduler.tick();
  assert.equal(f.card(owner).messageId,first.messageId);assert.equal(f.server.visible.size,1);
  assert.equal(f.card(owner).text,bytes.toString());assert.equal(owner.taskBusinessStatus,'complete');assert.equal(callback.status,'done');
  assert.equal(readBackgroundJson(path.join(dir,'schedule.json')).notification.status,'notified');
});

test('actual waiting form callback submits structured completion on the original owner card',async t=>{
  const f=fixture(t),owner=f.human('om_form_owner');await f.admit([owner]);
  const form={version:1,title:'日期条件',fields:[{name:'date',label:'日期',type:'text',required:true}]};
  f.submit(owner,'form-wait-v1','waiting','请一次补充日期。\n```feishu-form\n'+JSON.stringify(form)+'\n```');f.finish();await f.pump();
  const first=f.card(owner),callback=f.action(owner,'conditions',{date:'2026-10-10'});await f.admit([callback],'future-form-turn');
  await f.inbox.deliverReplies();assert.equal(callback.status,'delivered');
  const result=f.submit(callback,'form-complete-v2','complete','日期已核对为 2026-10-10，任务完成。');f.finish();await f.pump();
  assert.equal(f.card(owner).messageId,first.messageId);assert.equal(f.card(owner).taskResult.revision,2);
  assert.equal(f.card(owner).text,'日期已核对为 2026-10-10，任务完成。');assert.equal(f.server.visible.size,1);
  assert.equal(callback.status,'done');assert.equal(callback.taskResultLinkedReplyKey,result.replyKey);
});

test('actual shorter callback revises a completed answer on the same card',async t=>{
  const f=fixture(t),owner=f.human('om_shorter_owner');await f.admit([owner]);
  f.submit(owner,'full-v1','complete','已经核对完成。\n\n这是需要进一步简化的原始完整说明。');f.finish();await f.pump();
  const first=f.card(owner),callback=f.action(owner,'shorter');await f.admit([callback],'future-shorter-turn');
  const result=f.submit(callback,'shorter-v2','complete','已核对完成。');assert.equal(result.updateKind,'answer_revision');
  f.finish();await f.pump();assert.equal(f.card(owner).messageId,first.messageId);assert.equal(f.card(owner).cardId,first.cardId);
  assert.equal(f.card(owner).text,'已核对完成。');assert.equal(f.card(owner).taskResult.revision,2);assert.equal(f.server.visible.size,1);
  assert.equal(callback.status,'done');assert.equal(callback.taskResultLinkedReplyKey,result.replyKey);
});

test('human reply to the visible waiting task card resolves its privately bound owner',async t=>{
  const f=fixture(t),owner=f.human('om_visible_owner');await f.admit([owner]);
  f.submit(owner,'visible-wait-v1','waiting','请补充日期。');f.finish();await f.pump();const first=f.card(owner);
  const supplement=f.human('om_visible_reply',{parent_id:first.messageId});await f.admit([supplement],'future-visible-reply-turn');
  assert.equal(f.store.link(supplement.id,owner.id).ownerJobId,owner.id);
  const result=f.submit(supplement,'visible-complete-v2','complete','根据卡片回复补充的日期已经完成。');f.finish();await f.pump();
  assert.equal(f.card(owner).messageId,first.messageId);assert.equal(f.card(owner).text,result.text);assert.equal(supplement.status,'done');
  assert.equal(supplement.taskResultLinkedReplyKey,result.replyKey);
});

test('lost revised-card ACK leaves no result receipt and retries exact operation without inheriting old proof',async t=>{
  const f=fixture(t),owner=f.human('om_retry');await f.admit([owner]);const first=f.submit(owner,'waiting-v1','waiting','等待日期。');f.finish();await f.pump();
  const supplement=f.human('om_retry_supplement',{parent_id:owner.id});await f.admit([supplement],'retry-supplement-turn');f.store.link(supplement.id,owner.id);
  const next=f.submit(supplement,'complete-v2','complete','新日期已核对，结果完成。');let lost=true;
  f.server.after=async call=>{if(call.method==='PUT'&&lost){lost=false;throw Object.assign(Error('ACK lost'),{code:'ETIMEDOUT',deliveryUncertain:true});}};
  await f.pump();assert.equal(owner.taskResultPending,true);assert.equal(f.outbound.replyDelivered(first.replyKey),true);
  assert.equal(f.outbound.replyDelivered(next.replyKey),false);assert.equal(owner.finalDeliveryEvidence,undefined);
  assert.equal(fs.existsSync(path.join(f.inboxRoot,f.binding.bot,`sent-${next.replyKey}.json`)),false);
  const pending=f.card(owner).cardPending;assert.ok(pending);f.clock.now+=60000;f.open();await f.pump();
  const currentOwner=f.inbox.jobs.get(owner.id);assert.equal(currentOwner.taskResultPending,undefined);
  assert.equal(currentOwner.taskBusinessStatus,'complete');assert.equal(f.outbound.replyDelivered(next.replyKey),true);
  const writes=f.server.calls.filter(call=>call.method==='PUT'&&call.data.sequence===pending.sequence&&call.data.uuid===pending.body.uuid);
  assert.equal(writes.length,2);assert.deepEqual(writes[0].data,writes[1].data);
  assert.equal(f.card(currentOwner).text,'新日期已核对，结果完成。');
});
