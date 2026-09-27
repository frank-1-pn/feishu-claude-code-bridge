import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DurableInbox, digest } from './codex-bridge-inbox.mjs';
import { DurableOutbound, splitText } from './codex-bridge-outbound.mjs';
import { FileOutbox, enqueueFile } from './codex-bridge-files.mjs';
import { createLarkTransport, capture } from './codex-bridge-lark.mjs';
import { retryDelay, recordFailure } from './codex-bridge-retry.mjs';
import { launchAppend } from './start-lark-append.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-deep-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',profile:'fixture-profile',cwd:root,cardkit_enabled:false};
  return {root,binding};
}
const evt=id=>({message_id:`om_${id}`,message_type:'text',content:'hello',chat_id:'oc_fixture',sender_id:'ou_fixture'});
const marker=id=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`[飞书消息｜fixture｜om_${id}]`} ]}});
const message=(phase,text)=>({type:'response_item',payload:{type:'message',role:'assistant',phase,content:[{type:'output_text',text}]}});

test('100-message burst including repeated arrivals survives restart in exact order',async t=>{
  const {root}=fixture(t), rollout=path.join(root,'rollout');fs.writeFileSync(rollout,'');
  let now=1000, fail=true;const injected=[];
  const io={prepare:async e=>{if(fail){fail=false;throw Error('temporary network');}return e;},target:async()=>({rollout}),inject:async j=>injected.push(j.id)};
  let q=new DurableInbox(root,'fixture',io,{now:()=>now});
  for(let i=0;i<100;i++){q.enqueue(evt(i));q.enqueue(evt(i));}
  await q.dispatchOne();await q.dispatchOne();assert.equal(injected.length,0);
  now=10000;q=new DurableInbox(root,'fixture',io,{now:()=>now});
  for(let i=0;i<100;i++)await q.dispatchOne();
  assert.deepEqual(injected,Array.from({length:100},(_,i)=>`om_${i}`));
});

test('per-bot dispatch isolation and concurrent caller cannot double inject',async t=>{
  const {root}=fixture(t), rollout=path.join(root,'rollout');fs.writeFileSync(rollout,'');
  let release;const gate=new Promise(r=>release=r), seen=[];
  const a=new DurableInbox(root,'a',{prepare:async e=>{await gate;return e;},target:async()=>({rollout}),inject:async()=>seen.push('a')});
  const b=new DurableInbox(root,'b',{prepare:async e=>e,target:async()=>({rollout}),inject:async()=>seen.push('b')});
  a.enqueue(evt('a'));b.enqueue(evt('b'));const p=a.dispatchOne();await a.dispatchOne();await b.dispatchOne();assert.deepEqual(seen,['b']);release();await p;assert.deepEqual(seen,['b','a']);
});

test('same-turn reply failures share one persisted backoff across all burst jobs',async t=>{
  const {root}=fixture(t),rollout=path.join(root,'rollout');fs.writeFileSync(rollout,'');let calls=0,now=1000;
  const io={prepare:async e=>e,target:async()=>({rollout}),inject:async()=>{},send:async()=>{calls++;throw Error('offline');}};
  let q=new DurableInbox(root,'fixture',io,{now:()=>now});
  for(let i=0;i<5;i++){q.enqueue(evt(i));await q.dispatchOne();}
  fs.appendFileSync(rollout,[...Array.from({length:5},(_,i)=>marker(i)),message('final','answer')].map(i=>JSON.stringify(i)+'\n').join(''));
  await q.watch();await q.deliverReplies();assert.equal(calls,1);
  q=new DurableInbox(root,'fixture',io,{now:()=>now});await q.deliverReplies();assert.equal(calls,1);now=10000;await q.deliverReplies();assert.equal(calls,2);
});

