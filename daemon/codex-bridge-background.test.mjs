import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DurableInbox,digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { bindingSnapshot } from './codex-bridge-ux.mjs';
import { enqueueActionable } from './codex-bridge-completion.mjs';
import { BackgroundScheduler,verifyBackgroundCompletion,runBackgroundCli,parseBackgroundArguments } from './codex-bridge-background.mjs';
import { backgroundBudget,backgroundQueuedCount,stableJson,backgroundBinding,enqueueBackgroundTask,cancelBackgroundTask,backgroundTaskStatus,readBackgroundTask,readBackgroundJson,publishBackgroundJson } from './codex-bridge-background-store.mjs';

function fixture(t,{launchThrow=false,maxConcurrent=2}={}) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'background-store-')));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const stateRoot=path.join(base,'state'),root=path.join(stateRoot,'background-v1'),inboxRoot=path.join(stateRoot,'codex-inbox-v2'),cwd=path.join(base,'workspace');
  fs.mkdirSync(cwd,{mode:0o700});const promptFile=path.join(cwd,'draft.txt');fs.writeFileSync(promptFile,'只读整理资料，返回草稿。',{mode:0o600});
  const binding={bot:'fixture',profile:'fixture',cwd,chat_id:'ocFixture',allowed_sender_id:'ou_Owner',bot_open_id:'ou_Bot',group_access:'all_group_humans',codex_thread_id:'fixture-thread'};
  const codexCliJs=path.join(base,'cli.mjs'),codexHome=path.join(base,'codex-home');let time=Date.parse('2026-10-02T00:00:00Z'),probeAlive=true;
  const inbox=new DurableInbox(inboxRoot,binding.bot,{}, {now:()=>time});
  const source=inbox.enqueue({type:'im.message.receive_v1',message_id:'om_original',chat_id:binding.chat_id,chat_type:'group',sender_type:'user',sender_id:'ou_Member',
    message_type:'text',content:'原始人类请求',root_id:'om_root',parent_id:'om_parent',thread_id:'omt_thread',timestamp:new Date(time).toISOString(),create_time:String(time),bridge_binding:bindingSnapshot(binding)});
  Object.assign(source,{status:'delivered',markerSeen:true,feedbackDisposition:'actionable',rollout:path.join(base,'fixture-rollout.jsonl')});inbox.save(source);
  const options={root,inboxRoot,binding,jobId:source.id,promptFile,title:'研究草稿',taskKey:'draft',codexCliJs,codexHome,now:()=>time};
  const launches=[];let scheduler;
  const launch=({taskDir,nonce,task,env})=>{
    launches.push({taskDir,nonce,task,env});if(launchThrow)throw Error('unknown');
    return {unref(){launches.at(-1).unref=true;},once(){}};
  };
  const open=(overrides={})=>scheduler=new BackgroundScheduler({...options,inbox,launch,probe:async()=>probeAlive,maxConcurrent,...overrides});
  open();
  const enqueue=extra=>enqueueBackgroundTask({...options,...extra});
  const dir=id=>path.join(root,binding.bot,id);
  const schedule=id=>readBackgroundJson(path.join(dir(id),'schedule.json'),{optional:true});
  const run=(id,status='running',extra={})=>{
    const claim=readBackgroundJson(path.join(dir(id),'claim.json'));
    const record={schema:1,taskId:id,nonce:claim.nonce,pid:12345,processIdentity:{bootId:'fixture',startSeconds:1},heartbeatAt:time,status,taskSha256:digest(fs.readFileSync(path.join(dir(id),'task.json'))),...extra};
    if(status==='completed') {
      const bytes=Buffer.from(extra.finalText??'已完成只读草稿，等待审查。');fs.writeFileSync(path.join(dir(id),'result.txt'),bytes,{mode:0o600});
      Object.assign(record,{exitCode:0,resultBytes:bytes.length,resultSha256:digest(bytes)});delete record.finalText;
    }
    atomicWriteJson(path.join(dir(id),'run.json'),record);return record;
  };
  const done=job=>{job.status='done';job.completedAt=time;inbox.save(job);};
  return {base,stateRoot,root,inboxRoot,cwd,promptFile,binding,codexCliJs,codexHome,inbox,source,options,launches,enqueue,dir,schedule,run,done,open,
    get scheduler(){return scheduler;},advance:ms=>{time+=ms;},probe:v=>{probeAlive=v;}};
}
const callbacks=f=>[...f.inbox.jobs.values()].filter(job=>job.event.synthetic_callback);

