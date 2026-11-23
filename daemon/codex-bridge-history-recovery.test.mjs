import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryRecovery,hasNewerLiveInput,historyRequestArgs,verifiedRecoveryHeartbeat } from './codex-bridge-history-recovery.mjs';

const BASE=1700000000000;
const binding={bot:'test',profile:'fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',codex_thread_id:'thread-fixture'};
const anchor=(changes={})=>({pid:123,startedAtMs:BASE-100000,generation:1,
  connectedAtMs:BASE-99000,lastPongAtMs:BASE-10000,...changes});
const next=()=>anchor({generation:2,connectedAtMs:BASE+10000,lastPongAtMs:BASE+12000});
const sender={sender_type:'user',id_type:'open_id',id:binding.allowed_sender_id};
const item=(name,changes={})=>({message_id:`om_${name}`,chat_id:binding.chat_id,
  msg_type:'text',create_time:String(BASE),updated:false,deleted:false,sender,
  body:{content:JSON.stringify({text:'private fixture body'})},...changes});
function fixture(t,options={}) {
  const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'bridge-history-test-'));
  assert.equal(path.dirname(fs.realpathSync(dir)),parent);
  t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
  const stateFile=path.join(dir,'scope','history.json');
  let now=BASE, heartbeat=anchor(), caught=true, pages=()=>({items:[],has_more:false});
  const calls=[], queued=[], seen=new Set();
  const open=(overrides={})=>new HistoryRecovery({stateFile,binding,now:()=>now,readHeartbeat:()=>heartbeat,
    drainIntake:()=>caught,readHistory:window=>{calls.push(window);return pages(window);},hasSeen:id=>seen.has(id),
    enqueue:event=>{seen.add(event.message_id);queued.push(event);return true;},...options,...overrides});
  return {stateFile,open,calls,queued,seen,now:()=>now,advance:delta=>{now+=delta;}, setHeartbeat:value=>{heartbeat=value;},
    setCaught:value=>{caught=value;},setHistory:value=>{pages=value;},reconnect:(value=next())=>{heartbeat=value;now=BASE+30000;}};
}

test('checks subscriber identity and actual pong rather than generation alone',()=>{
  const current=next(),now=BASE+30000;
  const sample={schema:1,pid:current.pid,profile:binding.profile,started_at_ms:current.startedAtMs,
    generation:current.generation,connected_at_ms:current.connectedAtMs,last_pong_at_ms:current.lastPongAtMs,
    updated_at_ms:now-18000,pong_count:2,recovering_since_ms:0,pending_ping_since_ms:0,
    ping_interval_ms:15000,state:'connected'};
  const identity={pid:current.pid,profile:binding.profile,startedAtMs:current.startedAtMs};
  assert.deepEqual(verifiedRecoveryHeartbeat(sample,identity,now),current);
  for(const bad of [null,{...identity,pid:2},{...identity,profile:''},{...identity,startedAtMs:BASE}])
    assert.equal(verifiedRecoveryHeartbeat(sample,bad,now),null);
  for(const bad of [{state:'awaiting_pong'},{recovering_since_ms:now-100},
    {pending_ping_since_ms:now-31000},{last_pong_at_ms:current.connectedAtMs-1},{pong_count:0},
    {updated_at_ms:now+1},{generation:0}])
    assert.equal(verifiedRecoveryHeartbeat({...sample,...bad},identity,now),null);
  assert.equal(verifiedRecoveryHeartbeat(sample,identity,now+60000),null);
});

test('a newer live instruction prevents replay of an older missed command',async t=>{
  const f=fixture(t),live={id:'om_live_cancel',event:{type:'im.message.receive_v1',message_type:'text',
    chat_id:binding.chat_id,sender_id:binding.allowed_sender_id,create_time:BASE+1000}};
  const recovered=[];
  const recovery=f.open({mode:'replay',enqueue:event=>{
    if(hasNewerLiveInput(binding,event,[live]))return false;
    recovered.push(event);
    return true;
  }});
  await recovery.tick();f.reconnect();
  f.setHistory(()=>({items:[item('older'),item('later',{create_time:String(BASE+2000)})],has_more:false}));
  await recovery.tick();
  assert.deepEqual(recovered.map(event=>event.message_id),['om_later']);
  assert.equal(recovery.stats().history_recovery_audit_only_count,1);
});