test('chunk checkpoints resume unsent suffix only and preserve unicode',async t=>{
  const {root,binding}=fixture(t), calls=[];let fail=true;
  const request=async(_,args)=>{const key=args.at(-1);calls.push(key);if(calls.length===2 && fail){fail=false;throw Error('offline');}return{};};
  const text='汉字😀'.repeat(7000);assert.equal(splitText(text).join(''),text);assert.ok(splitText(text).every(s=>Buffer.byteLength(s)<=12000));
  let out=new DurableOutbound(root,binding,request);await assert.rejects(out.text(text,'key'));
  out=new DurableOutbound(root,binding,request);await out.text(text,'key');
  assert.equal(calls.filter(k=>k===calls[0]).length,1);assert.equal(calls[1],calls[2]);
  const before=calls.length;await out.text(text,'key');assert.equal(calls.length,before);
});

test('cards coalesce, survive restart, finalize once and reject late progress',async t=>{
  const {root,binding}=fixture(t), calls=[];let now=1000;
  const request=async(_,args)=>{calls.push(args);return {message_id:'om_card'};};
  let out=new DurableOutbound(root,binding,request,{now:()=>now});
  out.progress('first','turn');out.progress('second','turn');await out.flushCards();assert.equal(calls.length,1);
  assert.match(calls[0].at(-1),/second/);out.progress('latest','turn');await out.flushCards();assert.equal(calls.length,1);
  now+=11000;out=new DurableOutbound(root,binding,request,{now:()=>now});await out.flushCards();assert.equal(calls[1][1],'PATCH');
  await out.final('最终答案','reply',['turn']);const n=calls.length;out.progress('late','turn');await out.flushCards();await out.final('最终答案','reply',['turn']);assert.equal(calls.length,n);
});

test('permission error falls back to final text; long final never silently truncates',async t=>{
  const {root,binding}=fixture(t), text=[];
  const request=async(_,args)=>{if(args[0]==='api')throw Object.assign(Error('permission'),{type:'permission'});text.push(args[args.indexOf('--text')+1]);return{};};
  const out=new DurableOutbound(root,binding,request);out.progress('progress','turn');await out.flushCards();await out.final('final','reply',['turn']);assert.deepEqual(text,['final']);
  const long='内容😀'.repeat(20000);await out.final(long,'long',['large']);assert.equal(text.slice(1).join(''),long);
});

test('CardKit resumes uncertain sequence before newer progress and closes before late updates',async t=>{
  const {root,binding}=fixture(t);binding.cardkit_enabled=true;let now=1000,fail=false;const calls=[];
  const request=async(_,args)=>{
    calls.push(args);if(args[1]==='POST')return args[2].includes('cardkit')?{card_id:'123456'}:{message_id:'om_stream'};
    if(fail){fail=false;throw Error('timeout after server accepted');}return{};
  };
  let out=new DurableOutbound(root,binding,request,{now:()=>now});out.progress('first','run');await out.flushCards();
  assert.equal(calls.length,3);assert.equal(JSON.parse(calls[2].at(-1)).sequence,1);
  now=12000;out.progress('second','run');fail=true;await out.flushCards();const failed=calls.at(-1);
  out=new DurableOutbound(root,binding,request,{now:()=>now});out.progress('third','run');now=25000;await out.flushCards();
  assert.deepEqual(calls.at(-2),failed);assert.equal(JSON.parse(calls.at(-1).at(-1)).sequence,3);
  await out.final('final','reply',['run']);const close=JSON.parse(calls.at(-1).at(-1));assert.equal(close.sequence,4);assert.equal(JSON.parse(close.card.data).config.streaming_mode,false);
  const n=calls.length;out.progress('late','run');await out.flushCards();await out.final('final','reply',['run']);assert.equal(calls.length,n);
});