test('enqueue is immutable and idempotent, with conflict checks and private prompt snapshot',t=>{
  const f=fixture(t),a=f.enqueue();f.advance(10000);assert.equal(f.enqueue().taskId,a.taskId);assert.equal(f.enqueue().duplicate,true);
  const task=readBackgroundTask(f.root,f.binding,a.taskId);assert.equal(task.runAt,task.createdAt);assert.equal(task.sourceEvent.content,undefined);
  fs.writeFileSync(f.promptFile,'changed',{mode:0o600});assert.throws(()=>f.enqueue(),/background_task_conflict/);
  assert.throws(()=>f.enqueue({title:'different'}),/background_task_conflict/);assert.equal(task.prompt,'只读整理资料，返回草稿。');
  assert.equal(fs.statSync(path.join(f.dir(a.taskId),'task.json')).mode&0o077,0);
});

test('source identity, classification, turn end, active status and prompt paths fail closed',t=>{
  const f=fixture(t),original=structuredClone(f.source);
  for(const change of [{markerSeen:false},{feedbackDisposition:'silent'},{feedbackDisposition:undefined},{unclassifiedTurnEnded:true},{status:'done'},
    {event:{...original.event,synthetic_callback:true}},{event:{...original.event,sender_type:'app'}},
    {event:{...original.event,bridge_binding:{...original.event.bridge_binding,chat_id:'ocWrong'}}}]) {
    Object.assign(f.source,change);f.inbox.save(f.source);assert.throws(()=>f.enqueue());
    for(const key of Object.keys(f.source))delete f.source[key];Object.assign(f.source,structuredClone(original));f.inbox.save(f.source);
  }
  const outside=path.join(f.base,'outside.txt');fs.writeFileSync(outside,'outside',{mode:0o600});assert.throws(()=>f.enqueue({promptFile:outside}),/outside_cwd/);
  const linked=path.join(f.cwd,'linked.txt');fs.symlinkSync(f.promptFile,linked);assert.throws(()=>f.enqueue({promptFile:linked}),/path_invalid/);
  fs.chmodSync(f.promptFile,0o666);assert.throws(()=>f.enqueue(),/private_file_invalid/);fs.chmodSync(f.promptFile,0o600);
  fs.writeFileSync(f.promptFile,'x'.repeat(65537));assert.throws(()=>f.enqueue(),/private_file_invalid/);
});

test('real actionable decision can authorize a marked job without cached disposition',t=>{
  const f=fixture(t);delete f.source.feedbackDisposition;f.inbox.save(f.source);
  enqueueActionable({root:path.join(f.stateRoot,'completions-v1'),inboxRoot:f.inboxRoot,binding:f.binding,jobId:f.source.id});
  assert.equal(f.enqueue().queued,true);
});

test('future one-shot schedule, bounded concurrency and detached nonblocking tick',async t=>{
  const f=fixture(t);for(const taskKey of ['a','b','c'])f.enqueue({taskKey});const later=f.enqueue({taskKey:'later',runAt:'2026-10-02T00:01:00+00:00'});
  await f.scheduler.tick();assert.equal(f.launches.length,2);assert.ok(f.launches.every(l=>l.unref));
  const [first,second]=f.launches.map(l=>l.task.id);f.run(first);f.run(second);f.open();await f.scheduler.tick();
  assert.equal(f.launches.length,2);assert.equal(f.scheduler.stats().background_running_count,2);
  f.run(first,'completed');await f.scheduler.tick();assert.equal(f.launches.length,3);const third=f.launches[2].task.id;
  f.run(second,'failed',{errorCategory:'child_failed'});f.run(third,'completed');await f.scheduler.tick();assert.equal(f.launches.length,3);
  f.advance(60000);await f.scheduler.tick();assert.equal(f.launches.length,4);assert.equal(f.schedule(later.taskId).status,'claimed');
  assert.throws(()=>f.enqueue({taskKey:'bad',runAt:'2026-10-02T00:01:00'}),/run_at_invalid/);
  assert.throws(()=>f.enqueue({taskKey:'bad',runAt:'not a date'}),/run_at_invalid/);assert.throws(()=>f.enqueue({timeoutMs:1000}),/timeout_invalid/);
});

