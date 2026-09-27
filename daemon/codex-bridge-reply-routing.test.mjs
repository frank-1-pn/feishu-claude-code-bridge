import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableReplyRouter, nativeMessageContext, selectReplyRoute, replyRouteNotice, chatReplyRoute } from './codex-bridge-reply-routing.mjs';
import { bindingSnapshot } from './codex-bridge-ux.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'native-reply-test-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const binding = { bot:'fixture', profile:'selected', chat_id:'oc_fixture', allowed_sender_id:'ou_fixture', codex_thread_id:'thread_fixture' };
  let now = 1000, serial = 0; const calls = [], remote = new Map();
  const job = (id = 'om_first', fields = {}) => ({ id, sequence:1, acceptedAt:now, event:{
    message_id:id, chat_id:binding.chat_id, sender_id:binding.allowed_sender_id, bridge_binding:bindingSnapshot(binding), ...fields } });
  const request = async (actualBinding,args) => {
    assert.equal(actualBinding.profile,binding.profile);
    const body = JSON.parse(args[args.indexOf('--data')+1]);
    calls.push({ args, body, endpoint:args[2] });
    if (!remote.has(body.uuid)) remote.set(body.uuid,{ message_id:`om_reply_${++serial}`, chat_id:binding.chat_id,
      ...(body.reply_in_thread ? {thread_id:'omt_fixture'} : {}) });
    return remote.get(body.uuid);
  };
  const make = (options = {}) => new DurableReplyRouter({root,binding,request,now:()=>now,...options});
  const input = (route = selectReplyRoute(binding,[job()]), key = 'answer') => ({ key, route, msgType:'text', content:{text:'verified answer'} });
  return {root,binding,job,request,make,input,calls,remote,advance:ms=>now+=ms};
}
const apiError = apiCode => Object.assign(Error('private server body must not be retained'),{apiCode});

test('native IDs support compact and raw envelopes without treating quoted roots as topics', t => {
  const f = fixture(t);
  assert.deepEqual(nativeMessageContext({event:{message:{message_id:'om_first',root_id:'om_root',parent_id:'om_parent',thread_id:'omt_topic'}}}),
    {messageId:'om_first',rootId:'om_root',parentId:'om_parent',threadId:'omt_topic'});
  const quoted = selectReplyRoute(f.binding,[f.job('om_first',{root_id:'om_root',parent_id:'om_parent'})]);
  assert.equal(quoted.mode,'quote'); assert.equal(quoted.messageId,'om_first');
  assert.equal(selectReplyRoute(f.binding,[f.job('om_first',{thread_id:'omt_topic'})]).mode,'thread');
  assert.equal(selectReplyRoute(f.binding,[f.job()],{mode:'thread'}).mode,'thread');
  assert.equal(selectReplyRoute(f.binding,[f.job()],{mode:'off'}).mode,'chat');
  assert.equal(nativeMessageContext({message_id:'om_cb_fake',thread_id:'../../other'}).messageId,null);
});

test('routing requires matching chat, sender, Codex binding and message identity', t => {
  const f = fixture(t);
  for (const patch of [{chat_id:'oc_other'},{sender_id:'ou_other'},{codex_thread_id:'another_thread'},
    {bridge_binding:{...bindingSnapshot(f.binding),profile:'another_profile'}},{message_id:'om_unrelated'}])
    assert.throws(() => selectReplyRoute(f.binding,[f.job('om_first',patch)]),/reply_source_binding_mismatch/);
  assert.throws(() => selectReplyRoute(f.binding,[f.job(),f.job('om_bad',{chat_id:'oc_other'})]),/reply_source_binding_mismatch/);
  assert.equal(chatReplyRoute(f.binding).chatId,f.binding.chat_id);
});

test('callback replies use a source card only after following its authorized originating job', t => {
  const f = fixture(t), origin = f.job('om_original',{thread_id:'omt_topic'});
  const callback = f.job('om_cb_action',{synthetic_callback:true,action_source_job_id:origin.id,action_source_message_id:'om_botcard'});
  assert.throws(() => selectReplyRoute(f.binding,[callback]),/reply_source_binding_mismatch/);
  const route = selectReplyRoute(f.binding,[callback],{allJobs:[callback,origin]});
  assert.equal(route.messageId,'om_botcard'); assert.equal(route.threadId,'omt_topic'); assert.equal(route.mode,'thread');
  assert.throws(() => selectReplyRoute(f.binding,[callback],{allJobs:[callback,{...origin,event:{...origin.event,sender_id:'ou_other'}}]}),/binding_mismatch/);
  callback.event.action_source_job_id = callback.id;
  assert.throws(() => selectReplyRoute(f.binding,[callback]),/binding_mismatch/);
});

test('same-turn bursts select earliest source once; mixed topics are explicitly grouped in main chat', t => {
  const f = fixture(t), first = f.job('om_first'), second = {...f.job('om_second'),sequence:2};
  const route = selectReplyRoute(f.binding,[second,first]);
  assert.equal(route.messageId,first.id); assert.equal(route.sourceCount,2); assert.match(replyRouteNotice(route),/2 条连续消息/);
  const mixed = selectReplyRoute(f.binding,[first,{...second,event:{...second.event,thread_id:'omt_other'}}]);
  assert.equal(mixed.mode,'chat'); assert.equal(mixed.reason,'mixed_topics'); assert.match(replyRouteNotice(mixed),/不同话题/);
});

