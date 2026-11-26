import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {enqueueAgentRequest,enqueueAgentAttachment,AgentRequestDispatcher} from './codex-bridge-agent-requests.mjs';
import {DurableInbox,digest} from './codex-bridge-inbox.mjs';import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';import {readDisposition} from './codex-bridge-completion.mjs';
import {FileOutbox} from './codex-bridge-files.mjs';
function fixture(t){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'file-requests-')));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const cwd=path.join(base,'work'),daemon=path.join(base,'daemon'),stateRoot=path.join(daemon,'state'),codexHome=path.join(base,'home');
 for(const d of [cwd,daemon,stateRoot,codexHome])fs.mkdirSync(d,{mode:0o700});
 const binding={bot:'fixture',profile:'fixture',chat_id:'oc_Fixture',allowed_sender_id:'ou_Owner',bot_open_id:'ou_Bot',group_access:'all_group_humans',codex_thread_id:'fixture-thread',cwd};
 const configFile=path.join(daemon,'codex-thread-bindings.json'),config={runtime:{codex_home:codexHome},bindings:{fixture:binding}};atomicWriteJson(configFile,config);
 const inboxRoot=path.join(stateRoot,'codex-inbox-v2'),inbox=new DurableInbox(inboxRoot,binding.bot,{}),completionRoot=path.join(stateRoot,'completions-v1');
 const j=inbox.enqueue({type:'im.message.receive_v1',message_id:'om_source',message_type:'text',content:'send the requested file',chat_id:binding.chat_id,chat_type:'group',sender_id:'ou_Member',sender_type:'user',bridge_binding:bindingSnapshot(binding)});
 const rollout=path.join(base,'rollout.jsonl');fs.writeFileSync(rollout,JSON.stringify({type:'response_item',payload:{role:'user',content:[{type:'input_text',text:'[飞书消息｜fixture｜om_source]'}]}})+'\n',{mode:0o600});
 Object.assign(j,{status:'delivered',markerSeen:true,markerPosition:fs.statSync(rollout).size,rollout});inbox.save(j);
 const opts={stateRoot,configFile,binding,codexHome},file=path.join(cwd,'行程.html');fs.writeFileSync(file,'<html>Original</html>',{mode:0o600});
 const queue=()=>enqueueAgentAttachment({...opts,jobId:j.id,file});
 const classify=()=>enqueueAgentRequest({...opts,jobId:j.id,kind:'actionable'});
 const dispatcher=()=>new AgentRequestDispatcher({...opts,onClassification:()=>{j.feedbackDisposition=readDisposition({root:completionRoot,binding,job:j});inbox.save(j);}});
 const records=()=>{const root=path.join(stateRoot,'file-outbox',binding.bot);return !fs.existsSync(root)?[]:fs.readdirSync(root).filter(n=>/^[a-f0-9]{64}$/.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(root,n,'request.json'))));};
 return {base,cwd,daemon,stateRoot,codexHome,binding,configFile,config,inbox,inboxRoot,completionRoot,j,opts,file,queue,classify,dispatcher,records};
}
function snapshot(root){const out=[];const walk=d=>{if(!fs.existsSync(d))return;for(const n of fs.readdirSync(d).sort()){const p=path.join(d,n),s=fs.lstatSync(p);if(s.isDirectory())walk(p);else out.push([path.relative(root,p),s.mode&0o777,digest(fs.readFileSync(p))]);}};walk(root);return out;}
test('attachment requests write only cwd, preserve immutable originals and wait for classification before v3 intake',async t=>{
 const f=fixture(t),before=snapshot(f.stateRoot),queued=f.queue();assert.equal(queued.queued,true);assert.equal(queued.applied,false);assert.equal(queued.delivered,false);
 assert.deepEqual(snapshot(f.stateRoot),before);assert.equal(f.queue().duplicate,true);
 const d=f.dispatcher();d.drain();assert.equal(f.records().length,0);assert.equal(d.stats().agent_request_pending_count,1);
 fs.writeFileSync(f.file,'edited later');f.classify();d.drain();assert.equal(f.records().length,1);assert.equal(f.records()[0].deliveryVersion,3);
 let uploads=0,sends=0;
 const outbox=new FileOutbox(path.join(f.stateRoot,'file-outbox'),f.binding,async(_b,args,cwd)=>{
  if(args[0]==='im'){uploads++;assert.equal(fs.readFileSync(path.join(cwd,f.records()[0].name),'utf8'),'<html>Original</html>');return {file_key:'file_fixture'};}
  sends++;return {message_id:'om_delivered',chat_id:f.binding.chat_id};
 },{getRoute:()=>({version:1,scope:digest(JSON.stringify(bindingSnapshot(f.binding))),chatId:f.binding.chat_id,mode:'quote',messageId:f.j.id})});
 await outbox.flush();assert.equal(uploads,1);assert.equal(sends,1);assert.equal(f.records()[0].status,'done');f.dispatcher().drain();await outbox.flush();assert.equal(uploads,1);assert.equal(sends,1);
});
test('snapshot tampering, symlinks, hardlinks, unsafe source and silent conflicts never create an outbox record',t=>{
 for(const attack of ['content','symlink','hardlink','permissions']){
  const f=fixture(t);f.classify();f.queue();const root=path.join(f.cwd,'.codex-bridge-file-payloads-v1','fixture'),scope=fs.readdirSync(root)[0],dir=path.join(root,scope),file=path.join(dir,fs.readdirSync(dir)[0],'file');
  if(attack==='content')fs.writeFileSync(file,'tampered');
  if(attack==='permissions')fs.chmodSync(file,0o644);
  if(attack==='hardlink')fs.linkSync(file,path.join(f.cwd,'link'));
  if(attack==='symlink'){fs.renameSync(file,file+'.saved');fs.symlinkSync(file+'.saved',file);}
  const d=f.dispatcher();d.drain();assert.equal(f.records().length,0,attack);assert.equal(d.stats().agent_request_blocked_count,1,attack);
 }
 const f=fixture(t),outside=path.join(f.base,'secret');fs.writeFileSync(outside,'private');assert.throws(()=>enqueueAgentAttachment({...f.opts,jobId:f.j.id,file:outside}),/outside_roots/);
 enqueueAgentRequest({...f.opts,jobId:f.j.id,kind:'silent'});assert.throws(f.queue,/disposition_conflict/);assert.equal(f.records().length,0);
});
test('late-turn and changed-binding requests are rejected; actual pre-final immutable tool proof alone allows drain',t=>{
 const f=fixture(t);f.classify();f.dispatcher().drain();const queued=f.queue();
 const final={type:'response_item',payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Done'}]}};
 fs.appendFileSync(f.j.rollout,JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:JSON.stringify(queued)}})+'\n'+JSON.stringify(final)+'\n');
 assert.throws(()=>enqueueAgentAttachment({...f.opts,jobId:f.j.id,file:f.file,mode:'image'}),/turn_ended/);
 f.dispatcher().drain();assert.equal(f.records().length,1);assert.throws(f.queue,/turn_ended/);
 const g=fixture(t);g.classify();g.dispatcher().drain();g.queue();fs.appendFileSync(g.j.rollout,JSON.stringify(final)+'\n');g.dispatcher().drain();assert.equal(g.records().length,0);
 const h=fixture(t);h.classify();h.queue();h.config.bindings.fixture={...h.binding,chat_id:'oc_Changed'};atomicWriteJson(h.configFile,h.config);assert.throws(h.dispatcher,/scope_changed/);assert.equal(h.records().length,0);
});
test('receipt publication failure reconciles same immutable outbox item on restart',t=>{
 const f=fixture(t);f.classify();f.dispatcher().drain();const r=f.queue(),d=f.dispatcher(),link=fs.linkSync;let failed=false;
 t.mock.method(fs,'linkSync',(from,to)=>{if(!failed&&to===path.join(d.receiptDir,`receipt-${r.requestKey}.json`)){failed=true;throw Object.assign(Error('fixture'),{code:'EIO'});}return link(from,to);});
 d.drain();assert.equal(f.records().length,1);assert.equal(d.stats().agent_request_pending_count,1);f.dispatcher().drain();assert.equal(f.records().length,1);assert.equal(f.dispatcher().stats().agent_request_pending_count,0);
});
test('real macOS workspace-only sandbox can queue send CLI without daemon writes',{skip:process.platform!=='darwin'||!fs.existsSync('/usr/bin/sandbox-exec')},t=>{
 const f=fixture(t),source=path.dirname(fileURLToPath(import.meta.url));for(const name of fs.readdirSync(source).filter(n=>n.endsWith('.mjs')))fs.copyFileSync(path.join(source,name),path.join(f.daemon,name));
 const before=snapshot(f.stateRoot),profile=`(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(f.cwd)}))`;
 const r=spawnSync('/usr/bin/sandbox-exec',['-p',profile,process.execPath,path.join(f.daemon,'codex-bridge-send.mjs'),'--bot','fixture','--job-id',f.j.id,'--file',f.file],{cwd:f.cwd,encoding:'utf8',timeout:15000});
 assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);assert.equal(out.queued,true);assert.equal(out.applied,false);assert.equal(out.delivered,false);assert.deepEqual(snapshot(f.stateRoot),before);
 f.classify();f.dispatcher().drain();assert.equal(f.records().length,1);
});

test('invalid audio/video are rejected before durable intake rather than left pending',t=>{
 const f=fixture(t);for(const [name,mode] of [['sample.mp3','audio'],['sample.wav','audio'],['sample.mov','video']]){
  const file=path.join(f.cwd,name),cover=path.join(f.cwd,'cover.png');fs.writeFileSync(file,'not an Opus stream');fs.writeFileSync(cover,'fixture image');
  assert.throws(()=>enqueueAgentAttachment({...f.opts,jobId:f.j.id,file,mode,...(mode==='video'?{cover}:{})}),/requires_opus|requires_mp4/);
 }
 assert.equal(f.records().length,0);assert.equal(f.dispatcher().stats().agent_request_pending_count,0);
});