test('claim crash is indeterminate, reserved and never spawns again across restart',async t=>{
  const f=fixture(t),a=f.enqueue(),nonce=randomUUID();publishBackgroundJson(path.join(f.dir(a.taskId),'claim.json'),{schema:1,taskId:a.taskId,nonce,claimedAt:f.options.now()});
  await f.scheduler.tick();assert.equal(f.launches.length,0);f.advance(10001);f.open();await f.scheduler.tick();
  assert.equal(f.schedule(a.taskId).status,'indeterminate');assert.equal(f.scheduler.stats().background_running_count,1);
  f.done(f.source);await f.scheduler.tick();f.done(callbacks(f)[0]);await f.scheduler.tick();
  assert.equal(f.scheduler.stats().background_blocked_count,0);assert.equal(f.scheduler.stats().background_running_count,1);assert.equal(f.launches.length,0);
});

test('unknown launches and corrupted claimed records cannot release capacity',async t=>{
  const f=fixture(t,{launchThrow:true});for(const taskKey of ['a','b','c'])f.enqueue({taskKey});await f.scheduler.tick();
  assert.equal(f.launches.length,2);assert.equal(f.scheduler.stats().background_running_count,2);
  f.advance(20000);f.open();await f.scheduler.tick();assert.equal(f.launches.length,2);
  const id=f.launches[0].task.id;fs.writeFileSync(path.join(f.dir(id),'run.json'),'{broken',{mode:0o600});await f.scheduler.tick();assert.equal(f.launches.length,2);
  assert.ok(f.scheduler.stats().background_running_count>=2);
});

test('dead or reused identity is unknown, then late confirmed outcome uses a separate immutable notification',async t=>{
  const f=fixture(t),a=f.enqueue();await f.scheduler.tick();f.run(a.taskId);f.done(f.source);f.probe(false);await f.scheduler.tick();
  assert.equal(f.schedule(a.taskId).status,'indeterminate');assert.equal(callbacks(f).length,1);const unknown=callbacks(f)[0],content=unknown.event.content;
  f.run(a.taskId,'completed');f.probe(true);await f.scheduler.tick();assert.equal(callbacks(f).length,1);assert.equal(verifyBackgroundCompletion(f.binding,unknown.event,f.root),true);
  f.done(unknown);await f.scheduler.tick();assert.equal(callbacks(f).length,2);assert.equal(unknown.event.content,content);
  const completed=callbacks(f)[1];assert.equal(verifyBackgroundCompletion(f.binding,completed.event,f.root),true);f.done(completed);await f.scheduler.tick();
  assert.equal(f.scheduler.stats().background_running_count,0);assert.equal(f.scheduler.stats().background_result_pending_count,0);assert.equal(f.launches.length,1);
});

test('completion waits for real source done, deduplicates queueing, and only done marks notified',async t=>{
  const f=fixture(t),a=f.enqueue();await f.scheduler.tick();f.run(a.taskId,'completed');await f.scheduler.tick();assert.equal(callbacks(f).length,0);
  f.done(f.source);f.open();await f.scheduler.tick();assert.equal(callbacks(f).length,1);const callback=callbacks(f)[0];
  assert.equal(f.schedule(a.taskId).notification.status,'queued');assert.equal(f.scheduler.stats().background_result_pending_count,1);
  f.open();await f.scheduler.tick();assert.equal(callbacks(f).length,1);assert.equal(verifyBackgroundCompletion(f.binding,callback.event,f.root),true);
  callback.status='submitted';f.inbox.save(callback);await f.scheduler.tick();assert.equal(f.schedule(a.taskId).notification.status,'queued');
  f.done(callback);await f.scheduler.tick();assert.equal(f.schedule(a.taskId).notification.status,'notified');assert.equal(f.scheduler.stats().background_result_pending_count,0);
});

test('notification accept-to-checkpoint crash reconciles the existing synthetic job without reinjection',async t=>{
  const f=fixture(t),a=f.enqueue();await f.scheduler.tick();f.run(a.taskId,'completed');f.done(f.source);
  const enqueue=f.inbox.enqueue.bind(f.inbox);let once=true;f.inbox.enqueue=event=>{const job=enqueue(event);if(once){once=false;throw Error('checkpoint crash');}return job;};
  await f.scheduler.tick();assert.equal(callbacks(f).length,1);assert.equal(f.schedule(a.taskId).notification.status,'pending');
  f.open();await f.scheduler.tick();assert.equal(callbacks(f).length,1);assert.equal(f.schedule(a.taskId).notification.status,'queued');
});

