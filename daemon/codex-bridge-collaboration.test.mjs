import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DurableInbox,digest} from './codex-bridge-inbox.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';
import {opsScope} from './codex-bridge-ops-policy.mjs';
import {CollaborationContext,readCollaborationPolicy,stripExternalCollaborationFields} from './codex-bridge-collaboration.mjs';
import {parseCollaborationArguments,runCollaborationCli} from './codex-bridge-collaboration-cli.mjs';
function fixture(t,{enabled=true}={}) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'collaboration-')));fs.chmodSync(base,0o700);t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const stateRoot=path.join(base,'state'),root=path.join(stateRoot,'collaboration-v1'),inboxRoot=path.join(stateRoot,'codex-inbox-v2'),codexHome=path.join(base,'home');
  const binding={bot:'fixture',profile:'fixture',chat_id:'oc_Fixture',allowed_sender_id:'ou_Owner',bot_open_id:'ou_Bot',group_access:'all_group_humans',codex_thread_id:'fixture-thread',cwd:base};
  const inbox=new DurableInbox(inboxRoot,binding.bot,{}),opts={root,inboxRoot,binding,codexHome,now:()=>1000};
  const policyFile=path.join(root,binding.bot,'policy.json');
  if(enabled)fs.mkdirSync(path.dirname(policyFile),{recursive:true,mode:0o700});
  if(enabled)atomicWriteJson(policyFile,{schema:1,scope:opsScope(binding,codexHome),enabled:true});
  const add=(id,text='补充资料',sender='ou_A',extra={},active=true)=>{
    const j=inbox.enqueue({type:'im.message.receive_v1',message_id:id,message_type:'text',content:JSON.stringify({text}),chat_id:binding.chat_id,chat_type:'group',
      sender_id:sender,sender_type:'user',bridge_binding:bindingSnapshot(binding),...extra});
    if(active)Object.assign(j,{status:'submitted',markerSeen:true,feedbackDisposition:'actionable'});inbox.save(j);return j;
  };
  let context;const open=(extra={})=>context=new CollaborationContext({...opts,...extra});open();
  const register=(id='om_original',extra={})=>{add(id,'请整理分析');return context.register({jobId:id,operationKey:'register-v1',taskKey:'analysis',title:'供应商方案',responsibleSenderId:'ou_A',waitingFields:['出发日期'],...extra});};
  return {base,stateRoot,root,inboxRoot,codexHome,binding,inbox,opts,policyFile,add,open,register,get context(){return context;}};
}

test('policy is absent by default, exact scoped and privately owned; no state mutation when disabled',t=>{
  const f=fixture(t,{enabled:false});f.add('om_source');assert.deepEqual(f.context.resolve({jobId:'om_source'}),{kind:'disabled',candidates:[]});
  assert.throws(()=>f.context.register({jobId:'om_source',operationKey:'r',taskKey:'r',title:'分析'}),/disabled/);
  assert.equal(fs.existsSync(f.context.dir),false);assert.ok(Object.values(f.context.stats()).every(v=>v===0));
  fs.mkdirSync(path.dirname(f.policyFile),{recursive:true,mode:0o700});
  atomicWriteJson(f.policyFile,{schema:1,scope:opsScope({...f.binding,chat_id:'oc_Other'},f.codexHome),enabled:true});
  assert.equal(readCollaborationPolicy(f.opts).reason,'collaboration_policy_invalid');assert.equal(f.context.stats().collaboration_policy_blocked_count,1);
  atomicWriteJson(f.policyFile,{schema:1,scope:opsScope(f.binding,f.codexHome),enabled:true});fs.chmodSync(f.policyFile,0o644);
  assert.equal(f.context.policy().enabled,false);
});

