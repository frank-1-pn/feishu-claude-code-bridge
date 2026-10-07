import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {ActionStore} from './codex-bridge-actions.mjs';
import {DurableInbox,digest} from './codex-bridge-inbox.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';
import {TaskResultStore,taskResultSourceHash,taskResultRequestHash} from './codex-bridge-task-results.mjs';
import {runTaskResultCli,parseTaskResultArguments} from './codex-bridge-task-results-cli.mjs';
import {BackgroundScheduler,verifyBackgroundCompletion} from './codex-bridge-background.mjs';
import {enqueueBackgroundTask,readBackgroundJson} from './codex-bridge-background-store.mjs';

function fixture(t) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'task-results-')));fs.chmodSync(base,0o700);t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const stateRoot=path.join(base,'state'),root=path.join(stateRoot,'task-results-v1'),inboxRoot=path.join(stateRoot,'codex-inbox-v2'),
    completionRoot=path.join(stateRoot,'completions-v1'),backgroundRoot=path.join(stateRoot,'background-v1'),codexHome=path.join(base,'home');
  const binding={bot:'fixture',profile:'fixture',chat_id:'oc_Fixture',allowed_sender_id:'ou_Owner',bot_open_id:'ou_Bot',group_access:'all_group_humans',codex_thread_id:'fixture-thread',cwd:base};
  const inbox=new DurableInbox(inboxRoot,binding.bot,{}),opts={root,inboxRoot,completionRoot,backgroundRoot,binding,codexHome};
  const scope={cwd:base,codexHome};
  const add=(id='om_source',extra={})=>{
    const j=inbox.enqueue({type:'im.message.receive_v1',message_id:id,message_type:'text',content:JSON.stringify({text:'请处理这项任务'}),chat_id:binding.chat_id,chat_type:'group',
      sender_id:'ou_Member',sender_type:'user',bridge_binding:bindingSnapshot(binding),...extra});
    Object.assign(j,{status:'delivered',markerSeen:true,feedbackDisposition:'actionable',taskResultProtocolVersion:1,taskResultProtocolScope:scope});inbox.save(j);return j;
  };
  const receipt=result=>atomicWriteJson(path.join(inboxRoot,binding.bot,`sent-${result.replyKey}.json`),{sentAt:1000,finalDeliveryEvidence:{schema:1,at:1000,source:'send_response'}});
  let store;const open=(extra={})=>store=new TaskResultStore({...opts,...extra});open();
  return {base,stateRoot,root,inboxRoot,backgroundRoot,binding,codexHome,completionRoot,scope,inbox,opts,add,receipt,open,get store(){return store;}};
}
const request=(extra={})=>({resultKey:'answer-v1',text:'本项任务已完成。',status:'complete',...extra});

test('immutable result is scoped to original human source and stable key across restart',t=>{
  const f=fixture(t),j=f.add(),first=f.store.submit(j.id,request({title:'原始任务'}));
  assert.equal(first.delivered,false);assert.equal(first.duplicate,false);assert.equal(first.ownerJobId,j.id);assert.equal(first.revision,1);
  assert.equal(Object.isFrozen(f.store.get(j)),true);assert.equal(f.store.stats().task_result_pending_count,1);
  f.open();assert.equal(f.store.submit(j.id,request({title:'原始任务'})).duplicate,true);
  assert.throws(()=>f.store.submit(j.id,request({title:'变更标题'})),/key_conflict/);
  assert.throws(()=>f.store.submit(j.id,request({text:'不同正文'})),/key_conflict/);
  assert.throws(()=>f.store.submit(j.id,request({resultKey:'answer-v2'})),/prior_outstanding/);
  f.receipt(first);assert.equal(f.store.stats().task_result_pending_count,0);
  assert.throws(()=>f.store.submit(j.id,request({resultKey:'answer-v2'})),/terminal_frozen/);
  assert.equal(f.store.get(j).text,'本项任务已完成。');
});

test('new intake only, actual actionable marker and binding required; external protocol fields cannot authorize',t=>{
  const f=fixture(t);let n=0;
  for(const patch of [{markerSeen:false},{taskResultProtocolVersion:undefined},{feedbackDisposition:'silent'},{completionDisposition:'silent'},
    {unclassifiedTurnEnded:true},{status:'queued'},{taskResultProtocolBlocked:'turn_ended_without_task_result'},
    {taskResultProtocolScope:{cwd:f.base,codexHome:'/wrong-home'}}]) {
    const j=f.add(`om_invalid${n++}`);Object.assign(j,patch);f.inbox.save(j);assert.throws(()=>f.store.submit(j.id,request()));
  }
  for(const patch of [{sender_type:'app'},{sender_id:'ou_Bot'},{chat_id:'ocOther'},{chat_type:'p2p'},
    {synthetic_callback:true,background_completion:true,action_source_job_id:'om_source'},{bridge_binding:{}},{codex_thread_id:'wrong-thread'}]) {
    const j=f.add(`om_event${n++}`,patch);assert.throws(()=>f.store.submit(j.id,request()));
  }
  const j=f.add('om_external',{taskResultProtocolVersion:1,task_result_verified:true,task_result_owner:'om_source'});
  delete j.taskResultProtocolVersion;f.inbox.save(j);assert.throws(()=>f.store.submit(j.id,request()));assert.equal(f.store.get(j),null);
  assert.throws(()=>f.store.submit('om_unknown',request()));
});

