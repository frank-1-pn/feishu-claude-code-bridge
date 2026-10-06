import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DurableInbox} from './codex-bridge-inbox.mjs';
import {DurableOutbound} from './codex-bridge-outbound.mjs';
import {DurableReactions} from './codex-bridge-reactions.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {enqueueActionable,enqueueSilentCompletion} from './codex-bridge-completion.mjs';
import {classifyWithFastFeedback,isExplicitOperationalRequest} from './codex-bridge-fast-feedback.mjs';

function fixture(t,options={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'first-feedback-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let now=10000,hook=async()=>{};
  const binding={bot:'fixture',profile:'fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_owner',bot_open_id:'ou_bot',group_access:'all_group_humans',codex_thread_id:'thread',initial_feedback_card:true,...options};
  const inboxRoot=path.join(root,'inbox'),controlRoot=path.join(root,'control'),rollout=path.join(root,'rollout.jsonl'),calls=[],injected=[];
  fs.writeFileSync(rollout,'');let q,out;
  const request=async(_b,args)=>{
    calls.push(args);await hook(args);
    if(args[1]==='POST')return args[2].includes('cardkit')?{card_id:'card_fixture'}:{message_id:'om_card'};
    return {};
  };
  const open=()=>{
    out=new DurableOutbound(path.join(root,'outbound'),binding,request,{now:()=>now,presentationEnabled:true,minIntervalMs:2000,
      onCardMessage:(_id,_presentation,s)=>q.recordFeedbackTiming(s.jobId,'firstCardSentAt',s.firstCardSentAt,s.firstCardTimingSource)});
    q=new DurableInbox(inboxRoot,binding.bot,{
      prepare:async e=>e,target:async()=>({rollout}),inject:async j=>injected.push(j.id),classifiedFeedback:true,initialFeedbackCard:binding.initial_feedback_card,
      classification:job=>classifyWithFastFeedback({root:controlRoot,inboxRoot,binding,job}),
      progress:(text,key,context)=>out.progress(text,key,undefined,context),
      final:(text,key,keys)=>out.final(text,key,keys),send:async()=>assert.fail('no notices'),
    },{now:()=>now});return q;
  };
  open();
  const add=(id,text=id,extra={})=>q.enqueue({type:'im.message.receive_v1',message_id:'om_'+id,chat_id:binding.chat_id,chat_type:'group',sender_type:'user',sender_id:'ou_member',message_type:'text',content:JSON.stringify({text}),bridge_binding:bindingSnapshot(binding),...extra});
  const opts=id=>({root:controlRoot,inboxRoot,binding,jobId:'om_'+id});
  const append=(...items)=>fs.appendFileSync(rollout,items.map(item=>JSON.stringify(item)+'\n').join(''));
  const marker=id=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`[飞书消息｜fixture｜om_${id}]`}]}});
  const msg=(text,phase='commentary')=>({type:'response_item',payload:{type:'message',role:'assistant',phase,content:[{type:'output_text',text}]}});
  return {root,binding,inboxRoot,controlRoot,calls,injected,add,opts,append,marker,msg,open,hook:fn=>hook=fn,advance:ms=>now+=ms,now:()=>now,get q(){return q;},get out(){return out;}};
}

test('initial card waits for exact marker and immutable actionable, then closes the same stream after later turn context',async t=>{
  const f=fixture(t),j=f.add('a');await f.q.dispatchOne();enqueueActionable(f.opts('a'));
  await f.q.watch();await f.out.flushCards();assert.equal(f.calls.length,0);
  f.append(f.marker('other'));await f.q.watch();assert.equal(j.streamKey,undefined);
  f.append({type:'turn_context',payload:{turn_id:'owner'}},f.marker('a'));await f.q.watch();assert.equal(j.feedbackDisposition,'actionable');assert.ok(j.initialFeedbackQueuedAt);assert.equal(j.firstCardSentAt,undefined);
  const key=j.streamKey;await f.out.flushCards();assert.equal(j.firstCardSentAt,10000);assert.equal(j.firstCardTimingSource,'send_response');
  assert.match(f.calls.find(a=>a[2]==='/open-apis/cardkit/v1/cards').at(-1),/正在处理/);
  f.advance(3000);f.append({type:'turn_context',payload:{turn_id:'later'}},f.msg('[飞书进度｜om_a] 已查询日程'));
  await f.q.watch();assert.equal(j.streamKey,key);await f.out.flushCards();
  f.open();f.append({type:'turn_context',payload:{turn_id:'owner'}},f.msg('查询结果','final_answer'));await f.q.watch();await f.q.deliverReplies();
  const saved=f.q.jobs.get(j.id),card=f.out.read(f.out.file('card',key));assert.equal(saved.status,'done');assert.equal(saved.streamKey,key);assert.equal(saved.firstCardSentAt,10000);assert.equal(card.finalDelivered,true);
  assert.equal(f.calls.filter(a=>a[1]==='POST'&&a[2]==='/open-apis/im/v1/messages').length,1);
});

