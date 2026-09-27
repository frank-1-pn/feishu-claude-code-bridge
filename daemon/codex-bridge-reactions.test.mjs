import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DurableReactions,reactionForJob} from './codex-bridge-reactions.mjs';
import {DurableInbox} from './codex-bridge-inbox.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {resolveLarkAppId,createLarkTransport} from './codex-bridge-lark.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reaction-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let now=1000000,serial=0;const calls=[],server=new Map();
 const binding={bot:'fixture',profile:'chosen',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',codex_thread_id:'thread-fixture'};
 const api=async(_b,args)=>{
  assert.equal(_b.profile,'chosen');const method=args[2],params=JSON.parse(args[args.indexOf('--params')+1]);
  const emoji=args.includes('--data')?JSON.parse(args[args.indexOf('--data')+1]).reaction_type.emoji_type:params.reaction_type;
  calls.push({method,emoji,id:params.message_id,reactionId:params.reaction_id});
  if(method==='create'){
   const item={reaction_id:`rid_${++serial}`,reaction_type:{emoji_type:emoji},operator:{operator_type:'app',operator_id:'cli_fixture'}};
   server.set(item.reaction_id,{...item,messageId:params.message_id});return item;
  }
  if(method==='delete'){if(!server.delete(params.reaction_id))throw Object.assign(Error('gone'),{apiCode:231011});return {};}
  if(method==='list')return {items:[...server.values()].filter(v=>v.messageId===params.message_id&&v.reaction_type.emoji_type===emoji),has_more:false};
  throw Error('unexpected API');
 };
 const make=(options={})=>new DurableReactions({root,binding,request:api,resolveAppId:async()=>'cli_fixture',now:()=>now,...options});
 const job=(id='om_one')=>({id,status:'queued',acceptedAt:now,event:{message_id:id,message_type:'text',chat_id:binding.chat_id,sender_id:binding.allowed_sender_id,bridge_binding:bindingSnapshot(binding)}});
 return {root,binding,make,job,api,calls,server,advance:ms=>now+=ms,now:()=>now};
}

test('real inbox delivery checkpoints control OnIt -> Typing -> DONE, with one write per transition',async t=>{
 const f=fixture(t),r=f.make();const inbox=new DurableInbox(path.join(f.root,'inbox'),f.binding.bot,{final:async()=>{}},{now:f.now});
 const j=inbox.enqueue(f.job().event);r.observe(inbox.jobs.values());await r.flush();
 assert.equal(r.rows.get(j.id).current.emoji,'OnIt');
 j.status='submitted';r.observe(inbox.jobs.values());await r.flush();assert.equal(f.calls.length,1);
 j.status='reply_pending';j.markerSeen=true;j.reply='answer';j.replyKey='shared';inbox.save(j);
 r.observe(inbox.jobs.values());await r.flush();assert.equal(r.rows.get(j.id).current.emoji,'Typing');
 // A model final awaiting a failed network send is not DONE.
 inbox.io.final=async()=>{throw Object.assign(Error('offline'),{code:'ECONNRESET'});};
 await inbox.deliverReplies();r.observe(inbox.jobs.values());await r.flush();assert.equal(r.rows.get(j.id).current.emoji,'Typing');
 f.advance(400000);inbox.io.final=async()=>{};await inbox.deliverReplies();assert.equal(j.status,'done');
 r.observe(inbox.jobs.values());await r.flush();assert.equal(r.rows.get(j.id).current.emoji,'DONE');
 const count=f.calls.length;for(let i=0;i<10;i++){r.observe(inbox.jobs.values());await r.flush();}assert.equal(f.calls.length,count);
 const resumed=f.make();resumed.observe(inbox.jobs.values());await resumed.flush();assert.equal(f.calls.length,count);
 assert.deepEqual(f.calls.filter(c=>c.method==='create').map(c=>c.emoji),['OnIt','Typing','DONE']);
});

test('uncertain create is adopted after restart without duplicate add or deleting another operator',async t=>{
 const f=fixture(t),j=f.job();let uncertain=true;
 f.server.set('other',{reaction_id:'other',messageId:j.id,reaction_type:{emoji_type:'OnIt'},operator:{operator_type:'app',operator_id:'cli_other'}});
 const r=f.make({request:async(...args)=>{const result=await f.api(...args);if(args[1][2]==='create'&&uncertain){uncertain=false;throw Object.assign(Error('lost acknowledgement'),{code:'ETIMEDOUT'});}return result;}});
 r.observe([j]);await r.flush();assert.ok(r.rows.get(j.id).pending);
 f.advance(10000);const restarted=f.make();restarted.observe([j]);await restarted.flush();
 assert.equal(f.calls.filter(c=>c.method==='create').length,1);assert.equal(restarted.rows.get(j.id).current.emoji,'OnIt');
 j.status='done';restarted.observe([j]);await restarted.flush();assert.ok(f.server.has('other'));
 assert.ok(f.calls.filter(c=>c.method==='delete').every(c=>c.reactionId!=='other'));
});

