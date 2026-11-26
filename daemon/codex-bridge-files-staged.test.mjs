import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DurableInbox} from './codex-bridge-inbox.mjs';
import {FileOutbox,enqueueFile,enqueueImmutableAttachment,safeAttachmentName,attachmentFileType,attachmentFailureNotice} from './codex-bridge-files.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {selectReplyRoute} from './codex-bridge-reply-routing.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'file-staged-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',profile:'selected',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',codex_thread_id:'thread_fixture',cwd:root};
  const inboxRoot=path.join(root,'inbox'),outRoot=path.join(root,'outbox');let now=Date.now();
  const job=new DurableInbox(inboxRoot,binding.bot,{}).enqueue({message_id:'om_source',message_type:'text',content:'fixture',chat_id:binding.chat_id,sender_id:binding.allowed_sender_id,bridge_binding:bindingSnapshot(binding)});
  const file=path.join(root,'运营说明.xlsx'),cover=path.join(root,'cover.png');fs.writeFileSync(file,'private fixture bytes');fs.writeFileSync(cover,'image fixture');
  const calls=[],remote=new Map(),notices=[];let uploads=0;
  const request=async(b,args,cwd)=>{
    assert.equal(b.profile,'selected');calls.push({args,cwd});
    if(args[0]==='im')return args[1]==='images'?{image_key:`img_fixture_${++uploads}`}:{file_key:`file_fixture_${++uploads}`};
    const body=JSON.parse(args[args.indexOf('--data')+1]);
    if(!remote.has(body.uuid))remote.set(body.uuid,{message_id:`om_fixture_${remote.size+1}`,chat_id:b.chat_id});return remote.get(body.uuid);
  };
  const enqueue=(options={})=>enqueueFile({root:outRoot,inboxRoot,binding,jobId:job.id,file,cover,deliveryVersion:3,...options});
  const open=(options={})=>new FileOutbox(outRoot,binding,options.request??request,{now:()=>now,getRoute:async()=>selectReplyRoute(binding,[job]),notify:async(...args)=>notices.push(args),...options});
  const state=key=>JSON.parse(fs.readFileSync(path.join(outRoot,binding.bot,key,'request.json'),'utf8'));
  const write=(key,value)=>fs.writeFileSync(path.join(outRoot,binding.bot,key,'request.json'),JSON.stringify(value));
  return {root,binding,job,file,cover,inboxRoot,outRoot,calls,remote,notices,request,enqueue,open,state,write,advance:n=>now+=n};
}
const transient=()=>Object.assign(Error('sensitive private detail'),{code:'ETIMEDOUT'});
const apiError=code=>Object.assign(Error('sensitive private detail'),{apiCode:code});

test('native upload checkpoints keep office/unknown extensions as stream and send source-bound exact resource JSON',async t=>{
  const f=fixture(t),item=f.enqueue();await f.open().flush();
  assert.equal(f.state(item.key).status,'done');assert.equal(f.calls.length,2);
  const upload=f.calls[0];assert.deepEqual(upload.args.slice(0,3),['im','files','create']);
  assert.deepEqual(JSON.parse(upload.args[4]),{file_type:'stream',file_name:'运营说明.xlsx'});
  assert.equal(upload.args[6],'file=./运营说明.xlsx');
  assert.equal(f.calls[1].args[2],'/open-apis/im/v1/messages/om_source/reply');
  const body=JSON.parse(f.calls[1].args.at(-1));assert.equal(body.msg_type,'file');assert.deepEqual(JSON.parse(body.content),{file_key:'file_fixture_1'});
  assert.equal(f.state(item.key).transfer.stage,'sent');assert.equal(body.uuid,item.key.slice(0,32));
});

test('lost upload ACK does not start message uncertainty; retry can upload and then send once',async t=>{
  const f=fixture(t),item=f.enqueue();let once=true;
  await f.open({request:async(...args)=>{const result=await f.request(...args);if(once){once=false;throw transient();}return result;}}).flush();
  assert.equal(f.state(item.key).sendIntent,undefined);assert.equal(f.state(item.key).transfer.stage,'upload');assert.equal(f.remote.size,0);
  f.advance(60*60*1000);await f.open().flush();assert.equal(f.state(item.key).status,'done');assert.equal(f.remote.size,1);
  assert.equal(f.calls.filter(c=>c.args[0]==='im').length,2);
});