test('queued cancel never launches; running cancel uses exact nonce; already finished cancellation is reported honestly',async t=>{
  const f=fixture(t),a=f.enqueue();assert.equal(cancelBackgroundTask(f.options).cancelRequested,true);await f.scheduler.tick();assert.equal(f.launches.length,0);assert.equal(f.schedule(a.taskId).status,'cancelled');
  const b=f.enqueue({taskKey:'running'});await f.scheduler.tick();f.run(b.taskId);cancelBackgroundTask({...f.options,taskKey:'running'});
  assert.equal(readBackgroundJson(path.join(f.dir(b.taskId),'cancel.json')).nonce,f.schedule(b.taskId).nonce);
  f.run(b.taskId,'cancelled',{errorCategory:'cancelled'});await f.scheduler.tick();assert.equal(f.schedule(b.taskId).status,'cancelled');
  const c=f.enqueue({taskKey:'finished'});await f.scheduler.tick();f.run(c.taskId,'completed');
  const result=cancelBackgroundTask({...f.options,taskKey:'finished'});assert.equal(result.alreadyFinished,true);assert.equal(result.cancelRequested,false);
  assert.equal(fs.existsSync(path.join(f.dir(c.taskId),'cancel.json')),false);
});
test('delivered unknown notification does not prevent exact-nonce cancellation or release the runner reservation',async t=>{
  const f=fixture(t),a=f.enqueue();await f.scheduler.tick();const run=f.run(a.taskId);f.done(f.source);f.probe(false);await f.scheduler.tick();
  f.done(callbacks(f)[0]);await f.scheduler.tick();assert.equal(f.schedule(a.taskId).notification.status,'notified');
  const result=cancelBackgroundTask(f.options);assert.equal(result.cancelRequested,true);assert.equal(result.alreadyFinished,undefined);
  const cancellation=readBackgroundJson(path.join(f.dir(a.taskId),'cancel.json'));assert.equal(cancellation.nonce,run.nonce);
  f.advance(1000);cancelBackgroundTask(f.options);assert.deepEqual(readBackgroundJson(path.join(f.dir(a.taskId),'cancel.json')),cancellation);
  f.open();await f.scheduler.tick();assert.equal(f.launches.length,1);assert.equal(f.scheduler.stats().background_running_count,1);
  f.run(a.taskId,'cancelled',{errorCategory:'cancelled'});await f.scheduler.tick();assert.equal(f.scheduler.stats().background_running_count,0);
  assert.equal(callbacks(f).length,2);assert.equal(JSON.parse(JSON.parse(callbacks(f)[1].event.content).text.split('\n').at(-1)).status,'cancelled');
});
test('only a latest terminal run with matching task hash and claim nonce can block cancellation',async t=>{
  const f=fixture(t),a=f.enqueue();await f.scheduler.tick();const original=f.run(a.taskId,'completed'),file=path.join(f.dir(a.taskId),'run.json');
  for(const patch of [{nonce:randomUUID()},{taskSha256:'0'.repeat(64)},{schema:2},{taskId:'f'.repeat(64)},{status:'indeterminate'}]) {
    atomicWriteJson(file,{...original,...patch});const result=cancelBackgroundTask(f.options);
    assert.equal(result.cancelRequested,true);assert.equal(result.alreadyFinished,undefined);
    assert.equal(readBackgroundJson(path.join(f.dir(a.taskId),'cancel.json')).nonce,original.nonce);
  }
  atomicWriteJson(file,original);
  const state=f.schedule(a.taskId);state.notification={status:'notified'};atomicWriteJson(path.join(f.dir(a.taskId),'schedule.json'),state);
  const result=cancelBackgroundTask(f.options);assert.equal(result.alreadyFinished,true);assert.equal(result.status,'completed');assert.equal(result.cancelRequested,false);
  assert.equal(f.launches.length,1);
});
test('missing or invalid claim nonce stays cancellation-unknown and cannot replay the runner',async t=>{
  for(const mode of ['missing','invalid']) {
    const f=fixture(t),a=f.enqueue();await f.scheduler.tick();f.run(a.taskId);
    const file=path.join(f.dir(a.taskId),'claim.json');
    if(mode==='missing')fs.unlinkSync(file);else atomicWriteJson(file,{schema:1,taskId:a.taskId,nonce:'unverified'});
    const result=cancelBackgroundTask(f.options);assert.equal(result.cancelUnknown,true);assert.equal(result.cancelRequested,false);
    assert.equal(fs.existsSync(path.join(f.dir(a.taskId),'cancel.json')),false);
    f.open();await f.scheduler.tick();assert.equal(f.launches.length,1);assert.equal(f.scheduler.stats().background_running_count,1);
  }
});