test('late in-flight typing cannot overwrite completion and concurrent flushes do not double send',async t=>{
 const f=fixture(t),j=f.job();j.markerSeen=true;j.status='delivered';let release,started;
 const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);
 const r=f.make({request:async(...args)=>{if(args[1][2]==='create'&&JSON.parse(args[1][args[1].indexOf('--data')+1]).reaction_type.emoji_type==='Typing'){started();await gate;}return f.api(...args);}});
 r.observe([j]);const work=r.flush();await entered;await r.flush();j.status='done';r.observe([j]);release();await work;
 assert.equal(r.rows.get(j.id).current.emoji,'DONE');assert.deepEqual([...f.server.values()].map(x=>x.reaction_type.emoji_type),['DONE']);
});

test('unauthorized, synthetic, rebound and completed historical messages never receive new reactions',async t=>{
 const f=fixture(t),r=f.make();const jobs=[f.job('om_sender'),f.job('om_chat'),f.job('om_callback'),f.job('om_thread'),f.job('om_old')];
 jobs[0].event.sender_id='ou_other';jobs[1].event.chat_id='oc_other';jobs[2].event.synthetic_callback=true;
 jobs[3].event.bridge_binding.codex_thread_id='other';jobs[4].status='done';jobs[4].acceptedAt--;
 r.observe(jobs);await r.flush();assert.equal(f.calls.length,0);assert.equal(r.rows.size,0);
});

test('permission failures pause feedback across a burst without failing model delivery; recovery retries',async t=>{
 const f=fixture(t);let blocked=true,attempts=0;
 const r=f.make({request:async(...args)=>{attempts++;if(blocked)throw Object.assign(Error('private body must not persist'),{apiCode:99991672,type:'permission'});return f.api(...args);}});
 const jobs=Array.from({length:30},(_,i)=>f.job(`om_burst${i}`));r.observe(jobs);await r.flush();await r.flush();assert.equal(attempts,1);
 assert.equal(r.stats().reaction_last_error,'99991672');assert.ok(jobs.every(j=>j.status==='queued'));
 for(const p of fs.readdirSync(r.dir))assert.ok(!fs.readFileSync(path.join(r.dir,p),'utf8').includes('private body'));
 blocked=false;f.advance(300001);await r.flush();assert.equal(r.stats().reaction_error_count,0);assert.equal(r.stats().reaction_pending_count,0);
});

test('timeouts show waiting, terminal failures show ERROR, stale active indicators clean up and disabled mode stays silent',async t=>{
 const f=fixture(t),j=f.job(),r=f.make();r.observe([j]);await r.flush();
 j.timeoutNotified=true;r.observe([j]);await r.flush();assert.equal(r.rows.get(j.id).current.emoji,'OneSecond');
 j.status='failed';r.observe([j]);await r.flush();assert.equal(r.rows.get(j.id).current.emoji,'ERROR');
 const pending=f.job('om_stale');r.observe([pending]);await r.flush();f.advance(86400001);r.observe([pending]);await r.flush();assert.equal(r.rows.get(pending.id).current,null);
 const disabled=f.make({enabled:false});disabled.observe([f.job('om_disabled')]);await disabled.flush();assert.ok(!disabled.rows.has('om_disabled'));
});

test('already-deleted reaction on restart converges, permanent invalid message does not retry forever',async t=>{
 const f=fixture(t),j=f.job(),r=f.make();r.observe([j]);await r.flush();f.server.clear();
 j.status='done';const resumed=f.make();resumed.observe([j]);await resumed.flush();assert.equal(resumed.rows.get(j.id).current.emoji,'DONE');
 const broken=f.make({request:async()=>{throw Object.assign(Error('gone'),{apiCode:231003});}});const missing=f.job('om_deleted');broken.observe([missing]);await broken.flush();
 assert.equal(broken.stats().reaction_blocked_count,1);assert.equal(broken.rows.get(missing.id).retry.blocked,true);
});

test('feedback scope changes never reuse prior bot state and corrupt journals fail closed',async t=>{
 const f=fixture(t),j=f.job(),r=f.make();r.observe([j]);await r.flush();const before=f.calls.length;
 const changed=f.make({binding:{...f.binding,codex_thread_id:'new-thread'}});changed.observe([j]);await changed.flush();assert.equal(f.calls.length,before);
 fs.writeFileSync(r.file(j.id),'{broken');const corrupt=f.make();corrupt.observe([j]);await corrupt.flush();assert.equal(f.calls.length,before);assert.equal(corrupt.stats().reaction_blocked_count,1);
});

test('profile identity stays private and feedback transport enforces bounded bot requests',async()=>{
 const run=async(_exe,args,options)=>{assert.deepEqual(args,['--profile','chosen','config','show']);assert.equal(options.timeoutMs,15000);return {code:0,stdout:JSON.stringify({appId:'cli_fixture',appSecret:'fake'})};};
 assert.equal(await resolveLarkAppId('fixture',{profile:'chosen'},{run}),'cli_fixture');
 const request=createLarkTransport('fixture',{timeoutMs:15000,run:async(_exe,args,o)=>{assert.equal(o.timeoutMs,15000);assert.deepEqual(args.slice(-2),['--as','bot']);assert.equal(args[args.indexOf('--data')+1],'-');return {code:0,stdout:'{"ok":true,"data":{"reaction_id":"rid"}}'};}});
 await request({profile:'chosen'},['im','reactions','create','--data','{}']);
});