test('no shared turn association or most-recent fallback; only explicit same-sender real reply-chain links',t=>{
  const f=fixture(t),owner=f.add('om_owner'),independent=f.add('om_independent',{thread_id:'same-thread',root_id:owner.id}),another=f.add('om_another');
  const a=f.store.submit(owner.id,request({status:'waiting'}));f.receipt(a);owner.status='done';f.inbox.save(owner);
  assert.equal(f.store.get(independent),null);assert.throws(()=>f.store.link(independent.id,owner.id),/link_unverified/);
  const cross=f.add('om_cross',{parent_id:owner.id,sender_id:'ou_Other'});assert.throws(()=>f.store.link(cross.id,owner.id),/link_unverified/);
  const source=f.add('om_reply',{parent_id:owner.id});assert.equal(f.store.link(source.id,owner.id).linked,true);
  const linked=f.store.get(source);assert.equal(linked.ownerJobId,owner.id);assert.equal(linked.sourceJobId,source.id);assert.equal(linked.resultSourceJobId,owner.id);
  assert.throws(()=>f.store.link(source.id,another.id),/link_unverified/);
  const done=f.store.submit(source.id,request({resultKey:'answer-v2',text:'已据补充完成。'}));
  assert.equal(done.ownerJobId,owner.id);assert.equal(done.revision,2);assert.equal(f.store.get(owner).sourceJobId,source.id);
  assert.equal(f.store.get(independent),null);assert.equal(f.store.get(another),null);
  f.receipt(done);source.status='done';f.inbox.save(source);f.open();assert.equal(f.store.submit(source.id,request({resultKey:'answer-v2',text:'已据补充完成。'})).duplicate,true);
});

test('link before any owner result returns only verified ownership; independent owner cannot become supplement later',t=>{
  const f=fixture(t),owner=f.add('om_owner'),source=f.add('om_reply',{parent_id:owner.id});f.store.link(source.id,owner.id);
  assert.deepEqual(f.store.get(source),{linked:true,sourceJobId:source.id,ownerJobId:owner.id,revision:0});
  const first=f.store.submit(source.id,request());assert.equal(first.ownerJobId,owner.id);assert.equal(first.revision,1);
  assert.equal(f.store.get(owner).sourceJobId,source.id);assert.equal(f.store.get(owner).replyKey,first.replyKey);
  const own=f.add('om_self',{parent_id:owner.id});f.store.submit(own.id,request());assert.throws(()=>f.store.link(own.id,owner.id),/association_conflict/);
});

test('waiting revision requires real previous delivery proof and newly active source; final bytes cannot overwrite',t=>{
  const f=fixture(t),owner=f.add(),first=f.store.submit(owner.id,request({status:'waiting'})),source=f.add('om_reply',{parent_id:owner.id});
  f.store.link(source.id,owner.id);
  assert.throws(()=>f.store.submit(source.id,request({resultKey:'v2'})),/prior_outstanding/);
  const receiptFile=path.join(f.inboxRoot,f.binding.bot,`sent-${first.replyKey}.json`);atomicWriteJson(receiptFile,{sentAt:1000});
  assert.throws(()=>f.store.submit(source.id,request({resultKey:'v2'})),/receipt_invalid/);
  f.receipt(first);owner.status='done';f.inbox.save(owner);
  assert.throws(()=>f.store.submit(owner.id,request({resultKey:'v2'})),/submitter_not_active/);
  const complete=f.store.submit(source.id,request({resultKey:'v2'}));f.receipt(complete);
  const third=f.add('om_third',{parent_id:source.id});f.store.link(third.id,owner.id);
  assert.throws(()=>f.store.submit(third.id,request({resultKey:'v3'})),/terminal_frozen/);
  assert.equal(f.store.get(owner).text,complete.text);
});

test('tampered source, frozen records, role scope and private file shape fail closed after restart',t=>{
  const f=fixture(t),j=f.add();f.store.submit(j.id,request());
  const record=path.join(f.store.dir,`results-${digest(j.id)}`,'v-000001.json'),original=JSON.parse(fs.readFileSync(record));
  atomicWriteJson(record,{...original,request:{...original.request,text:'tampered'}});assert.throws(()=>f.store.get(j));assert.ok(f.store.stats().task_result_blocked_count>0);
  atomicWriteJson(record,original);j.event.content='tampered';f.inbox.save(j);assert.throws(()=>f.store.get(j));
  j.event.content=JSON.stringify({text:'请处理这项任务'});f.inbox.save(j);
  f.open({binding:{...f.binding,codex_thread_id:'wrong-thread'}});assert.throws(()=>f.store.get(j));f.open({codexHome:path.join(f.base,'wrong-home')});assert.throws(()=>f.store.get(j));f.open();
  fs.chmodSync(record,0o644);assert.throws(()=>f.store.get(j));fs.chmodSync(record,0o600);
  fs.linkSync(record,record+'.link');assert.throws(()=>f.store.get(j));fs.unlinkSync(record+'.link');
  fs.renameSync(record,record+'.original');fs.symlinkSync(record+'.original',record);assert.throws(()=>f.store.get(j));
});

