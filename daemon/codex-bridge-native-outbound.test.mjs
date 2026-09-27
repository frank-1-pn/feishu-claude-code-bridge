import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DurableOutbound} from './codex-bridge-outbound.mjs';
import {DurableReplyRouter,selectReplyRoute} from './codex-bridge-reply-routing.mjs';

function fixture(t,{cardkit=true,presentation=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-outbound-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',profile:'profile-fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',
    codex_thread_id:'thread-fixture',cardkit_enabled:cardkit};
  const job={id:'om_source',acceptedAt:1,event:{message_id:'om_source',chat_id:binding.chat_id,sender_id:binding.allowed_sender_id}};
  const route=selectReplyRoute(binding,[job]),clock={now:1000};
  const server={calls:[],events:[],created:new Map(),entityCount:0,displayedCards:[],before:null,after:null};
  const request=async(b,args)=>{
    assert.equal(b.profile,binding.profile);const i=args.indexOf('--data');
    const call={args:[...args],method:args[1],url:args[2],data:i>=0?JSON.parse(args[i+1]):null};server.calls.push(call);
    await server.before?.(call);let result={};
    if(call.method==='POST'&&call.url==='/open-apis/cardkit/v1/cards')result={card_id:`card_fixture_${++server.entityCount}`};
    else if(call.method==='POST'&&(call.url==='/open-apis/im/v1/messages'||call.url.endsWith('/reply'))){
      if(!server.created.has(call.data.uuid))server.created.set(call.data.uuid,{message_id:`om_sent_${server.created.size+1}`});
      result=server.created.get(call.data.uuid);server.events.push({type:'send',call});
    }else if(call.method==='PUT'&&call.data?.card){server.displayedCards.push(JSON.parse(call.data.card.data));server.events.push({type:'put',call});}
    else if(call.method==='PATCH'){server.displayedCards.push(JSON.parse(call.data.content));server.events.push({type:'patch',call});}
    await server.after?.(call,result);return result;
  };
  const reload=({onCardMessage}={})=>{
    const router=new DurableReplyRouter({root:path.join(root,'routes'),binding,request,now:()=>clock.now});
    const outbound=new DurableOutbound(path.join(root,'outbound'),binding,request,{now:()=>clock.now,minIntervalMs:1000,
      presentationEnabled:presentation,sendMessage:args=>router.send(args),
      onCardMessage:async(id,p)=>{server.events.push({type:'bind',id,p});await onCardMessage?.(id,p);}});
    return {router,outbound};
  };
  return {root,binding,job,route,clock,server,request,reload,...reload()};
}
const sentCalls=f=>f.server.calls.filter(c=>c.method==='POST'&&(c.url==='/open-apis/im/v1/messages'||c.url.endsWith('/reply')));
const textCalls=f=>sentCalls(f).filter(c=>c.data.msg_type==='text');
const finalState=(f,key='turn')=>f.outbound.read(f.outbound.file('card',key));

test('explicit form renderer upgrade patches the same message and recovers an uncertain patch without resending',async t=>{
  const f=fixture(t),oldCard={schema:'2.0',body:{elements:[{tag:'input',name:'due'}]}},
    picker={schema:'2.0',body:{elements:[{tag:'picker_datetime',name:'due'}]}};
  const first=await f.outbound.interactive(oldCard,'existing_form',{route:f.route});
  // Emulate a journal from the version before renderVersion existed.
  const file=f.outbound.file('interactive','existing_form'),old=f.outbound.read(file);delete old.renderVersion;fs.writeFileSync(file,JSON.stringify(old));
  let lost=true;f.server.after=async c=>{if(c.method==='PATCH'&&lost){lost=false;throw Object.assign(Error('ack lost'),{code:'ETIMEDOUT'});}};
  await assert.rejects(f.outbound.interactive(picker,'existing_form',{route:f.route,renderVersion:2}));
  assert.equal(f.outbound.read(file).renderVersion,2);assert.equal(f.outbound.read(file).patched,false);
  ({outbound:f.outbound}=f.reload());
  const recovered=await f.outbound.interactive(picker,'existing_form',{route:f.route,renderVersion:2});
  assert.equal(first.message_id,recovered.message_id);assert.equal(sentCalls(f).length,1);
  assert.equal(f.outbound.read(file).patched,true);
  const patches=f.server.calls.filter(c=>c.method==='PATCH');assert.deepEqual(patches.at(-1),patches.at(-2));
  await assert.rejects(f.outbound.interactive(oldCard,'existing_form',{route:f.route,renderVersion:2}),/interactive_payload_changed/);
});

