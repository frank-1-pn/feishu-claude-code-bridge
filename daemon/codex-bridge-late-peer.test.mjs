import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableInbox } from './codex-bridge-inbox.mjs';
import { DurableOutbound } from './codex-bridge-outbound.mjs';
import { createReplyDelivery } from './codex-bridge-delivery.mjs';
import { bindingSnapshot } from './codex-bridge-ux.mjs';

function fixture(t,{cardkit=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-late-peer-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',profile:'fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_owner',bot_open_id:'ou_bot',
    codex_thread_id:'fixture-thread',group_access:'all_group_humans',cardkit_enabled:cardkit};
  const inboxRoot=path.join(root,'inbox'),outRoot=path.join(root,'out'),rollout=path.join(root,'rollout.jsonl');
  fs.writeFileSync(rollout,'');let now=1000,created=0,entities=0,nativeCalls=0,failClose=false,crashAfterFinal=false;
  const calls=[],injected=[],dispositions=new Map();let inbox,outbound;
  const request=async(_binding,args)=>{
    calls.push(args);
    if(args[1]==='POST')return args[2].includes('/cardkit/')?{card_id:`card_fixture_${++entities}`}:{message_id:`om_card_${++created}`};
    if(failClose && args[1]==='PATCH' && args[2]==='/open-apis/im/v1/messages/om_card_1')throw failClose==='permanent'?Object.assign(Error('denied'),{permanent:true,code:'permission'}):Error('offline');
    if(args[0]==='im')return {message_id:'om_text'};
    return {};
  };
  const open=()=>{
    outbound=new DurableOutbound(outRoot,binding,request,{now:()=>now,presentationEnabled:true,minIntervalMs:0});
    const final=createReplyDelivery({binding,outbound,files:{flush:async()=>assert.fail('short result has no report')},
      reportOptions:{inboxRoot,reportRoot:path.join(root,'reports'),fileOutboxRoot:path.join(root,'files')},
      nativeInteractions:{taskButton:async()=>{nativeCalls++;return {contextId:'native_fixture',element:{tag:'button',text:{tag:'plain_text',content:'任务'}}};}}});
    inbox=new DurableInbox(inboxRoot,binding.bot,{
      prepare:async e=>e,target:async()=>({rollout}),inject:async job=>injected.push(job.id),
      classifiedFeedback:true,initialFeedbackCard:true,classification:job=>dispositions.get(job.id),
      progress:async(text,key,context)=>outbound.progress(text,key,undefined,context),
      final:async(...args)=>{await final(...args);if(crashAfterFinal){crashAfterFinal=false;throw Error('simulated_receipt_crash');}},
      closeReplyCards:final.closeCards,send:async()=>assert.fail('no notice or duplicate answer'),
    },{now:()=>now});return inbox;
  };
  open();
  const append=(...items)=>fs.appendFileSync(rollout,items.map(item=>JSON.stringify(item)+'\n').join(''));
  const marker=id=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`[飞书消息｜fixture｜om_${id}]`}]}});
  const message=(text,phase='commentary')=>({type:'response_item',payload:{type:'message',role:'assistant',phase,content:[{type:'output_text',text}]}});
  const add=async(id,disposition='actionable')=>{
    const job=inbox.enqueue({type:'im.message.receive_v1',message_id:`om_${id}`,chat_id:binding.chat_id,chat_type:'group',
      sender_type:'user',sender_id:'ou_member',message_type:'text',content:id,bridge_binding:bindingSnapshot(binding)});
    dispositions.set(job.id,disposition);await inbox.dispatchOne();return job;
  };
  const prime=async()=>{
    await add('a');append({type:'turn_context',payload:{turn_id:'one'}},marker('a'),message('[飞书进度｜om_a] A正在处理'));
    await inbox.watch();await outbound.flushCards();
    // 2.56 MiB of synthetic execution history leaves A more than two scans
    // behind, while B is submitted at the tail and immediately finds the final.
    const record=JSON.stringify({type:'event_msg',payload:{type:'token_count',padding:'x'.repeat(32700)}})+'\n';
    const filler=record.repeat(Math.ceil(2.56*1024*1024/Buffer.byteLength(record)));
    fs.appendFileSync(rollout,filler);assert.ok(Buffer.byteLength(filler)>2.56*1024*1024);
    await add('b');await add('silent','silent');await add('unknown',null);
    append(marker('b'),marker('silent'),marker('unknown'),message('[飞书进度｜om_b] B正在整理'),message('唯一完整结果','final_answer'));
    await inbox.watch();await outbound.flushCards();
    assert.equal(inbox.jobs.get('om_a').status,'delivered');assert.equal(inbox.jobs.get('om_b').status,'reply_pending');
  };
  const catchUp=async()=>{for(let i=0;i<4;i++){await inbox.watch();await inbox.deliverReplies();}};
  return {root,binding,inboxRoot,outRoot,rollout,calls,injected,open,add,append,marker,message,prime,catchUp,
    get inbox(){return inbox;},get outbound(){return outbound;},get nativeCalls(){return nativeCalls;},
    advance:()=>{now+=10000;},failClose:v=>{failClose=v;},crashAfterFinal:()=>{crashAfterFinal=true;}};
}
const patches=f=>f.calls.filter(args=>args[1]==='PATCH');
const creations=f=>f.calls.filter(args=>args[1]==='POST' && args[2]==='/open-apis/im/v1/messages');
const card=(f,id)=>f.outbound.read(f.outbound.file('card',f.inbox.jobs.get(`om_${id}`).streamKey));
const fullDeliveries=f=>f.calls.filter(args=>['PATCH','PUT'].includes(args[1])).filter(args=>{
  const data=JSON.parse(args.at(-1));
  const card=data.card?.data?JSON.parse(data.card.data):args[2].startsWith('/open-apis/im/v1/messages/') && data.content?JSON.parse(data.content):null;
  return card?.body?.elements?.some(e=>e.content==='唯一完整结果');
});