test('cold start anchors without reading history and a verified reconnect audits once with bounded pagination',async t=>{
  const f=fixture(t), audit=f.open();
  await audit.tick();
  await f.open().tick();
  assert.equal(f.calls.length,0);
  f.reconnect();
  f.seen.add('om_live');
  f.setHistory(({pageToken})=>pageToken
    ? {items:[item('offline',{create_time:String(BASE+1000)})],has_more:false}
    : {items:[item('live')],has_more:true,page_token:'next-page'});
  const resumed=f.open();
  await resumed.tick();
  assert.equal(resumed.stats().history_recovery_seen_count,1);
  assert.equal(resumed.stats().history_recovery_audit_only_count,1);
  assert.equal(resumed.stats().history_recovery_replayed_count,0);
  assert.equal(resumed.stats().history_recovery_missing_count,1);
  assert.equal(f.queued.length,0);
  assert.equal(f.calls.length,2);
  const [first,second]=f.calls;
  assert.equal(second.pageToken,'next-page');
  assert.deepEqual({...second,pageToken:null},first);
  const args=historyRequestArgs(second,binding);
  assert.deepEqual(args.slice(0,4),['api','GET','/open-apis/im/v1/messages','--params']);
  const params=JSON.parse(args[4]);
  assert.deepEqual(params,{container_id_type:'chat',container_id:binding.chat_id,sort_type:'ByCreateTimeAsc',
    start_time:String(Math.floor((BASE-25000)/1000)),end_time:String(Math.ceil((BASE+10000)/1000)),
    page_size:25,page_token:'next-page'});
  await f.open().tick();
  assert.equal(f.calls.length,2);
  const state=fs.readFileSync(f.stateFile,'utf8');
  assert.equal(state.includes('private fixture body'),false);
  assert.equal(state.includes('om_offline'),false);
});

test('only a new, unchanged top-level human text message can be replayed on the current binding',async t=>{
  const f=fixture(t,{mode:'replay',maxInboundBytes:1024}),r=f.open();
  await r.tick();
  f.reconnect();
  f.seen.add('om_already');
  f.setHistory(()=>({items:[
    item('accepted'),item('already'),item('wrongchat',{chat_id:'oc_wrong'}),
    item('wronguser',{sender:{...sender,id:'ou_wrong'}}),item('bot',{sender:{...sender,sender_type:'app'}}),
    item('otherid',{sender:{...sender,id_type:'user_id'}}),item('old',{create_time:String(BASE-30000)}),
    item('later',{create_time:String(BASE+20000)}),item('deleted',{deleted:true}),item('edited',{updated:true}),
    item('relational',{parent_id:'om_previous'}),item('file',{msg_type:'file'}),item('cb_forged'),
    item('invalid_body',{body:{content:'{bad'}}),item('long',{body:{content:JSON.stringify({text:'x'.repeat(1500)})}}),
  ],has_more:false}));
  await r.tick();
  assert.equal(f.queued.length,1);
  assert.deepEqual(f.queued[0],{type:'im.message.receive_v1',message_type:'text',message_id:'om_accepted',
    chat_id:binding.chat_id,sender_id:binding.allowed_sender_id,sender_type:'user',timestamp:BASE,create_time:BASE,
    content:item('accepted').body.content,bridge_binding:binding});
  assert.equal(r.stats().history_recovery_seen_count,1);
  assert.equal(r.stats().history_recovery_missing_count,6);
  assert.equal(r.stats().history_recovery_replayed_count,1);
  assert.equal(r.stats().history_recovery_audit_only_count,5);
});