test('disabled, unknown, silent and historical completed jobs never receive an initial card',async t=>{
  const f=fixture(t);for(const id of ['unknown','silent','old']){f.add(id);await f.q.dispatchOne();}
  enqueueSilentCompletion(f.opts('silent'));const old=f.q.jobs.get('om_old');old.status='done';old.markerSeen=true;old.feedbackDisposition='actionable';f.q.save(old);
  f.append(f.marker('unknown'),f.marker('silent'));await f.q.watch();await f.out.flushCards();assert.equal(f.calls.length,0);assert.equal(f.q.jobs.get('om_silent').status,'done');
  const off=fixture(t,{initial_feedback_card:false}),j=off.add('a');await off.q.dispatchOne();enqueueActionable(off.opts('a'));off.append(off.marker('a'));await off.q.watch();assert.equal(j.initialFeedbackQueuedAt,undefined);await off.out.flushCards();assert.equal(off.calls.length,0);
});

test('two classified messages in one turn keep separate initial cards and stream keys',async t=>{
  const f=fixture(t);for(const id of ['a','b']){f.add(id);await f.q.dispatchOne();enqueueActionable(f.opts(id));}
  f.append({type:'turn_context',payload:{turn_id:'shared'}},f.marker('a'),f.marker('b'));await f.q.watch();
  const keys=[...f.q.jobs.values()].map(j=>j.streamKey);assert.equal(new Set(keys).size,2);
  await f.out.flushCards();assert.equal(f.calls.filter(a=>a[1]==='POST'&&a[2]==='/open-apis/im/v1/messages').length,2);
});

test('entity creation and failed message sends are not first-card success; retries preserve the first acknowledged timestamp',async t=>{
  const f=fixture(t),j=f.add('a');await f.q.dispatchOne();enqueueActionable(f.opts('a'));f.append(f.marker('a'));await f.q.watch();
  f.hook(async args=>{if(args[2]==='/open-apis/im/v1/messages')throw Object.assign(Error('offline'),{code:'ECONNRESET'});});await f.out.flushCards();
  let state=f.out.read(f.out.file('card',j.streamKey));assert.ok(state.cardId);assert.equal(state.firstCardSentAt,undefined);assert.equal(j.firstCardSentAt,undefined);
  f.advance(400000);f.hook(async()=>{});f.open();await f.out.flushCards();state=f.out.read(f.out.file('card',j.streamKey));assert.equal(state.firstCardSentAt,410000);assert.equal(f.q.jobs.get(j.id).firstCardSentAt,410000);
  f.advance(3000);f.out.progress('后续进度',j.streamKey,undefined,{jobId:j.id});await f.out.flushCards();assert.equal(f.q.jobs.get(j.id).firstCardSentAt,410000);
});

test('crash after durable progress intent is replayed once and cannot regress newer commentary or final',async t=>{
  const f=fixture(t),j=f.add('a');await f.q.dispatchOne();enqueueActionable(f.opts('a'));
  const progress=f.q.io.progress;f.q.io.progress=(...args)=>{progress(...args);throw Error('crash after intent');};
  f.append(f.marker('a'));await f.q.watch();assert.ok(j.pendingProgress);const key=j.streamKey;
  f.out.progress('较新的进度',key,undefined,{jobId:j.id,position:500});f.open();await f.q.watch();assert.equal(f.out.read(f.out.file('card',key)).text,'较新的进度');
  await f.out.flushCards();const count=f.calls.filter(a=>a[1]==='POST'&&a[2]==='/open-apis/im/v1/messages').length;
  f.open();await f.q.watch();await f.out.flushCards();assert.equal(f.calls.filter(a=>a[1]==='POST'&&a[2]==='/open-apis/im/v1/messages').length,count);
  await f.out.final('最终答复','reply',[key]);f.out.progress('正在处理…',key,undefined,{initialFeedback:true});await f.out.flushCards();assert.equal(f.out.read(f.out.file('card',key)).text,'最终答复');
});