test('CardKit missing scope falls back once to standard cards and records capability result',async t=>{
  const {root,binding}=fixture(t);binding.cardkit_enabled=true;let creates=0;
  const request=async(_,args)=>{if(args[2]?.includes('cardkit')){creates++;throw Object.assign(Error('scope'),{apiCode:99991672});}return {message_id:'om_fallback'};};
  const out=new DurableOutbound(root,binding,request,{now:()=>1000});out.progress('one','run');await out.flushCards();await out.final('done','reply',['run']);
  assert.equal(creates,1);const s=out.read(out.file('card','run'));assert.equal(s.cardkitDisabled,true);assert.equal(s.finalDelivered,true);
});

test('CardKit sequence conflict stops retries and preserves a full text final',async t=>{
  const {root,binding}=fixture(t);binding.cardkit_enabled=true;const text=[];let updates=0;
  const request=async(_,args)=>{
    if(args[0]!=='api'){text.push(args[args.indexOf('--text')+1]);return{};}
    if(args[1]==='POST')return args[2].includes('cardkit')?{card_id:'123456'}:{message_id:'om_stream'};
    updates++;throw Object.assign(Error('conflict'),{apiCode:300317});
  };
  const out=new DurableOutbound(root,binding,request);out.progress('one','run');await out.flushCards();await out.flushCards();
  assert.equal(updates,1);assert.equal(out.read(out.file('card','run')).blocked,true);
  await out.final('完整最终结果','reply',['run']);assert.deepEqual(text,['完整最终结果']);assert.equal(updates,1);
});

test('rollout forwards public commentary, never reasoning, and final wins after restart',async t=>{
  const {root,binding}=fixture(t), rollout=path.join(root,'rollout');fs.writeFileSync(rollout,'');const sent=[];
  const out=new DurableOutbound(root,binding,async(_,a)=>{sent.push(a);return{message_id:'om_card'};});
  const io={prepare:async e=>e,target:async()=>({rollout}),inject:async()=>{},progress:(t,k)=>out.progress(t,k),final:(t,k,s)=>out.final(t,k,s)};
  let q=new DurableInbox(root,'fixture',io);q.enqueue(evt('one'));q.enqueue(evt('two'));await q.dispatchOne();await q.dispatchOne();
  const lines=[{type:'turn_context',payload:{turn_id:'shared-turn'}},marker('one'),marker('two'),message('analysis','PRIVATE REASONING'),message('commentary','公开进度'),message('final','最终结果')];
  fs.appendFileSync(rollout,lines.map(l=>JSON.stringify(l)+'\n').join(''));await q.watch();q=new DurableInbox(root,'fixture',io);await q.deliverReplies();
  assert.equal(sent.length,1);assert.ok(!JSON.stringify(sent).includes('PRIVATE REASONING'));assert.equal(q.stats().completed_count,2);
});

test('files snapshot common types, isolate recipients, dedupe and recover transient send',async t=>{
  const {root,binding}=fixture(t);const inboxRoot=path.join(root,'inbox'),outRoot=path.join(root,'out');
  const q=new DurableInbox(inboxRoot,'fixture',{});q.enqueue(evt('file'));const args=[], now=()=>1000000;let fail=true;
  for(const ext of ['pdf','docx','xlsx','pptx','zip','txt','html','mp4','mp3','png']){
    const file=path.join(root,`中文.${ext}`);fs.writeFileSync(file,`fixture-${ext}`);
    enqueueFile({root:outRoot,inboxRoot,binding,jobId:'om_file',file});enqueueFile({root:outRoot,inboxRoot,binding,jobId:'om_file',file});fs.writeFileSync(file,'changed later');
  }
  const request=async(b,a,cwd)=>{assert.equal(b.chat_id,'oc_fixture');assert.equal(fs.readFileSync(path.join(cwd,a[a.indexOf('--file')+1]),'utf8').startsWith('fixture-'),true);args.push(a);if(fail){fail=false;throw Error('network');}return{};};
  let out=new FileOutbox(outRoot,binding,request,{now:()=>1000});await out.flush();assert.equal(out.stats().file_pending_count,1);
  out=new FileOutbox(outRoot,binding,request,{now});await out.flush();assert.equal(out.stats().file_pending_count,0);assert.equal(args.length,11);
  assert.equal(args[0].at(-1),args.at(-1).at(-1));
  const file=path.join(root,'outside.txt');fs.writeFileSync(file,'x');
  assert.throws(()=>enqueueFile({root:outRoot,inboxRoot,binding:{...binding,chat_id:'oc_other'},jobId:'om_file',file}),/binding_mismatch/);
  const narrow=path.join(root,'allowed');fs.mkdirSync(narrow);
  assert.throws(()=>enqueueFile({root:outRoot,inboxRoot,binding:{...binding,cwd:narrow},jobId:'om_file',file}),/outside_allowed_roots/);
});

