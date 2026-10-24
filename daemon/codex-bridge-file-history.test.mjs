import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DurableInbox, digest } from './codex-bridge-inbox.mjs';
import { FileOutbox, enqueueFile } from './codex-bridge-files.mjs';
import { prepareReplyReport } from './codex-bridge-report.mjs';
import { bindingSnapshot } from './codex-bridge-ux.mjs';

function fixture(t,{report=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'file-history-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',profile:'fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_owner',bot_open_id:'ou_bot',
    group_access:'all_group_humans',codex_thread_id:'thread_fixture',cwd:root};
  const inboxRoot=path.join(root,'inbox'),outRoot=path.join(root,'files'),reportRoot=path.join(root,'reports');
  const inbox=new DurableInbox(inboxRoot,binding.bot,{}),now=Date.now()+3600000;
  const job=inbox.enqueue({type:'im.message.receive_v1',message_id:'om_source',message_type:'text',chat_type:'group',
    sender_type:'user',chat_id:binding.chat_id,sender_id:'ou_member',content:'request',bridge_binding:bindingSnapshot(binding)});
  Object.assign(job,{reply:'answer',replyKey:digest('final reply'),markerSeen:true,feedbackDisposition:'actionable',status:'done',completedAt:now-100,
    taskResultProtocolVersion:1,taskBusinessStatus:'waiting',replyCardsClosedAt:now-101,
    finalDeliveryEvidence:{schema:1,source:'send_response',at:now-101}});inbox.save(job);
  const file=path.join(root,'original.pdf');fs.writeFileSync(file,'original bytes');
  const items=report?prepareReplyReport({inboxRoot,fileOutboxRoot:outRoot,reportRoot,binding,jobId:job.id,replyKey:job.replyKey,text:job.reply,force:true}).artifacts
    :[enqueueFile({root:outRoot,inboxRoot,binding,jobId:job.id,file})];
  const requestFile=key=>path.join(outRoot,binding.bot,key,'request.json');
  const read=key=>JSON.parse(fs.readFileSync(requestFile(key),'utf8'));
  const write=(key,s)=>fs.writeFileSync(requestFile(key),JSON.stringify(s));
  for(const {key} of items){const s=read(key);Object.assign(s,{status:'blocked',blocked:true,retryAt:null,noticeSent:true,noticeRetry:{},
    attempts:2,error:'attachment_delivery_uncertain_expired'});
    s.sendIntent={schema:1,scope:s.bindingScope,uuid:key.slice(0,32),legacy:false,uncertain:true,uncertainSince:now-3600000,lastAttemptAt:now-3600000,
      payloadHash:digest(JSON.stringify([key,s.mode,s.name,s.hash,s.coverName??null,s.coverHash??null])),
      route:{version:1,scope:s.bindingScope,chatId:binding.chat_id,mode:'quote',messageId:job.id}};write(key,s);}
  let reads=0,sends=0,notices=0;
  const fresh=()=>{reads++;return JSON.parse(fs.readFileSync(path.join(inboxRoot,binding.bot,`job-${digest(job.id)}.json`),'utf8'));};
  const open=options=>new FileOutbox(outRoot,binding,async()=>{sends++;throw Error('unexpected send');},
    {now:()=>now,notify:async()=>{notices++;},resolveHistoricalSource:fresh,...options});
  return {root,binding,job,inbox,outRoot,items,file,now,read,write,requestFile,open,fresh,reads:()=>reads,sends:()=>sends,notices:()=>notices};
}
const counts=(pending=0,active=0,historical=1)=>({file_pending_count:pending,file_failed_count:active+historical,
  file_active_failed_count:active,file_historical_failed_count:historical});

test('two terminal report failures become historical diagnostics without sending, mutating, or claiming attachment delivery',async t=>{
  const f=fixture(t,{report:true}),before=f.items.map(({key})=>digest(fs.readFileSync(f.requestFile(key))));
  const out=f.open();assert.deepEqual(out.stats(),counts(0,0,2));assert.equal(f.reads(),2);
  await out.flush();assert.deepEqual(out.stats(),counts(0,0,2));
  assert.equal(f.sends(),0);assert.equal(f.notices(),0);
  assert.deepEqual(f.items.map(({key})=>digest(fs.readFileSync(f.requestFile(key)))),before);
  for(const {key} of f.items){assert.equal(f.read(key).status,'blocked');assert.equal(f.read(key).sendIntent.uncertain,true);assert.equal(f.read(key).completedAt,undefined);}
});

