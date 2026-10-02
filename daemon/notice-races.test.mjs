import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableInbox } from './codex-bridge-inbox.mjs';
import { DurableOutbound } from './codex-bridge-outbound.mjs';

function temp(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'notice-races-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}

test('same-key failed timeout retries never reopen an answer-closed peer card, including after restart', async t => {
  for(const cardkit of [false,true]) {
    const root=temp(t),calls=[],displayed=[];let failNext=false,messages=0,entities=0;
    const binding={bot:'fixture',chat_id:'oc_fixture',cardkit_enabled:cardkit};
    const request=async(_binding,args)=>{
      calls.push(args);
      if(['PATCH','PUT'].includes(args[1])) {
        if(failNext){failNext=false;throw Error('temporary timeout patch failure');}
        const data=JSON.parse(args.at(-1));
        if(data.card?.data)displayed.push(JSON.parse(data.card.data));
        else if(args[1]==='PATCH' && data.content)displayed.push(JSON.parse(data.content));
      }
      if(args[1]==='POST')return args[2].includes('/cardkit/')
        ?{card_id:`card_fixture_${++entities}`}:{message_id:`om_card_${++messages}`};
      return {};
    };
    const open=()=>new DurableOutbound(root,binding,request,{presentationEnabled:true,minIntervalMs:0});
    let outbound=open();outbound.progress('working','peer');await outbound.flushCards();
    failNext=true;await assert.rejects(outbound.notice('still tracking','timeout-1',{streamKey:'peer'}));
    await outbound.final('business result','reply-1',[],{status:'complete'});
    await outbound.closeReplyCards('reply-1',['peer']);
    assert.equal(displayed.at(-1).config.streaming_mode,false);
    const before=calls.length;
    await outbound.notice('still tracking','timeout-1',{streamKey:'peer'});
    outbound=open();await outbound.notice('still tracking','timeout-1',{streamKey:'peer'});
    assert.equal(calls.length,before);
    assert.equal(displayed.at(-1).config.streaming_mode,false);
    assert.equal(outbound.read(outbound.file('card','peer')).finalClosedReplyKey,'reply-1');
  }
});

test('late final cancels an in-flight timeout failure without interrupting final delivery or replaying it', async t => {
  const root=temp(t),rollout=path.join(root,'rollout.jsonl');fs.writeFileSync(rollout,'');
  let now=1000,rejectNotice;const pending=new Promise((_resolve,reject)=>{rejectNotice=reject;});
  const injected=[],finals=[];
  const io={prepare:async event=>event,target:async()=>({rollout}),inject:async job=>injected.push(job.id),
    classifiedFeedback:true,classification:()=> 'actionable',notice:()=>pending,
    final:async(text,key)=>finals.push({text,key})};
  const open=()=>new DurableInbox(root,'fixture',io,{now:()=>now,timeoutMs:1000});
  let inbox=open();const job=inbox.enqueue({message_id:'om_task'});await inbox.dispatchOne();
  const append=item=>fs.appendFileSync(rollout,JSON.stringify(item)+'\n');
  append({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'[飞书消息｜fixture｜om_task]'}]}});
  await inbox.watch();now=3000;await inbox.watch();assert.ok(job.notice);
  const delivery=inbox.deliverReplies();
  append({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'late result'}]}});
  await inbox.watch();assert.equal(job.noticeRetry,undefined);
  rejectNotice(Error('temporary timeout update failure'));await delivery;
  assert.equal(job.status,'done');assert.equal(job.notice,undefined);assert.equal(job.noticeRetry,undefined);
  assert.equal(finals.length,1);assert.equal(finals[0].text,'late result');assert.deepEqual(injected,['om_task']);
  inbox=open();await inbox.watch();await inbox.deliverReplies();
  assert.equal(inbox.jobs.get('om_task').status,'done');assert.equal(finals.length,1);assert.deepEqual(injected,['om_task']);
});