test('fast classifier recognizes a narrow operational grammar and rejects casual, quoted, negated and unrelated replies',()=>{
  for(const text of ['查一下10月4日安排','查一下邮箱里面有什么新邮件吗','取消亚瑟顿高原的行程','请创建明天下午的会议','帮我整理会议纪要'])assert.equal(isExplicitOperationalRequest(text),true,text);
  for(const text of ['是的','好的谢谢','后天我要全天带团去丹翠雨林','今天天气不错','他说查一下邮箱','“查询日程”','不要查询日程','查一下日程这句话什么意思','查询日程\n不用回复','查询日程，如果有空再说','比如创建会议','查一下邮件还是不要查','请帮我查一下天气'])assert.equal(isExplicitOperationalRequest(text),false,text);
});

test('optional fast classification waits for marker, preserves silent and injects every legal human into the original session',async t=>{
  const f=fixture(t,{fast_actionable_classification:true});
  for(const [id,text] of [['query','查一下10月4日安排'],['mail','查一下邮箱里面有什么新邮件吗'],['silent','取消亚瑟顿高原的行程'],['unknown','是的']]){f.add(id,text);await f.q.dispatchOne();}
  enqueueSilentCompletion(f.opts('silent'));await f.q.watch();assert.ok([...f.q.jobs.values()].every(j=>!j.feedbackDisposition));
  f.append(...['query','mail','silent','unknown'].map(f.marker));await f.q.watch();
  assert.deepEqual(f.injected,['om_query','om_mail','om_silent','om_unknown']);assert.equal(f.q.jobs.get('om_query').feedbackDisposition,'actionable');assert.equal(f.q.jobs.get('om_mail').feedbackDisposition,'actionable');assert.equal(f.q.jobs.get('om_silent').completionDisposition,'silent');assert.equal(f.q.jobs.get('om_unknown').feedbackDisposition,undefined);
  assert.throws(()=>enqueueActionable(f.opts('silent')),/conflict/);
});

test('fast classification rejects wrong group, bots, callbacks, rebound snapshots, attachments and ended turns',async t=>{
  const f=fixture(t,{fast_actionable_classification:true});
  const jobs=[f.add('chat','查询日程',{chat_id:'oc_other'}),f.add('bot','查询日程',{sender_type:'app'}),f.add('callback','查询日程',{synthetic_callback:true}),f.add('attachment','查询日程',{message_type:'audio'}),f.add('ended','查询日程'),f.add('rebound','查询日程')];
  for(const j of jobs){j.markerSeen=true;j.status='delivered';f.q.save(j);}
  jobs[4].unclassifiedTurnEnded=true;jobs[5].event.bridge_binding.codex_thread_id='other';
  for(const job of jobs)assert.equal(classifyWithFastFeedback({root:f.controlRoot,inboxRoot:f.inboxRoot,binding:f.binding,job}),null,job.id);
  assert.equal(fs.existsSync(f.controlRoot),false);
});

test('Typing timing waits for validated create success, persists across DONE, and uncertain recovery records verification separately',async t=>{
  const f=fixture(t),j=f.add('a');j.markerSeen=true;j.feedbackDisposition='actionable';j.status='delivered';f.q.save(j);
  const timing=(id,at,source)=>f.q.recordFeedbackTiming(id,source==='reconciled_observation'?'firstTypingVerifiedAt':'firstTypingAppliedAt',at,source);
  const make=request=>new DurableReactions({root:path.join(f.root,'reactions'),binding:f.binding,request,now:f.now,resolveAppId:async()=> 'cli_fixture',onTypingApplied:timing});
  const valid=emoji=>({reaction_id:'rid_'+emoji,operator:{operator_type:'app',operator_id:'cli_fixture'},reaction_type:{emoji_type:emoji}});
  const r=make(async(_b,args)=>args[2]==='create'?valid(JSON.parse(args.at(-1)).reaction_type.emoji_type):{});
  r.observe([j]);assert.equal(j.firstTypingAppliedAt,undefined);await r.flush();assert.equal(j.firstTypingAppliedAt,10000);assert.equal(j.firstTypingTimingSource,'create_response');
  f.advance(2000);j.status='done';r.observe([j]);await r.flush();assert.equal(r.rows.get(j.id).current.emoji,'DONE');assert.equal(j.firstTypingAppliedAt,10000);
  const u=f.add('uncertain');u.markerSeen=true;u.status='delivered';u.feedbackDisposition='actionable';f.q.save(u);let created;
  const lost=make(async(_b,args)=>{if(args[2]==='create'){created=valid('Typing');throw Object.assign(Error('lost acknowledgement'),{code:'ETIMEDOUT'});}return {};});
  lost.observe([u]);await lost.flush();assert.equal(u.firstTypingAppliedAt,undefined);assert.equal(u.firstTypingVerifiedAt,undefined);
  f.advance(400000);const recovered=make(async(_b,args)=>args[2]==='list'?{items:[created],has_more:false}:assert.fail('no duplicate create'));
  recovered.observe([u]);await recovered.flush();assert.equal(u.firstTypingAppliedAt,undefined);assert.equal(u.firstTypingVerifiedAt,f.now());assert.equal(u.firstTypingVerifiedTimingSource,'reconciled_observation');
});

