import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DurableInbox,suppressUnclassifiedNotice} from './codex-bridge-inbox.mjs';
import {DurableOutbound} from './codex-bridge-outbound.mjs';
import {DurableReplyRouter,selectReplyRoute} from './codex-bridge-reply-routing.mjs';
import {reactionForJob} from './codex-bridge-reactions.mjs';

const marker=id=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`[飞书消息｜fixture｜om_${id}]`}]}});
const final=text=>({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text}]}});
const failure=()=>({type:'event_msg',payload:{type:'task_complete',error:{message:'private credential errorraw must stay private'}}});

function fixture(t,{cardkit=true,initial=true,classification='actionable',prepare}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'inbox-failure-feedback-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const rollout=path.join(root,'rollout.jsonl');fs.writeFileSync(rollout,'');
  const binding={bot:'fixture',profile:'profile-fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',bot_open_id:'ou_fixturebot',codex_thread_id:'thread-fixture',group_access:'all_group_humans',cardkit_enabled:cardkit};
  const clock={now:1000},calls=[],displayed=[],injected=[];let nextCard=0,nextMessage=0,q,outbound;
  const request=async(b,args)=>{
    assert.equal(b.profile,binding.profile);
    const i=args.indexOf('--data'),data=i<0?{}:JSON.parse(args[i+1]);
    const call={method:args[1],url:args[2],data};calls.push(call);
    await f.before?.(call);
    if(call.method==='POST' && call.url==='/open-apis/cardkit/v1/cards')return {card_id:`card_fixture_${++nextCard}`};
    if(call.method==='POST' && (call.url.endsWith('/reply') || call.url==='/open-apis/im/v1/messages'))return {message_id:`om_sent_${++nextMessage}`};
    if(call.method==='PUT' && data.card)displayed.push(JSON.parse(data.card.data));
    if(call.method==='PATCH')displayed.push(JSON.parse(data.content));
    return {};
  };
  const route=context=>selectReplyRoute(binding,[context.job??q.jobs.get(context.jobId)]);
  const reload=()=>{
    const router=new DurableReplyRouter({root:path.join(root,'routes'),binding,request,now:()=>clock.now});
    outbound=new DurableOutbound(path.join(root,'outbound'),binding,request,{now:()=>clock.now,minIntervalMs:0,presentationEnabled:true,sendMessage:args=>router.send(args)});
    q=new DurableInbox(path.join(root,'inbox'),binding.bot,{
      prepare:prepare??(async e=>e),target:async()=>({rollout}),inject:async job=>injected.push(job.id),
      classifiedFeedback:true,initialFeedbackCard:initial,classification:()=>classification,
      suppressNotices:suppressUnclassifiedNotice,
      send:(text,key,context)=>outbound.text(text,key,route(context)),
      notice:(text,key,context)=>outbound.notice(text,key,{...context,route:route(context)}),
      progress:(text,key,context)=>outbound.progress(text,key,route(context),context),
      final:(text,key,keys,context)=>outbound.final(text,key,keys,{status:'complete',replyRoute:selectReplyRoute(binding,context.jobs)}),
    },{now:()=>clock.now,timeoutMs:1000});
    return q;
  };
  const f={root,rollout,binding,clock,calls,displayed,injected,reload,
    append:(...items)=>fs.appendFileSync(rollout,items.map(item=>JSON.stringify(item)+'\n').join('')),
    event:id=>({type:'im.message.receive_v1',message_id:`om_${id}`,message_type:'text',content:'fixture task',chat_id:binding.chat_id,chat_type:'group',sender_type:'user',sender_id:binding.allowed_sender_id}),
    get q(){return q;},get outbound(){return outbound;},
  };
  reload();return f;
}
const messages=f=>f.calls.filter(c=>c.method==='POST' && (c.url.endsWith('/reply') || c.url==='/open-apis/im/v1/messages'));
const cardState=(f,job)=>f.outbound.read(f.outbound.file('card',job.streamKey));
async function started(f,id='task') {
  f.q.enqueue(f.event(id));await f.q.dispatchOne();f.append(marker(id));await f.q.watch();await f.outbound.flushCards();
  return f.q.jobs.get(`om_${id}`);
}

