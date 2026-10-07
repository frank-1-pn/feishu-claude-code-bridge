import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {enqueueAgentRequest,AgentRequestDispatcher,AGENT_REQUEST_LIMITS} from './codex-bridge-agent-requests.mjs';
import {DurableInbox,digest} from './codex-bridge-inbox.mjs';import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {readDisposition} from './codex-bridge-completion.mjs';import {atomicWriteJson} from './codex-bridge-storage.mjs';
import {TaskResultStore} from './codex-bridge-task-results.mjs';import {ActionStore} from './codex-bridge-actions.mjs';
import {spawn,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {stableJson,enqueueBackgroundTask} from './codex-bridge-background-store.mjs';
import {BackgroundScheduler,verifyBackgroundCompletion} from './codex-bridge-background.mjs';
function fixture(t){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agent-requests-')));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const cwd=path.join(base,'workspace'),daemon=path.join(base,'daemon'),stateRoot=path.join(daemon,'state'),codexHome=path.join(base,'home');
 for(const dir of [cwd,daemon,stateRoot,codexHome])fs.mkdirSync(dir,{mode:0o700});
 const binding={bot:'fixture',profile:'fixture',chat_id:'oc_Fixture',allowed_sender_id:'ou_Owner',bot_open_id:'ou_Bot',group_access:'all_group_humans',codex_thread_id:'fixture-thread',cwd};
 const configFile=path.join(daemon,'codex-thread-bindings.json'),config={runtime:{codex_home:codexHome},bindings:{fixture:binding}};atomicWriteJson(configFile,config);
 const inboxRoot=path.join(stateRoot,'codex-inbox-v2'),completionRoot=path.join(stateRoot,'completions-v1'),inbox=new DurableInbox(inboxRoot,binding.bot,{});
 const opts={stateRoot,configFile,binding,codexHome},store=new TaskResultStore({root:path.join(stateRoot,'task-results-v1'),inboxRoot,completionRoot,binding,codexHome});
 const add=(id='om_source',extra={})=>{
  const j=inbox.enqueue({type:'im.message.receive_v1',message_id:id,message_type:'text',content:'operational request',chat_id:binding.chat_id,chat_type:'group',sender_id:'ou_Member',sender_type:'user',bridge_binding:bindingSnapshot(binding),...extra});
  const rollout=path.join(base,`${digest(id)}.jsonl`);fs.writeFileSync(rollout,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`[飞书消息｜fixture｜${id}]`}]}})+'\n',{mode:0o600});
  Object.assign(j,{status:'delivered',markerSeen:true,markerPosition:fs.statSync(rollout).size,rollout,taskResultProtocolVersion:1,taskResultProtocolScope:{cwd,codexHome}});inbox.save(j);return j;
 };
 const enqueue=(j,kind,request)=>enqueueAgentRequest({...opts,jobId:j.id,kind,...(request?{request}:{})});
 const dispatcher=()=>new AgentRequestDispatcher({...opts,taskResults:store,onClassification:id=>{const j=inbox.jobs.get(id);j.feedbackDisposition=readDisposition({root:completionRoot,binding,job:j});inbox.save(j);}});
 return {base,cwd,daemon,stateRoot,codexHome,binding,configFile,config,opts,inbox,store,add,enqueue,dispatcher,completionRoot};
}
const value=(extra={})=>({resultKey:'answer-v1',text:'Verified result.',status:'complete',...extra});