test('raw-card mode records only successful visible message sends and final reuses that message',async t=>{
  const f=fixture(t,{cardkit_enabled:false}),j=f.add('raw');await f.q.dispatchOne();enqueueActionable(f.opts('raw'));f.append(f.marker('raw'));await f.q.watch();
  assert.equal(j.firstCardSentAt,undefined);await f.out.flushCards();assert.equal(j.firstCardSentAt,10000);
  const initial=f.calls.find(a=>a[1]==='POST');assert.match(initial.at(-1),/正在处理/);assert.equal(initial[2],'/open-apis/im/v1/messages');
  f.advance(3000);f.append(f.msg('[飞书进度｜om_raw] 已读取日程'),f.msg('最终日程','final_answer'));await f.q.watch();await f.q.deliverReplies();
  assert.equal(j.status,'done');assert.equal(j.firstCardSentAt,10000);assert.equal(f.calls.filter(a=>a[1]==='POST').length,1);
  assert.ok(f.calls.some(a=>a[1]==='PATCH'&&a[2]==='/open-apis/im/v1/messages/om_card'));
});

test('slow first-card network does not block marker scanning, and concurrent wakes plus final cannot duplicate or reopen it',async t=>{
  const f=fixture(t),j=f.add('a');await f.q.dispatchOne();enqueueActionable(f.opts('a'));f.append(f.marker('a'));await f.q.watch();
  let entered,release;const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);let once=false;
  f.hook(async args=>{if(args[2]==='/open-apis/im/v1/messages'&&!once){once=true;entered();await held;}});
  const flushing=f.out.flushCards();await started;const duplicate=f.out.flushCards();
  assert.equal(j.firstCardSentAt,undefined);const other=f.add('unknown','谢谢');await f.q.dispatchOne();f.append(f.marker('unknown'),f.msg('快速最终答复','final_answer'));
  await f.q.watch();assert.equal(other.markerSeen,true);assert.equal(j.status,'reply_pending');
  const final=f.q.deliverReplies();release();await Promise.all([flushing,duplicate,final]);
  assert.equal(j.status,'done');assert.equal(f.calls.filter(a=>a[1]==='POST'&&a[2]==='/open-apis/im/v1/messages').length,1);
  const state=f.out.read(f.out.file('card',j.streamKey));assert.equal(state.finalDelivered,true);assert.equal(state.cardClosed,true);
  f.out.progress('迟到的首卡',j.streamKey,undefined,{initialFeedback:true});await f.out.flushCards();assert.equal(f.out.read(f.out.file('card',j.streamKey)).text,'快速最终答复');
});

test('an immediate final after classification finishes one card without a late initial send after DONE',async t=>{
  const f=fixture(t),j=f.add('a');await f.q.dispatchOne();enqueueActionable(f.opts('a'));f.append(f.marker('a'),f.msg('已经完成','final_answer'));
  await f.q.watch();assert.equal(j.status,'reply_pending');assert.ok(j.initialFeedbackQueuedAt);const key=j.streamKey;
  await f.q.deliverReplies();const count=f.calls.length;await f.out.flushCards();assert.equal(f.calls.length,count);assert.equal(j.status,'done');assert.equal(f.out.read(f.out.file('card',key)).finalDelivered,true);
  assert.equal(f.calls.filter(a=>a[1]==='POST'&&a[2]==='/open-apis/im/v1/messages').length,1);
});