test('request schema excludes caller identity, control fields and unbounded bytes',t=>{
  const f=fixture(t),j=f.add();
  for(const patch of [{jobId:j.id},{ownerJobId:j.id},{scope:{}},{schema:1},{status:'completed'},{text:''},{text:'\u0000'},
    {text:'x'.repeat(65537)},{resultKey:'../escape'},{title:'bad\nline'}])assert.throws(()=>f.store.submit(j.id,request(patch)),/request_invalid/);
  assert.equal(f.store.get(j),null);
});

test('CLI accepts only exact private cwd request and selected config; no arbitrary roots, duplicates or source override',t=>{
  const f=fixture(t),j=f.add(),configFile=path.join(f.base,'config.json'),requestFile=path.join(f.base,'request.json');
  atomicWriteJson(configFile,{runtime:{codex_home:f.codexHome},bindings:{fixture:f.binding}});atomicWriteJson(requestFile,request());
  const args=['--bot','fixture','--job-id',j.id,'--action','complete','--request-file',requestFile],options={configFile,stateRoot:f.stateRoot};
  assert.equal(runTaskResultCli(args,options).queued,true);assert.equal(runTaskResultCli(args,options).duplicate,true);
  assert.throws(()=>parseTaskResultArguments([...args,'--root',f.base]),/arguments_invalid/);
  assert.throws(()=>parseTaskResultArguments([...args,'--bot','other']),/arguments_invalid/);
  assert.throws(()=>runTaskResultCli([...args.slice(0,-1),`${f.base}/sub/../request.json`],options));
  fs.chmodSync(requestFile,0o644);assert.throws(()=>runTaskResultCli(args,options));fs.chmodSync(requestFile,0o600);
  fs.linkSync(requestFile,requestFile+'.link');assert.throws(()=>runTaskResultCli(args,options));fs.unlinkSync(requestFile+'.link');
  fs.renameSync(requestFile,requestFile+'.original');fs.symlinkSync(requestFile+'.original',requestFile);assert.throws(()=>runTaskResultCli(args,options));
});

test('actual scheduler callback revises original background owner only, never arbitrary synthetic source',async t=>{
  const f=fixture(t),owner=f.add(),first=f.store.submit(owner.id,request({status:'background',text:'后台草稿已排队。'}));
  const promptFile=path.join(f.base,'prompt.txt');fs.writeFileSync(promptFile,'仅整理给定资料。',{mode:0o600});
  const queued=enqueueBackgroundTask({root:f.backgroundRoot,inboxRoot:f.inboxRoot,completionRoot:f.completionRoot,binding:f.binding,codexHome:f.codexHome,
    codexCliJs:path.join(f.base,'cli.mjs'),jobId:owner.id,taskKey:'research',title:'后台资料',promptFile,now:()=>1000});
  const scheduler=new BackgroundScheduler({root:f.backgroundRoot,inboxRoot:f.inboxRoot,completionRoot:f.completionRoot,binding:f.binding,codexHome:f.codexHome,
    codexCliJs:path.join(f.base,'cli.mjs'),inbox:f.inbox,launch:()=>({unref(){},once(){}}),probe:async()=>true,now:()=>1000});
  await scheduler.tick();const dir=path.join(f.backgroundRoot,f.binding.bot,queued.taskId),claim=readBackgroundJson(path.join(dir,'claim.json')),bytes=Buffer.from('实际完成的后台草稿。');
  fs.writeFileSync(path.join(dir,'result.txt'),bytes,{mode:0o600});atomicWriteJson(path.join(dir,'run.json'),{schema:1,taskId:queued.taskId,nonce:claim.nonce,pid:12345,
    processIdentity:{bootId:'fixture',startSeconds:1},heartbeatAt:1000,status:'completed',exitCode:0,resultBytes:bytes.length,resultSha256:digest(bytes),taskSha256:digest(fs.readFileSync(path.join(dir,'task.json')))});
  f.receipt(first);owner.status='done';f.inbox.save(owner);await scheduler.tick();
  const callback=[...f.inbox.jobs.values()].find(j=>j.event.synthetic_callback);assert.ok(callback);
  Object.assign(callback,{status:'delivered',markerSeen:true,taskResultProtocolVersion:1,taskResultProtocolScope:f.scope});f.inbox.save(callback);
  assert.equal(verifyBackgroundCompletion(f.binding,callback.event,f.backgroundRoot),true);
  assert.equal(f.store.get(callback).ownerJobId,owner.id);assert.equal(f.store.get(callback).sourceJobId,callback.id);
  const result=f.store.submit(callback.id,request({resultKey:'bg-reviewed-v2',text:bytes.toString()}));
  assert.equal(result.ownerJobId,owner.id);assert.equal(f.store.get(owner).text,bytes.toString());assert.equal(f.store.get(owner).sourceJobId,callback.id);
  owner.taskResultPending=true;owner.taskBusinessStatus='complete';f.inbox.save(owner);f.open();
  assert.equal(f.store.get(owner).replyKey,result.replyKey);assert.equal(f.store.get(callback).ownerJobId,owner.id);
  const fake=f.add('om_fake',{...callback.event,message_id:'om_fake'});assert.throws(()=>f.store.submit(fake.id,request({resultKey:'fake'})),/background_unverified/);
  const forged={...callback,event:{...callback.event,action_source_job_id:'om_other'}};assert.throws(()=>f.store.get(forged));
});