test('lost message ACK retries exact JSON on the frozen endpoint without reupload across restart',async t=>{
  const f=fixture(t),item=f.enqueue();let once=true;
  await f.open({request:async(...args)=>{const result=await f.request(...args);if(args[1][0]==='api'&&once){once=false;throw transient();}return result;}}).flush();
  assert.equal(f.state(item.key).sendIntent.uncertain,true);f.advance(10000);f.job.event.thread_id='omt_later';await f.open().flush();
  assert.equal(f.state(item.key).status,'done');assert.equal(f.calls.length,3);assert.deepEqual(f.calls[1],f.calls[2]);assert.equal(f.remote.size,1);
});

test('uncertain message expires before dedup window and never changes endpoint or resource keys',async t=>{
  const f=fixture(t),item=f.enqueue();const out=f.open({request:async(...args)=>{if(args[1][0]==='api')throw transient();return f.request(...args);}});
  await out.flush();f.advance(55*60*1000);await out.flush();await out.flush();
  assert.equal(f.state(item.key).status,'blocked');assert.equal(f.state(item.key).sendIntent.uncertain,true);
  assert.equal(f.calls.length,1);assert.equal(f.notices.length,1);assert.match(f.notices[0][0],/状态尚未确认/);assert.equal(f.notices[0][2],f.job.id);
});

test('explicit first source rejection falls back with same keys; a later rejection after lost ACK does not',async t=>{
  const f=fixture(t),item=f.enqueue();let fail=true;
  await f.open({request:async(...args)=>{if(args[1][0]==='api'&&fail){fail=false;throw apiError(230011);}return f.request(...args);}}).flush();
  assert.equal(f.state(item.key).status,'done');assert.equal(f.state(item.key).sendIntent.fallback,'source_unavailable');
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].args[2],'/open-apis/im/v1/messages');
  const g=fixture(t),other=g.enqueue();await g.open({request:async(...args)=>{if(args[1][0]==='api')throw transient();return g.request(...args);}}).flush();g.advance(10000);
  await g.open({request:async()=>{throw apiError(230011);}}).flush();
  assert.equal(g.state(other.key).sendIntent.route.mode,'quote');assert.equal(g.state(other.key).sendIntent.uncertain,true);
});

test('video resumes a successful primary upload when cover upload fails',async t=>{
  const f=fixture(t),item=f.enqueue({mode:'video',name:'clip.mp4'});let once=true;
  await f.open({request:async(...args)=>{if(args[1][1]==='images'&&once){once=false;throw transient();}return f.request(...args);}}).flush();
  assert.ok(f.state(item.key).transfer.primary);assert.equal(f.state(item.key).sendIntent,undefined);
  f.advance(10000);await f.open().flush();assert.equal(f.state(item.key).status,'done');assert.equal(f.calls.filter(c=>c.args[1]==='files').length,1);
  const body=JSON.parse(f.calls.at(-1).args.at(-1));assert.equal(body.msg_type,'media');assert.deepEqual(JSON.parse(body.content),{file_key:'file_fixture_1',image_key:'img_fixture_2'});
});

test('image and Opus voice use their own resource fields and message types',async t=>{
  const f=fixture(t);const image=f.enqueue({mode:'image',name:'photo.png'});await f.open().flush();
  assert.equal(f.state(image.key).status,'done');assert.deepEqual(f.calls[0].args.slice(0,3),['im','images','create']);
  assert.equal(f.calls[0].args[6],'image=./photo.png');
  let body=JSON.parse(f.calls.at(-1).args.at(-1));assert.equal(body.msg_type,'image');assert.deepEqual(JSON.parse(body.content),{image_key:'img_fixture_1'});
  fs.writeFileSync(f.file,Buffer.from('OggS OpusHead voice fixture'));const audio=f.enqueue({mode:'audio',name:'voice.ogg'});await f.open().flush();
  assert.equal(f.state(audio.key).status,'done');assert.equal(JSON.parse(f.calls.at(-2).args[4]).file_type,'opus');
  body=JSON.parse(f.calls.at(-1).args.at(-1));assert.equal(body.msg_type,'audio');assert.deepEqual(JSON.parse(body.content),{file_key:'file_fixture_2'});
});