test('same-layout renderer version bumps are durable and cannot later mutate at the same version',async t=>{
  const f=fixture(t),card={schema:'2.0',body:{elements:[]}};
  await f.outbound.interactive(card,'form',{route:f.route});
  const count=f.server.calls.length;
  await f.outbound.interactive(card,'form',{route:f.route,renderVersion:2});assert.equal(f.server.calls.length,count);
  assert.equal(f.outbound.read(f.outbound.file('interactive','form')).renderVersion,2);
  await assert.rejects(f.outbound.interactive({...card,header:{}},'form',{route:f.route,renderVersion:2}),/interactive_payload_changed/);
});

test('quoted progress and final share one routed message through restart; final cannot regress',async t=>{
  const f=fixture(t);f.outbound.progress('正在整理公开资料。','turn',f.route);await f.outbound.flushCards();
  await f.outbound.final('结论已经确认。','answer',['turn'],{status:'complete',replyRoute:f.route});
  assert.equal(sentCalls(f).length,1);assert.equal(sentCalls(f)[0].url,'/open-apis/im/v1/messages/om_source/reply');
  assert.equal(sentCalls(f)[0].data.reply_in_thread,false);assert.equal(f.server.created.size,1);assert.equal(textCalls(f).length,0);
  const before=finalState(f);assert.deepEqual(before.route,f.route);assert.equal(before.text,'结论已经确认。');assert.equal(before.finalDelivered,true);
  const calls=f.server.calls.length;({outbound:f.outbound}=f.reload());
  f.outbound.progress('迟到旧进度','turn',f.route);await f.outbound.flushCards();
  await f.outbound.final('结论已经确认。','answer',['turn'],{status:'complete',replyRoute:f.route});
  assert.equal(f.server.calls.length,calls);assert.equal(finalState(f).text,'结论已经确认。');
});

test('uncertain final message acknowledgement never falls back to text and retry reuses the same visible card',async t=>{
  const f=fixture(t);let lost=false;
  f.server.after=async c=>{if(c.url.endsWith('/reply')&&!lost){lost=true;throw Object.assign(Error('ack lost'),{code:'ETIMEDOUT'});}};
  await assert.rejects(f.outbound.final('唯一的最终答复','answer',[],{replyRoute:f.route}),e=>e.deliveryUncertain===true);
  assert.equal(textCalls(f).length,0);assert.equal(f.server.created.size,1);
  ({outbound:f.outbound}=f.reload());await f.outbound.final('唯一的最终答复','answer',[],{replyRoute:f.route});
  assert.equal(f.server.created.size,1);assert.equal(textCalls(f).length,0);assert.equal(f.server.entityCount,1);
  const sends=sentCalls(f);assert.equal(sends.length,2);assert.deepEqual(sends[0].data,sends[1].data);
});

test('raw progress becoming final after an uncertain shell reuses its immutable creation payload',async t=>{
  const f=fixture(t,{cardkit:false});let lost=false;
  f.server.after=async c=>{if(c.url.endsWith('/reply')&&!lost){lost=true;throw Object.assign(Error('ack lost'),{code:'ETIMEDOUT'});}};
  f.outbound.progress('最初的公开进度','turn',f.route);await f.outbound.flushCards();assert.equal(f.server.created.size,1);
  ({outbound:f.outbound}=f.reload());
  await f.outbound.final('随后得到的最终答复','answer',['turn'],{replyRoute:f.route,nativeContext:'native_fixture',
    interactions:[{tag:'button',text:{tag:'plain_text',content:'转待办'}}]});
  assert.equal(f.server.created.size,1);assert.equal(textCalls(f).length,0);
  const sends=sentCalls(f);assert.equal(sends.length,2);assert.deepEqual(sends[0].data,sends[1].data);
  assert.equal(finalState(f).finalDelivered,true);assert.equal(Boolean(finalState(f).deliveryUncertain),false);
  assert.match(JSON.stringify(f.server.displayedCards.at(-1)),/随后得到的最终答复/);
});