test('file size checks fail before network; unchanged partial snapshot is recoverable',t=>{
  const {root,binding}=fixture(t);const inboxRoot=path.join(root,'inbox'),outRoot=path.join(root,'out');new DurableInbox(inboxRoot,'fixture',{}).enqueue(evt('file'));
  const file=path.join(root,'large.zip');fs.writeFileSync(file,'');fs.truncateSync(file,31*1024*1024);
  assert.throws(()=>enqueueFile({root:outRoot,inboxRoot,binding,jobId:'om_file',file}),/size_invalid/);
  fs.writeFileSync(file,'small');const opts={root:outRoot,inboxRoot,binding,jobId:'om_file',file};const first=enqueueFile(opts);
  fs.unlinkSync(path.join(outRoot,'fixture',first.key,'request.json'));assert.equal(enqueueFile(opts).key,first.key);
});

test('native image/audio/video modes keep cover and permission failures observable',async t=>{
  const {root,binding}=fixture(t),inboxRoot=path.join(root,'inbox'),outRoot=path.join(root,'out');new DurableInbox(inboxRoot,'fixture',{}).enqueue(evt('file'));
  const file=path.join(root,'media.bin'),cover=path.join(root,'cover.png');fs.writeFileSync(file,'media');fs.writeFileSync(cover,'cover');
  for(const mode of ['image','audio','video'])enqueueFile({root:outRoot,inboxRoot,binding,jobId:'om_file',file,mode,cover});
  const args=[],notices=[];
  const out=new FileOutbox(outRoot,binding,async(_,a)=>{args.push(a);if(a.includes('--audio'))throw Object.assign(Error('forbidden'),{type:'permission'});return{};},{notify:async(t,k)=>notices.push(k)});
  await out.flush();await out.flush();await out.flush();assert.equal(args.length,3);assert.equal(notices.length,1);assert.equal(out.stats().file_failed_count,1);
  assert.ok(args.find(a=>a.includes('--video')).includes('--video-cover'));
});

test('inbound cached file tampering is rejected before model dispatch',async t=>{
  const {root,binding}=fixture(t);const {prepareInbound}=await import('./codex-bridge-media.mjs');let local;
  const options={downloadRoot:root,writeText:fs.writeFileSync,download:async(_,args,dir)=>{local=path.join(dir,'r.txt');fs.writeFileSync(local,'original');return{saved_path:local};}};
  const e={...evt('file'),message_type:'file',content:JSON.stringify({file_key:'file_v3_fixture',file_name:'test.txt'})};
  await prepareInbound(binding,e,options);fs.writeFileSync(local,'changed');await assert.rejects(prepareInbound(binding,e,options),/cache_changed/);
});

