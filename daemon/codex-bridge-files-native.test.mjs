import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DurableInbox} from './codex-bridge-inbox.mjs';
import {FileOutbox,enqueueFile} from './codex-bridge-files.mjs';
import {selectReplyRoute} from './codex-bridge-reply-routing.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'file-native-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const binding={bot:'fixture',profile:'selected',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',codex_thread_id:'thread_fixture',cwd:root};
 const inboxRoot=path.join(root,'inbox'),outRoot=path.join(root,'files');let now=Date.now(),seq=0,routeCalls=0;
 const inbox=new DurableInbox(inboxRoot,binding.bot,{});
 const job=inbox.enqueue({message_id:'om_source',message_type:'text',content:'original question',chat_id:binding.chat_id,sender_id:binding.allowed_sender_id,bridge_binding:bindingSnapshot(binding)});
 const file=path.join(root,'report.pdf'),cover=path.join(root,'cover.png');fs.writeFileSync(file,'immutable source bytes');fs.writeFileSync(cover,'cover bytes');
 const enqueue=(mode='file')=>enqueueFile({root:outRoot,inboxRoot,binding,jobId:job.id,file,mode,cover});
 const route=()=>selectReplyRoute(binding,[job]),calls=[],remote=new Map(),notices=[];
 const request=async(b,args,cwd)=>{assert.equal(b.profile,'selected');calls.push({args,cwd});const key=args[args.indexOf('--idempotency-key')+1];
  if(!remote.has(key))remote.set(key,{message_id:`om_attachment_${++seq}`,chat_id:binding.chat_id});return remote.get(key);};
 const open=(options={})=>new FileOutbox(outRoot,binding,options.request??request,{now:()=>now,getRoute:async id=>{assert.equal(id,job.id);routeCalls++;return route();},notify:async(...args)=>notices.push(args),...options});
 const state=key=>JSON.parse(fs.readFileSync(path.join(outRoot,binding.bot,key,'request.json'),'utf8'));
 const write=(key,value)=>fs.writeFileSync(path.join(outRoot,binding.bot,key,'request.json'),JSON.stringify(value));
 return {root,binding,inboxRoot,outRoot,job,file,cover,enqueue,route,request,calls,remote,notices,open,state,write,advance:n=>now+=n,routeCalls:()=>routeCalls,now:()=>now};
}
const apiError=code=>Object.assign(Error('private server message'),{apiCode:code});

test('native file/image/audio/video replies keep source association, profile, cover and immutable bytes',async t=>{
 const f=fixture(t);f.job.event.thread_id='omt_existing';for(const mode of ['file','image','audio','video'])f.enqueue(mode);
 fs.writeFileSync(f.file,'edited after queue');await f.open().flush();assert.equal(f.calls.length,4);
 for(const {args,cwd} of f.calls){assert.equal(args[1],'+messages-reply');assert.equal(args[3],'om_source');assert.ok(args.includes('--reply-in-thread'));
  const flag=['--file','--image','--audio','--video'].find(flag=>args.includes(flag));assert.equal(fs.readFileSync(path.join(cwd,args[args.indexOf(flag)+1]),'utf8'),'immutable source bytes');}
 assert.ok(f.calls.find(c=>c.args.includes('--video')).args.includes('--video-cover'));
});

test('uncertain attachment send freezes route and stable UUID across restart; no duplicate final',async t=>{
 const f=fixture(t),item=f.enqueue();let once=true;
 await f.open({request:async(...args)=>{const result=await f.request(...args);if(once){once=false;throw Object.assign(Error('lost ack'),{code:'ETIMEDOUT'});}return result;}}).flush();
 assert.equal(f.state(item.key).status,'queued');f.advance(10000);f.job.event.thread_id='omt_later';await f.open().flush();
 assert.equal(f.state(item.key).status,'done');assert.deepEqual(f.calls[0].args,f.calls[1].args);assert.equal(f.routeCalls(),1);assert.equal(f.remote.size,1);
});

test('unknown delivery expires before UUID dedup window and emits one source-bound uncertainty notice',async t=>{
 const f=fixture(t),item=f.enqueue();let calls=0;
 const out=f.open({request:async()=>{calls++;throw Object.assign(Error('offline'),{code:'ECONNRESET'});}});await out.flush();
 f.advance(55*60*1000);await out.flush();assert.equal(f.state(item.key).status,'blocked');assert.equal(calls,1);
 await out.flush();await out.flush();assert.equal(f.notices.length,1);assert.equal(f.notices[0][2],f.job.id);assert.match(f.notices[0][0],/状态尚未确认/);
});