test('invalid upload ACK never unlocks a message; invalid message ACK retains exact payload for reconciliation',async t=>{
  const f=fixture(t),item=f.enqueue();await f.open({request:async()=>({file_key:{secret:'unexpected object'}})}).flush();
  assert.equal(f.state(item.key).sendIntent,undefined);assert.equal(f.state(item.key).error,'attachment_upload_ack_invalid');
  const g=fixture(t),other=g.enqueue();await g.open({request:async(...args)=>args[1][0]==='api'?{}:g.request(...args)}).flush();
  assert.equal(g.state(other.key).sendIntent.uncertain,true);assert.equal(g.state(other.key).error,'attachment_ack_invalid');
  g.advance(10000);await g.open().flush();assert.equal(g.state(other.key).status,'done');assert.equal(g.calls.filter(c=>c.args[0]==='im').length,1);
});

test('checkpoint recovery after acknowledged send never repeats upload or message',async t=>{
  const f=fixture(t),item=f.enqueue();await f.open().flush();const saved=f.state(item.key);saved.status='queued';f.write(item.key,saved);
  await f.open().flush();assert.equal(f.calls.length,2);assert.equal(f.state(item.key).status,'done');
});

test('upload checkpoint or snapshot tampering blocks all subsequent network IO',async t=>{
  const f=fixture(t),item=f.enqueue();await f.open({request:async(...args)=>{if(args[1][0]==='api')throw transient();return f.request(...args);}}).flush();
  const saved=f.state(item.key);saved.transfer.primary.hash='bad';f.write(item.key,saved);f.advance(10000);
  await f.open().flush();assert.equal(f.calls.length,1);assert.equal(f.state(item.key).status,'blocked');
  const g=fixture(t),other=g.enqueue();fs.writeFileSync(path.join(g.outRoot,g.binding.bot,other.key,'payload','运营说明.xlsx'),'tampered');
  await g.open().flush();assert.equal(g.calls.length,0);assert.equal(g.state(other.key).status,'blocked');
});

test('permission rejection is an upload failure with safe source-bound diagnosis, never a blind message retry',async t=>{
  const f=fixture(t),item=f.enqueue(),out=f.open({request:async()=>{throw apiError(99991672);}});await out.flush();await out.flush();
  assert.equal(f.state(item.key).status,'blocked');assert.equal(f.state(item.key).sendIntent,undefined);assert.equal(f.notices.length,1);
  assert.match(f.notices[0][0],/附件上传未完成/);assert.match(f.notices[0][0],/机器人/);assert.doesNotMatch(f.notices[0][0],/sensitive|fixture|\/tmp/);
});

test('documented format/resolution upload errors block with a useful file fallback; temporary stop retries',async t=>{
  for(const code of [234011,234039]) {
    const f=fixture(t),item=f.enqueue({mode:'image'});let attempts=0;const out=f.open({request:async()=>{attempts++;throw apiError(code);}});
    await out.flush();f.advance(10000);await out.flush();assert.equal(attempts,1);assert.equal(f.state(item.key).status,'blocked');assert.match(f.notices[0][0],/普通文件/);
  }
  const f=fixture(t),item=f.enqueue();await f.open({request:async()=>{throw apiError(232096);}}).flush();
  assert.equal(f.state(item.key).status,'queued');assert.ok(f.state(item.key).retryAt);assert.equal(f.state(item.key).sendIntent,undefined);
});