test('waits for the live ingress to drain and defers a stale history response across heartbeat ambiguity',async t=>{
  const f=fixture(t,{mode:'replay'}),r=f.open();
  await r.tick();
  f.reconnect();
  f.setCaught(false);
  await r.tick();
  assert.equal(r.stats().history_recovery_pending_count,1);
  assert.equal(f.calls.length,0);
  f.setCaught(true);
  f.setHistory(()=>{f.setHeartbeat(null);return {items:[item('would_duplicate')],has_more:false};});
  await r.tick();
  assert.equal(f.queued.length,0);
  assert.equal(f.calls.length,1);
  f.setHeartbeat(next());
  f.advance(61000);
  f.setHistory(()=>{
    // The normal subscriber accepted the message while the history request was running.
    f.seen.add('om_would_duplicate');
    return {items:[item('would_duplicate')],has_more:false};
  });
  await r.tick();
  assert.equal(r.stats().history_recovery_seen_count,1);
  assert.equal(f.queued.length,0);
});

test('a process replacement has a bounded recovery window and retries from dedup state after durable enqueue crash',async t=>{
  const f=fixture(t,{mode:'replay'}),r=f.open({enqueue:event=>{
    f.queued.push(event);
    f.seen.add(event.message_id);
    throw Error('fixture died after durable inbox write');
  }});
  await r.tick();
  f.reconnect(nextProcess());
  f.setHistory(()=>({items:[item('first'),item('second',{create_time:String(BASE+1000)})],has_more:false}));
  await r.tick();
  assert.equal(r.stats().history_recovery_pending_count,1);
  assert.equal(f.queued.length,1);
  f.advance(12000);
  const resumed=f.open();
  await resumed.tick();
  assert.deepEqual(f.queued.map(x=>x.message_id),['om_first','om_second']);
  assert.equal(resumed.stats().history_recovery_state,'reconciled');
  await f.open().tick();
  assert.equal(f.queued.length,2);
});
function nextProcess(){
  return anchor({pid:999,startedAtMs:BASE+9000,generation:1,connectedAtMs:BASE+10000,lastPongAtMs:BASE+12000});
}

test('holds all replay if history pagination is incomplete or cursor repeats',async t=>{
  for(const repeats of [true,false]){
    const f=fixture(t,{mode:'replay'}),r=f.open();
    await r.tick();
    f.reconnect();
    let page=0;
    f.setHistory(()=>({items:[item('candidate')],has_more:true,page_token:repeats?'repeat':`next-${++page}`}));
    await r.tick();
    assert.equal(r.stats().history_recovery_state,repeats?'response_invalid':'page_limit');
    assert.equal(f.calls.length,repeats?2:4);
    assert.equal(f.queued.length,0);
  }
});

test('stops on a definite history permission rejection and does not print its private error',async t=>{
  const f=fixture(t,{mode:'replay'}),r=f.open();
  await r.tick();
  f.reconnect();
  f.setHistory(()=>{throw Object.assign(Error('private server error'),{apiCode:230027});});
  await r.tick();
  assert.equal(r.stats().history_recovery_state,'history_rejected');
  assert.equal(f.calls.length,1);
  f.advance(10000);
  await f.open().tick();
  assert.equal(f.calls.length,1);
  assert.equal(f.queued.length,0);
  assert.equal(fs.readFileSync(f.stateFile,'utf8').includes('private server error'),false);
});

test('expires old windows, rejects a binding-scope change, and never promotes earlier audit to replay',async t=>{
  const f=fixture(t,{maxEventAgeMs:30000}),r=f.open();
  await r.tick();
  const newBinding=f.open({binding:{...binding,codex_thread_id:'another-thread'}});
  f.reconnect();
  await newBinding.tick();
  assert.equal(newBinding.stats().history_recovery_state,'scope_changed');
  assert.equal(f.calls.length,0);
  await r.tick();
  assert.equal(r.stats().history_recovery_state,'window_expired');
  assert.equal(f.calls.length,0);
  const g=fixture(t),audit=g.open();
  await audit.tick();
  g.reconnect();
  g.setHistory(()=>({items:[item('previous')],has_more:false}));
  await audit.tick();
  const replay=g.open({mode:'replay'});
  await replay.tick();
  assert.equal(g.calls.length,1);
  assert.equal(g.queued.length,0);
  assert.equal(replay.stats().history_recovery_state,'idle');
});