test('ambiguous or broken reply-chain and one source role cannot redirect frozen owner',t=>{
  const f=fixture(t),a=f.add('om_a'),b=f.add('om_b');
  for(const [id,extra] of [['om_loop',{parent_id:'om_loop'}],['om_missing',{parent_id:'om_unknown'}],
    ['om_ambiguous',{parent_id:a.id,reply_to:b.id}],['om_rootonly',{root_id:a.id,thread_id:a.id}]]) {
    const source=f.add(id,extra);assert.throws(()=>f.store.link(source.id,a.id));assert.equal(f.store.get(source),null);
  }
  const r=f.add('om_reply',{parent_id:a.id});f.store.link(r.id,a.id);f.open();assert.equal(f.store.link(r.id,a.id).linked,true);
  const roleFile=f.store.roleFile(r.id),original=JSON.parse(fs.readFileSync(roleFile));atomicWriteJson(roleFile,{...original,ownerJobId:b.id});
  assert.throws(()=>f.store.get(r));atomicWriteJson(roleFile,original);assert.equal(f.store.get(r).ownerJobId,a.id);
});

test('concurrent source revisions cannot overwrite or advance past an outstanding answer',async t=>{
  const f=fixture(t),owner=f.add(),first=f.store.submit(owner.id,request({status:'waiting'}));f.receipt(first);
  owner.status='done';f.inbox.save(owner);const sources=[f.add('om_replyA',{parent_id:owner.id}),f.add('om_replyB',{parent_id:owner.id})];
  for(const source of sources)f.store.link(source.id,owner.id);
  const configFile=path.join(f.base,'config.json');atomicWriteJson(configFile,{runtime:{codex_home:f.codexHome},bindings:{fixture:f.binding}});
  const cliUrl=new URL('./codex-bridge-task-results-cli.mjs',import.meta.url).href;
  const attempts=sources.map((source,i)=>{
    const file=path.join(f.base,`request-${i}.json`);atomicWriteJson(file,request({resultKey:`revision-${i}`,text:`候选 ${i}`}));
    const input={args:['--bot','fixture','--job-id',source.id,'--action','complete','--request-file',file],configFile,stateRoot:f.stateRoot};
    return new Promise((resolve,reject)=>{
      const code=`import {runTaskResultCli} from ${JSON.stringify(cliUrl)};const input=JSON.parse(process.argv[1]);try{const r=runTaskResultCli(input.args,input);console.log(JSON.stringify({ok:true,replyKey:r.replyKey}));}catch(e){console.log(JSON.stringify({ok:false,error:e.code??'failed'}));}`;
      const child=spawn(process.execPath,['--input-type=module','-e',code,JSON.stringify(input)],{stdio:['ignore','pipe','pipe']});let out='',err='';
      child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.once('error',reject);child.once('exit',exit=>exit?reject(Error(err)):resolve(JSON.parse(out)));
    });
  });
  const outcomes=await Promise.all(attempts);assert.equal(outcomes.filter(r=>r.ok).length,1);
  assert.ok(['task_result_revision_conflict','task_result_prior_outstanding','task_result_terminal_frozen'].includes(outcomes.find(r=>!r.ok).error),JSON.stringify(outcomes));
  f.open();const frozen=f.store.get(owner);assert.equal(frozen.revision,2);assert.match(frozen.text,/^候选 [01]$/u);
  assert.equal(f.store.history(owner).length,2);assert.equal(f.store.stats().task_result_pending_count,1);
});