test('full-group notice gate requires marker, actionable, and non-silent disposition',()=>{
  assert.equal(suppressUnclassifiedNotice({}),true);
  assert.equal(suppressUnclassifiedNotice({feedbackDisposition:'actionable'}),true);
  assert.equal(suppressUnclassifiedNotice({markerSeen:true}),true);
  assert.equal(suppressUnclassifiedNotice({markerSeen:true,feedbackDisposition:'actionable',completionDisposition:'silent'}),true);
  assert.equal(suppressUnclassifiedNotice({markerSeen:true,feedbackDisposition:'actionable'}),false);
  const source=fs.readFileSync(new URL('./codex-bridge-worker.mjs',import.meta.url),'utf8');
  assert.match(source,/suppressNotices: job => binding\.group_access==='all_group_humans' && suppressUnclassifiedNotice\(job\)/);
  assert.match(source,/notice: \(text,key,context\) => outbound\.notice/);
});

test('unclassified failure, pre-marker timeout, and silent completion stay quiet',async t=>{
  const unclassified=fixture(t,{classification:undefined});
  // The fixture default is actionable; override the reader to model undecided intake.
  unclassified.q.io.classification=()=>undefined;
  await started(unclassified);unclassified.append(failure());await unclassified.q.watch();await unclassified.q.deliverReplies();
  assert.equal(unclassified.q.jobs.get('om_task').status,'failed');assert.equal(unclassified.q.jobs.get('om_task').noticeSuppressed,true);
  assert.equal(messages(unclassified).length,0);
  const pending=fixture(t);pending.q.enqueue(pending.event('pending'));await pending.q.dispatchOne();pending.clock.now=2200;
  await pending.q.watch();await pending.q.deliverReplies();assert.equal(messages(pending).length,0);assert.equal(pending.q.jobs.get('om_pending').status,'submitted');
  const silent=fixture(t,{classification:'silent'});await started(silent);await silent.q.deliverReplies();
  assert.equal(silent.q.jobs.get('om_task').completionDisposition,'silent');assert.equal(messages(silent).length,0);
});

test('preparation failure remains private and is never mistaken for task completion',async t=>{
  const f=fixture(t,{prepare:async()=>{throw Object.assign(Error('errorraw credential'),{permanent:true});}});
  f.q.enqueue(f.event('prepare'));await f.q.dispatchOne();await f.q.deliverReplies();
  const job=f.q.jobs.get('om_prepare');assert.equal(job.status,'failed');assert.equal(job.noticeSuppressed,true);assert.equal(messages(f).length,0);
  assert.equal(f.q.stats().completed_count,0);
});

for(const cardkit of [true,false])test(`actionable failure closes the original ${cardkit?'CardKit':'raw'} card without DONE or raw errors`,async t=>{
  const f=fixture(t,{cardkit}),job=await started(f);assert.equal(messages(f).length,1);
  f.append(failure());await f.q.watch();await f.q.deliverReplies();
  const state=cardState(f,job);
  assert.equal(job.status,'failed');assert.equal(f.q.stats().completed_count,0);assert.equal(reactionForJob(job,f.clock.now),'ERROR');
  assert.equal(state.final,true);assert.notEqual(state.finalDelivered,true);assert.equal(state.presentation.status,'error');
  if(cardkit)assert.equal(state.cardClosed,true);
  assert.equal(f.displayed.at(-1).header.template,'red');assert.match(JSON.stringify(f.displayed.at(-1)),/未正常完成/);
  assert.doesNotMatch(JSON.stringify(f.displayed),/credential|errorraw/);assert.equal(messages(f).length,1);
  const count=f.calls.length;f.reload();await f.q.watch();await f.q.deliverReplies();await f.outbound.flushCards();assert.equal(f.calls.length,count);
});

test('actionable failure without a progress card replies safely to the original task once',async t=>{
  const f=fixture(t,{initial:false}),job=await started(f);
  f.append(failure());await f.q.watch();await f.q.deliverReplies();
  assert.equal(job.status,'failed');assert.equal(messages(f).length,1);assert.equal(messages(f)[0].url,'/open-apis/im/v1/messages/om_task/reply');
  assert.equal(messages(f)[0].data.msg_type,'text');assert.doesNotMatch(JSON.stringify(messages(f)),/credential|errorraw/);
  f.reload();await f.q.deliverReplies();assert.equal(messages(f).length,1);
});