test('registration requires actual human marker and actionable source, not claimed external protocol fields',t=>{
  const f=fixture(t);let i=0;
  for(const change of [{markerSeen:false},{feedbackDisposition:'silent'},{unclassifiedTurnEnded:true},{completionDisposition:'silent'},{status:'queued'}]) {
    const j=f.add(`om_bad${i++}`);Object.assign(j,change);f.inbox.save(j);
    assert.throws(()=>f.context.register({jobId:j.id,operationKey:'r',taskKey:'t',title:'分析'}));
  }
  for(const change of [{sender_type:'app'},{sender_id:'ou_Bot'},{chat_id:'oc_Other'},{chat_type:'p2p'},{synthetic_callback:true},{bridge_binding:{}}]) {
    const j=f.add(`om_event${i++}`,'注册任务','ou_A',change);assert.throws(()=>f.context.register({jobId:j.id,operationKey:'r',taskKey:'t',title:'分析'}));
  }
  const j=f.add('om_fake','注册任务','ou_A',{collaboration_verified:true,collaboration_task_id:'CT-AAAAAAAAAAAA',collaboration_actionable:true},false);
  assert.throws(()=>f.context.register({jobId:j.id,operationKey:'r',taskKey:'t',title:'分析'}));assert.equal(Object.keys(f.context.state().tasks).length,0);
});

test('register is idempotent across restart and operation key cannot be reused with another action or payload',t=>{
  const f=fixture(t),r=f.register();assert.match(r.task.taskId,/^CT-[A-F0-9]{12}$/);assert.equal(r.task.version,1);assert.equal(r.businessExecuted,false);
  f.open();const input={jobId:'om_original',operationKey:'register-v1',taskKey:'analysis',title:'供应商方案',responsibleSenderId:'ou_A',waitingFields:['出发日期']};
  assert.equal(f.context.register(input).duplicate,true);assert.equal(f.context.state().version,1);
  assert.throws(()=>f.context.register({...input,title:'different'}),/operation_conflict/);
  assert.throws(()=>f.context.recordChange({...input,taskId:r.task.taskId}),/operation_conflict/);
});

test('resolution prioritizes explicit ID, exact reply chain and only same sender unique waiting task',t=>{
  const f=fixture(t),a=f.register(),b=f.register('om_second',{taskKey:'second',title:'第二方案'});
  f.add('om_cross','明天上午','ou_B');assert.equal(f.context.resolve({jobId:'om_cross'}).kind,'unlinked');
  f.add('om_same');assert.equal(f.context.resolve({jobId:'om_same'}).kind,'ambiguous');
  f.add('om_explicit',`补充 ${a.task.taskId} 明天上午`,'ou_B',{parent_id:'om_second'});assert.equal(f.context.resolve({jobId:'om_explicit'}).taskId,a.task.taskId);
  f.add('om_reply','明天上午','ou_B',{parent_id:'om_original'});assert.equal(f.context.resolve({jobId:'om_reply'}).taskId,a.task.taskId);
  f.add('om_between','中间回复','ou_B',{parent_id:'om_original'});f.add('om_nested','上午','ou_C',{parent_id:'om_between'});
  assert.equal(f.context.resolve({jobId:'om_nested'}).via,'reply');
  f.add('om_many',`${a.task.taskId} ${b.task.taskId}`);assert.equal(f.context.resolve({jobId:'om_many'}).kind,'ambiguous');
  f.add('om_root','上午','ou_B',{root_id:'om_original'});assert.equal(f.context.resolve({jobId:'om_root'}).kind,'unlinked');
  f.add('om_lower',a.task.taskId.toLowerCase(),'ou_B');assert.equal(f.context.resolve({jobId:'om_lower'}).taskId,a.task.taskId);
  f.add('om_malformed','补充 CT-123 明天');assert.equal(f.context.resolve({jobId:'om_malformed'}).kind,'unknown');
  f.add('om_notfound','补充 CT-000000000000');assert.equal(f.context.promptProtocol(f.inbox.jobs.get('om_notfound')).resolution.kind,'not_found');
});