for(const cardkit of [false,true])test(`2.56 MiB late peer closes its own ${cardkit?'CardKit':'raw'} card after shared receipt and restart without repeating the final`,async t=>{
  const f=fixture(t,{cardkit});await f.prime();await f.inbox.deliverReplies();
  assert.equal(f.inbox.jobs.get('om_b').status,'done');assert.equal(card(f,'a').final,undefined);assert.equal(fullDeliveries(f).length,1);
  const created=creations(f).length,native=f.nativeCalls;f.open();await f.catchUp();
  assert.equal(f.inbox.jobs.get('om_a').status,'done');assert.equal(card(f,'a').final,true);
  assert.equal(card(f,'a').text,'处理完成，完整答复已发送。');assert.equal(card(f,'a').finalClosedReplyKey,card(f,'b').finalReplyKey);
  assert.equal(fullDeliveries(f).length,1);assert.equal(creations(f).length,created);assert.equal(f.nativeCalls,native);
  assert.equal(f.inbox.jobs.get('om_silent').completionDisposition,'silent');assert.equal(f.inbox.jobs.get('om_unknown').unclassifiedTurnEnded,true);
  assert.equal(f.inbox.jobs.get('om_unknown').status,'delivered');assert.equal(f.inbox.jobs.get('om_unknown').replyKey,undefined);
  const count=f.calls.length;f.open();await f.catchUp();assert.equal(f.calls.length,count);assert.equal(f.injected.length,4);
});

test('late card patch failure persists separately from sent answer and retries after restart',async t=>{
  const f=fixture(t);await f.prime();await f.inbox.deliverReplies();f.failClose(true);await f.catchUp();
  const job=f.inbox.jobs.get('om_a');assert.equal(job.status,'reply_pending');assert.equal(job.replyCardRetry.attempts,1);
  assert.equal(job.replyCardsClosedAt,undefined);assert.equal(fullDeliveries(f).length,1);
  f.open();const before=f.calls.length;await f.inbox.deliverReplies();assert.equal(f.calls.length,before);
  f.failClose(false);f.advance();await f.inbox.deliverReplies();assert.equal(f.inbox.jobs.get('om_a').status,'done');
  assert.equal(f.inbox.jobs.get('om_a').replyCardRetry,undefined);assert.equal(card(f,'a').final,true);assert.equal(fullDeliveries(f).length,1);
});

test('delivery-to-inbox-receipt crash discovers already delivered final before an earlier late card',async t=>{
  const f=fixture(t);await f.prime();f.crashAfterFinal();await f.inbox.deliverReplies();
  assert.equal(f.inbox.jobs.get('om_b').status,'reply_pending');assert.equal(fullDeliveries(f).length,1);
  const native=f.nativeCalls;f.open();f.advance();await f.catchUp();
  assert.equal(f.inbox.jobs.get('om_a').status,'done');assert.equal(f.inbox.jobs.get('om_b').status,'done');assert.equal(fullDeliveries(f).length,1);
  // Receipt recovery bypasses native action, report, file and message setup.
  assert.equal(f.nativeCalls,native);assert.equal(creations(f).length,2);
});