test('binding/runtime changes prevent callbacks but preserve live or unknown runner reservations',async t=>{
  const f=fixture(t),a=f.enqueue();await f.scheduler.tick();f.run(a.taskId);f.done(f.source);
  f.open({binding:{...f.binding,codex_thread_id:'changed'}});await f.scheduler.tick();assert.equal(callbacks(f).length,0);assert.equal(f.scheduler.stats().background_running_count,1);
  assert.equal(f.schedule(a.taskId).executionBlocked,'binding_changed');
  f.open({codexHome:path.join(f.base,'changed-home')});await f.scheduler.tick();assert.equal(f.scheduler.stats().background_running_count,1);
  f.run(a.taskId,'completed');await f.scheduler.tick();assert.equal(callbacks(f).length,0);assert.equal(f.scheduler.stats().background_running_count,0);
});

test('silent source or result hash/path tampering prevents valid result callback proof',async t=>{
  const f=fixture(t),a=f.enqueue();await f.scheduler.tick();f.run(a.taskId,'completed');f.done(f.source);
  f.source.feedbackDisposition='silent';f.inbox.save(f.source);await f.scheduler.tick();assert.equal(callbacks(f).length,0);
  f.source.feedbackDisposition='actionable';f.inbox.save(f.source);await f.scheduler.tick();const callback=callbacks(f)[0];assert.equal(verifyBackgroundCompletion(f.binding,callback.event,f.root),true);
  fs.writeFileSync(path.join(f.dir(a.taskId),'result.txt'),'modified',{mode:0o600});assert.equal(verifyBackgroundCompletion(f.binding,callback.event,f.root),false);
  const linked=path.join(f.dir(a.taskId),'result.txt');fs.unlinkSync(linked);fs.symlinkSync(f.promptFile,linked);assert.equal(verifyBackgroundCompletion(f.binding,callback.event,f.root),false);
});

test('fake callbacks and any altered route, time, content or local capability field are rejected',async t=>{
  const f=fixture(t),a=f.enqueue();await f.scheduler.tick();f.run(a.taskId,'completed');f.done(f.source);await f.scheduler.tick();const event=callbacks(f)[0].event;
  assert.equal(verifyBackgroundCompletion(f.binding,{...event},f.root),true);
  for(const change of [{synthetic_callback:false},{message_id:'om_fake'},{background_task_id:'0'.repeat(64)},
    {background_nonce:randomUUID()},{content:'forged'},{thread_id:'omt_other'},{parent_id:'om_other'},{root_id:'om_other'},
    {create_time:'0'},{timestamp:'2000-01-01T00:00:00Z'},{native_context_verified:true}])
    assert.equal(verifyBackgroundCompletion(f.binding,{...event,...change},f.root),false);
});

test('CLI reads fixed private config, validates known arguments, and status stays separate from delivery',t=>{
  const f=fixture(t),configFile=path.join(f.base,'config.json');atomicWriteJson(configFile,{runtime:{codex_cli_js:f.codexCliJs,codex_home:f.codexHome},bindings:{fixture:f.binding}});
  const args=['--bot','fixture','--job-id','om_original','--task-key','draft','--action','enqueue','--title','研究草稿','--prompt-file',f.promptFile];
  const result=runBackgroundCli(args,{configFile,stateRoot:f.stateRoot,now:f.options.now});assert.equal(result.queued,true);assert.equal(result.delivered,false);
  const status=runBackgroundCli(args.slice(0,6).concat(['--action','status']),{configFile,stateRoot:f.stateRoot});assert.equal(status.status,'queued');assert.equal(status.delivered,false);
  assert.throws(()=>parseBackgroundArguments(args.concat(['--cmd','dangerous'])),/arguments_invalid/);
  assert.throws(()=>backgroundTaskStatus({...f.options,jobId:'om_other'}));
});

test('large final preserves full local bytes/hash and sends a bounded Unicode preview',async t=>{
  const f=fixture(t),a=f.enqueue();await f.scheduler.tick();const text='😀"\\\n'.repeat(30000);assert.ok(Buffer.byteLength(text)<256*1024);
  f.run(a.taskId,'completed',{finalText:text});f.done(f.source);await f.scheduler.tick();const callback=callbacks(f)[0];
  const body=JSON.parse(callback.event.content).text,result=JSON.parse(body.slice(body.indexOf('\n')+1));
  assert.equal(result.previewTruncated,true);assert.ok(Buffer.byteLength(result.finalText)<=32768);assert.equal(result.finalText.includes('\ufffd'),false);
  assert.equal(result.resultSha256,digest(Buffer.from(text)));assert.equal(result.resultFile,path.join(f.dir(a.taskId),'result.txt'));
  assert.equal(fs.readFileSync(result.resultFile,'utf8'),text);assert.ok(Buffer.byteLength(JSON.stringify(callback.event))<1024*1024);
  assert.equal(verifyBackgroundCompletion(f.binding,callback.event,f.root),true);f.open();await f.scheduler.tick();assert.equal(callbacks(f).length,1);
});