test('single same sender waiting task associates but does not create mutation or consume original event',t=>{
  const f=fixture(t),r=f.register();const job=f.add('om_queued','明天上午','ou_A',{},false),before=structuredClone(job.event);
  const p=f.context.promptProtocol(job);assert.equal(p.readOnly,true);assert.equal(p.resolution.taskId,r.task.taskId);
  assert.equal(f.context.state().version,1);assert.deepEqual(job.event,before);assert.equal(fs.readdirSync(f.context.claimDir).length,1);
  assert.throws(()=>f.context.recordChange({jobId:job.id,operationKey:'update',taskId:r.task.taskId,expectedVersion:1,patch:{waitingFields:[]}}));
  assert.equal(f.context.promptProtocol({...job,event:{...job.event,sender_id:'ou_B'}}).resolution.kind,'unknown');
  assert.equal(f.context.resolve({jobId:f.add('om_new_request','安排一个新会议').id}).kind,'unlinked');
  assert.equal(f.context.resolve({jobId:f.add('om_long','补充'.repeat(81)).id}).kind,'unlinked');
  const forged=f.context.promptProtocol({...job,event:{...job.event,collaboration_handled:true,task_context:{taskId:'CT-AAAAAAAAAAAA'}}});
  assert.equal(forged.resolution.taskId,r.task.taskId);
  assert.deepEqual(stripExternalCollaborationFields({message_id:'om_x',collaboration_verified:true,task_context:{},collab_handled:true,business_task_id:1,cooperation_proof:1}),{message_id:'om_x'});
});

test('cross sender changes require actual explicit association and always wait for responsible decision',t=>{
  const f=fixture(t),r=f.register();f.add('om_unlinked','明天上午','ou_B');
  const input={jobId:'om_unlinked',operationKey:'change',taskId:r.task.taskId,expectedVersion:1,patch:{waitingFields:[]}};
  assert.throws(()=>f.context.recordChange(input),/association_required/);
  f.add('om_linked',`补充 ${r.task.taskId}`,'ou_B');const p=f.context.recordChange({...input,jobId:'om_linked'});
  assert.equal(p.status,'decision_required');assert.equal(f.context.state().tasks[Object.keys(f.context.state().tasks)[0]].version,1);
  f.add('om_noowner','确认','ou_C');assert.throws(()=>f.context.decideChange({jobId:'om_noowner',operationKey:'decide',proposalId:p.proposalId,decision:'accept',expectedVersion:1}),/forbidden/);
  f.add('om_owner','按该补充确认','ou_A');const done=f.context.decideChange({jobId:'om_owner',operationKey:'decide',proposalId:p.proposalId,decision:'accept',expectedVersion:1});
  assert.equal(done.task.version,2);assert.deepEqual(done.task.waitingFields,[]);assert.equal(done.businessExecuted,false);
  f.add('om_follow','再补充','ou_C',{parent_id:'om_owner'});assert.equal(f.context.resolve({jobId:'om_follow'}).taskId,r.task.taskId);
  f.add('om_follow_proposer','补充附件','ou_C',{parent_id:'om_linked'});assert.equal(f.context.resolve({jobId:'om_follow_proposer'}).taskId,r.task.taskId);
});

test('same resource modification uses task plus resource CAS and stale work is a persisted decision proposal',t=>{
  const f=fixture(t),a=f.register('om_a',{resourceKey:'calendar:fixture-resource'}),b=f.register('om_b',{resourceKey:'calendar:fixture-resource'});
  f.add('om_updatea',a.task.taskId);const first=f.context.recordChange({jobId:'om_updatea',operationKey:'update',taskId:a.task.taskId,expectedVersion:1,expectedResourceVersion:0,patch:{title:'第一修改'}});
  assert.equal(first.task.resourceVersion,1);
  f.add('om_updateb',b.task.taskId);const stale=f.context.recordChange({jobId:'om_updateb',operationKey:'update',taskId:b.task.taskId,expectedVersion:1,expectedResourceVersion:0,patch:{title:'第二修改'}});
  assert.equal(stale.status,'conflict');assert.equal(stale.requiresResponsibleDecision,true);
  f.add('om_arbitrate','裁决采用第二修改','ou_Owner');assert.throws(()=>f.context.decideChange({jobId:'om_arbitrate',operationKey:'decide-old',proposalId:stale.proposalId,decision:'accept',expectedVersion:1,expectedResourceVersion:0}),/version_conflict/);
  const accepted=f.context.decideChange({jobId:'om_arbitrate',operationKey:'decide-new',proposalId:stale.proposalId,decision:'accept',expectedVersion:1,expectedResourceVersion:1});
  assert.equal(accepted.task.version,2);assert.equal(accepted.task.resourceVersion,2);
});