for(const cardkit of [true,false])test(`timeout keeps ${cardkit?'CardKit':'raw'} card open; restart and late final reuse it without reinjection`,async t=>{
  const f=fixture(t,{cardkit}),job=await started(f);f.clock.now=2200;await f.q.watch();await f.q.deliverReplies();
  const waiting=cardState(f,job);assert.equal(job.status,'delivered');assert.equal(job.timeoutNotified,true);
  assert.notEqual(waiting.final,true);assert.notEqual(waiting.cardClosed,true);assert.notEqual(waiting.finalDelivered,true);
  assert.equal(reactionForJob(job,f.clock.now),'OneSecond');assert.match(JSON.stringify(waiting.lastAppliedCard??f.displayed.at(-1)),/仍在跟踪/);
  f.reload();await f.q.watch();await f.q.deliverReplies();assert.equal(messages(f).length,1);
  f.clock.now=2400;f.append(final('晚到的业务结果'));await f.q.watch();await f.q.deliverReplies();
  const done=f.q.jobs.get('om_task'),state=cardState(f,done);
  assert.equal(done.status,'done');assert.equal(state.finalDelivered,true);assert.equal(state.text,'晚到的业务结果');assert.equal(messages(f).length,1);
  assert.deepEqual(f.injected,['om_task']);assert.equal(reactionForJob(done,f.clock.now),'DONE');
});

test('fault-card retry is durable and stays distinct from final delivery',async t=>{
  const f=fixture(t),job=await started(f);let reject=true;
  f.before=async call=>{if(reject && call.method==='PUT'){reject=false;throw Object.assign(Error('ETIMEDOUT raw private'),{code:'ETIMEDOUT'});}};
  f.append(failure());await f.q.watch();await f.q.deliverReplies();
  assert.ok(job.noticeRetry?.retryAt);assert.equal(job.status,'failed');assert.notEqual(cardState(f,job).finalDelivered,true);
  f.reload();f.clock.now=100000;await f.q.deliverReplies();
  const recovered=f.q.jobs.get('om_task');assert.equal(recovered.notice,undefined);assert.equal(recovered.status,'failed');assert.equal(messages(f).length,1);
  assert.equal(cardState(f,recovered).cardClosed,true);assert.notEqual(cardState(f,recovered).finalDelivered,true);
});

test('definitely rejected fault-card patch falls back to safe text on the original task',async t=>{
  const f=fixture(t),job=await started(f);
  f.before=async call=>{if(call.method==='PUT')throw Object.assign(Error('private errorraw'),{permanent:true,apiCode:'230006'});};
  f.append(failure());await f.q.watch();await f.q.deliverReplies();
  const state=cardState(f,job);
  assert.equal(job.status,'failed');assert.equal(job.notice,undefined);assert.equal(state.noticeCardFailed,true);assert.equal(state.blocked,true);
  assert.notEqual(state.finalDelivered,true);assert.equal(messages(f).length,2);
  const warning=messages(f).at(-1);assert.equal(warning.url,'/open-apis/im/v1/messages/om_task/reply');assert.equal(warning.data.msg_type,'text');
  assert.match(warning.data.content,/未正常完成/);assert.doesNotMatch(warning.data.content,/private|errorraw/);
  f.reload();await f.q.deliverReplies();assert.equal(messages(f).length,2);
});

test('stale fault and timeout notices cannot overwrite a completed card',async t=>{
  const f=fixture(t),job=await started(f);f.append(final('成功结果'));await f.q.watch();await f.q.deliverReplies();
  const count=f.calls.length;
  await f.outbound.notice('迟到故障','stale-fault',{streamKey:job.streamKey,terminal:true});
  await f.outbound.notice('迟到超时','stale-timeout',{streamKey:job.streamKey});
  assert.equal(f.calls.length,count);assert.equal(cardState(f,job).text,'成功结果');
});
