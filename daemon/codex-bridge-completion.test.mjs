import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DurableInbox} from './codex-bridge-inbox.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {enqueueSilentCompletion,readSilentCompletion} from './codex-bridge-completion.mjs';
import {DurableReactions} from './codex-bridge-reactions.mjs';
import {enqueueFile} from './codex-bridge-files.mjs';
function fixture(t) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'silent-test-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const binding={bot:'fixture',profile:'example',chat_id:'oc_fixture',allowed_sender_id:'ou_owner',bot_open_id:'ou_bot',group_access:'all_group_humans',codex_thread_id:'thread',cwd:root};
 const inboxRoot=path.join(root,'inbox'),controlRoot=path.join(root,'completion');const rollout=path.join(root,'rollout.jsonl');fs.writeFileSync(rollout,'');
 let now=1000;const sent=[],progress=[],injected=[];
 const io={suppressNotices:()=>binding.group_access==='all_group_humans',prepare:async e=>e,target:async()=>({rollout}),inject:async j=>injected.push(j.id),send:async t=>sent.push(t),progress:async t=>progress.push(t),silentCompletion:job=>readSilentCompletion({root:controlRoot,binding,job})};
 const open=()=>new DurableInbox(inboxRoot,binding.bot,io,{now:()=>now,timeoutMs:1000});const q=open();
 const event=id=>({type:'im.message.receive_v1',message_id:`om_${id}`,message_type:'text',content:'hello',chat_id:binding.chat_id,chat_type:'group',sender_id:'ou_member',sender_type:'user',mentions:[],bridge_binding:bindingSnapshot(binding)});
 const append=(...items)=>fs.appendFileSync(rollout,items.map(x=>JSON.stringify(x)+'\n').join(''));
 const marker=id=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`[飞书消息｜fixture｜om_${id}]`}]}});
 const final=text=>({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text}]}});
 const complete=id=>enqueueSilentCompletion({root:controlRoot,inboxRoot,binding,jobId:`om_${id}`});
 return {root,binding,q,open,event,append,marker,final,complete,sent,progress,injected,advance:()=>{now+=2000;}};
}
test('silent control requires marker proof, clears queues without ordinary final or sending',async t=>{
 const f=fixture(t);f.q.enqueue(f.event('chat'));await f.q.dispatchOne();f.complete('chat');await f.q.watch();
 assert.equal(f.q.stats().awaiting_delivery_count,1);
 f.append(f.marker('chat'));await f.q.watch();await f.q.deliverReplies();
 assert.equal(f.q.jobs.get('om_chat').completionDisposition,'silent');assert.equal(f.q.stats().silent_completed_count,1);
 for(const key of ['queued_count','awaiting_delivery_count','awaiting_reply_count','reply_pending_count','watch_error_count','outbound_blocked_count','failed_count'])assert.equal(f.q.stats()[key],0,key);
 f.advance();await f.q.watch();await f.q.deliverReplies();assert.deepEqual(f.sent,[]);assert.deepEqual(f.progress,[]);
});
test('silent survives restart and duplicate controls without reinjection, stale notices or late-final leakage',async t=>{
 const f=fixture(t);f.q.enqueue(f.event('chat'));await f.q.dispatchOne();f.append(f.marker('chat'));await f.q.watch();f.advance();await f.q.watch();
 assert.ok(f.q.jobs.get('om_chat').notice);assert.equal(f.complete('chat').duplicate,false);assert.equal(f.complete('chat').duplicate,true);
 const q=f.open();f.append(f.final('ordinary final must remain internal'));await q.watch();await q.deliverReplies();
 q.enqueue(f.event('chat'));await q.dispatchOne();assert.deepEqual(f.injected,['om_chat']);assert.deepEqual(f.sent,[]);assert.equal(q.jobs.get('om_chat').notice,undefined);
 assert.equal(f.complete('chat').duplicate,true);
});
test('interleaved silent and operational messages retain separate endings and only one final',async t=>{
 const f=fixture(t);for(const id of ['chat','task']){f.q.enqueue(f.event(id));await f.q.dispatchOne();}
 f.complete('chat');f.append(f.marker('chat'),f.marker('task'),f.final('task result'));await f.q.watch();await f.q.deliverReplies();
 assert.deepEqual(f.sent,['task result']);assert.equal(f.q.stats().completed_count,2);assert.equal(f.q.stats().silent_completed_count,1);
});
test('ordinary final text cannot select silent completion',async t=>{
 const f=fixture(t);f.q.enqueue(f.event('chat'));await f.q.dispatchOne();f.append(f.marker('chat'),f.final('silent'));await f.q.watch();await f.q.deliverReplies();assert.deepEqual(f.sent,['silent']);
 assert.equal(f.q.stats().silent_completed_count,0);
});
test('silent refuses queued, unknown, callback, other-chat and rebound jobs',async t=>{
 const f=fixture(t);f.q.enqueue(f.event('queued'));assert.throws(()=>f.complete('queued'),/not_active/);assert.throws(()=>f.complete('unknown'),/unknown_completion/);
 f.q.enqueue({...f.event('foreign'),chat_id:'oc_other'});await f.q.dispatchOne();await f.q.dispatchOne();assert.throws(()=>f.complete('foreign'),/scope_mismatch/);
 f.binding.codex_thread_id='different';assert.throws(()=>f.complete('queued'),/scope_mismatch/);
});
test('all human strategy adds no queued, delivered or done reactions and new member attachments remain scoped',async t=>{
 const f=fixture(t);const j=f.q.enqueue(f.event('task'));
 const feedback=new DurableReactions({root:path.join(f.root,'reactions'),binding:f.binding,now:()=>1000,request:async()=>{throw Error('must not request');},resolveAppId:async()=>{throw Error('must not resolve');}});
 feedback.observe([j]);j.status='delivered';j.markerSeen=true;feedback.observe([j]);j.status='done';feedback.observe([j]);await feedback.flush();assert.equal(feedback.rows.size,0);assert.equal(feedback.stats().reaction_pending_count,0);
 const file=path.join(f.root,'deliverable.txt');fs.writeFileSync(file,'requested output');
 assert.equal(enqueueFile({root:path.join(f.root,'files'),inboxRoot:path.join(f.root,'inbox'),binding:f.binding,jobId:j.id,file}).status,'queued');
 f.binding.chat_id='oc_other';assert.throws(()=>enqueueFile({root:path.join(f.root,'files'),inboxRoot:path.join(f.root,'inbox'),binding:f.binding,jobId:j.id,file}),/attachment_/);
});

test('unclassified group chat preserves stalled health diagnostics but sends no automatic timeout notice',async t=>{
 const f=fixture(t);f.q.enqueue(f.event('chat'));await f.q.dispatchOne();f.append(f.marker('chat'));await f.q.watch();
 f.advance();await f.q.watch();assert.equal(f.q.jobs.get('om_chat').timeoutNotified,true);await f.q.deliverReplies();
 assert.equal(f.q.jobs.get('om_chat').noticeSuppressed,true);assert.equal(f.q.stats().awaiting_reply_count,1);assert.deepEqual(f.sent,[]);
 f.complete('chat');await f.q.watch();await f.q.deliverReplies();assert.equal(f.q.stats().silent_completed_count,1);assert.deepEqual(f.sent,[]);
});
