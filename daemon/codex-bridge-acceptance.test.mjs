import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {collectBridgeAcceptance} from './codex-bridge-acceptance.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {opsScope} from './codex-bridge-ops-policy.mjs';
import {digest,DurableInbox} from './codex-bridge-inbox.mjs';
import {stableJson,enqueueBackgroundTask,readBackgroundJson} from './codex-bridge-background-store.mjs';
import {BackgroundScheduler} from './codex-bridge-background.mjs';

const base=1790852400000,epoch={deploymentId:'fixture_release',versionRef:'a'.repeat(40),startedAt:base};
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'acceptance-readonly-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',profile:'fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',bot_open_id:'ou_bot',codex_thread_id:'fixture-thread',cwd:root,group_access:'all_group_humans'};
  const event={type:'im.message.receive_v1',message_id:'om_source',message_type:'text',content:'查看后台任务',chat_id:binding.chat_id,chat_type:'group',sender_id:binding.allowed_sender_id,
    sender_type:'user',create_time:base+10,bridge_binding:bindingSnapshot(binding)};
  const job={id:event.message_id,event,status:'done',markerSeen:true,intakeEpoch:{deploymentId:epoch.deploymentId,versionRef:epoch.versionRef}};
  const write=(rootName,parts,value)=>{const dir=path.join(root,rootName,binding.bot,...parts.slice(0,-1));fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,parts.at(-1));fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});return file;};
  const jobFile=write('inbox',[`job-${digest(job.id)}.json`],job);
  const key=`task-control:${digest(`${binding.bot}\0${job.id}`)}`;
  const receipt={schema:1,id:job.id,binding:bindingSnapshot(binding),auditEvent:event,auditHash:digest(stableJson(event)),command:{action:'list'},visible:true,delivery:{key,state:'sent'}};
  const receiptFile=write('control',['receipts',`${digest(job.id)}.json`],receipt);
  const intent={scope:opsScope(binding,root),key,ownerKind:'control',ownerId:digest(job.id),jobId:job.id,msgType:'text',content:{text:'fixture result'},route:{mode:'quote',messageId:job.id}};
  const delivery={schema:1,...intent,intent,status:'verified',messageId:'om_result'};
  const deliveryFile=write('delivery',[`delivery-${digest(key)}.json`],delivery),calls=[];
  const request=async(b,args)=>{calls.push(args);assert.equal(args[1],'GET');assert.deepEqual(b,binding);
    return args[2].endsWith('/om_source')?{items:[{message_id:job.id,chat_id:binding.chat_id,msg_type:'text',deleted:false,create_time:String(event.create_time),
      sender:{sender_type:'user',id_type:'open_id',id:event.sender_id},body:{content:JSON.stringify({text:event.content})}}]}
      :{items:[{message_id:'om_result',chat_id:binding.chat_id,msg_type:'text',deleted:false,parent_id:job.id,
        sender:{sender_type:'app',id_type:'open_id',id:binding.bot_open_id},body:{content:JSON.stringify({text:'fixture result'})}}]};};
  const options={binding,codexHome:root,inboxRoot:path.join(root,'inbox'),controlRoot:path.join(root,'control'),deliveryRoot:path.join(root,'delivery'),
    backgroundRoot:path.join(root,'background'),request,metricsEpoch:epoch,now:base+1000,evidenceLabel:'test_fixture'};
  return {root,binding,event,job,jobFile,receipt,receiptFile,delivery,deliveryFile,calls,options,write};
}
test('no selected real cases stays pending and makes no GET or write',async t=>{
  const f=fixture(t),before=fs.statSync(f.jobFile).mtimeMs;const result=await collectBridgeAcceptance(f.options);
  assert.equal(result.status,'pending');assert.equal(result.reason,'no_real_cases_selected');assert.equal(f.calls.length,0);assert.equal(fs.statSync(f.jobFile).mtimeMs,before);
});
test('actual source marker, exact receipt audit and original route require fresh platform GET readback',async t=>{
  const f=fixture(t),before=[f.jobFile,f.receiptFile,f.deliveryFile].map(file=>fs.readFileSync(file));
  const report=await collectBridgeAcceptance({...f.options,cases:[{sourceJobId:f.job.id,controlJobId:f.job.id}]});
  assert.equal(report.status,'verified');assert.equal(report.results[0].source_marker,true);assert.equal(report.results[0].delivery.platform_verified,true);assert.equal(f.calls.length,2);
  assert.doesNotMatch(JSON.stringify(report),/om_source|om_result|ou_fixture|oc_fixture|fixture result|fixture-thread|查看后台|\/(?:var|Users|tmp)\//);
  [f.jobFile,f.receiptFile,f.deliveryFile].forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),before[i]));
});
test('ACK, local done and historical human samples cannot replace new-version feature acceptance',async t=>{
  const f=fixture(t);let report=await collectBridgeAcceptance({...f.options,cases:[{sourceJobId:f.job.id}]});assert.equal(report.status,'pending');
  f.job.event.create_time=base-1;fs.writeFileSync(f.jobFile,JSON.stringify(f.job));f.calls.length=0;
  report=await collectBridgeAcceptance({...f.options,cases:[{sourceJobId:f.job.id,controlJobId:f.job.id}]});
  assert.equal(report.status,'pending');assert.equal(report.results[0].epoch_member,false);assert.equal(f.calls.length,0);
  f.job.event.create_time=base+10;delete f.job.intakeEpoch;fs.writeFileSync(f.jobFile,JSON.stringify(f.job));
  report=await collectBridgeAcceptance({...f.options,cases:[{sourceJobId:f.job.id,controlJobId:f.job.id}]});assert.equal(report.results[0].epoch_member,false);
});
test('receipt mutation, wrong owner hash, route or GET content fail without a POST retry',async t=>{
  const f=fixture(t),cases=[{sourceJobId:f.job.id,controlJobId:f.job.id}];
  f.receipt.auditEvent={...f.event,sender_id:'ou_other'};fs.writeFileSync(f.receiptFile,JSON.stringify(f.receipt));
  assert.equal((await collectBridgeAcceptance({...f.options,cases})).unknown_count,1);
  f.receipt.auditEvent=f.event;fs.writeFileSync(f.receiptFile,JSON.stringify(f.receipt));f.delivery.ownerId='b'.repeat(64);fs.writeFileSync(f.deliveryFile,JSON.stringify(f.delivery));
  assert.equal((await collectBridgeAcceptance({...f.options,cases})).unknown_count,1);
  f.delivery.ownerId=digest(f.job.id);fs.writeFileSync(f.deliveryFile,JSON.stringify(f.delivery));
  const request=async(b,args)=>{const response=await f.options.request(b,args);if(args[2].endsWith('om_result'))response.items[0].parent_id='om_unrelated';return response;};
  const report=await collectBridgeAcceptance({...f.options,cases,request});assert.equal(report.status,'pending');assert.equal(report.results[0].delivery.platform_verified,false);
  assert.ok(f.calls.every(args=>args[1]==='GET'));
});
test('missing background/task records and GET outage are unknown, never fabricated empty or delivered',async t=>{
  const f=fixture(t);
  const report=await collectBridgeAcceptance({...f.options,cases:[{sourceJobId:f.job.id,taskId:'a'.repeat(64)}]});assert.equal(report.status,'pending');assert.equal(report.unknown_count,1);
  const outage=await collectBridgeAcceptance({...f.options,cases:[{sourceJobId:f.job.id,controlJobId:f.job.id}],request:async()=>{throw Error('private endpoint credentials');}});
  assert.equal(outage.unknown_count,1);assert.doesNotMatch(JSON.stringify(outage),/credentials|endpoint/);
});
test('background completion needs immutable input/nonce/result hash and actual callback done, not queued notification',async t=>{
  const f=fixture(t);f.job.status='delivered';f.job.feedbackDisposition='actionable';fs.writeFileSync(f.jobFile,JSON.stringify(f.job));
  const inbox=new DurableInbox(f.options.inboxRoot,f.binding.bot,{}, {now:()=>base+1000}),source=inbox.jobs.get(f.job.id);
  const codexCliJs=path.join(f.root,'cli.mjs'),codexHome=f.root;
  const {taskId}=enqueueBackgroundTask({root:f.options.backgroundRoot,inboxRoot:f.options.inboxRoot,binding:f.binding,jobId:source.id,
    taskKey:'draft',title:'fixture draft',promptText:'readonly fixture',codexCliJs,codexHome,now:()=>base+1000});
  const scheduler=new BackgroundScheduler({root:f.options.backgroundRoot,inboxRoot:f.options.inboxRoot,binding:f.binding,inbox,codexCliJs,codexHome,
    now:()=>base+1000,env:{},probe:async()=>true,launch:()=>({unref(){},once(){}})});
  await scheduler.tick();const dir=path.join(f.options.backgroundRoot,f.binding.bot,taskId),claim=readBackgroundJson(path.join(dir,'claim.json'));
  const bytes=Buffer.from('fixture draft'),run={schema:1,taskId,nonce:claim.nonce,taskSha256:digest(fs.readFileSync(path.join(dir,'task.json'))),
    pid:12345,processIdentity:{bootId:'fixture',startSeconds:1},heartbeatAt:base+1000,completedAt:base+1000,status:'completed',exitCode:0,resultBytes:bytes.length,resultSha256:digest(bytes)};
  fs.writeFileSync(path.join(dir,'result.txt'),bytes,{mode:0o600});fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify(run),{mode:0o600});
  source.status='done';inbox.save(source);await scheduler.tick();const callback=[...inbox.jobs.values()].find(j=>j.event.synthetic_callback);
  const cases=[{sourceJobId:source.id,taskId,callbackJobId:callback.id}];let report=await collectBridgeAcceptance({...f.options,cases});
  assert.equal(report.status,'pending');assert.equal(report.results[0].background.callback_verified,true);assert.equal(report.results[0].background.callback_done,false);
  callback.status='done';inbox.save(callback);await scheduler.tick();report=await collectBridgeAcceptance({...f.options,cases});assert.equal(report.status,'verified');
  fs.writeFileSync(path.join(dir,'result.txt'),'mutated private');report=await collectBridgeAcceptance({...f.options,cases});assert.equal(report.status,'pending');assert.equal(report.unknown_count,1);
});
