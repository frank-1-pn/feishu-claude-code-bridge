import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {readMetricsPolicy,sourceTimestamp,buildFinalDeliveryEvidence,metricsEpochKey} from './codex-bridge-metrics.mjs';
import {opsScope} from './codex-bridge-ops-policy.mjs';
import {DurableMonitor} from './codex-bridge-monitor.mjs';
import {performanceMetadata,DeferredPerformance} from './codex-bridge-performance.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';

const base=1790852400000,epoch={deploymentId:'fixture_release',versionRef:'a'.repeat(40),startedAt:base};
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'epoch-metrics-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',profile:'fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',bot_open_id:'ou_bot',codex_thread_id:'fixture-thread',cwd:root,group_access:'all_group_humans'};
  const clock={now:base+1000};
  const job=(name,extra={})=>({id:`om_${name}`,status:'done',markerSeen:true,feedbackDisposition:'actionable',acceptedAt:base+100,submittedAt:base+150,deliveredAt:base+200,completedAt:clock.now,
    intakeEpoch:{deploymentId:epoch.deploymentId,versionRef:epoch.versionRef},event:{type:'im.message.receive_v1',message_id:`om_${name}`,chat_id:binding.chat_id,sender_id:binding.allowed_sender_id,
      sender_type:'user',chat_type:'group',message_type:'text',content:'fixture private',create_time:base+50,bridge_binding:bindingSnapshot(binding)},...extra});
  const open=(value=epoch)=>new DurableMonitor({root:path.join(root,'monitor'),binding,now:()=>clock.now,metricsEpoch:value,evidenceLabel:'test_fixture'});
  return {root,binding,clock,job,open};
}
test('metrics policy is missing by default, exact scoped, private and deployment checked',t=>{
  const f=fixture(t),root=path.join(f.root,'metrics'),args={root,binding:f.binding,codexHome:f.root,now:f.clock.now};
  assert.deepEqual(readMetricsPolicy(args),{enabled:false,status:'missing',reason:'metrics_policy_missing',metricsEpoch:null});
  fs.mkdirSync(path.join(root,f.binding.bot),{recursive:true,mode:0o700});const file=path.join(root,f.binding.bot,'policy.json');
  const policy={schema:1,scope:opsScope(f.binding,f.root),epoch};fs.writeFileSync(file,JSON.stringify(policy),{mode:0o600});
  assert.equal(readMetricsPolicy(args).enabled,true);assert.equal(readMetricsPolicy({...args,expectedDeploymentId:'other'}).status,'invalid');
  assert.equal(readMetricsPolicy({...args,codexHome:'/other'}).status,'invalid');assert.equal(readMetricsPolicy({...args,binding:{...f.binding,codex_thread_id:'other'}}).status,'invalid');
  fs.chmodSync(file,0o644);assert.equal(readMetricsPolicy(args).status,'invalid');fs.chmodSync(file,0o600);
  fs.writeFileSync(file,JSON.stringify({...policy,endpoint:'https://invalid'}));assert.equal(readMetricsPolicy(args).status,'invalid');
  fs.unlinkSync(file);fs.symlinkSync(path.join(f.root,'missing'),file);assert.equal(readMetricsPolicy(args).enabled,false);
});
test('epoch rejects ambiguous dates, invalid freeze and unsafe fields; missing epoch never falls back to history',t=>{
  const f=fixture(t);assert.equal(sourceTimestamp({create_time:'2026-10-01T10:00:00'}),null);
  assert.equal(sourceTimestamp({create_time:new Date(base).toISOString()}),base);assert.equal(sourceTimestamp({create_time:String(base)}),base);
  for(const invalid of [{...epoch,startedAt:'2026-10-01'},{...epoch,frozenAt:base-1},{...epoch,frozenAt:f.clock.now+1},{...epoch,extra:true}])assert.equal(f.open(invalid).stats().epochAggregate,null);
  const monitor=f.open(undefined); // default helper supplies epoch; explicitly construct absent below
  assert.ok(monitor.stats().epochAggregate);
  const absent=new DurableMonitor({root:path.join(f.root,'absent'),binding:f.binding,now:()=>f.clock.now});
  assert.equal(absent.stats().epochAggregate,null);assert.equal(absent.stats().metrics.status,'missing');
});
test('completed checkpoints and reconciliation never become real final duration; actual response survives late closure',t=>{
  const f=fixture(t),job=f.job('actual');
  let record=performanceMetadata('fixture',job);assert.equal(record.timings_ms.original_to_final_delivery,null);assert.equal(record.sources.final,'completion_checkpoint');
  job.finalDeliveryEvidence=buildFinalDeliveryEvidence({at:base+500,source:'reconciled_observation'});
  assert.equal(performanceMetadata('fixture',job).timings_ms.intake_to_final_delivery,null);
  job.finalDeliveryEvidence=buildFinalDeliveryEvidence({at:base+500,source:'send_response'});job.completedAt=base+999999;
  record=performanceMetadata('fixture',job);assert.equal(record.timings_ms.original_to_final_delivery,450);assert.equal(record.timings_ms.intake_to_final_delivery,400);
  job.finalDeliveryEvidence={schema:1,at:base-1,source:'create_response'};assert.equal(performanceMetadata('fixture',job).sources.final,'missing');
  assert.equal(buildFinalDeliveryEvidence({at:base,source:'receipt_checkpoint'}),null);
});
test('epoch denominator uses new intake tag plus original human date, ignores callbacks, silent and old observations',t=>{
  const f=fixture(t),monitor=f.open(),actual=f.job('actual',{finalDeliveryEvidence:buildFinalDeliveryEvidence({at:base+500,source:'send_response'})});
  const missing=f.job('missing'),reconciled=f.job('reconciled',{finalDeliveryEvidence:buildFinalDeliveryEvidence({at:base+600,source:'reconciled_observation'})});
  const active=f.job('active',{status:'delivered'}),unknownDate=f.job('unknown');delete unknownDate.event.create_time;
  const old=f.job('old');old.event.create_time=base-1000;
  const untagged=f.job('untagged',{intakeEpoch:undefined}),wrong=f.job('wrong',{intakeEpoch:{...epoch,versionRef:'b'.repeat(40)}});
  untagged.event.intakeEpoch={deploymentId:epoch.deploymentId,versionRef:epoch.versionRef};
  const silent=f.job('silent',{completionDisposition:'silent'}),callback=f.job('callback');callback.event.synthetic_callback=true;callback.event.action_source_job_id=actual.id;
  monitor.observe({jobs:[actual,missing,reconciled,active,unknownDate,old,untagged,wrong,silent,callback],backgroundTasks:[{id:'b'.repeat(64),sourceJobId:old.id,status:'completed',completedAt:f.clock.now}]});
  const stats=monitor.stats().epochAggregate;
  assert.equal(stats.source_count,4);assert.equal(stats.source_time_unknown_count,1);assert.equal(stats.pending_source_count,1);
  assert.equal(stats.reply_sample_count,3);assert.equal(stats.background_sample_count,0);assert.equal(stats.intake_epoch_unverified_count,1);assert.equal(stats.other_intake_epoch_count,1);
  assert.equal(stats.final_timestamp_count,1);assert.equal(stats.final_reconciled_observation_count,1);assert.equal(stats.final_checkpoint_only_count,1);
  assert.deepEqual(stats.timings_ms.original_to_final_delivery,{count:1,p50:450,p95:450});
  assert.equal(f.open().stats().epochAggregate.source_count,4);
});
test('frozen window is stable on restart, cannot reopen, and keeps previous epoch samples',t=>{
  const f=fixture(t),job=f.job('one'),monitor=f.open();monitor.observe({jobs:[job]});
  const frozen={...epoch,frozenAt:f.clock.now};let closed=f.open(frozen);closed.observe({jobs:[job]});const before=closed.stats().epochAggregate;
  f.clock.now+=5000;closed.observe({jobs:[f.job('later')]});assert.deepEqual(closed.stats().epochAggregate,before);
  closed=f.open();assert.equal(closed.stats().metrics.status,'frozen');assert.deepEqual(closed.stats().epochAggregate,before);
  const next={deploymentId:'next',versionRef:'b'.repeat(40),startedAt:f.clock.now},other=f.open(next);other.observe({jobs:[job]});
  assert.equal(other.stats().epochAggregate.source_count,0);assert.equal(Object.keys(other.state.epochs).length,2);
  assert.equal(other.state.epochs[metricsEpochKey(epoch)].samples[Object.keys(monitor.state.samples)[0]].status,'done');
});
test('retroactive freeze excludes late observations and does not mislabel later source completion',t=>{
  const f=fixture(t),job=f.job('later',{status:'delivered'}),monitor=f.open();monitor.observe({jobs:[job]});
  f.clock.now+=1000;job.status='done';monitor.observe({jobs:[job]});
  const closed=f.open({...epoch,frozenAt:base+1500}).stats().epochAggregate;
  assert.equal(closed.source_count,1);assert.equal(closed.reply_sample_count,0);assert.equal(closed.pending_source_count,1);
});
test('deferred epoch recorder gates on actual new intake and never schedules old or synthetic completions',t=>{
  const f=fixture(t),scheduled=[],recorder=new DeferredPerformance(path.join(f.root,'perf'),{metricsEpoch:epoch,now:()=>f.clock.now,schedule:fn=>scheduled.push(fn)});
  const old=f.job('old');old.event.create_time=base-1;const callback=f.job('callback');callback.event.synthetic_callback=true;
  recorder.observe('fixture',[old,callback,f.job('untagged',{intakeEpoch:undefined}),f.job('new')]);assert.equal(scheduled.length,1);
});
test('background result response, reconciliation and missing proof have independent timing without increasing human denominator',t=>{
  const f=fixture(t),source=f.job('research'),monitor=f.open();
  const tasks=[
    {id:'1'.repeat(64),sourceJobId:source.id,status:'completed',completedAt:base+700,resultDeliveryVerified:true,resultDeliveryStatus:'done',resultDeliveryEvidence:buildFinalDeliveryEvidence({at:base+900,source:'send_response'})},
    {id:'2'.repeat(64),sourceJobId:source.id,status:'completed',completedAt:base+700,resultDeliveryVerified:true,resultDeliveryStatus:'done',resultDeliveryEvidence:buildFinalDeliveryEvidence({at:base+900,source:'reconciled_observation'})},
    {id:'3'.repeat(64),sourceJobId:source.id,status:'completed',completedAt:base+700,resultDeliveryStatus:'done',resultDeliveryEvidence:buildFinalDeliveryEvidence({at:base+900,source:'send_response'})}
  ];
  monitor.observe({jobs:[source],backgroundTasks:tasks});const stats=monitor.stats().epochAggregate;
  assert.equal(stats.source_count,1);assert.equal(stats.reply_sample_count,1);assert.equal(stats.background_sample_count,3);
  assert.equal(stats.background_result_delivery_count,2);assert.equal(stats.background_result_delivery_timestamp_count,1);
  assert.equal(stats.background_result_delivery_reconciled_count,1);assert.equal(stats.background_result_delivery_unknown_count,1);
  assert.deepEqual(stats.timings_ms.original_to_background_result_delivery,{count:1,p50:850,p95:850});
});