test('expired uncertain progress stays uncertain across restart and cannot produce an extra text answer',async t=>{
  const f=fixture(t);f.server.after=async c=>{if(c.url.endsWith('/reply'))throw Object.assign(Error('lost'),{code:'ETIMEDOUT'});};
  f.outbound.progress('公开进度','turn',f.route);await f.outbound.flushCards();assert.equal(f.server.created.size,1);
  f.clock.now+=56*60*1000;await f.outbound.flushCards();
  ({outbound:f.outbound}=f.reload());
  let error;try{await f.outbound.final('最终内容','answer',['turn'],{replyRoute:f.route});}catch(e){error=e;}
  assert.equal(textCalls(f).length,0,'an uncertain visible progress card must not trigger a new text send');
  assert.equal(f.server.created.size,1);assert.equal(error?.deliveryUncertain,true);
});

test('interactive sends inert shell, persists and binds its message before controls; retry patches the same message',async t=>{
  const f=fixture(t),card={schema:'2.0',body:{elements:[{tag:'button',text:{tag:'plain_text',content:'确认创建待办'},value:{context_id:'native_fixture'}}]}};
  let failPatch=true;f.server.after=async c=>{if(c.method==='PATCH'&&failPatch){failPatch=false;throw Object.assign(Error('patch ack lost'),{code:'ETIMEDOUT'});}};
  const bind=async id=>{
    const saved=f.outbound.read(f.outbound.file('interactive','confirm'));
    assert.equal(saved.messageId,id);f.server.events.push({type:'bound-before-controls',id});
  };
  await assert.rejects(f.outbound.interactive(card,'confirm',{route:f.route,onMessage:bind}));
  assert.equal(f.server.created.size,1);const shell=JSON.parse(sentCalls(f)[0].data.content);
  assert.doesNotMatch(JSON.stringify(shell),/确认创建待办|native_fixture/);
  assert.deepEqual(f.server.events.map(x=>x.type),['send','bound-before-controls','patch']);
  ({outbound:f.outbound}=f.reload());await f.outbound.interactive(card,'confirm',{route:f.route,onMessage:bind});
  assert.equal(sentCalls(f).length,1);assert.equal(f.server.created.size,1);
  const patches=f.server.calls.filter(c=>c.method==='PATCH');assert.equal(patches.length,2);assert.equal(patches[0].url,patches[1].url);
  assert.deepEqual(patches[0].data,patches[1].data);const calls=f.server.calls.length;
  await f.outbound.interactive(card,'confirm',{route:f.route,onMessage:bind});assert.equal(f.server.calls.length,calls);
  await assert.rejects(f.outbound.interactive({...card,header:{title:'changed'}},'confirm',{route:f.route,onMessage:bind}),/interactive_payload_changed/);
  assert.equal(f.server.calls.length,calls);
});

test('raw-card final binds native context before patching controls and retains the source quote',async t=>{
  const f=fixture(t,{cardkit:false}),button={tag:'button',text:{tag:'plain_text',content:'转待办'},value:{context_id:'native_fixture'}};
  await f.outbound.final('完成的答复','answer',[],{status:'complete',replyRoute:f.route,nativeContext:'native_fixture',interactions:[button]});
  const sends=sentCalls(f);assert.equal(sends.length,1);assert.equal(sends[0].url,'/open-apis/im/v1/messages/om_source/reply');
  assert.doesNotMatch(sends[0].data.content,/native_fixture|转待办/);
  const bind=f.server.events.findIndex(e=>e.type==='bind'),patch=f.server.events.findIndex(e=>e.type==='patch');assert(bind>=0&&patch>bind);
  assert.equal(f.server.events[bind].p.nativeContext,'native_fixture');assert.match(JSON.stringify(f.server.displayedCards.at(-1)),/转待办/);
});