test('parallel catalog CAS cannot lose updates and failed CAS never replays under the same operation key',t=>{
  const f=fixture(t),r=f.register();f.add('om_a',r.task.taskId);f.add('om_b',r.task.taskId);
  const other=new CollaborationContext(f.opts);let once=false;
  f.open({afterClaim:()=>{if(!once){once=true;other.proposeChange({jobId:'om_b',operationKey:'p',taskId:r.task.taskId,expectedVersion:1,patch:{note:'第二建议'}});}}});
  const input={jobId:'om_a',operationKey:'r',taskId:r.task.taskId,expectedVersion:1,patch:{title:'第一修改'}};
  assert.equal(f.context.recordChange(input).reason,'catalog_cas');f.open();assert.equal(f.context.recordChange(input).duplicate,true);
  assert.equal(Object.values(f.context.state().tasks)[0].title,'供应商方案');assert.equal(Object.values(f.context.state().proposals).length,1);
});

test('crash after durable claim is unknown across restart and reserves runtime pending capacity without automatic replay',t=>{
  const f=fixture(t);f.add('om_crash');let calls=0;f.open({afterClaim:()=>{calls++;throw Error('simulated_crash');}});
  const input={jobId:'om_crash',operationKey:'register',taskKey:'t',title:'分析'};
  assert.throws(()=>f.context.register(input),/simulated_crash/);f.open();const retry=f.context.register(input);
  assert.equal(retry.status,'unknown');assert.equal(retry.replayed,false);assert.equal(calls,1);assert.equal(Object.keys(f.context.state().tasks).length,0);
  assert.equal(f.context.stats().collaboration_operation_pending_count,1);assert.equal(f.context.stats().collaboration_operation_blocked_count,1);
  fs.unlinkSync(f.policyFile);assert.equal(f.context.stats().collaboration_operation_pending_count,1);assert.throws(()=>f.context.register(input),/disabled/);
});

test('classification revocation after claim prevents commit, and missing sources or corrupted files fail closed',t=>{
  const f=fixture(t);const j=f.add('om_revoked');f.open({afterClaim:()=>{j.feedbackDisposition='silent';f.inbox.save(j);}});
  assert.throws(()=>f.context.register({jobId:j.id,operationKey:'r',taskKey:'t',title:'分析'}));assert.equal(f.context.stats().collaboration_operation_pending_count,1);
  f.open();const r=f.register();const file=path.join(f.inboxRoot,f.binding.bot,`job-${digest('om_original')}.json`);
  const original=JSON.parse(fs.readFileSync(file,'utf8'));original.event.content='modified';atomicWriteJson(file,original);
  assert.equal(f.context.promptProtocol(f.add('om_check',r.task.taskId)).resolution.kind,'unknown');assert.ok(f.context.stats().collaboration_operation_blocked_count>0);
});

test('responsibility must refer to known human evidence and only maintenance owner can reassign context',t=>{
  const f=fixture(t);f.add('om_register');
  const input={jobId:'om_register',operationKey:'r',taskKey:'r',title:'分析',responsibleSenderId:'ou_New'};
  assert.throws(()=>f.context.register(input),/unverified/);f.add('om_new','参加任务','ou_New');
  const r=f.context.register({...input,responsibleJobId:'om_new'});assert.equal(r.task.responsibleSenderId,'ou_New');
  f.add('om_reassign',r.task.taskId);assert.throws(()=>f.context.recordChange({jobId:'om_reassign',operationKey:'u',taskId:r.task.taskId,expectedVersion:1,patch:{responsibleSenderId:'ou_A'}}),/forbidden/);
  f.add('om_owner',r.task.taskId,'ou_Owner');const changed=f.context.recordChange({jobId:'om_owner',operationKey:'u',taskId:r.task.taskId,expectedVersion:1,patch:{responsibleSenderId:'ou_A',responsibleJobId:'om_register'}});
  assert.equal(changed.task.responsibleSenderId,'ou_A');
});