test('serialized snapshot growth, symlink state directories and runner input hash mismatches fail closed',async t=>{
  const f=fixture(t);fs.writeFileSync(f.promptFile,'\x01'.repeat(64000),{mode:0o600});assert.throws(()=>f.enqueue(),/snapshot_too_large/);
  fs.writeFileSync(f.promptFile,'ordinary',{mode:0o600});const a=f.enqueue();await f.scheduler.tick();f.run(a.taskId,'completed',{taskSha256:'0'.repeat(64)});
  f.done(f.source);await f.scheduler.tick();assert.equal(f.schedule(a.taskId).status,'indeterminate');assert.equal(f.scheduler.stats().background_running_count,1);
  const old=f.dir(a.taskId),moved=old+'-moved';fs.renameSync(old,moved);fs.symlinkSync(moved,old);assert.throws(()=>readBackgroundTask(f.root,f.binding,a.taskId),/private_path_invalid/);
});

test('source returns to reply_pending for late card recovery, then completion resumes once done and actionable',async t=>{
  const f=fixture(t),a=f.enqueue();await f.scheduler.tick();f.run(a.taskId,'completed');f.source.status='reply_pending';f.inbox.save(f.source);
  await f.scheduler.tick();assert.equal(callbacks(f).length,0);assert.equal(f.schedule(a.taskId).status,'completed');
  f.done(f.source);await f.scheduler.tick();assert.equal(callbacks(f).length,1);assert.equal(verifyBackgroundCompletion(f.binding,callbacks(f)[0].event,f.root),true);
});

test('missing claim never releases an already running reservation during a binding change',async t=>{
  const f=fixture(t),a=f.enqueue();await f.scheduler.tick();f.run(a.taskId);await f.scheduler.tick();
  fs.unlinkSync(path.join(f.dir(a.taskId),'claim.json'));f.open({binding:{...f.binding,codex_thread_id:'changed'}});await f.scheduler.tick();
  assert.equal(f.scheduler.stats().background_running_count,1);assert.equal(f.schedule(a.taskId).status,'indeterminate');assert.equal(f.launches.length,1);
});

test('failed, timed-out and cancelled outcomes remain safe data and cease blocking after their real notification is done',async t=>{
  for(const status of ['failed','timed_out','cancelled']) {
    const f=fixture(t),a=f.enqueue();await f.scheduler.tick();f.run(a.taskId,status,{errorCategory:'sensitive_raw_error',stderr:'private detail'});f.done(f.source);await f.scheduler.tick();
    const callback=callbacks(f)[0];assert.equal(callback.event.content.includes('private detail'),false);assert.equal(callback.event.content.includes('sensitive_raw_error'),false);
    assert.equal(verifyBackgroundCompletion(f.binding,callback.event,f.root),true);f.done(callback);await f.scheduler.tick();
    assert.equal(f.scheduler.stats().background_blocked_count,0);assert.equal(f.scheduler.stats().background_running_count,0);
  }
});


test('escaped control-character preview remains verifiable after durable prepared snapshot duplicates the envelope',async t=>{
  const f=fixture(t),a=f.enqueue();await f.scheduler.tick();f.run(a.taskId,'completed',{finalText:'\x01'.repeat(65536)});f.done(f.source);await f.scheduler.tick();
  const callback=callbacks(f)[0];assert.equal(verifyBackgroundCompletion(f.binding,callback.event,f.root),true);
  callback.prepared=structuredClone(callback.event);callback.status='submitted';f.inbox.save(callback);
  assert.ok(fs.statSync(path.join(f.inboxRoot,f.binding.bot,`job-${digest(callback.id)}.json`)).size>512*1024);
  assert.equal(verifyBackgroundCompletion(f.binding,callback.event,f.root),true);
});


