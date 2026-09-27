import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionStore } from './codex-bridge-actions.mjs';
import { DurableInbox, digest } from './codex-bridge-inbox.mjs';
import { DurableOutbound } from './codex-bridge-outbound.mjs';
import { FileOutbox } from './codex-bridge-files.mjs';
import { createReplyDelivery } from './codex-bridge-delivery.mjs';
import { streamCard } from './codex-bridge-cardkit.mjs';
import { subscriberArgs } from './start-lark-append.mjs';
import { bindingSnapshot } from './codex-bridge-ux.mjs';

function fixture(t,{cardFail=false,fileFail=false,interactions=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-ux-integration-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',codex_thread_id:'thread1',profile:'p',cwd:root,interactions_enabled:interactions};
  const reportOptions={reportRoot:path.join(root,'reports'),fileOutboxRoot:path.join(root,'files'),inboxRoot:path.join(root,'inbox')};
  const actions=new ActionStore({root:path.join(root,'actions'),bot:binding.bot});
  const calls=[];let count=0;
  const request=async(_,args)=>{
    calls.push(args);
    if(args[0]==='im'){
      if(fileFail && args.includes('--file'))throw Error('offline');
      return {message_id:`om_file_${count++}`};
    }
    if(cardFail)throw Object.assign(Error('permission'),{type:'permission'});
    if(args[1]==='POST')return args[2].includes('cardkit')?{card_id:`card_${count++}`}:{message_id:`om_card_${count++}`};
    return {};
  };
  const outbound=new DurableOutbound(path.join(root,'outbound'),binding,request,{presentationEnabled:true,
    onCardMessage:(id,p)=>{if(p?.actionContext)actions.bindMessage(p.actionContext,id);}});
  const files=new FileOutbox(reportOptions.fileOutboxRoot,binding,(...args)=>outbound.serial(()=>request(...args)));
  const deliver=createReplyDelivery({binding,actions,outbound,files,reportOptions});
  const inbox=new DurableInbox(reportOptions.inboxRoot,binding.bot,{});
  const source=(text,id='om_source')=>{
    const job=inbox.enqueue({type:'im.message.receive_v1',message_id:id,message_type:'text',content:'request',chat_id:binding.chat_id,
      sender_id:binding.allowed_sender_id,bridge_binding:bindingSnapshot(binding)});
    job.reply=text;job.replyKey=digest(id);job.status='reply_pending';inbox.save(job);return job;
  };
  const card=()=>{
    const update=calls.filter(a=>a[1]==='PUT').at(-1);
    return JSON.parse(JSON.parse(update.at(-1)).card.data);
  };
  const callback=(job,action,form_value)=>{
    const s=outbound.read(outbound.file('card',`reply:${job.replyKey}`));
    return {type:'card.action.trigger',event_id:'evt_1',operator:{open_id:binding.allowed_sender_id},
      context:{open_chat_id:binding.chat_id,open_message_id:s.messageId},
      action:{tag:'button',value:{context_id:s.presentation.actionContext,version:1,action},...(form_value?{form_value}:{})}};
  };
  return {root,binding,reportOptions,actions,calls,outbound,files,deliver,inbox,source,card,callback};
}

test('short final without commentary publishes bound buttons; callback survives restart and queues once',async t=>{
  const f=fixture(t),job=f.source('结论已经验证。\n\n- 要点一\n- 要点二');
  await f.deliver(job.reply,job.replyKey,[],{jobId:job.id});
  assert.equal(f.card().config.streaming_mode,false);assert.ok(JSON.stringify(f.card()).includes('再简短一点'));
  const event=f.callback(job,'shorter');assert.equal(f.actions.acceptCallback(event,{binding:f.binding,authenticatedBot:f.binding.bot}).accepted,true);
  const reopened=new ActionStore({root:path.join(f.root,'actions'),bot:f.binding.bot});reopened.drain({binding:f.binding,inbox:f.inbox});
  reopened.acceptCallback(event,{binding:f.binding,authenticatedBot:f.binding.bot});reopened.drain({binding:f.binding,inbox:f.inbox});
  assert.equal(f.inbox.jobs.size,2);assert.match([...f.inbox.jobs.values()][1].event.content,/结论已经验证/);
  const count=f.calls.length;await f.deliver(job.reply,job.replyKey,[],{jobId:job.id});assert.equal(f.calls.length,count);
});

test('missing conditions render waiting form and one submit contains all conditions',async t=>{
  const f=fixture(t),form={version:1,title:'补充两项条件',fields:[{name:'audience',label:'阅读对象',type:'text',required:true},
    {name:'format',label:'格式',type:'select',options:[{label:'表格',value:'table'}]}]};
  const job=f.source(`请一次补充。\n\`\`\`feishu-form\n${JSON.stringify(form)}\n\`\`\``);
  await f.deliver(job.reply,job.replyKey,[],{jobId:job.id});
  assert.equal(f.card().header.title.content,'等待补充');assert.ok(f.card().body.elements.some(e=>e.tag==='form'));
  assert.ok(!JSON.stringify(f.card()).includes('再简短一点'));
  const result=f.actions.acceptCallback(f.callback(job,'conditions',{audience:'同事',format:'table'}),{binding:f.binding,authenticatedBot:f.binding.bot});
  assert.equal(result.accepted,true);f.actions.drain({binding:f.binding,inbox:f.inbox});
  assert.equal(f.inbox.jobs.size,2);assert.match([...f.inbox.jobs.values()][1].event.content,/同事/);
});

test('long reply sends immutable complete files before a compact final and retries no delivery',async t=>{
  const f=fixture(t),answer='结论：完整报告已整理。\n\n- 第一点\n- 第二点\n\n'+('长段落内容😀\n\n'.repeat(400));
  const job=f.source(answer);await f.deliver(answer,job.replyKey,[],{jobId:job.id});
  assert.equal(f.calls.filter(a=>a.includes('--file')).length,2);
  const c=f.card();assert.ok(!c.body.elements.some(e=>e.element_id==='details'));assert.match(JSON.stringify(c),/完整报告已作为附件发送/);
  assert.equal(fs.readFileSync(path.join(f.reportOptions.reportRoot,f.binding.bot,digest(job.replyKey),'answer.md'),'utf8'),answer.trim());
  const count=f.calls.length;await f.deliver(answer,job.replyKey,[],{jobId:job.id});assert.equal(f.calls.length,count);
});

test('report outage retains pending files and full final; never claims report delivered',async t=>{
  const f=fixture(t,{fileFail:true}),text='原始完整内容😀'.repeat(3000),job=f.source(text);
  await f.deliver(text,job.replyKey,[],{jobId:job.id});
  const sent=f.calls.filter(a=>a.includes('--text')).map(a=>a[a.indexOf('--text')+1]).join('');assert.equal(sent,text);
  assert.equal(f.files.stats().file_pending_count,2);assert.ok(!JSON.stringify(f.card()).includes('完整报告已作为附件发送'));
});

test('disabled interactions and card permission failure preserve visible clarification fields',async t=>{
  for(const options of [{interactions:false},{cardFail:true}]){
    const f=fixture(t,options),job=f.source('请补充。\n```feishu-form\n{"version":1,"title":"条件","fields":[{"name":"x","label":"使用对象","type":"text","required":true}]}\n```');
    await f.deliver(job.reply,job.replyKey,[],{jobId:job.id});
    const visible=options.cardFail?f.calls.filter(a=>a.includes('--text')).map(a=>a[a.indexOf('--text')+1]).join(''):JSON.stringify(f.card());
    assert.match(visible,/使用对象/);assert.match(visible,/必填/);
  }
});

test('many sources and accumulated progress stay inside actual card JSON budget',async t=>{
  const f=fixture(t);
  for(let i=0;i<10;i++)f.outbound.progress('[检索] '+Array.from({length:99},(_,n)=>`[资料${n}](https://example.org/${i}/${n}/${'a'.repeat(120)})`).join('\n'),'turn');
  const s=f.outbound.read(f.outbound.file('card','turn'));
  assert.ok(Buffer.byteLength(JSON.stringify(streamCard(s.text,false,s.presentation)))<=26000);
});

test('oversized final across several cards binds actions to only the deterministic first card',async t=>{
  const f=fixture(t,{fileFail:true}),text='很长的最终内容'.repeat(5000),job=f.source(text);
  f.outbound.progress('阶段一','a');f.outbound.progress('阶段二','b');await f.outbound.flushCards();
  await f.deliver(text,job.replyKey,['a','b'],{jobId:job.id});
  const first=f.outbound.read(f.outbound.file('card','a')),second=f.outbound.read(f.outbound.file('card','b'));
  assert.ok(first.presentation.actionContext);assert.equal(second.presentation.actionContext,undefined);assert.equal(second.finalCardFailed,undefined);
});

test('changed binding rejects old answer before registering actions, reports or network sends',async t=>{
  const f=fixture(t),job=f.source('private answer');f.binding.codex_thread_id='different';
  await assert.rejects(f.deliver(job.reply,job.replyKey,[],{jobId:job.id}),/binding_changed/);assert.equal(f.calls.length,0);
});

test('same subscriber includes message and card callback filters without force',()=>{
  const args=subscriberArgs('profile');assert.equal(args[args.indexOf('--event-types')+1],'im.message.receive_v1,card.action.trigger');
  assert.ok(!args.includes('--force'));assert.equal(args.filter(a=>a==='+subscribe').length,1);
});