test('reader waits for live immutable publication without admitting staging or unknown catalog files',async t=>{
  const f=fixture(t),owner=f.add(),first=f.store.submit(owner.id,request({status:'waiting'}));f.receipt(first);
  owner.status='done';f.inbox.save(owner);const source=f.add('om_paused_publish',{parent_id:owner.id});f.store.link(source.id,owner.id);
  const configFile=path.join(f.base,'config.json'),requestFile=path.join(f.base,'request.json');
  atomicWriteJson(configFile,{runtime:{codex_home:f.codexHome},bindings:{fixture:f.binding}});
  atomicWriteJson(requestFile,request({resultKey:'paused-v2',text:'完整冻结的第二次答复。'}));
  const cliUrl=new URL('./codex-bridge-task-results-cli.mjs',import.meta.url).href,
    input={args:['--bot','fixture','--job-id',source.id,'--action','complete','--request-file',requestFile],configFile,stateRoot:f.stateRoot};
  // Pause the real publisher after its exclusive link, like a scheduler delay.
  // The parent must not mistake that complete owned inode for a foreign link.
  const code=`import fs from 'node:fs';import {runTaskResultCli} from ${JSON.stringify(cliUrl)};const input=JSON.parse(process.argv[1]),link=fs.linkSync;fs.linkSync=(a,b)=>{const r=link(a,b);if(b.endsWith('v-000002.json')){console.log('published');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120);}return r;};try{const r=runTaskResultCli(input.args,input);console.log(JSON.stringify({ok:true,revision:r.revision}));}catch(e){console.log(JSON.stringify({ok:false,error:e.code??'failed'}));process.exitCode=1;}`;
  const child=spawn(process.execPath,['--input-type=module','-e',code,JSON.stringify(input)],{stdio:['ignore','pipe','pipe']});
  let out='',err='';const published=new Promise((resolve,reject)=>{child.stdout.on('data',value=>{out+=value;if(out.includes('published\n'))resolve();});child.once('error',reject);});
  const completed=new Promise((resolve,reject)=>{child.stderr.on('data',value=>err+=value);child.once('error',reject);child.once('exit',exit=>exit?reject(Error(err||out)):resolve());});
  await published;const result=f.store.get(owner);assert.equal(result.revision,2);assert.equal(result.text,'完整冻结的第二次答复。');await completed;
  const catalog=path.join(f.store.dir,`results-${digest(owner.id)}`),staging=path.join(f.store.dir,'staging');
  assert.deepEqual(fs.readdirSync(catalog).sort(),['v-000001.json','v-000002.json']);assert.deepEqual(fs.readdirSync(staging),[]);
  const orphan=path.join(staging,`${digest(path.join(catalog,'v-000003.json'))}.00000000-0000-0000-0000-000000000000.tmp`);
  fs.writeFileSync(orphan,'uncommitted fixture bytes',{mode:0o600});assert.equal(f.store.get(owner).revision,2);
  fs.writeFileSync(path.join(catalog,'unknown.json'),'{}',{mode:0o600});assert.throws(()=>f.store.get(owner),/history_invalid/);
});

test('abandoned linked publication remains blocked and never becomes a replayable result',t=>{
  const f=fixture(t),owner=f.add();f.store.submit(owner.id,request());
  const file=path.join(f.store.dir,`results-${digest(owner.id)}`,'v-000001.json'),
    staging=path.join(f.store.dir,'staging'),orphan=path.join(staging,`${digest(file)}.00000000-0000-0000-0000-000000000000.tmp`);
  fs.linkSync(file,orphan);f.open();assert.throws(()=>f.store.get(owner),/publication_pending/);
  assert.equal(fs.lstatSync(file).nlink,2);assert.equal(fs.existsSync(orphan),true);
  assert.throws(()=>f.store.submit(owner.id,request()),/publication_pending/);
  fs.unlinkSync(orphan);assert.equal(f.store.get(owner).revision,1);
  const foreign=path.join(f.base,'foreign-link.json');fs.linkSync(file,foreign);
  assert.throws(()=>f.store.get(owner),/private_file_invalid/);
});

function actionFixture(t,{status='complete',action='shorter',now=()=>1000}={}) {
  const f=fixture(t),owner=f.add(),streamKey='fixture-task-card';owner.streamKey=streamKey;f.inbox.save(owner);
  const first=f.store.submit(owner.id,request({status}));f.receipt(first);owner.status='done';f.inbox.save(owner);
  const actions=new ActionStore({root:path.join(f.stateRoot,'actions-v1'),bot:f.binding.bot,now});
  const registration={key:`task:${owner.id}`,sourceJobId:owner.id,codexThreadId:f.binding.codex_thread_id,chatId:f.binding.chat_id,
    allowedSenderId:f.binding.allowed_sender_id,answer:first.text,messageId:'om_visiblecard',version:1,mode:status==='waiting'?'waiting':'complete'};
  const context=actions.registerContext(registration),cardFile=path.join(f.stateRoot,'outbound-v3',f.binding.bot,`card-${digest(streamKey)}.json`);
  atomicWriteJson(cardFile,{key:streamKey,jobId:owner.id,messageId:'om_visiblecard',taskResult:{ownerJobId:owner.id,revision:1,status},
    finalReplyKey:first.replyKey,finalDelivered:true,presentation:{actionContext:context.contextId}});
  const envelope={schema:'2.0',header:{event_type:'card.action.trigger',event_id:'fixture-event',app_id:'fixture-app'},event:{host:'im_message',
    operator:{open_id:f.binding.allowed_sender_id},context:{open_chat_id:f.binding.chat_id,open_message_id:'om_visiblecard'},
    action:{tag:'button',value:{context_id:context.contextId,version:1,action},...(action==='conditions'?{form_value:{extra:'已补充需要的条件'}}:{})}}};
  assert.equal(actions.acceptCallback(envelope,{binding:f.binding,authenticatedBot:f.binding.bot,appId:'fixture-app'}).accepted,true);
  actions.drain({binding:f.binding,inbox:f.inbox});const callback=[...f.inbox.jobs.values()].find(j=>j.event.synthetic_callback);
  Object.assign(callback,{taskResultProtocolVersion:1,taskResultProtocolScope:f.scope});f.inbox.save(callback);
  const activate=()=>{callback.markerSeen=true;callback.status='delivered';f.inbox.save(callback);};
  return {...f,owner,first,actions,registration,context,callback,cardFile,activate,store:f.store};
}