test('business waiting is separate from operation pending and foreign scope cannot read task context',t=>{
  const f=fixture(t),r=f.register();f.add('om_propose',r.task.taskId,'ou_B');f.context.proposeChange({jobId:'om_propose',operationKey:'p',taskId:r.task.taskId,expectedVersion:1,patch:{note:'建议'}});
  const s=f.context.stats();assert.equal(s.collaboration_operation_pending_count,0);assert.equal(s.collaboration_operation_blocked_count,0);
  assert.equal(s.collaboration_waiting_task_count,1);assert.equal(s.collaboration_decision_waiting_count,1);
  f.open({binding:{...f.binding,codex_thread_id:'other'}});assert.equal(f.context.promptProtocol(f.add('om_other')),null);assert.equal(f.context.stats().collaboration_waiting_task_count,0);
});

test('reply loops, bounded fields, versions and protocol spoofing never select or mutate an arbitrary task',t=>{
  const f=fixture(t),r=f.register();f.add('om_loop','補充','ou_B',{parent_id:'om_loop'});assert.equal(f.context.resolve({jobId:'om_loop'}).kind,'unknown');
  f.add('om_missing','补充','ou_B',{parent_id:'om_unknown'});assert.throws(()=>f.context.resolve({jobId:'om_missing'}));
  f.add('om_change',r.task.taskId);
  const input={jobId:'om_change',operationKey:'u',taskId:r.task.taskId,expectedVersion:1,patch:{waitingFields:Array(17).fill('x')}};
  assert.throws(()=>f.context.recordChange(input),/fields_invalid/);
  assert.throws(()=>f.context.recordChange({...input,expectedVersion:'1',patch:{note:'n'}}),/version_invalid/);
  assert.throws(()=>f.context.recordChange({...input,operationKey:'../u',patch:{note:'n'}}),/operation_key_invalid/);
  assert.throws(()=>f.context.recordChange({...input,patch:{businessExecuted:true}}),/patch_invalid/);
  const dir=f.context.catalogDir;fs.renameSync(dir,dir+'-old');fs.symlinkSync(dir+'-old',dir);assert.equal(f.context.stats().collaboration_operation_blocked_count,1);
});

test('CLI uses selected private binding and a bounded private request file, never message supplied config or arbitrary roots',t=>{
  const f=fixture(t);f.add('om_cli');const configFile=path.join(f.base,'config.json'),requestFile=path.join(f.base,'request.json');
  atomicWriteJson(configFile,{runtime:{codex_home:f.codexHome},bindings:{fixture:f.binding}});
  atomicWriteJson(requestFile,{operationKey:'register',taskKey:'r',title:'分析'});
  const args=['--bot','fixture','--job-id','om_cli','--action','register','--request-file',requestFile];
  const result=runCollaborationCli(args,{configFile,stateRoot:f.stateRoot});assert.equal(result.status,'registered');assert.equal(result.task.responsibleSenderId,f.binding.allowed_sender_id);
  assert.throws(()=>parseCollaborationArguments([...args,'--root',f.base]),/arguments_invalid/);
  assert.throws(()=>parseCollaborationArguments([...args,'--bot','other']),/arguments_invalid/);
  assert.throws(()=>parseCollaborationArguments(['--bot','fixture','--job-id','om_cli','--action','resolve','--request-file',requestFile]),/arguments_invalid/);
  const outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'collaboration-outside-')));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  const outsideFile=path.join(outside,'request.json');atomicWriteJson(outsideFile,{operationKey:'x',taskKey:'x',title:'分析'});
  assert.throws(()=>runCollaborationCli([...args.slice(0,-1),outsideFile],{configFile,stateRoot:f.stateRoot}),/request_path_invalid/);
  fs.chmodSync(requestFile,0o644);assert.throws(()=>runCollaborationCli(args,{configFile,stateRoot:f.stateRoot}));
  fs.chmodSync(requestFile,0o600);fs.linkSync(requestFile,requestFile+'.link');assert.throws(()=>runCollaborationCli(args,{configFile,stateRoot:f.stateRoot}));
  fs.unlinkSync(requestFile+'.link');fs.renameSync(requestFile,requestFile+'.original');fs.symlinkSync(requestFile+'.original',requestFile);
  assert.throws(()=>runCollaborationCli(args,{configFile,stateRoot:f.stateRoot}));
});
