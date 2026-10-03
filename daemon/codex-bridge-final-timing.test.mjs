import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DurableOutbound} from './codex-bridge-outbound.mjs';
import {DurableInbox} from './codex-bridge-inbox.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';
import {DurableReplyRouter,chatReplyRoute} from './codex-bridge-reply-routing.mjs';

function fixture(t,cardkit=false){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'final-timing-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,binding:{bot:'fixture',chat_id:'oc_fixture',cardkit_enabled:cardkit}};
}
test('actual final response survives a much later receipt recovery without shifting its time',async t=>{
  const f=fixture(t);let time=1000,calls=0;
  const request=async()=>{calls++;return {message_id:'om_reply'};};
  let out=new DurableOutbound(f.root,f.binding,request,{now:()=>time});
  assert.deepEqual(await out.final('answer','reply',['stream']),{schema:1,at:1000,source:'send_response'});
  const sent=calls;fs.unlinkSync(out.file('reply','reply'));time=9000;
  out=new DurableOutbound(f.root,f.binding,request,{now:()=>time});
  assert.deepEqual(await out.final('answer','reply',['stream']),{schema:1,at:1000,source:'send_response'});assert.equal(calls,sent);
});
test('cached legacy answer reports an observation and never invents an original send time',async t=>{
  const f=fixture(t),out=new DurableOutbound(f.root,f.binding,async()=>{throw Error('must not send');},{now:()=>9000});
  atomicWriteJson(out.file('card','stream'),{key:'stream',final:true,finalDelivered:true,finalReplyKey:'reply',revision:1,sentRevision:1});
  assert.deepEqual(await out.final('answer','reply',[]),{schema:1,at:9000,source:'reconciled_observation'});
});
test('legacy incomplete text recovers a cached native ACK without calling it a fresh send response',async t=>{
  const f=fixture(t);let time=1000,posts=0;
  const router=new DurableReplyRouter({root:path.join(f.root,'router'),binding:f.binding,now:()=>time,
    request:async()=>{posts++;return {message_id:'om_reply',chat_id:f.binding.chat_id};}});
  const route=chatReplyRoute(f.binding),options={now:()=>time,sendMessage:args=>router.send(args)};
  await router.send({key:'text:reply:0',route,msgType:'text',content:{text:'answer'}});
  let out=new DurableOutbound(path.join(f.root,'out'),f.binding,async()=>{throw Error('unexpected direct send');},options);
  // Old worker crashed after the router persisted success but before next++.
  atomicWriteJson(out.file('text','reply'),{parts:['answer'],next:0,route});time=9000;
  const proof={schema:1,at:9000,source:'reconciled_observation'};
  assert.deepEqual(await out.final('answer','reply',[],{replyRoute:route}),proof);assert.equal(posts,1);
  time=15000;out=new DurableOutbound(path.join(f.root,'out'),f.binding,async()=>{throw Error('unexpected direct send');},options);
  assert.deepEqual(await out.final('answer','reply',[],{replyRoute:route}),proof);assert.equal(posts,1);
  assert.deepEqual(await out.final('new answer','fresh',[],{replyRoute:route}),{schema:1,at:15000,source:'send_response'});assert.equal(posts,2);
});
test('unknown text ACK after restart remains reconciliation evidence even when retry succeeds',async t=>{
  const f=fixture(t);let out=new DurableOutbound(f.root,f.binding,async()=>{throw Error('lost ACK');},{now:()=>1000});
  await assert.rejects(out.final('answer','reply',[]));
  out=new DurableOutbound(f.root,f.binding,async()=>({message_id:'om_reply'}),{now:()=>9000});
  assert.deepEqual(await out.final('answer','reply',[]),{schema:1,at:9000,source:'reconciled_observation'});
});
test('uncertain CardKit final reuses its frozen revision and labels the recovered response honestly',async t=>{
  const f=fixture(t,true);let fail=true,time=1000,updates=0;
  const request=async(_b,args)=>{
    if(args[1]==='PUT'){updates++;if(fail)throw Object.assign(Error('lost ACK'),{deliveryUncertain:true});return {};}
    return args[2].includes('cardkit')?{card_id:'card_fixture'}:{message_id:'om_reply'};
  };
  let out=new DurableOutbound(f.root,f.binding,request,{now:()=>time});
  await assert.rejects(out.final('answer','reply',['stream']));
  const revision=out.read(out.file('card','stream')).revision;fail=false;time=9000;
  out=new DurableOutbound(f.root,f.binding,request,{now:()=>time});
  assert.deepEqual(await out.final('answer','reply',['stream']),{schema:1,at:9000,source:'reconciled_observation'});
  assert.equal(out.read(out.file('card','stream')).revision,revision);assert.equal(updates,2);
});
test('late inbox peer receives the original delivery proof rather than its card-close checkpoint',async t=>{
  const f=fixture(t);let time=1000,sends=0;
  const inbox=new DurableInbox(f.root,'fixture',{final:async()=>{sends++;return {schema:1,at:800,source:'send_response'};},closeReplyCards:async()=>{}},{now:()=>time});
  const add=id=>{const j=inbox.enqueue({message_id:id,message_type:'text',content:'{"text":"query"}'});Object.assign(j,{status:'reply_pending',reply:'answer',replyKey:'shared',streamKey:id,markerSeen:true,feedbackDisposition:'actionable'});inbox.save(j);return j;};
  const a=add('om_first');await inbox.deliverReplies();time=9000;const b=add('om_later');await inbox.deliverReplies();
  assert.equal(sends,1);assert.equal(a.finalDeliveryEvidence.at,800);assert.equal(b.finalDeliveryEvidence.at,800);assert.equal(b.completedAt,9000);
});