test('native controls bind only to the first final card in a merged turn',async t=>{
  const f=fixture(t);f.outbound.progress('先前进度一','a',f.route);f.outbound.progress('先前进度二','b',f.route);await f.outbound.flushCards();
  await f.outbound.final('合并结果','answer',['a','b'],{replyRoute:f.route,actionContext:'legacy',nativeContext:'native_fixture',
    interactions:[{tag:'button',text:{tag:'plain_text',content:'转待办'}}]});
  const a=finalState(f,'a'),b=finalState(f,'b');assert.equal(a.presentation.nativeContext,'native_fixture');
  assert.equal(b.presentation.actionContext,undefined);assert.equal(b.presentation.nativeContext,undefined);assert.deepEqual(b.presentation.interactions,[]);
});

test('cloud link patches the same completed card, preserves answer, and retries an uncertain patch without sending again',async t=>{
  const f=fixture(t);await f.outbound.final('原始答案不能改变。','answer',[],{replyRoute:f.route});
  const key='reply:answer',before=finalState(f,key),created=f.server.created.size;
  const record={status:'ready',url:'https://fixture.feishu.cn/docx/doc_fixture',title:'完整报告'};
  let lost=true;f.server.after=async c=>{if(c.method==='PUT'&&c.data.card&&JSON.stringify(c.data).includes('打开飞书云文档')&&lost){lost=false;throw Object.assign(Error('ack lost'),{code:'ETIMEDOUT'});}};
  await assert.rejects(f.outbound.attachCloudDoc('answer',record));assert.equal(f.server.created.size,created);
  ({outbound:f.outbound}=f.reload());assert.equal(await f.outbound.attachCloudDoc('answer',record),true);
  const after=finalState(f,key);assert.equal(after.messageId,before.messageId);assert.equal(after.text,before.text);
  assert.equal(after.finalReplyKey,before.finalReplyKey);assert.equal(after.finalDelivered,true);assert.equal(f.server.created.size,created);
  const rendered=f.server.displayedCards.at(-1);assert.match(JSON.stringify(rendered),/原始答案不能改变/);
  assert.match(JSON.stringify(rendered),/打开飞书云文档/);const calls=f.server.calls.length;
  assert.equal(await f.outbound.attachCloudDoc('answer',record),true);assert.equal(f.server.calls.length,calls);
  assert.equal(await f.outbound.attachCloudDoc('unknown',record),false);assert.equal(f.server.calls.length,calls);
});

test('different native topics close progress and publish only one combined final in the main chat',async t=>{
  const f=fixture(t),first={...f.job,event:{...f.job.event,thread_id:'omt_first'}},second={id:'om_second',acceptedAt:2,
    event:{...f.job.event,message_id:'om_second',thread_id:'omt_second'}};
  const a=selectReplyRoute(f.binding,[first]),b=selectReplyRoute(f.binding,[second]);
  f.outbound.progress('话题一进度','a',a);f.outbound.progress('话题二进度','b',b);await f.outbound.flushCards();
  const route=selectReplyRoute(f.binding,[first,second]);assert.equal(route.reason,'mixed_topics');
  await f.outbound.final('两项任务的统一结果','answer',['a','b'],{replyRoute:route});
  const sends=sentCalls(f);assert.equal(sends.length,3);assert.equal(sends[0].data.reply_in_thread,true);assert.equal(sends[1].data.reply_in_thread,true);
  assert.equal(sends[2].url,'/open-apis/im/v1/messages');assert.equal(sends[2].data.receive_id,f.binding.chat_id);
  assert.equal(finalState(f,'a').final,true);assert.equal(finalState(f,'b').final,true);
  assert.equal(finalState(f,'reply:answer').finalDelivered,true);assert.equal(textCalls(f).length,0);
  await f.outbound.final('两项任务的统一结果','answer',['a','b'],{replyRoute:route});assert.equal(sentCalls(f).length,3);
});
