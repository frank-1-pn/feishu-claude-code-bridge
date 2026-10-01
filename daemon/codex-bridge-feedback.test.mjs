import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DurableInbox} from './codex-bridge-inbox.mjs';
import {enqueueActionable,enqueueSilentCompletion,readDisposition} from './codex-bridge-completion.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {DurableReactions} from './codex-bridge-reactions.mjs';
function fixture(t) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'action-feedback-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const binding={bot:'fixture',profile:'fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_owner',bot_open_id:'ou_bot',group_access:'all_group_humans',codex_thread_id:'thread',reaction_feedback:true};
 const inboxRoot=path.join(root,'inbox'),controlRoot=path.join(root,'control'),rollout=path.join(root,'rollout.jsonl');fs.writeFileSync(rollout,'');const progress=[],finals=[];
 const io={prepare:async e=>e,target:async()=>({rollout}),inject:async()=>{},classifiedFeedback:true,classification:job=>readDisposition({root:controlRoot,binding,job}),progress:async(text,key,context)=>progress.push({text,key,id:context.jobId}),final:async(text,key,keys,context)=>finals.push({text,key,keys,ids:context.jobs.map(j=>j.id)}),send:async()=>assert.fail('no placeholder')};
 const open=()=>new DurableInbox(inboxRoot,binding.bot,io,{now:()=>1000});const q=open();
 const add=id=>q.enqueue({type:'im.message.receive_v1',message_id:'om_'+id,chat_id:binding.chat_id,chat_type:'group',sender_type:'user',sender_id:'ou_member',message_type:'text',content:id,bridge_binding:bindingSnapshot(binding)});
 const opts=id=>({root:controlRoot,inboxRoot,binding,jobId:'om_'+id});
 const append=(...items)=>fs.appendFileSync(rollout,items.map(item=>JSON.stringify(item)+'\n').join(''));
 const marker=id=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`[飞书消息｜fixture｜om_${id}]`}]}});
 const msg=(text,phase='commentary')=>({type:'response_item',payload:{type:'message',role:'assistant',phase,content:[{type:'output_text',text}]}});
 return {root,binding,q,open,add,opts,append,marker,msg,progress,finals};
}
test('actionable intent remains queued until exact marker, and silent/actionable are immutable exclusive',async t=>{
 const f=fixture(t),a=f.add('a');await f.q.dispatchOne();assert.equal(enqueueActionable(f.opts('a')).queued,true);assert.equal(a.feedbackDisposition,undefined);
 assert.equal(enqueueActionable(f.opts('a')).duplicate,true);assert.throws(()=>enqueueSilentCompletion(f.opts('a')),/conflict/);
 await f.q.watch();assert.equal(a.feedbackDisposition,undefined);f.append(f.marker('a'));await f.q.watch();assert.equal(a.feedbackDisposition,'actionable');
 const s=f.add('s');await f.q.dispatchOne();enqueueSilentCompletion(f.opts('s'));assert.throws(()=>enqueueActionable(f.opts('s')),/conflict/);f.append(f.marker('s'));await f.q.watch();assert.equal(s.completionDisposition,'silent');
});
test('same-turn humans get only exact attributed progress, independent streams and marked-only shared final',async t=>{
 const f=fixture(t);for(const id of ['a','b','silent','unknown']){f.add(id);await f.q.dispatchOne();}
 enqueueActionable(f.opts('a'));enqueueActionable(f.opts('b'));enqueueSilentCompletion(f.opts('silent'));
 f.append({type:'turn_context',payload:{turn_id:'one-turn'}},...['a','b','silent','unknown'].map(f.marker),f.msg('unattributed commentary'),f.msg('[飞书进度｜om_a] A progress'),f.msg('[飞书进度｜om_b] B progress'),f.msg('[飞书进度｜om_silent] should not send'),f.msg('shared result','final_answer'));
 await f.q.watch();await f.q.deliverReplies();assert.deepEqual(f.progress.map(p=>[p.id,p.text]),[['om_a','A progress'],['om_b','B progress']]);assert.equal(new Set(f.progress.map(p=>p.key)).size,2);
 assert.equal(f.finals.length,1);assert.deepEqual(f.finals[0].ids,['om_a','om_b']);assert.equal(f.finals[0].keys.length,2);assert.equal(f.q.jobs.get('om_silent').status,'done');assert.equal(f.q.jobs.get('om_unknown').unclassifiedTurnEnded,true);
 const restart=f.open();f.append(f.msg('future unrelated result','final_answer'));await restart.watch();await restart.deliverReplies();assert.equal(f.finals.length,1);assert.throws(()=>enqueueActionable(f.opts('unknown')),/turn_ended/);
 enqueueSilentCompletion(f.opts('unknown'));await restart.watch();assert.equal(restart.jobs.get('om_unknown').status,'done');
});
test('classification survives restart, but late old jobs, forged scope and callbacks cannot enable feedback',async t=>{
 const f=fixture(t);f.add('a');await f.q.dispatchOne();enqueueActionable(f.opts('a'));f.append(f.marker('a'));const q=f.open();await q.watch();assert.equal(q.jobs.get('om_a').feedbackDisposition,'actionable');
 const other={...f.opts('a'),binding:{...f.binding,chat_id:'oc_other'}};assert.throws(()=>enqueueActionable(other),/scope/);
 const callback=f.add('cb');callback.event.synthetic_callback=true;f.q.save(callback);await f.q.dispatchOne();assert.throws(()=>enqueueActionable(f.opts('cb')),/scope/);
 const queued=f.add('queued');assert.throws(()=>enqueueActionable(f.opts('queued')),/not_active/);queued.status='done';f.q.save(queued);assert.throws(()=>enqueueActionable(f.opts('queued')),/not_active/);
});
test('all-group feedback never adds OnIt or historical DONE, and marked marker changes Typing to delivered DONE once',async t=>{
 const f=fixture(t),job=f.add('a'),calls=[];let n=0;
 const make=()=>new DurableReactions({root:path.join(f.root,'reactions'),binding:f.binding,now:()=>1000,resolveAppId:async()=> 'cli_fixture',request:async(_b,args)=>{calls.push(args);return {reaction_id:'reaction_'+(++n),operator:{operator_type:'app',operator_id:'cli_fixture'}};}});
 const reactions=make();reactions.observe([job]);await reactions.flush();assert.equal(calls.length,0);await f.q.dispatchOne();enqueueActionable(f.opts('a'));reactions.observe([job]);await reactions.flush();assert.equal(calls.length,0);
 f.append(f.marker('a'));await f.q.watch();reactions.observe([job]);await reactions.flush();assert.equal(reactions.rows.get(job.id).current.emoji,'Typing');
 f.append(f.msg('answer','final_answer'));await f.q.watch();await f.q.deliverReplies();reactions.observe([job]);await reactions.flush();assert.equal(reactions.rows.get(job.id).current.emoji,'DONE');
 const createEmoji=calls.filter(a=>a[2]==='create').map(a=>JSON.parse(a[a.indexOf('--data')+1]).reaction_type.emoji_type);assert.deepEqual(createEmoji,['Typing','DONE']);
 const before=calls.length;const restart=make();restart.observe([job]);await restart.flush();assert.equal(calls.length,before);
 const old=f.add('old');old.status='done';old.markerSeen=true;reactions.observe([old]);await reactions.flush();assert.equal(reactions.rows.has(old.id),false);
 job.completionDisposition='silent';job.feedbackDisposition='silent';reactions.observe([job]);await reactions.flush();assert.equal(reactions.rows.get(job.id).current,null);
});