test('stats freshly invalidates completed source, binding, notification and final proof; business waiting is still a delivered final',t=>{
  const f=fixture(t),out=f.open(),{key}=f.items[0],state=f.read(key),job=structuredClone(f.job);
  assert.deepEqual(out.stats(),counts());
  for(const mutate of [j=>j.status='reply_pending',j=>j.markerSeen=false,j=>j.feedbackDisposition='silent',
    j=>j.completionDisposition='silent',j=>j.taskResultPending=true,j=>j.event.synthetic_callback=true,
    j=>j.event.chat_id='oc_other',j=>j.event.sender_type='app',j=>delete j.event.bridge_binding,
    j=>j.event.bridge_binding.codex_thread_id='thread_other',j=>delete j.finalDeliveryEvidence,
    j=>j.finalDeliveryEvidence.source='queued',j=>j.finalDeliveryEvidence.at=1.5,j=>j.finalDeliveryEvidence.at=j.completedAt+1]){
    const changed=structuredClone(job);mutate(changed);f.inbox.save(changed);assert.deepEqual(out.stats(),counts(0,1,0));
  }
  f.inbox.save(job);assert.deepEqual(out.stats(),counts());
  f.binding.codex_thread_id='other';assert.deepEqual(out.stats(),counts(0,1,0));f.binding.codex_thread_id='thread_fixture';
  const changed=structuredClone(state);changed.noticeRetry={error:'network_error',retryAt:f.now+1000};f.write(key,changed);
  assert.deepEqual(out.stats(),counts(0,1,0));f.write(key,state);assert.deepEqual(out.stats(),counts());
});

test('noticeSent alone, legacy schemas, invalid intent and tampering never suppress active failures',t=>{
  const f=fixture(t),out=f.open(),{key}=f.items[0],original=f.read(key);
  for(const mutate of [s=>s.blocked=false,s=>s.retryAt=0,s=>s.error='permission_denied',s=>s.noticeSent=false,
    s=>delete s.deliveryVersion,s=>delete s.bindingScope,s=>s.origin.chatId='oc_other',s=>s.key=digest('other'),
    s=>s.sendIntent.payloadHash=digest('other'),s=>s.sendIntent.scope=digest('other'),s=>s.sendIntent.sent=true,
    s=>s.sendIntent.uncertain=false,s=>s.sendIntent.uncertainSince=f.now-1000,s=>s.sendIntent.route.chatId='oc_other',
    s=>s.sendIntent.route.messageId='om_other',s=>s.jobId='om_other',s=>s.generatedReport=digest('other'),s=>s.status='unknown']){
    const changed=structuredClone(original);mutate(changed);f.write(key,changed);assert.deepEqual(out.stats(),counts(0,1,0));
  }
  f.write(key,original);fs.writeFileSync(path.join(f.outRoot,f.binding.bot,key,'payload',original.name),'tampered');
  assert.deepEqual(out.stats(),counts(0,1,0));assert.equal(fs.readFileSync(f.file,'utf8'),'original bytes');
});

test('missing, corrupt, throwing and asynchronous source evidence stays active; no default resolver exemption',t=>{
  const f=fixture(t);
  for(const resolveHistoricalSource of [undefined,()=>null,()=>{throw Error('unreadable');},()=>Promise.resolve(f.job),
    ()=>({...f.job,id:'om_other'})])assert.deepEqual(f.open({resolveHistoricalSource}).stats(),counts(0,1,0));
  const jobFile=path.join(f.inbox.dir,`job-${digest(f.job.id)}.json`);fs.writeFileSync(jobFile,'{broken');
  assert.deepEqual(f.open().stats(),counts(0,1,0));fs.rmSync(jobFile);assert.deepEqual(f.open().stats(),counts(0,1,0));
});

test('additional failed records and pending tasks remain active and unknown/corrupt manifests are retained',async t=>{
  const f=fixture(t),out=f.open();
  const pending=enqueueFile({root:f.outRoot,inboxRoot:path.join(f.root,'inbox'),binding:f.binding,jobId:f.job.id,file:f.file,mode:'image'});
  assert.deepEqual(out.stats(),counts(1,0,1));
  const blocked=f.read(pending.key);Object.assign(blocked,{status:'blocked',blocked:true,retryAt:null,error:'permission_denied',noticeSent:true});f.write(pending.key,blocked);
  assert.deepEqual(out.stats(),counts(0,1,1));
  const corrupt=f.requestFile(digest('corrupt')),missing=f.requestFile(digest('missing'));
  fs.mkdirSync(path.dirname(corrupt));fs.writeFileSync(corrupt,'{broken');fs.mkdirSync(path.dirname(missing));
  assert.deepEqual(out.stats(),counts(0,3,1));const before=fs.readFileSync(corrupt,'utf8');
  await out.flush();assert.equal(fs.readFileSync(corrupt,'utf8'),before);assert.equal(fs.existsSync(missing),false);
  assert.equal(f.sends(),0);assert.equal(f.notices(),0);
});