test('producer writes only cwd, ignores private Git contents and classification drains before an earlier result',t=>{
 const f=fixture(t),j=f.add();f.enqueue(j,'result',value());const d=f.dispatcher();d.drain();assert.equal(d.stats().agent_request_pending_count,1);
 assert.equal(fs.existsSync(f.completionRoot),false);assert.throws(()=>f.store.get(j),/source_unclassified/);
 const decision=f.enqueue(j,'actionable');assert.equal(decision.queued,true);assert.equal(decision.applied,false);assert.equal(decision.delivered,false);
 assert.equal(f.enqueue(j,'actionable').duplicate,true);assert.throws(()=>f.enqueue(j,'silent'),/conflict/);
 d.drain();assert.equal(d.stats().agent_request_pending_count,0);assert.equal(d.stats().agent_request_blocked_count,0);
 assert.equal(f.store.get(j).text,value().text);assert.equal(j.feedbackDisposition,'actionable');
 const ignore=path.join(f.cwd,'.codex-bridge-requests-v1','.gitignore');assert.equal(fs.readFileSync(ignore,'utf8'),'*\n');assert.equal(fs.statSync(ignore).mode&0o777,0o600);
 assert.equal(fs.statSync(d.dir).mode&0o777,0o700);for(const n of fs.readdirSync(d.dir))assert.equal(fs.statSync(path.join(d.dir,n)).mode&0o777,0o600);
});
test('marker and classification visibility wait, then same immutable source resumes without permanent blocking',t=>{
 const f=fixture(t),j=f.add();j.markerSeen=false;j.status='submitted';f.inbox.save(j);
 f.enqueue(j,'actionable');f.enqueue(j,'result',value());const d=f.dispatcher();d.drain();assert.equal(d.stats().agent_request_pending_count,2);assert.equal(d.stats().agent_request_blocked_count,0);
 j.markerSeen=true;j.status='delivered';f.inbox.save(j);d.drain();assert.equal(f.store.get(j).text,value().text);assert.equal(d.stats().agent_request_pending_count,0);
});
test('immutable key conflicts, source/config tampering, old silence and unknown sources cannot authorize dispatch',t=>{
 const f=fixture(t),j=f.add();f.enqueue(j,'result',value());assert.throws(()=>f.enqueue(j,'result',value({text:'changed'})),/conflict/);
 assert.throws(()=>enqueueAgentRequest({...f.opts,jobId:'om_unknown',kind:'actionable'}));
 j.event.content='changed original';f.inbox.save(j);const d=f.dispatcher();d.drain();assert.equal(d.stats().agent_request_blocked_count,1);assert.throws(()=>f.store.get(j),/source_unclassified/);
 const silent=f.add('om_silent');f.enqueue(silent,'silent');assert.throws(()=>f.enqueue(silent,'result',value()),/conflict/);
 const pending=f.add('om_config');f.enqueue(pending,'actionable');f.config.bindings.fixture={...f.binding,initial_feedback_card:true};atomicWriteJson(f.configFile,f.config);
 assert.throws(()=>f.enqueue(pending,'result',value()),/scope_changed/);assert.ok(d.stats().agent_request_blocked_count>=1);
 const fresh=new AgentRequestDispatcher({...f.opts,binding:{...f.binding,initial_feedback_card:true},taskResults:f.store});assert.ok(fresh.stats().agent_request_blocked_count>=2);
});
test('new late-turn payload is rejected from actual rollout despite stale delivered inbox; frozen duplicate remains readable',t=>{
 const f=fixture(t),j=f.add();const queued=f.enqueue(j,'actionable');
 fs.appendFileSync(j.rollout,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'ended'}]}})+'\n');
 assert.equal(f.enqueue(j,'actionable').requestKey,queued.requestKey);assert.throws(()=>f.enqueue(j,'result',value()),/source_turn_ended/);
});
test('derived runtime binding fields are accepted but undeclared additions are not',t=>{
 const f=fixture(t),j=f.add(),derived={...f.binding,logPath:'derived',offsetPath:'derived',receiptOffsetPath:'derived'};
 assert.equal(enqueueAgentRequest({...f.opts,binding:derived,jobId:j.id,kind:'actionable'}).queued,true);
 assert.doesNotThrow(()=>new AgentRequestDispatcher({...f.opts,binding:derived,taskResults:f.store}));
 assert.throws(()=>enqueueAgentRequest({...f.opts,binding:{...derived,unknown:true},jobId:j.id,kind:'actionable'}),/scope_changed/);
});
test('unsafe existing spool directory or file is rejected without chmod repair; partial publish never executes',t=>{
 const f=fixture(t),j=f.add();const root=path.join(f.cwd,'.codex-bridge-requests-v1');fs.mkdirSync(root,{mode:0o755});assert.throws(()=>f.enqueue(j,'actionable'));assert.equal(fs.statSync(root).mode&0o777,0o755);
 fs.chmodSync(root,0o700);f.enqueue(j,'actionable');const d=f.dispatcher(),file=path.join(d.dir,fs.readdirSync(d.dir)[0]);
 fs.writeFileSync(path.join(d.dir,`request-${'a'.repeat(64)}.json.00000000-0000-4000-8000-000000000000.tmp`),'{partial',{mode:0o600});assert.equal(d.stats().agent_request_pending_count,1);
 fs.chmodSync(file,0o644);assert.throws(()=>f.enqueue(j,'actionable'));assert.equal(d.stats().agent_request_blocked_count,1);fs.chmodSync(file,0o600);
 fs.linkSync(file,file+'.link');assert.throws(()=>f.enqueue(j,'actionable'));fs.unlinkSync(file+'.link');
 fs.renameSync(file,file+'.original');fs.symlinkSync(file+'.original',file);assert.throws(()=>f.enqueue(j,'actionable'));fs.unlinkSync(file);fs.renameSync(file+'.original',file);
 d.drain();assert.equal(j.feedbackDisposition,'actionable');
});
test('private store success before receipt failure reconciles after restart without another result revision',t=>{
 const f=fixture(t),j=f.add();f.enqueue(j,'actionable');f.enqueue(j,'result',value());const d=f.dispatcher(),link=fs.linkSync;let crash=true;
 t.mock.method(fs,'linkSync',(from,to)=>{if(crash&&to.startsWith(d.receiptDir)&&from.includes('receipt-')){crash=false;throw Object.assign(Error('receipt crash'),{code:'EIO'});}return link(from,to);});
 d.drain();assert.equal(readDisposition({root:f.completionRoot,binding:f.binding,job:j}),'actionable');
 // Inbox's normal classification scan can expose the already published result.
 j.feedbackDisposition='actionable';f.inbox.save(j);const restored=f.dispatcher();restored.drain();assert.equal(f.store.history(j).length,1);
 const count=fs.readdirSync(f.store.dir).length;restored.drain();assert.equal(fs.readdirSync(f.store.dir).length,count);assert.equal(restored.stats().agent_request_pending_count,0);
});
test('result receipt crash after actual frozen store publication and done source only reconciles the immutable duplicate',t=>{
 const f=fixture(t),j=f.add();f.enqueue(j,'actionable');const d=f.dispatcher();d.drain();const r=f.enqueue(j,'result',value()),link=fs.linkSync;let crash=true;
 t.mock.method(fs,'linkSync',(from,to)=>{if(crash&&to===path.join(d.receiptDir,`receipt-${r.requestKey}.json`)){crash=false;throw Object.assign(Error('receipt crash'),{code:'EIO'});}return link(from,to);});
 d.drain();assert.equal(f.store.history(j).length,1);j.status='done';f.inbox.save(j);f.dispatcher().drain();assert.equal(f.store.history(j).length,1);
 assert.equal(f.dispatcher().stats().agent_request_pending_count,0);
});
test('bounded pending requests and payload bytes cannot fill or bypass the queue',t=>{
 const f=fixture(t);for(let i=0;i<AGENT_REQUEST_LIMITS.maxPending;i++)f.enqueue(f.add(`om_many${i}`),'actionable');
 assert.throws(()=>f.enqueue(f.add('om_over'),'actionable'),/queue_full/);
 assert.throws(()=>f.enqueue(f.add('om_big'),'result',value({text:'x'.repeat(65537)})),/payload_invalid/);
});
function actionFixture(t,action,status){
 const f=fixture(t),owner=f.add();owner.feedbackDisposition='actionable';owner.streamKey='owner-stream';f.inbox.save(owner);const first=f.store.submit(owner.id,value({status}));
 atomicWriteJson(path.join(f.stateRoot,'codex-inbox-v2',f.binding.bot,`sent-${first.replyKey}.json`),{sentAt:Date.now(),finalDeliveryEvidence:{schema:1,at:Date.now(),source:'send_response'}});
 owner.status='done';f.inbox.save(owner);const actions=new ActionStore({root:path.join(f.stateRoot,'actions-v1'),bot:f.binding.bot,now:()=>Date.parse('2026-10-08T00:00:00Z')});
 const registration={key:`task:${owner.id}`,sourceJobId:owner.id,codexThreadId:f.binding.codex_thread_id,chatId:f.binding.chat_id,allowedSenderId:f.binding.allowed_sender_id,answer:first.text,mode:status==='waiting'?'waiting':'complete',
  ...(status==='waiting'?{form:{version:1,title:'Date',fields:[{name:'date',label:'Date',type:'text',required:true}]}}:{})};
 const c=actions.registerContext(registration);actions.bindMessage(c.contextId,'om_card');
 const cardFile=path.join(f.stateRoot,'outbound-v3',f.binding.bot,`card-${digest('owner-stream')}.json`);atomicWriteJson(cardFile,{key:'owner-stream',jobId:owner.id,messageId:'om_card',presentation:{actionContext:c.contextId},final:true,finalDelivered:true});
 const envelope={schema:'2.0',header:{event_type:'card.action.trigger',event_id:'fixture-event',app_id:'fixture-app'},event:{host:'im_message',operator:{open_id:f.binding.allowed_sender_id},
  context:{open_chat_id:f.binding.chat_id,open_message_id:'om_card'},action:{tag:'button',value:{context_id:c.contextId,version:1,action},...(action==='conditions'?{form_value:{date:'2026-10-09'}}:{})}}};
 assert.equal(actions.acceptCallback(envelope,{binding:f.binding,authenticatedBot:f.binding.bot,appId:'fixture-app'}).accepted,true);
 actions.drain({binding:f.binding,inbox:f.inbox});const queued=[...f.inbox.jobs.values()].find(j=>j.event.synthetic_callback),callback=f.add(queued.id,queued.event);return {...f,owner,callback,actions,c,registration,cardFile};
}
for(const [action,status] of [['conditions','waiting'],['shorter','complete']])test(`genuine ActionStore ${action} callback spools and revises only its verified original owner`,t=>{
 const f=actionFixture(t,action,status);assert.equal(f.callback.event.bridge_binding,undefined);
 f.enqueue(f.callback,'result',value({resultKey:'callback-v2',text:'Revised answer.'}));f.dispatcher().drain();assert.equal(f.store.get(f.owner).text,'Revised answer.');
 const next=f.actions.registerContext({...f.registration,version:2,answer:'Revised answer.'}),card=JSON.parse(fs.readFileSync(f.cardFile));card.presentation.actionContext=next.contextId;atomicWriteJson(f.cardFile,card);
 assert.equal(f.enqueue(f.callback,'result',value({resultKey:'callback-v2',text:'Revised answer.'})).duplicate,true);
 assert.throws(()=>f.enqueue(f.callback,'result',value({resultKey:'stale-v3'})),/action_stale/);
});