test('GUI environment receives only validated private loopback proxy fallback before detached launch',async t=>{
  const f=fixture(t),a=f.enqueue(),proxyEnv={HTTP_PROXY:'http://127.0.0.1:7890',HTTPS_PROXY:'http://localhost:7890',
    ALL_PROXY:'socks5h://[::1]:7890',http_proxy:'http://127.0.0.1:7890',NO_PROXY:'localhost,127.0.0.1,::1'};
  atomicWriteJson(path.join(f.root,f.binding.bot,'transport.json'),{schema:1,binding:backgroundBinding(f.binding),codexHome:f.codexHome,proxyEnv});
  f.open({env:{PATH:'/fixture/bin',NODE_OPTIONS:'--untrusted',API_KEY:'untrusted',MCP_TOKEN:'untrusted'}});await f.scheduler.tick();
  assert.equal(f.launches.length,1);assert.equal(f.schedule(a.taskId).status,'claimed');
  for(const [key,value] of Object.entries(proxyEnv))assert.equal(f.launches[0].env[key],value);
  assert.equal(f.launches[0].env.CODEX_HOME,f.codexHome);assert.equal(f.launches[0].env.PATH,'/fixture/bin');
  for(const key of ['NODE_OPTIONS','API_KEY','MCP_TOKEN'])assert.equal(f.launches[0].env[key],undefined);
});

test('unsafe transport fields, scope/home changes, loose permissions and symlinks block before any claim',async t=>{
  const f=fixture(t),file=path.join(f.root,f.binding.bot,'transport.json');
  const valid={schema:1,binding:backgroundBinding(f.binding),codexHome:f.codexHome,proxyEnv:{HTTP_PROXY:'http://127.0.0.1:7890'}};
  const cases=[{...valid,proxyEnv:{OPENAI_API_KEY:'untrusted'}},{...valid,proxyEnv:{HTTP_PROXY:'http://user:pass@127.0.0.1:7890'}},
    {...valid,proxyEnv:{HTTP_PROXY:'http://example.com:7890'}},{...valid,endpoint:'http://127.0.0.1:7890'},
    {...valid,binding:{...valid.binding,profile:'other'}},{...valid,codexHome:path.join(f.base,'other-home')},null];
  for(let i=0;i<cases.length;i++) {
    const a=f.enqueue({taskKey:'invalid'+i});atomicWriteJson(file,cases[i]);f.open({env:{}});await f.scheduler.tick();
    assert.equal(f.schedule(a.taskId).status,'blocked');assert.equal(f.schedule(a.taskId).errorCategory,'transport_invalid');
    assert.equal(fs.existsSync(path.join(f.dir(a.taskId),'claim.json')),false);
  }
  const loose=f.enqueue({taskKey:'loose'});atomicWriteJson(file,valid);fs.chmodSync(file,0o644);await f.scheduler.tick();
  assert.equal(f.schedule(loose.taskId).status,'blocked');assert.equal(fs.existsSync(path.join(f.dir(loose.taskId),'claim.json')),false);
  const linked=f.enqueue({taskKey:'linked'}),target=path.join(f.base,'linked-transport.json');atomicWriteJson(target,valid);fs.unlinkSync(file);fs.symlinkSync(target,file);
  await f.scheduler.tick();assert.equal(f.schedule(linked.taskId).status,'blocked');assert.equal(f.launches.length,0);
});

test('valid runtime proxy fields take precedence and absent private transport keeps existing filtered environment',async t=>{
  const f=fixture(t),a=f.enqueue(),runtime={HTTP_PROXY:'http://127.0.0.1:7000',NO_PROXY:'localhost',PATH:'/fixture/bin'};
  f.open({env:runtime});await f.scheduler.tick();assert.equal(f.launches[0].env.HTTP_PROXY,runtime.HTTP_PROXY);assert.equal(f.launches[0].env.HTTPS_PROXY,undefined);
  f.run(a.taskId,'completed');const b=f.enqueue({taskKey:'fallback'});
  atomicWriteJson(path.join(f.root,f.binding.bot,'transport.json'),{schema:1,binding:backgroundBinding(f.binding),codexHome:f.codexHome,
    proxyEnv:{HTTP_PROXY:'http://127.0.0.1:7890',HTTPS_PROXY:'http://127.0.0.1:7890',NO_PROXY:'localhost,127.0.0.1'}});
  await f.scheduler.tick();assert.equal(f.schedule(b.taskId).status,'claimed');
  assert.equal(f.launches[1].env.HTTP_PROXY,runtime.HTTP_PROXY);assert.equal(f.launches[1].env.NO_PROXY,runtime.NO_PROXY);
  assert.equal(f.launches[1].env.HTTPS_PROXY,'http://127.0.0.1:7890');assert.deepEqual(runtime,{HTTP_PROXY:'http://127.0.0.1:7000',NO_PROXY:'localhost',PATH:'/fixture/bin'});
});