test('authentic action callback is validated before marker; quick answer revision remains readable after context advances',t=>{
  const f=actionFixture(t);assert.deepEqual(f.store.verifyActionEvent(f.callback.event),{ownerJobId:f.owner.id,action:'shorter'});
  assert.throws(()=>f.store.submit(f.callback.id,request({resultKey:'shorter-v2'})),/source_mismatch/);f.activate();
  const revised=f.store.submit(f.callback.id,request({resultKey:'shorter-v2',text:'精简后的原答案。'}));assert.equal(revised.updateKind,'answer_revision');
  f.receipt(revised);const next=f.actions.registerContext({...f.registration,version:2,answer:revised.text});
  const card=JSON.parse(fs.readFileSync(f.cardFile));card.presentation.actionContext=next.contextId;atomicWriteJson(f.cardFile,card);
  assert.throws(()=>f.store.verifyActionEvent(f.callback.event),/action_stale/);
  assert.equal(f.store.get(f.owner).text,revised.text);assert.equal(f.store.get(f.callback).updateKind,'answer_revision');
  assert.equal(f.store.submit(f.callback.id,request({resultKey:'shorter-v2',text:revised.text})).duplicate,true);
});

test('actual ActionStore callback remains verifiable when each clock read advances',t=>{
  let ticks=1000;const f=actionFixture(t,{now:()=>ticks++});
  const operation=JSON.parse(fs.readFileSync(f.actions.operationFile(f.context.contextId,f.callback.id),'utf8'));
  assert.equal(ticks,1004);assert.equal(operation.acceptedAt,1002); // Drain has its own later checkpoint clock sample.
  assert.equal(f.callback.event.timestamp,new Date(1002).toISOString());
  assert.deepEqual(f.store.verifyActionEvent(f.callback.event),{ownerJobId:f.owner.id,action:'shorter'});
  f.activate();assert.equal(f.store.submit(f.callback.id,request({resultKey:'clock-callback-v2'})).ownerJobId,f.owner.id);
});

test('private accepted historical callback allows bounded canonical forward skew and rejects timestamp forgery',t=>{
  const f=actionFixture(t),operationFile=f.actions.operationFile(f.context.contextId,f.callback.id),
    original=JSON.parse(fs.readFileSync(operationFile,'utf8')),
    contextFile=f.actions.contextFile(f.context.contextId),context=JSON.parse(fs.readFileSync(contextFile,'utf8'));
  const timestamp=(value,{operation=true}={})=>{
    f.callback.event={...original.event,timestamp:value};f.inbox.save(f.callback);
    atomicWriteJson(operationFile,{...original,event:operation?{...f.callback.event}:original.event});
  };
  for(const offset of [0,1,1000]) {
    timestamp(new Date(original.acceptedAt+offset).toISOString());
    assert.equal(f.store.verifyActionEvent(f.callback.event).ownerJobId,f.owner.id);
  }
  for(const value of [new Date(original.acceptedAt-1).toISOString(),new Date(original.acceptedAt+1001).toISOString(),
    '1970-01-01T00:00:01Z','1970-01-01T00:00:01.000+00:00','invalid']) {
    timestamp(value);assert.throws(()=>f.store.verifyActionEvent(f.callback.event),/action_unverified/);
  }
  timestamp(new Date(original.acceptedAt+1).toISOString(),{operation:false});
  assert.throws(()=>f.store.verifyActionEvent(f.callback.event),/action_unverified/);
  atomicWriteJson(contextFile,{...context,expiresAt:original.acceptedAt+20});
  timestamp(new Date(original.acceptedAt+19).toISOString());assert.equal(f.store.verifyActionEvent(f.callback.event).ownerJobId,f.owner.id);
  timestamp(new Date(original.acceptedAt+20).toISOString());assert.throws(()=>f.store.verifyActionEvent(f.callback.event),/action_unverified/);
});