test('filenames preserve extension within byte budget and avoid platform/path hazards',()=>{
  assert.equal(safeAttachmentName('CON.pdf'),'_CON.pdf');assert.equal(safeAttachmentName('offer:2026?.pdf. '),'offer_2026_.pdf');
  const name=safeAttachmentName('路线'.repeat(100)+'.xlsx');assert.ok(Buffer.byteLength(name)<=180);assert.ok(name.endsWith('.xlsx'));
  assert.equal(safeAttachmentName('..'),'attachment');assert.equal(safeAttachmentName('dir/report.pdf'),'report.pdf');
  for(const ext of ['docx','xlsx','pptx','html','md','zip','bin'])assert.equal(attachmentFileType(`a.${ext}`),'stream');
});

test('voice format errors explain original-file fallback and never silently transcode',()=>{
  assert.throws(()=>attachmentFileType('a.mp3','audio'),{code:'attachment_audio_requires_opus'});
  assert.throws(()=>attachmentFileType('a.ogg','audio',Buffer.from('OggS vorbis')),{code:'attachment_audio_requires_opus'});
  assert.equal(attachmentFileType('a.opus','audio',Buffer.from('OggS OpusHead fixture')),'opus');
  assert.match(attachmentFailureNotice({deliveryVersion:3,error:'attachment_audio_requires_opus'}),/作为文件/);
});

test('existing file/image size limits and allowed-root checks remain enforced before queueing',t=>{
  const f=fixture(t),large=path.join(f.root,'large.bin');fs.writeFileSync(large,'x');fs.truncateSync(large,30*1024*1024+1);
  assert.throws(()=>f.enqueue({file:large}),{code:'attachment_size_invalid'});fs.truncateSync(large,10*1024*1024+1);
  assert.throws(()=>f.enqueue({file:large,mode:'image'}),{code:'attachment_size_invalid'});
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'file-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  const original=path.join(outside,'private.bin');fs.writeFileSync(original,'private');const linked=path.join(f.root,'linked.bin');fs.symlinkSync(original,linked);
  assert.throws(()=>f.enqueue({file:linked}),{code:'attachment_outside_allowed_roots'});
});

test('worker immutable byte API repeats binding/type/limit/name checks and converges on the same v3 request',async t=>{
  const f=fixture(t),options={root:f.outRoot,inboxRoot:f.inboxRoot,binding:f.binding,jobId:f.job.id,name:'运营说明.xlsx',bytes:fs.readFileSync(f.file)};
  const item=enqueueImmutableAttachment(options);assert.equal(item.key,f.enqueue().key);assert.equal(enqueueImmutableAttachment(options).key,item.key);
  for(const patch of [{bytes:new Uint8Array([1])},{bytes:Buffer.alloc(0)},{name:'../private.pdf'},{name:'CON.pdf'},{mode:'audio',name:'a.mp3'},{mode:'video',name:'a.mp4'},{mode:'other'}])
    assert.throws(()=>enqueueImmutableAttachment({...options,...patch}));
  assert.throws(()=>enqueueImmutableAttachment({...options,binding:{...f.binding,chat_id:'oc_other'}}),{code:'attachment_binding_mismatch'});
  await f.open().flush();assert.equal(f.state(item.key).status,'done');assert.deepEqual(f.state(item.key).sendIntent.result,{message_id:'om_fixture_1',chat_id:'oc_fixture'});
});

test('malicious routes and synthetic message ACKs cannot become successful delivery proof',async t=>{
  for(const patch of [{scope:'other'},{chatId:'oc_other'},{mode:'quote',messageId:'om_cb_forged'},{mode:'quote',messageId:'../../other'}]) {
    const f=fixture(t),item=f.enqueue();await f.open({getRoute:async()=>({...selectReplyRoute(f.binding,[f.job]),...patch})}).flush();
    assert.equal(f.state(item.key).status,'blocked');assert.equal(f.calls.length,0);
  }
  const f=fixture(t),item=f.enqueue();await f.open({request:async(...args)=>args[1][0]==='api'?{message_id:'om_cb_forged',chat_id:f.binding.chat_id}:f.request(...args)}).flush();
  assert.equal(f.state(item.key).status,'queued');assert.equal(f.state(item.key).sendIntent.uncertain,true);assert.equal(f.state(item.key).sendIntent.sent,undefined);
});