test('symlink manifests and payloads cannot become historical and flush leaves them untouched',async t=>{
  const f=fixture(t),{key}=f.items[0],manifest=f.requestFile(key),original=fs.readFileSync(manifest),external=path.join(f.root,'external.json');
  fs.writeFileSync(external,original);fs.rmSync(manifest);fs.symlinkSync(external,manifest);
  const out=f.open();assert.deepEqual(out.stats(),counts(0,1,0));await out.flush();assert.deepEqual(fs.readFileSync(external),original);
  fs.rmSync(manifest);fs.writeFileSync(manifest,original);
  const state=f.read(key),payload=path.join(path.dirname(manifest),'payload',state.name),outside=path.join(f.root,'outside.pdf');
  fs.writeFileSync(outside,fs.readFileSync(payload));fs.rmSync(payload);fs.symlinkSync(outside,payload);
  assert.deepEqual(out.stats(),counts(0,1,0));assert.equal(f.sends(),0);assert.equal(f.notices(),0);
});

test('digest cache avoids repeated payload IO but same-length rewrite with restored mtime invalidates via ctime',t=>{
  const f=fixture(t),out=f.open(),{key}=f.items[0],state=f.read(key),payload=path.join(path.dirname(f.requestFile(key)),'payload',state.name);
  const originalRead=fs.readFileSync;let payloadReads=0;
  fs.readFileSync=function(file,...args){if(typeof file==='number')payloadReads++;return originalRead.call(fs,file,...args);};
  t.after(()=>fs.readFileSync=originalRead);
  assert.deepEqual(out.stats(),counts());assert.deepEqual(out.stats(),counts());assert.deepEqual(out.stats(),counts());
  assert.equal(payloadReads,1);assert.equal(f.reads(),3);
  const before=fs.statSync(payload);fs.writeFileSync(payload,'changed! bytes');fs.utimesSync(payload,before.atime,before.mtime);
  assert.equal(fs.statSync(payload).size,before.size);assert.deepEqual(out.stats(),counts(0,1,0));assert.equal(payloadReads,2);
  assert.deepEqual(out.stats(),counts(0,1,0));assert.equal(payloadReads,2);
});

test('cached digest still checks current owner, permissions, link count and replacement on every stats call',t=>{
  const f=fixture(t),out=f.open(),{key}=f.items[0],state=f.read(key),payload=path.join(path.dirname(f.requestFile(key)),'payload',state.name);
  assert.deepEqual(out.stats(),counts());fs.chmodSync(payload,0o644);assert.deepEqual(out.stats(),counts(0,1,0));
  assert.equal(out.historicalPayloadDigests.size,0);fs.chmodSync(payload,0o600);assert.deepEqual(out.stats(),counts());
  const linked=path.join(f.root,'hardlink.pdf');fs.linkSync(payload,linked);assert.deepEqual(out.stats(),counts(0,1,0));
  fs.rmSync(linked);assert.deepEqual(out.stats(),counts());
  const originalStat=fs.fstatSync;
  fs.fstatSync=function(fd,options){const s=originalStat.call(fs,fd,options);return options?.bigint?Object.assign(Object.create(Object.getPrototypeOf(s)),s,{uid:s.uid+1n}):s;};
  try{assert.deepEqual(out.stats(),counts(0,1,0));}finally{fs.fstatSync=originalStat;}
  assert.deepEqual(out.stats(),counts());
  const original=fs.readFileSync(payload);fs.rmSync(payload);fs.writeFileSync(payload,original,{mode:0o600});assert.deepEqual(out.stats(),counts());
});

test('payload digest cache is bounded independently of the number of historical records',t=>{
  const f=fixture(t),out=f.open();for(let i=0;i<40;i++)out.historicalPayloadDigests.set(`old-${i}`,{signature:'old',digest:'old'});
  assert.deepEqual(out.stats(),counts());assert.equal(out.historicalPayloadDigests.size,32);
});

test('payload mutation during a digest read cannot populate or reuse a successful cache entry',t=>{
  const f=fixture(t),out=f.open(),{key}=f.items[0],state=f.read(key),payload=path.join(path.dirname(f.requestFile(key)),'payload',state.name);
  const originalRead=fs.readFileSync;
  fs.readFileSync=function(file,...args){const bytes=originalRead.call(fs,file,...args);if(typeof file==='number')fs.writeFileSync(payload,'changed! bytes');return bytes;};
  try{assert.deepEqual(out.stats(),counts(0,1,0));assert.equal(out.historicalPayloadDigests.size,0);}finally{fs.readFileSync=originalRead;}
  assert.deepEqual(out.stats(),counts(0,1,0));
});