test('raw quote/topic/card/file sends preserve identity and cache successful ack over concurrent calls and restart', async t => {
  const f = fixture(t), router = f.make();
  await Promise.all([router.send(f.input()),router.send(f.input())]);
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].endpoint,'/open-apis/im/v1/messages/om_first/reply');
  assert.equal(f.calls[0].body.reply_in_thread,false); assert.equal(f.calls[0].body.uuid.length,40);
  await f.make().send(f.input()); assert.equal(f.calls.length,1);
  const topic = selectReplyRoute(f.binding,[f.job('om_topic',{thread_id:'omt_existing'})]);
  await router.send({...f.input(topic,'card'),msgType:'interactive',content:{type:'card',data:{card_id:'card_fixture'}}});
  await router.send({...f.input(topic,'file'),msgType:'file',content:{file_key:'file_fixture'}});
  assert.equal(f.calls[1].body.reply_in_thread,true); assert.equal(f.calls[2].body.msg_type,'file');
  assert.equal(router.stats().native_reply_pending_count,0);
});

test('server-created reply with lost ack retries exact endpoint/body/UUID and does not create another final', async t => {
  const f = fixture(t); let loseAck = true;
  const router = f.make({request:async(...args) => {
    const result = await f.request(...args);
    if (loseAck) { loseAck = false; throw Object.assign(Error('offline'),{code:'ETIMEDOUT'}); }
    return result;
  }});
  await assert.rejects(router.send(f.input()),/offline/);
  assert.equal(router.stats().native_reply_pending_count,1);
  f.advance(10000); await f.make().send(f.input());
  assert.equal(f.remote.size,1); assert.deepEqual(f.calls[0],f.calls[1]);
});

test('uncertain send cannot alter body, target or fall back after later source deletion', async t => {
  const f = fixture(t), router = f.make({request:async()=>{throw Object.assign(Error('lost'),{code:'ECONNRESET'});}});
  await assert.rejects(router.send(f.input()));
  await assert.rejects(f.make().send({...f.input(),content:{text:'changed'}}),/reply_intent_changed/);
  const other = selectReplyRoute(f.binding,[f.job('om_other')]);
  await assert.rejects(f.make().send(f.input(other)),/reply_intent_changed/);
  let calls = 0;
  await assert.rejects(f.make({request:async(_binding,args)=>{calls++;assert.match(args[2],/\/reply$/);throw apiError(230011);}}).send(f.input()));
  assert.equal(calls,1); assert.equal(f.calls.length,0);
});

test('uncertain sends stop before UUID deduplication expires, even across restarts', async t => {
  const f = fixture(t), router = f.make({request:async()=>{throw Object.assign(Error('lost'),{code:'ETIMEDOUT'});}});
  await assert.rejects(router.send(f.input()));
  f.advance(55*60*1000);
  const restarted = f.make();
  await assert.rejects(restarted.send(f.input()),/reply_delivery_uncertain_expired/);
  assert.equal(f.calls.length,0); assert.equal(restarted.stats().native_reply_blocked_count,1);
});

test('definite recalled source rejection falls back only to the same bound chat and survives retry', async t => {
  const f = fixture(t); let attempts = 0;
  const router = f.make({request:async(binding,args)=>{
    attempts++;
    if (attempts === 1) throw apiError(230011);
    return f.request(binding,args);
  }});
  const result = await router.send(f.input());
  assert.equal(result.fallback,'source_unavailable'); assert.equal(attempts,2);
  assert.equal(f.calls[0].endpoint,'/open-apis/im/v1/messages');
  assert.equal(f.calls[0].body.receive_id,f.binding.chat_id);
  await f.make().send(f.input()); assert.equal(f.calls.length,1);
});

test('definitely unsupported topic downgrades to quote, while permission/visibility errors never change location', async t => {
  const f = fixture(t), route = selectReplyRoute(f.binding,[f.job()],{mode:'thread'}); let attempts = 0;
  await f.make({request:async(binding,args)=>{ if (++attempts === 1) throw apiError(230071); return f.request(binding,args); }}).send(f.input(route));
  assert.equal(f.calls[0].body.reply_in_thread,false); assert.match(f.calls[0].endpoint,/\/reply$/);
  for (const code of [230002,230027,230035,230050,99991672]) {
    let calls = 0; const router = f.make({request:async()=>{calls++;throw apiError(code);}});
    await assert.rejects(router.send(f.input(route,`denied_${code}`)),error=>error.permanent === true);
    await assert.rejects(router.send(f.input(route,`denied_${code}`)),error=>error.permanent === true);
    assert.equal(calls,1);
  }
});

test('rate rejection is safe to retry after an hour without pretending a message was created', async t => {
  const f = fixture(t); let attempts = 0;
  const router = f.make({request:async(binding,args)=>{if (++attempts === 1) throw apiError(230020); return f.request(binding,args);}});
  await assert.rejects(router.send(f.input())); f.advance(2*60*60*1000);
  await router.send(f.input()); assert.equal(f.remote.size,1);
});

test('invalid ack remains uncertain, corrupt journals fail closed, and changed bindings do not reuse old routes', async t => {
  const f = fixture(t);
  await assert.rejects(f.make({request:async()=>({message_id:'om_ack',chat_id:'oc_unexpected'})}).send(f.input()),/reply_ack_invalid/);
  const stateFile = path.join(f.root,f.binding.bot,fs.readdirSync(path.join(f.root,f.binding.bot))[0]);
  const serialized = fs.readFileSync(stateFile,'utf8');
  assert.ok(!serialized.includes('private server body'));
  const state = JSON.parse(serialized); state.content = JSON.stringify({text:'tampered'}); fs.writeFileSync(stateFile,JSON.stringify(state));
  await assert.rejects(f.make().send(f.input()),/reply_intent_changed/);
  fs.writeFileSync(stateFile,'{'); await assert.rejects(f.make().send(f.input()),/reply_state_corrupt/);
  await assert.rejects(f.make({binding:{...f.binding,profile:'rebound'}}).send(f.input()),/reply_route_binding_mismatch/);
});