test('form continuation requires waiting owner; operation/event/context/private-card tampering fails closed',t=>{
  const f=actionFixture(t,{status:'waiting',action:'conditions'});f.activate();
  const operationFile=path.join(f.stateRoot,'actions-v1',f.binding.bot,'contexts',f.context.contextId,'operations',`${f.callback.id}.json`),
    contextFile=path.join(f.stateRoot,'actions-v1',f.binding.bot,'contexts',f.context.contextId,'context.json'),
    originalOperation=JSON.parse(fs.readFileSync(operationFile)),originalContext=JSON.parse(fs.readFileSync(contextFile));
  for(const patch of [{action:'delete'},{binding:{...originalOperation.binding,chat_id:'oc_foreign'}},{acceptedAt:originalContext.expiresAt},{sequence:0},
    {event:{...originalOperation.event,action_source_job_id:'om_other'}}]) {
    atomicWriteJson(operationFile,{...originalOperation,...patch});assert.throws(()=>f.store.verifyActionEvent(f.callback.event));
  }
  atomicWriteJson(operationFile,originalOperation);
  for(const patch of [{answerHash:'0'.repeat(64)},{messageId:'om_other'},{keyHash:'0'.repeat(64)},{version:2},
    {allowedSenderId:'ou_Other'}]) {
    atomicWriteJson(contextFile,{...originalContext,...patch});assert.throws(()=>f.store.verifyActionEvent(f.callback.event));
  }
  atomicWriteJson(contextFile,originalContext);
  const card=JSON.parse(fs.readFileSync(f.cardFile));atomicWriteJson(f.cardFile,{...card,jobId:'om_unknown'});
  assert.throws(()=>f.store.verifyActionEvent(f.callback.event));atomicWriteJson(f.cardFile,card);
  const final=f.store.submit(f.callback.id,request({resultKey:'conditions-v2'}));assert.equal(final.ownerJobId,f.owner.id);assert.equal(final.updateKind,undefined);
  const complete=actionFixture(t,{status:'complete',action:'conditions'});complete.activate();
  assert.throws(()=>complete.store.submit(complete.callback.id,request({resultKey:'bad-conditions'})),/action_stale/);
});

test('outgoing card reply maps exact private owner once, rejects duplicate card identities and other sender',t=>{
  const f=actionFixture(t,{status:'waiting',action:'conditions'}),source=f.add('om_human_reply',{parent_id:'om_visiblecard'});
  assert.equal(f.store.link(source.id,f.owner.id).ownerJobId,f.owner.id);
  assert.equal(f.store.submit(source.id,request({resultKey:'card-reply-v2'})).ownerJobId,f.owner.id);
  const other=f.add('om_wrong_sender',{parent_id:'om_visiblecard',sender_id:'ou_Other'});assert.throws(()=>f.store.link(other.id,f.owner.id));
  const duplicateKey='duplicate-card',duplicate=path.join(path.dirname(f.cardFile),`card-${digest(duplicateKey)}.json`),card=JSON.parse(fs.readFileSync(f.cardFile));
  atomicWriteJson(duplicate,{...card,key:duplicateKey});const fresh=f.add('om_duplicate_reply',{parent_id:'om_visiblecard'});
  assert.throws(()=>f.store.link(fresh.id,f.owner.id));assert.equal(f.store.get(fresh),null);
});

test('valid user form can freeze only an explicit waiting result',t=>{
  const f=fixture(t),source=f.add(),text='请补充资料。\n```feishu-form\n'+JSON.stringify({version:1,title:'条件',fields:[{name:'extra',label:'要求',type:'text'}]})+'\n```';
  assert.throws(()=>f.store.submit(source.id,request({text})),/form_status_mismatch/);assert.equal(f.store.get(source),null);
  assert.equal(f.store.submit(source.id,request({text,status:'waiting'})).status,'waiting');
});

function recoveryFixture(t) {
  const f=fixture(t),owner=f.add(),value=request({title:'只读结果恢复',text:'原先已读取的查询结果；自动提醒仍未启用。'}),stamp=Date.now();
  Object.assign(owner,{markerTurnId:'fixture-owning-turn',streamKey:'fixture-recovery-stream',taskResultProtocolBlocked:'turn_ended_without_task_result',
    taskResultProtocolBlockedAt:stamp-1000});f.inbox.save(owner);
  const file=path.join(f.base,'reviewed-result.json');atomicWriteJson(file,value);
  const cardFile=path.join(f.store.outboundRoot,f.binding.bot,`card-${digest(owner.streamKey)}.json`);
  atomicWriteJson(cardFile,{key:owner.streamKey,jobId:owner.id,messageId:'om_original_card',final:false,revision:2,sentRevision:2});
  const proof={schema:1,action:'resume_delivery_only',reviewed:true,scopeHash:f.store.scopeHash,sourceHash:taskResultSourceHash(owner),markerTurnId:owner.markerTurnId,
    blockedCode:owner.taskResultProtocolBlocked,blockedAt:owner.taskResultProtocolBlockedAt,requestHash:taskResultRequestHash(value),requestFile:file,
    requestFileSha256:digest(fs.readFileSync(file)),reviewedAt:new Date(stamp).toISOString()};
  const proofFile=f.store.recoveryFile(owner.id,value.resultKey);fs.mkdirSync(path.dirname(proofFile),{recursive:true,mode:0o700});atomicWriteJson(proofFile,proof);
  return {...f,owner,value,file,cardFile,proof,proofFile,stamp,store:f.store};
}