function installCliFixture(f){
 const source=path.dirname(fileURLToPath(import.meta.url));
 for(const name of fs.readdirSync(source).filter(n=>n.endsWith('.mjs')))fs.copyFileSync(path.join(source,name),path.join(f.daemon,name));
}
function stateSnapshot(dir){
 const entries=[];const scan=d=>{if(!fs.existsSync(d))return;for(const name of fs.readdirSync(d).sort()){
  const file=path.join(d,name),s=fs.lstatSync(file);if(s.isDirectory())scan(file);else entries.push([path.relative(dir,file),s.mode&0o777,digest(fs.readFileSync(file))]);
 }};scan(dir);return entries;
}
test('real macOS workspace-only sandbox denies legacy state writes while all executable request CLIs queue and runtime ACKs',
 {skip:process.platform!=='darwin'||!fs.existsSync('/usr/bin/sandbox-exec')},t=>{
 const f=fixture(t),active=f.add('om_sandbox_active'),silent=f.add('om_sandbox_silent');installCliFixture(f);
 const profile=`(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(f.cwd)}))`;
 const invoke=args=>spawnSync('/usr/bin/sandbox-exec',['-p',profile,process.execPath,...args],{cwd:f.cwd,encoding:'utf8',timeout:15000});
 const old=invoke(['--input-type=module','-e',`import {enqueueActionable} from ${JSON.stringify(path.join(f.daemon,'codex-bridge-completion.mjs'))};enqueueActionable(${JSON.stringify({root:f.completionRoot,inboxRoot:path.join(f.stateRoot,'codex-inbox-v2'),binding:f.binding,jobId:active.id})});`]);
 assert.equal(old.status,1);assert.match(old.stderr,/EPERM|EACCES/);assert.equal(fs.existsSync(f.completionRoot),false);
 const before=stateSnapshot(f.stateRoot),requestFile=path.join(f.cwd,'result.json');fs.writeFileSync(requestFile,JSON.stringify(value()),{mode:0o600});
 const calls=[['codex-bridge-feedback.mjs','--bot','fixture','--job-id',active.id,'--state','actionable'],
  ['codex-bridge-task-results-cli.mjs','--bot','fixture','--job-id',active.id,'--action','complete','--request-file',requestFile],
  ['codex-bridge-complete.mjs','--bot','fixture','--job-id',silent.id,'--disposition','silent']];
 for(const [name,...args] of calls){const r=invoke([path.join(f.daemon,name),...args]);assert.equal(r.status,0,r.stderr);
  const output=JSON.parse(r.stdout);assert.equal(output.ok,true);assert.equal(output.queued,true);assert.equal(output.applied,false);assert.equal(output.delivered,false);assert.match(output.requestHash,/^[a-f0-9]{64}$/);
 }
 assert.deepEqual(stateSnapshot(f.stateRoot),before);const d=f.dispatcher();assert.equal(d.stats().agent_request_pending_count,3);d.drain();
 assert.equal(f.store.get(active).text,value().text);assert.equal(readDisposition({root:f.completionRoot,binding:f.binding,job:silent}),'silent');
 assert.equal(d.stats().agent_request_pending_count,0);assert.equal(d.stats().agent_request_blocked_count,0);
 const records=fs.readdirSync(d.receiptDir).map(n=>JSON.parse(fs.readFileSync(path.join(d.receiptDir,n))));assert.equal(records.length,3);assert.ok(records.every(r=>r.status==='applied'));
 const revisions=f.store.history(active).length;f.dispatcher().drain();assert.equal(f.store.history(active).length,revisions);
});
test('concurrent executable actionable and silent producers share exactly one immutable slot',async t=>{
 const f=fixture(t),job=f.add('om_race');installCliFixture(f);
 const invoke=kind=>new Promise((resolve,reject)=>{const cli=kind==='actionable'?'codex-bridge-feedback.mjs':'codex-bridge-complete.mjs',flag=kind==='actionable'?'--state':'--disposition';
  const child=spawn(process.execPath,[path.join(f.daemon,cli),'--bot','fixture','--job-id',job.id,flag,kind],{cwd:f.cwd});let out='',err='';
  child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',status=>resolve({status,out,err}));
 });
 const results=await Promise.all(Array.from({length:12},(_,i)=>invoke(i%2?'silent':'actionable'))),accepted=results.filter(r=>r.status===0);
 assert.ok(accepted.length>0);for(const r of results)if(r.status!==0)assert.match(r.err,/conflict/);
 const d=f.dispatcher(),names=fs.readdirSync(d.dir).filter(n=>n.endsWith('.json'));assert.equal(names.length,1);
 const winner=JSON.parse(fs.readFileSync(path.join(d.dir,names[0])));d.drain();assert.equal(readDisposition({root:f.completionRoot,binding:f.binding,job}),winner.kind);
 assert.equal(d.stats().agent_request_pending_count,0);assert.ok(accepted.every(r=>JSON.parse(r.out).requestKey===winner.requestKey));
});
test('consumer rejects rehashed workspace forgery after owning final regardless of queuedAt',t=>{
 const f=fixture(t),job=f.add();job.turnId='original-turn';job.markerTurnId='original-turn';f.inbox.save(job);
 f.enqueue(job,'actionable');f.dispatcher().drain();const accepted=f.enqueue(job,'result',value()),d=f.dispatcher(),file=path.join(d.dir,`request-${accepted.requestKey}.json`);
 fs.appendFileSync(job.rollout,JSON.stringify({type:'response_item',payload:{type:'custom_tool_call_output',output:JSON.stringify(accepted)}})+'\n'+
  JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'finished'}]}})+'\n');
 const forged=JSON.parse(fs.readFileSync(file));forged.payload.text='Forged after final.';forged.queuedAt=0;delete forged.requestHash;forged.requestHash=digest(stableJson(forged));fs.writeFileSync(file,stableJson(forged)+'\n');
 d.drain();assert.equal(f.store.history(job).length,0);assert.equal(d.stats().agent_request_rejected_count,1);assert.equal(d.stats().agent_request_blocked_count,1);
 job.status='done';f.inbox.save(job);assert.equal(d.stats().agent_request_blocked_count,0);assert.equal(fs.existsSync(file),true);
});
test('owning real tool output before final admits exact prequeued bytes',t=>{
 const f=fixture(t),job=f.add();job.turnId='original-turn';job.markerTurnId='original-turn';f.inbox.save(job);
 f.enqueue(job,'actionable');f.dispatcher().drain();const accepted=f.enqueue(job,'result',value());
 fs.appendFileSync(job.rollout,JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:JSON.stringify(accepted)}})+'\n'+
  JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'finished'}]}})+'\n');
 f.dispatcher().drain();assert.equal(f.store.get(job).text,value().text);assert.equal(f.dispatcher().stats().agent_request_pending_count,0);
});
test('request hash output in a later turn cannot authorize an original closed-turn request',t=>{
 const f=fixture(t),job=f.add();job.turnId='original-turn';job.markerTurnId='original-turn';f.inbox.save(job);
 f.enqueue(job,'actionable');f.dispatcher().drain();const accepted=f.enqueue(job,'result',value());
 fs.appendFileSync(job.rollout,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'finished'}]}})+'\n'+
  JSON.stringify({type:'turn_context',payload:{turn_id:'later-turn'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'custom_tool_call_output',output:JSON.stringify(accepted)}})+'\n');
 f.dispatcher().drain();assert.equal(f.store.history(job).length,0);assert.equal(f.dispatcher().stats().agent_request_rejected_count,1);
});
test('verified scheduler background completion spools only to its original card and rejects changed completion evidence',async t=>{
 const f=fixture(t),owner=f.add();f.enqueue(owner,'actionable');f.dispatcher().drain();
 const root=path.join(f.stateRoot,'background-v1'),inboxRoot=path.join(f.stateRoot,'codex-inbox-v2'),codexCliJs=path.join(f.base,'background-cli.mjs');
 const task=enqueueBackgroundTask({root,inboxRoot,completionRoot:f.completionRoot,binding:f.binding,jobId:owner.id,taskKey:'draft',title:'Read-only draft',promptText:'Prepare a draft.',codexCliJs,codexHome:f.codexHome});
 const initial=f.store.submit(owner.id,value({status:'background'}));atomicWriteJson(path.join(inboxRoot,f.binding.bot,`sent-${initial.replyKey}.json`),
  {sentAt:Date.now(),finalDeliveryEvidence:{schema:1,at:Date.now(),source:'send_response'}});owner.status='done';f.inbox.save(owner);
 const scheduler=new BackgroundScheduler({root,inboxRoot,binding:f.binding,inbox:f.inbox,codexCliJs,codexHome:f.codexHome,launch:()=>({unref(){},once(){}}),probe:async()=>true});
 await scheduler.tick();const dir=path.join(root,f.binding.bot,task.taskId),claim=JSON.parse(fs.readFileSync(path.join(dir,'claim.json'))),bytes=Buffer.from('Completed verified draft.');
 fs.writeFileSync(path.join(dir,'result.txt'),bytes,{mode:0o600});atomicWriteJson(path.join(dir,'run.json'),{schema:1,taskId:task.taskId,nonce:claim.nonce,pid:12345,
  processIdentity:{bootId:'fixture',startSeconds:1},heartbeatAt:Date.now(),status:'completed',taskSha256:digest(fs.readFileSync(path.join(dir,'task.json'))),exitCode:0,resultBytes:bytes.length,resultSha256:digest(bytes)});
 await scheduler.tick();const queued=[...f.inbox.jobs.values()].find(j=>j.event.background_completion);assert.ok(queued);assert.equal(verifyBackgroundCompletion(f.binding,queued.event,root),true);
 const callback=f.add(queued.id,queued.event);assert.throws(()=>f.enqueue(callback,'actionable'),/source_unauthorized/);
 f.enqueue(callback,'result',value({resultKey:'background-result',text:bytes.toString()}));f.dispatcher().drain();assert.equal(f.store.get(owner).text,bytes.toString());
 callback.event.background_result_sha256='a'.repeat(64);f.inbox.save(callback);assert.throws(()=>f.enqueue(callback,'result',value({resultKey:'forged-background'})),/background_unverified/);
});
test('unique thread authority is rechecked and terminal historical scoped requests no longer block',t=>{
 const f=fixture(t),job=f.add();f.enqueue(job,'actionable');f.config.bindings.other={...f.binding,bot:'other'};atomicWriteJson(f.configFile,f.config);
 assert.throws(()=>f.enqueue(job,'result',value()),/scope_ambiguous/);delete f.config.bindings.other;
 f.config.bindings.fixture={...f.binding,initial_feedback_card:true};atomicWriteJson(f.configFile,f.config);
 const d=new AgentRequestDispatcher({...f.opts,binding:f.config.bindings.fixture,taskResults:f.store});assert.equal(d.stats().agent_request_blocked_count,1);
 job.status='done';f.inbox.save(job);assert.equal(d.stats().agent_request_blocked_count,0);
});