test('pre-upgrade jobs keep chat endpoint and UUID; old unknown legacy jobs are not resent after an hour',async t=>{
 const f=fixture(t),item=f.enqueue(),legacy=f.state(item.key);delete legacy.deliveryVersion;delete legacy.bindingScope;legacy.attempts=1;legacy.createdAt=f.now();f.write(item.key,legacy);
 await f.open({getRoute:async()=>{throw Error('legacy route must not change');}}).flush();
 assert.equal(f.calls[0].args[1],'+messages-send');assert.equal(f.calls[0].args[3],f.binding.chat_id);assert.equal(f.calls[0].args.at(-1),item.key.slice(0,32));
 const second={...legacy,createdAt:f.now()-60*60*1000};f.write(item.key,second);await f.open().flush();assert.equal(f.state(item.key).status,'blocked');assert.equal(f.calls.length,1);
});

test('definite first source deletion can fall back, but deletion after uncertain delivery cannot change endpoint',async t=>{
 const f=fixture(t),item=f.enqueue();let calls=0;
 await f.open({request:async(...args)=>{if(++calls===1)throw apiError(230011);return f.request(...args);}}).flush();
 assert.equal(f.state(item.key).status,'done');assert.equal(f.calls[0].args[1],'+messages-send');assert.equal(f.state(item.key).sendIntent.fallback,'source_unavailable');
 const g=fixture(t),other=g.enqueue();await g.open({request:async()=>{throw Object.assign(Error('lost'),{code:'ETIMEDOUT'});}}).flush();g.advance(10000);
 const args=[];await g.open({request:async(_b,a)=>{args.push(a);throw apiError(230011);}}).flush();assert.equal(args.length,1);assert.equal(args[0][1],'+messages-reply');assert.equal(g.state(other.key).sendIntent.uncertain,true);
});

test('unsupported topic degrades to quote while permission errors never become unquoted sends',async t=>{
 const f=fixture(t),item=f.enqueue();f.job.event.thread_id='omt_topic';let calls=0;
 await f.open({request:async(...args)=>{if(++calls===1)throw apiError(230071);return f.request(...args);}}).flush();
 assert.equal(f.state(item.key).status,'done');assert.equal(f.calls[0].args[1],'+messages-reply');assert.ok(!f.calls[0].args.includes('--reply-in-thread'));
 const g=fixture(t),other=g.enqueue();let denied=0;const out=g.open({request:async()=>{denied++;throw apiError(230050);}});await out.flush();await out.flush();await out.flush();
 assert.equal(denied,1);assert.equal(g.state(other.key).status,'blocked');assert.equal(g.notices.length,1);
});

test('route scope, binding and payload tampering are blocked before network',async t=>{
 const f=fixture(t),item=f.enqueue();await f.open({getRoute:async()=>({...f.route(),scope:'other'})}).flush();assert.equal(f.state(item.key).status,'blocked');assert.equal(f.calls.length,0);
 const g=fixture(t),other=g.enqueue();await g.open({request:async()=>{throw Object.assign(Error('lost'),{code:'ETIMEDOUT'});}}).flush();
 const source=path.join(g.outRoot,g.binding.bot,other.key,'payload','report.pdf');fs.writeFileSync(source,'tampered');g.advance(10000);await g.open().flush();
 assert.equal(g.state(other.key).status,'blocked');assert.equal(g.calls.length,0);
 const h=fixture(t),last=h.enqueue();h.binding.codex_thread_id='another_thread';await h.open().flush();assert.equal(h.state(last.key).status,'blocked');assert.equal(h.calls.length,0);
});

test('success receipt preceding outer completion checkpoint recovers without another send',async t=>{
 const f=fixture(t),item=f.enqueue();await f.open().flush();const state=f.state(item.key);state.status='queued';f.write(item.key,state);
 await f.open().flush();assert.equal(f.calls.length,1);assert.equal(f.state(item.key).status,'done');
});

test('enabling optional routing after a chat send has started does not change its endpoint or UUID',async t=>{
 const f=fixture(t),item=f.enqueue();let once=true;
 const request=async(...args)=>{const result=await f.request(...args);if(once){once=false;throw Object.assign(Error('lost'),{code:'ETIMEDOUT'});}return result;};
 await f.open({getRoute:undefined,request}).flush();f.advance(10000);
 await f.open().flush();assert.deepEqual(f.calls[0].args,f.calls[1].args);assert.equal(f.calls[1].args[1],'+messages-send');
 assert.equal(f.routeCalls(),0);assert.equal(f.remote.size,1);assert.equal(f.state(item.key).status,'done');
});