test('reviewed private recovery freezes only the original delivery and reconciles duplicates after expiry',t=>{
  const f=recoveryFixture(t),before=fs.readFileSync(path.join(f.inboxRoot,f.binding.bot,`job-${digest(f.owner.id)}.json`));
  assert.throws(()=>f.store.submit(f.owner.id,f.value),/submitter_not_active/);
  const result=f.store.recover(f.owner.id,f.value);assert.equal(result.duplicate,false);assert.equal(result.revision,1);assert.equal(result.delivered,false);
  assert.deepEqual(fs.readFileSync(path.join(f.inboxRoot,f.binding.bot,`job-${digest(f.owner.id)}.json`)),before);
  assert.equal(f.store.get(f.owner).text,f.value.text);f.receipt(result);
  f.owner.status='done';delete f.owner.taskResultProtocolBlocked;delete f.owner.taskResultProtocolBlockedAt;f.inbox.save(f.owner);
  fs.unlinkSync(f.file);f.open({now:()=>f.stamp+60*60*1000});
  const duplicate=f.store.recover(f.owner.id,f.value);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.delivered,true);assert.equal(duplicate.replyKey,result.replyKey);
  assert.throws(()=>f.store.recover(f.owner.id,{...f.value,resultKey:'unreviewed-next'}));assert.equal(f.store.history(f.owner).length,1);
});

test('missing, stale, mismatched or workspace supplied recovery approval cannot bypass ordinary source protection',t=>{
  const f=recoveryFixture(t);
  const patches=[{reviewed:false},{action:'rerun_business'},{sourceHash:'0'.repeat(64)},{scopeHash:'0'.repeat(64)},{markerTurnId:'other-turn'},
    {blockedAt:f.proof.blockedAt+1},{requestHash:'0'.repeat(64)},{requestFileSha256:'0'.repeat(64)},{reviewedAt:new Date(f.stamp-16*60*1000).toISOString()},
    {reviewedAt:new Date(f.stamp+60000).toISOString()},{extra:'forged'}];
  for(const patch of patches) {atomicWriteJson(f.proofFile,{...f.proof,...patch});assert.throws(()=>f.store.recover(f.owner.id,f.value));assert.equal(f.store.history(f.owner).length,0);}
  atomicWriteJson(f.proofFile,f.proof);fs.chmodSync(f.proofFile,0o644);assert.throws(()=>f.store.recover(f.owner.id,f.value));fs.chmodSync(f.proofFile,0o600);
  fs.linkSync(f.proofFile,path.join(f.base,'proof-link'));assert.throws(()=>f.store.recover(f.owner.id,f.value));fs.unlinkSync(path.join(f.base,'proof-link'));
  fs.renameSync(f.proofFile,f.proofFile+'.original');fs.symlinkSync(f.proofFile+'.original',f.proofFile);assert.throws(()=>f.store.recover(f.owner.id,f.value));
  fs.unlinkSync(f.proofFile);assert.throws(()=>f.store.recover(f.owner.id,f.value));
  assert.throws(()=>f.store.submit(f.owner.id,f.value,{reviewed:true}),/submitter_not_active/);
});

test('recovery cannot revise changed payloads, linked/callback sources or a successful or unknown card delivery',t=>{
  const f=recoveryFixture(t);atomicWriteJson(f.file,{...f.value,text:'后来改写的答案'});assert.throws(()=>f.store.recover(f.owner.id,f.value),/request_changed/);
  atomicWriteJson(f.file,f.value);const card=JSON.parse(fs.readFileSync(f.cardFile));
  for(const patch of [{final:true},{cardClosed:true},{blocked:true},{finalDelivered:true},{finalReplyKey:'existing'},{deliveryUncertain:true},{taskResult:{status:'complete'}},{jobId:'om_other'}]) {
    atomicWriteJson(f.cardFile,{...card,...patch});assert.throws(()=>f.store.recover(f.owner.id,f.value));
  }
  atomicWriteJson(f.cardFile,card);const priorKey=digest(`${f.store.scopeHash}\0${f.owner.id}\0${f.value.resultKey}`);
  atomicWriteJson(path.join(f.inboxRoot,f.binding.bot,`sent-${priorKey}.json`),{sentAt:f.stamp});assert.throws(()=>f.store.recover(f.owner.id,f.value),/already_sent/);
  const source=f.add('om_linked',{parent_id:f.owner.id});f.store.link(source.id,f.owner.id);assert.throws(()=>f.store.recover(source.id,f.value),/source_invalid/);
});

test('recovery rechecks card and sent evidence immediately before its immutable CAS',t=>{
  const f=recoveryFixture(t),check=f.store.assertRecoveryDelivery.bind(f.store);let validations=0;
  f.store.assertRecoveryDelivery=(source,value)=>{
    if(++validations===2) {const card=JSON.parse(fs.readFileSync(f.cardFile));atomicWriteJson(f.cardFile,{...card,cardClosed:true});}
    return check(source,value);
  };
  assert.throws(()=>f.store.recover(f.owner.id,f.value),/card_invalid/);assert.equal(validations,2);assert.equal(f.store.history(f.owner).length,0);
});