test('aggregate outbox receipt crash recovers from a delivered card even when it is absent from current stream keys',async t=>{
  const f=fixture(t);await f.prime();await f.inbox.deliverReplies();const key=f.inbox.jobs.get('om_b').replyKey;
  fs.unlinkSync(f.outbound.file('reply',key));f.open();
  await f.outbound.final('唯一完整结果',key,[f.inbox.jobs.get('om_a').streamKey]);
  assert.equal(fullDeliveries(f).length,1);assert.equal(creations(f).length,2);assert.equal(card(f,'a').final,true);
});

test('card-only recovery never creates a new card and rejects silent, unclassified, stale-binding or unrelated keys',async t=>{
  const f=fixture(t);await f.prime();await f.inbox.deliverReplies();await f.catchUp();
  const a=f.inbox.jobs.get('om_a'),final=createReplyDelivery({binding:f.binding,outbound:f.outbound,reportOptions:{inboxRoot:f.inboxRoot}});
  const before=f.calls.length;
  await f.outbound.closeReplyCards(a.replyKey,['missing']);assert.equal(f.calls.length,before);
  for(const change of [{completionDisposition:'silent'},{feedbackDisposition:'silent'},{unclassifiedTurnEnded:true},
    {replyKey:'0'.repeat(64)},{event:{...a.event,bridge_binding:{...a.event.bridge_binding,chat_id:'oc_other'}}}]) {
    const original={...a};Object.assign(a,change);f.inbox.save(a);
    await assert.rejects(final.closeCards(original.replyKey,[original.streamKey],{jobs:[a]}));
    for(const key of Object.keys(a))if(!(key in original))delete a[key];Object.assign(a,original);f.inbox.save(a);
  }
  await assert.rejects(f.outbound.closeReplyCards('0'.repeat(64),[a.streamKey]),/card_reply_key_changed/);
  assert.equal(f.calls.length,before);
});


test('upgrade recovers an old done late peer from its shared receipt without replaying delivery',async t=>{
  const f=fixture(t);await f.prime();await f.inbox.deliverReplies();
  for(let i=0;i<3;i++)await f.inbox.watch();
  const a=f.inbox.jobs.get('om_a');assert.equal(a.status,'reply_pending');assert.equal(card(f,'a').final,undefined);
  a.status='done';a.completedAt=1000;delete a.reply;f.inbox.save(a);
  const native=f.nativeCalls;f.open();await f.inbox.deliverReplies();
  assert.equal(f.inbox.jobs.get('om_a').status,'done');assert.ok(f.inbox.jobs.get('om_a').replyCardsClosedAt);
  assert.equal(card(f,'a').final,true);assert.equal(fullDeliveries(f).length,1);assert.equal(f.nativeCalls,native);
});

test('permanent card-close failure remains blocked across restart while the sent final stays deduplicated',async t=>{
  const f=fixture(t);await f.prime();await f.inbox.deliverReplies();f.failClose('permanent');await f.catchUp();
  assert.equal(f.inbox.jobs.get('om_a').status,'reply_pending');assert.equal(f.inbox.jobs.get('om_a').replyCardRetry.blocked,true);
  assert.equal(f.inbox.stats().outbound_blocked_count,1);const before=f.calls.length;f.open();f.advance();await f.catchUp();
  assert.equal(f.calls.length,before);assert.equal(fullDeliveries(f).length,1);assert.equal(f.inbox.jobs.get('om_a').status,'reply_pending');
});

test('card-only closure freezes unsent intents and preserves a waiting final status on late peer cards',async t=>{
  const f=fixture(t);f.outbound.progress('queued only','unsent');
  await f.outbound.closeReplyCards('waiting-reply',['unsent']);assert.equal(f.calls.length,0);
  assert.equal(f.outbound.read(f.outbound.file('card','unsent')).final,true);await f.outbound.flushCards();assert.equal(f.calls.length,0);
  f.outbound.progress('existing','late');await f.outbound.flushCards();
  await f.outbound.final('请一次补充两项条件。','waiting-reply',[],{status:'waiting'});
  const created=creations(f).length;await f.outbound.closeReplyCards('waiting-reply',['late']);
  const late=f.outbound.read(f.outbound.file('card','late'));assert.equal(late.presentation.status,'waiting');assert.equal(late.text,'等待补充，完整答复已发送。');
  assert.equal(creations(f).length,created);
});