test('queue admission has a hard cap, preserves identical retries at capacity, and releases only claimed slots',async t=>{
  const f=fixture(t),a=f.enqueue({taskKey:'one',maxQueued:2}),b=f.enqueue({taskKey:'two',maxQueued:2});
  assert.equal(backgroundQueuedCount(f.root,f.binding),2);assert.equal(f.enqueue({taskKey:'one',maxQueued:2}).duplicate,true);
  assert.throws(()=>f.enqueue({taskKey:'three',maxQueued:2}),/queue_full/);assert.equal(fs.existsSync(path.join(f.root,f.binding.bot,'admission.json')),false);
  await f.scheduler.tick();assert.equal(f.launches.length,2);assert.equal(backgroundQueuedCount(f.root,f.binding),0);
  f.enqueue({taskKey:'three',maxQueued:2});assert.equal(backgroundQueuedCount(f.root,f.binding),1);
  atomicWriteJson(path.join(f.root,f.binding.bot,'admission.json'),{schema:1,nonce:'crashed-private-admission',taskId:'unknown'});
  assert.throws(()=>f.enqueue({taskKey:'four',maxQueued:2}),/queue_busy/);
  assert.equal(f.enqueue({taskKey:'three',maxQueued:2}).duplicate,true);assert.equal(f.launches.length,2);
  assert.equal(f.scheduler.stats().background_admission_blocked_count,1);
});

test('queued priority is stable and cannot preempt either claimed or unknown work',async t=>{
  const f=fixture(t);const low=f.enqueue({taskKey:'low',priority:'low'}),normal=f.enqueue({taskKey:'normal'}),high=f.enqueue({taskKey:'high',priority:'high'});
  await f.scheduler.tick();assert.deepEqual(f.launches.map(l=>l.task.id),[high.taskId,normal.taskId]);assert.equal(f.schedule(low.taskId),null);
  const urgent=f.enqueue({taskKey:'urgent',priority:'high'});await f.scheduler.tick();assert.equal(f.launches.length,2);
  f.run(high.taskId,'failed',{errorCategory:'child_failed'});f.run(normal.taskId);await f.scheduler.tick();assert.equal(f.launches[2].task.id,urgent.taskId);
  f.probe(false);await f.scheduler.tick();assert.equal(f.launches.length,3);assert.equal(f.scheduler.stats().background_running_count,2);
  assert.throws(()=>f.enqueue({taskKey:'urgent',priority:'low'}),/task_conflict/);
});

test('budget controls are bounded, deduplicated, and result readback rejects a violated per-task output limit',async t=>{
  const f=fixture(t),budget={version:1,timeoutMs:60000,maxOutputBytes:1024,researchStepLimit:2};
  for(const patch of [{maxOutputBytes:1023},{maxOutputBytes:262145},{researchStepLimit:0},{researchStepLimit:25},{timeoutMs:60001},{dollars:1},{version:2}])
    assert.throws(()=>f.enqueue({timeoutMs:60000,budget:{...budget,...patch}}),/budget_invalid/);
  assert.throws(()=>f.enqueue({priority:'urgent'}),/priority_invalid/);
  const a=f.enqueue({timeoutMs:60000,budget});assert.equal(f.enqueue({timeoutMs:60000,budget}).duplicate,true);
  assert.throws(()=>f.enqueue({timeoutMs:60000,budget:{...budget,researchStepLimit:3}}),/task_conflict/);
  await f.scheduler.tick();f.run(a.taskId,'completed',{finalText:'x'.repeat(1025)});await f.scheduler.tick();
  assert.equal(f.schedule(a.taskId).status,'failed');assert.equal(f.schedule(a.taskId).errorCategory,'result_invalid');
});

test('legacy schema-one tasks preserve old hash, idempotency, priority and output budget on read and execution',async t=>{
  const f=fixture(t),a=f.enqueue(),file=path.join(f.dir(a.taskId),'task.json'),task=readBackgroundTask(f.root,f.binding,a.taskId);
  delete task.priority;delete task.budget;
  const keys=['bot','sourceJobId','taskKey','title','prompt','runAtInput','timeoutMs','binding','sourceFingerprint','inboxRoot','sourceEvent','codexCliJs','codexHome'];
  task.requestHash=digest(stableJson(Object.fromEntries(keys.map(key=>[key,task[key]]))));atomicWriteJson(file,task);
  assert.equal(backgroundBudget(readBackgroundTask(f.root,f.binding,a.taskId)).maxOutputBytes,262144);
  assert.equal(f.enqueue().duplicate,true);assert.throws(()=>f.enqueue({priority:'high'}),/task_conflict/);
  await f.scheduler.tick();assert.equal(f.launches.length,1);assert.equal(f.launches[0].task.priority,undefined);
});