test('CLI transport uses stdin, fixed profile, bot identity and classifies structured failures',async()=>{
  const observed=[];const lark=createLarkTransport('fake',{run:async(f,args,opts)=>{observed.push({args,opts});return{code:0,stdout:JSON.stringify({ok:true,data:{code:0,data:{message_id:'om_x'}}})};}});
  const body=JSON.stringify({text:'中文\n'.repeat(20000)});assert.equal((await lark({profile:'p'},['api','PATCH','/test','--data',body])).message_id,'om_x');
  assert.equal(observed[0].opts.input,body);assert.equal(observed[0].args.at(-1),'bot');assert.equal(observed[0].args[1],'p');assert.equal(observed[0].opts.env.LARK_CLI_NO_PROXY,'1');
  const bad=createLarkTransport('fake',{run:async()=>({code:1,stdout:JSON.stringify({ok:false,error:{type:'permission',code:99991672}})})});
  const s={};await bad({},[]).catch(e=>recordFailure(s,e,1000));assert.equal(s.blocked,true);
  assert.equal(retryDelay(100,0,()=>0.5),300000);assert.equal(retryDelay(1,60000,()=>0.5),60000);
});

test('actual child capture decodes split UTF-8 and drains stdout before close',async()=>{
  const code="const b=Buffer.from('中文😀');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),20)";
  const result=await capture(process.execPath,['-e',code]);assert.equal(result.stdout,'中文😀');
});

test('installed CLI accepts card patch JSON through stdin in dry-run mode',{skip:process.platform!=='win32'},async()=>{
  const exe=path.join(process.env.APPDATA,'npm','node_modules','@larksuite','cli','bin','lark-cli.exe');
  const result=await capture(exe,['api','PATCH','/open-apis/im/v1/messages/om_fixture','--data','-','--as','bot','--dry-run'],
    {input:JSON.stringify({content:JSON.stringify({config:{update_multi:true},elements:[{tag:'div',text:{tag:'plain_text',content:'fixture'}}]})}),env:{...process.env,LARK_CLI_NO_PROXY:'1'}});
  assert.equal(result.code,0);assert.match(result.stdout,/Dry Run/i);assert.match(result.stdout,/PATCH/);assert.match(result.stdout,/update_multi/);
});

test('actual subscriber launch appends across restarts without losing unread bytes',async t=>{
  const {root}=fixture(t),log=path.join(root,'events'),errorLog=path.join(root,'errors'),pidFile=path.join(root,'pid');fs.writeFileSync(log,'{"old":1}\n');
  for(let i=0;i<2;i++){
    await launchAppend({executable:process.execPath,args:['-e',`process.stdout.write('{"new":${i}}\\n')`],log,errorLog,pidFile});
    const target=i===0?'"new":0':'"new":1';
    for(let j=0;j<100 && !fs.readFileSync(log,'utf8').includes(target);j++)await new Promise(r=>setTimeout(r,20));
    assert.ok(fs.readFileSync(log,'utf8').includes(target));
  }
  assert.equal(fs.readFileSync(log,'utf8'),'{"old":1}\n{"new":0}\n{"new":1}\n');
});

test('subscriber health uses exact profile and ignores quiet chats and handler errors',{skip:process.platform!=='win32'},t=>{
  const {root}=fixture(t), log=path.join(root,'err');fs.writeFileSync(log,'handle message failed\n');
  const script=path.join(root,'probe.ps1');
  fs.writeFileSync(script,`. '${path.resolve('daemon/subscriber-health.ps1').replaceAll("'","''")}'\n$p=@{Name='lark-cli.exe';CommandLine='lark-cli event +subscribe --profile coding-other'}\nif(Test-LarkSubscriber $p 'coding'){exit 11}\nif((Get-LarkSocketSignal '${log}') -ne 'unknown'){exit 12}\n[IO.File]::AppendAllText('${log}',"reconnect exhausted after 7 attempts\n")\nif((Get-LarkSocketSignal '${log}') -ne 'reconnect_exhausted'){exit 13}\n[IO.File]::AppendAllText('${log}',"bridge-subscriber-start\n")\nif((Get-LarkSocketSignal '${log}') -ne 'connected_or_starting'){exit 14}\n`);
  execFileSync('powershell.exe',['-NoProfile','-File',script],{timeout:10000});
});
