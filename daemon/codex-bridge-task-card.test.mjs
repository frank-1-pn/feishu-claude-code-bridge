import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DurableOutbound} from './codex-bridge-outbound.mjs';

function fixture(t,{cardkit=true}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'task-card-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',profile:'fixture-profile',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',cardkit_enabled:cardkit};
  const server={calls:[],created:new Map(),entities:0,after:null,before:null};
  const request=async (_binding,args)=> {
    const index=args.indexOf('--data');
    const call={method:args[1],url:args[2],data:index>=0?JSON.parse(args[index+1]):null};
    server.calls.push(call);await server.before?.(call);
    let result={};
    if(call.method==='POST'&&call.url==='/open-apis/cardkit/v1/cards')result={card_id:`card_fixture_${++server.entities}`};
    else if(call.method==='POST'&&call.url==='/open-apis/im/v1/messages') {
      if(!server.created.has(call.data.uuid))server.created.set(call.data.uuid,{message_id:`om_visible_${server.created.size+1}`});
      result=server.created.get(call.data.uuid);
    }
    await server.after?.(call,result);return result;
  };
  const reload=()=>new DurableOutbound(root,binding,request,{presentationEnabled:true,minIntervalMs:0});
  const f={root,binding,server,reload,outbound:reload(),ownerKey:'owner-card'};
  f.state=()=>f.outbound.read(f.outbound.file('card',f.ownerKey));
  f.result=(revision,status,ownerJobId='om_owner')=>({status:status==='background'?'working':status,
    taskResult:{schema:1,ownerJobId,revision,resultKey:`result-${revision}`,status}});
  f.submit=(revision,status,text=`revision ${revision}`)=>f.outbound.final(text,`reply-${revision}`,[f.ownerKey],f.result(revision,status));
  f.start=async()=>{f.outbound.progress('原任务正在处理',f.ownerKey,undefined,{jobId:'om_owner',initialFeedback:true});await f.outbound.flushCards();};
  return f;
}

for(const cardkit of [true,false]) {
  const mode=cardkit?'CardKit':'raw card';
  test(`${mode}: waiting, supplement and completion retain one owner card across restart`,async t=>{
    const f=fixture(t,{cardkit});await f.start();
    const original=f.state();
    await f.submit(1,'waiting','请补充日期。');
    assert.equal(f.state().presentation.status,'waiting');
    assert.equal(f.state().taskResult.status,'waiting');
    f.outbound=f.reload();
    await f.submit(2,'complete','日期已经核对，处理完成。');
    const completed=f.state();
    assert.equal(completed.messageId,original.messageId);
    assert.equal(completed.cardId,original.cardId);
    assert.equal(f.server.created.size,1);
    assert.equal(completed.text,'日期已经核对，处理完成。');
    assert.equal(completed.taskResult.revision,2);
    assert.equal(f.outbound.replyDelivered('reply-1'),true);
    assert.equal(f.outbound.replyDelivered('reply-2'),true);
    const count=f.server.calls.length;
    await f.submit(1,'waiting','请补充日期。');
    f.outbound.progress('迟到的原任务进度',f.ownerKey,undefined,{jobId:'om_owner',position:999});
    await f.outbound.flushCards();
    assert.equal(f.server.calls.length,count);
    assert.equal(f.state().text,'日期已经核对，处理完成。');
    assert.equal(f.state().taskResult.revision,2);
  });

  test(`${mode}: background acknowledgment remains working and completion updates the same card`,async t=>{
    const f=fixture(t,{cardkit});await f.start();
    await f.submit(1,'background','研究已安排，正在后台执行。');
    const before=f.state();
    assert.equal(before.presentation.status,'working');
    assert.equal(before.taskResult.status,'background');
    await f.submit(2,'complete','原研究的最终结论。');
    assert.equal(f.state().messageId,before.messageId);
    assert.equal(f.server.created.size,1);
    assert.equal(f.state().presentation.status,'complete');
    assert.equal(f.state().text,'原研究的最终结论。');
  });
}

test('new revision cannot inherit old delivery proof after an uncertain card update',async t=>{
  const f=fixture(t);await f.start();await f.submit(1,'waiting','等待补充。');
  let lost=true;
  f.server.after=async call=>{
    if(call.method==='PUT'&&lost){lost=false;throw Object.assign(Error('ack lost'),{code:'ETIMEDOUT',deliveryUncertain:true});}
  };
  await assert.rejects(f.submit(2,'background','补充已受理，后台研究执行中。'));
  assert.equal(f.outbound.replyDelivered('reply-1'),true);
  assert.equal(f.outbound.replyDelivered('reply-2'),false);
  assert.equal(f.state().finalDelivered,undefined);
  assert.equal(f.state().finalDeliveryEvidence,undefined);
  const count=f.server.calls.length;
  await assert.rejects(f.submit(3,'complete','不得越过尚未确认的结果。'));
  assert.equal(f.server.calls.length,count);
  const pending=f.state().cardPending;
  assert.ok(pending,'the exact uncertain card operation stays durable');
  f.outbound=f.reload();
  await f.submit(2,'background','补充已受理，后台研究执行中。');
  const writes=f.server.calls.filter(call=>call.method==='PUT');
  assert.deepEqual(writes.at(-1).data,writes.at(-2).data);
  assert.equal(writes.at(-1).data.sequence,pending.sequence);
  assert.equal(f.outbound.replyDelivered('reply-2'),true);
  assert.equal(f.server.created.size,1);
  await f.submit(3,'complete','后台研究已审查完成。');
  assert.equal(f.state().text,'后台研究已审查完成。');
});

test('wrong owner, revision gaps and a different payload at one revision cause no card mutation',async t=>{
  const f=fixture(t);await f.start();await f.submit(1,'waiting','等待补充。');
  const original=structuredClone(f.state()),count=f.server.calls.length;
  await assert.rejects(f.outbound.final('越权结果','foreign',[f.ownerKey],f.result(2,'complete','om_other')));
  await assert.rejects(f.submit(3,'complete','跳过一版。'));
  await assert.rejects(f.submit(1,'waiting','同一结果版本改写。'));
  assert.equal(f.server.calls.length,count);
  assert.deepEqual(f.state(),original);
});

test('task result accepts exactly one owner stream and never fans out across independent cards',async t=>{
  const f=fixture(t);await f.start();
  f.outbound.progress('另一项任务','other-card',undefined,{jobId:'om_other'});await f.outbound.flushCards();
  const count=f.server.calls.length;
  await assert.rejects(f.outbound.final('混合结果','reply-mixed',[f.ownerKey,'other-card'],f.result(1,'complete')));
  assert.equal(f.server.calls.length,count);
  assert.equal(f.state().text,'原任务正在处理');
  assert.equal(f.outbound.read(f.outbound.file('card','other-card')).text,'另一项任务');
});
