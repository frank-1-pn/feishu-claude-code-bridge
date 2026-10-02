import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DurableMonitor,monitorSource,aggregateMonitorSamples} from './codex-bridge-monitor.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';

function fixture(t,options={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-monitor-test-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',profile:'fixture-profile',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',bot_open_id:'ou_fixturebot',codex_thread_id:'thread-fixture',group_access:'all_group_humans'};
  const clock={now:1000};
  const open=extra=>new DurableMonitor({root:path.join(root,'monitor'),binding,now:()=>clock.now,thresholds:{queued:100,delivery:100,reply:100,backgroundQueued:100},
    persistMs:20,recoveryMs:20,cooldownMs:100,windowMs:100000,maxSamples:100,evidenceLabel:'test_fixture',...options,...extra});
  const job=(id='source',extra={})=>({id:`om_${id}`,status:'reply_pending',acceptedAt:0,submittedAt:5,deliveredAt:10,lastActivityAt:20,
    markerSeen:true,feedbackDisposition:'actionable',event:{type:'im.message.receive_v1',message_id:`om_${id}`,message_type:'text',chat_id:binding.chat_id,
      sender_id:binding.allowed_sender_id,sender_type:'user',chat_type:'group',bridge_binding:bindingSnapshot(binding),content:'private customer content',create_time:1790852400000},...extra});
  const background=(source,extra={})=>({id:'a'.repeat(64),sourceJobId:source.id,status:'blocked',createdAt:0,runAt:0,claimedAt:10,...extra});
  const observe=(monitor,jobs=[],backgroundTasks=[],extra={})=>monitor.observe({jobs,backgroundTasks,
    backgroundStats:{background_blocked_count:backgroundTasks.filter(b=>['blocked','indeterminate'].includes(b.status)).length,background_running_count:backgroundTasks.filter(b=>['running','indeterminate'].includes(b.status)).length},
    health:{transport_healthy:true,delivery_healthy:true},...extra});
  const mature=(monitor,jobs,backgroundTasks=[])=>{observe(monitor,jobs,backgroundTasks);clock.now+=20;observe(monitor,jobs,backgroundTasks);return monitor.pendingAlerts();};
  return {root,binding,clock,open,job,background,observe,mature,monitor:open()};
}

test('thresholds require continuous observation and restart preserves the pending alert identity',t=>{
  const f=fixture(t),job=f.job();f.observe(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts().length,0);
  f.clock.now+=19;f.observe(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts().length,0);
  f.clock.now++;f.observe(f.monitor,[job]);const [alert]=f.monitor.pendingAlerts();assert.equal(alert.kind,'reply_stalled');
  assert.equal(alert.sourceJobId,job.id);assert.doesNotMatch(JSON.stringify(alert.public),/om_|oc_|ou_|private|customer|thread/);
  f.monitor=f.open();f.observe(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts()[0].id,alert.id);
  assert.equal(f.monitor.stats().monitor_pending_alert_count,1);assert.equal(f.monitor.stats().monitor_private_diagnostic_count,0);
  assert.equal(fs.statSync(f.monitor.file(alert.id)).mode&0o777,0o600);
});

test('short interruptions reset the persistence threshold instead of accumulating intermittent stalls',t=>{
  const f=fixture(t),job=f.job();f.observe(f.monitor,[job]);f.clock.now+=10;job.status='delivered';f.observe(f.monitor,[job]);
  f.clock.now+=5;job.status='reply_pending';f.observe(f.monitor,[job]);f.clock.now+=19;f.observe(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts().length,0);
  f.clock.now++;f.observe(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts().length,1);
});

test('unmarked queued intake, unclassified, silent and foreign sources remain private diagnostics',t=>{
  for(const override of [{status:'queued',markerSeen:false},{feedbackDisposition:undefined},{completionDisposition:'silent'},{unclassifiedTurnEnded:true}]) {
    const f=fixture(t),job=f.job('quiet',override);f.mature(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts().length,0);
    assert.ok(f.monitor.stats().monitor_private_diagnostic_count>0);
  }
  const f=fixture(t),job=f.job();job.event.chat_id='oc_foreign';f.mature(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts().length,0);
  const missingBinding=fixture(t),bad=missingBinding.job();delete bad.event.bridge_binding;missingBinding.mature(missingBinding.monitor,[bad]);assert.equal(missingBinding.monitor.pendingAlerts().length,0);
});

test('synthetic waiting work resolves the real human source and rejects cycles or missing parents',t=>{
  const f=fixture(t),source=f.job('human',{status:'done',completedAt:900}),child=f.job('callback',{status:'queued',markerSeen:false,feedbackDisposition:undefined});
  child.event.synthetic_callback=true;child.event.action_source_job_id=source.id;
  const all=new Map([[source.id,source],[child.id,child]]);assert.equal(monitorSource(f.binding,child,all).id,source.id);
  const alerts=f.mature(f.monitor,[source,child]);assert.equal(alerts.length,1);assert.equal(alerts[0].kind,'queued_stalled');assert.equal(alerts[0].sourceJobId,source.id);
  child.event.action_source_job_id=child.id;assert.equal(monitorSource(f.binding,child,all),null);
  child.event.action_source_job_id='om_missing';assert.equal(monitorSource(f.binding,child,all),null);
});

test('normal long-running foreground and background work do not trigger timeout alarms',t=>{
  const f=fixture(t),job=f.job('long',{status:'delivered',timeoutNotified:false,lastActivityAt:995}),task=f.background(job,{status:'running'});
  f.mature(f.monitor,[job],[task]);f.clock.now+=10000;f.observe(f.monitor,[job],[task]);assert.equal(f.monitor.pendingAlerts().length,0);
  assert.equal(f.monitor.stats().monitor_active_condition_count,0);
  const ack=f.job('ack',{status:'done',completedAt:990}),later=f.background(ack,{status:'queued',runAt:f.clock.now+1000});
  f.observe(f.monitor,[ack],[later]);assert.equal(f.monitor.pendingAlerts().length,0);
});

test('reply age uses final execution activity, while explicit reply blockage takes precedence',t=>{
  const f=fixture(t),job=f.job('recent',{lastActivityAt:995});f.mature(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts().length,0);
  job.replyCardRetry={blocked:true,error:'private raw token'};f.mature(f.monitor,[job]);const alerts=f.monitor.pendingAlerts();assert.equal(alerts.length,1);assert.equal(alerts[0].kind,'reply_blocked');
  assert.doesNotMatch(JSON.stringify(alerts[0].public),/raw|token|private/);
});

test('background blocked and indeterminate alerts require the actual acknowledged human source',t=>{
  for(const status of ['blocked','indeterminate']) {
    const f=fixture(t),source=f.job('ack',{status:'done',completedAt:900}),task=f.background(source,{status,executionBlocked:'private raw reason'});
    const alerts=f.mature(f.monitor,[source],[task]);assert.equal(alerts.length,1);assert.equal(alerts[0].kind,status==='blocked'?'background_blocked':'background_indeterminate');
    assert.equal(alerts[0].sourceJobId,source.id);assert.doesNotMatch(JSON.stringify(alerts[0].public),/reason|private|om_|aaaa/);
    source.markerSeen=false;const second=f.open();assert.equal(second.beginSubmission(alerts[0].id,{jobs:[source]}),null);
  }
});

test('unhealthy transport with no eligible active source stays private, and missing snapshots are unknown',t=>{
  const f=fixture(t);f.observe(f.monitor,[],[],{health:{transport_healthy:false,delivery_healthy:true}});f.clock.now+=20;
  f.observe(f.monitor,[],[],{health:{transport_healthy:false,delivery_healthy:true}});assert.equal(f.monitor.pendingAlerts().length,0);assert.equal(f.monitor.stats().monitor_private_diagnostic_count,1);
  const source=f.job();f.observe(f.monitor,[source],[],{health:{transport_healthy:false,delivery_healthy:true}});
  assert.ok(f.monitor.pendingAlerts().some(a=>a.kind==='transport_unhealthy'));
  f.monitor.observe({});const stats=f.monitor.stats();assert.equal(stats.snapshot.queued_count,null);assert.equal(stats.snapshot.background_running_count,null);
  assert.equal(stats.snapshot.transport_healthy,null);assert.equal(stats.snapshot.jobs_available,false);assert.ok(stats.monitor_active_condition_count>0);
});

test('fresh source gating rejects a classification revoked before actual submission',t=>{
  const f=fixture(t),job=f.job(),[alert]=f.mature(f.monitor,[job]);job.completionDisposition='silent';
  assert.equal(f.monitor.beginSubmission(alert.id,{jobs:[job]}),null);assert.equal(f.monitor.pendingAlerts().length,0);
  assert.equal(f.monitor.readAlert(alert.id).status,'suppressed');
});

test('durable submit claim allows one attempt and unknown ACK never replays across restart',t=>{
  const f=fixture(t),job=f.job(),[alert]=f.mature(f.monitor,[job]);assert.equal(f.monitor.beginSubmission(alert.id,{jobs:[job]}).status,'submitted');
  assert.equal(f.monitor.beginSubmission(alert.id,{jobs:[job]}),null);const other=f.open();assert.equal(other.beginSubmission(alert.id,{jobs:[job]}),null);
  f.monitor.recordDelivery(alert.id,'unknown');assert.throws(()=>f.monitor.recordDelivery(alert.id,'sent'),/reconciliation_required/);
  f.monitor=f.open();f.clock.now+=1000;f.observe(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts().length,0);assert.equal(f.monitor.stats().monitor_unknown_alert_count,1);
  f.monitor.recordDelivery(alert.id,'sent',{verified:true});assert.equal(f.monitor.stats().monitor_unknown_alert_count,0);
  f.observe(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts().length,1);
});

test('crash after hard-linked submission but before submitted checkpoint becomes unknown',t=>{
  const f=fixture(t),job=f.job(),[alert]=f.mature(f.monitor,[job]);
  fs.writeFileSync(path.join(f.monitor.dir,`submit-${alert.id}.json`),JSON.stringify({schema:1,id:alert.id,scope:f.monitor.scope,payloadSha256:alert.payloadSha256,submittedAt:f.clock.now}),{mode:0o600});
  const restarted=f.open();assert.equal(restarted.stats().monitor_unknown_alert_count,1);assert.equal(restarted.pendingAlerts().length,0);
  assert.equal(restarted.beginSubmission(alert.id,{jobs:[job]}),null);
});

test('immutable alert publication recovers its condition pointer after a checkpoint crash',t=>{
  const f=fixture(t),job=f.job();f.observe(f.monitor,[job]);const before=fs.readFileSync(f.monitor.stateFile);
  f.clock.now+=20;f.observe(f.monitor,[job]);const [alert]=f.monitor.pendingAlerts();fs.writeFileSync(f.monitor.stateFile,before,{mode:0o600});
  f.monitor=f.open();f.clock.now+=10;f.observe(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts().length,1);assert.equal(f.monitor.pendingAlerts()[0].id,alert.id);
  assert.equal(f.monitor.beginSubmission(alert.id,{jobs:[job]}).status,'submitted');
});

test('confirmed alerts respect cooldown, recovery persists, and sent history does not block idle',t=>{
  const f=fixture(t),job=f.job(),[alert]=f.mature(f.monitor,[job]);f.monitor.beginSubmission(alert.id,{jobs:[job]});f.monitor.recordDelivery(alert.id,'sent');
  f.clock.now+=99;f.observe(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts().length,0);
  f.clock.now++;f.observe(f.monitor,[job]);const reminder=f.monitor.pendingAlerts()[0];assert.notEqual(reminder.id,alert.id);
  job.status='done';job.completedAt=f.clock.now;f.observe(f.monitor,[job]);assert.equal(f.monitor.readAlert(reminder.id).status,'suppressed');
  f.clock.now+=100;f.observe(f.monitor,[job]);const recovery=f.monitor.pendingAlerts()[0];assert.equal(recovery.phase,'recovery');
  f.monitor.beginSubmission(recovery.id,{jobs:[job]});f.monitor.recordDelivery(recovery.id,'sent');const stats=f.monitor.stats();
  assert.equal(stats.monitor_pending_alert_count,0);assert.equal(stats.monitor_submitted_alert_count,0);assert.equal(stats.monitor_unknown_alert_count,0);
  assert.equal(stats.monitor_rejected_alert_count,0);assert.equal(stats.monitor_active_condition_count,0);assert.equal(stats.monitor_sent_alert_count,2);
});

test('rejected alerts do not retry or permanently block after the condition recovers',t=>{
  const f=fixture(t),job=f.job(),[alert]=f.mature(f.monitor,[job]);f.monitor.beginSubmission(alert.id,{jobs:[job]});f.monitor.recordDelivery(alert.id,'rejected');
  assert.equal(f.monitor.stats().monitor_rejected_alert_count,1);f.clock.now+=1000;f.observe(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts().length,0);
  job.status='done';job.completedAt=f.clock.now;f.observe(f.monitor,[job]);f.clock.now+=100;f.observe(f.monitor,[job]);
  assert.equal(f.monitor.stats().monitor_rejected_alert_count,0);assert.equal(f.monitor.pendingAlerts().length,0);
});

test('a cleared incident with an unsent alert creates no recovery noise; relapse suppresses an unsent recovery',t=>{
  const f=fixture(t),job=f.job(),[alert]=f.mature(f.monitor,[job]);job.status='done';job.completedAt=f.clock.now;f.observe(f.monitor,[job]);f.clock.now+=100;f.observe(f.monitor,[job]);
  assert.equal(f.monitor.pendingAlerts().length,0);assert.equal(f.monitor.readAlert(alert.id).status,'suppressed');
  job.status='reply_pending';f.clock.now+=1;const [next]=f.mature(f.monitor,[job]);f.monitor.beginSubmission(next.id,{jobs:[job]});f.monitor.recordDelivery(next.id,'sent');
  job.status='done';f.observe(f.monitor,[job]);f.clock.now+=100;f.observe(f.monitor,[job]);const recovery=f.monitor.pendingAlerts()[0];assert.equal(recovery.phase,'recovery');
  job.status='reply_pending';f.observe(f.monitor,[job]);assert.equal(f.monitor.readAlert(recovery.id).status,'suppressed');
});

test('private samples persist only hashed identity and timing data, with bounded window and explicit fixture evidence',t=>{
  const f=fixture(t),jobs=[1,2,3,4].map(n=>f.job(`sample${n}`,{status:'done',completedAt:f.clock.now-n*10,acceptedAt:100,submittedAt:120,deliveredAt:150,
    firstCardSentAt:100+n*100,firstTypingAppliedAt:100+n*50,firstTypingTimingSource:'create_response'}));
  jobs.push(f.job('failed',{status:'failed'}),f.job('silent',{status:'done',completionDisposition:'silent'}));
  const source=jobs[0],background=[f.background(source,{status:'completed',completedAt:900}),f.background(source,{id:'b'.repeat(64),status:'timed_out',completedAt:950}),
    f.background(source,{id:'c'.repeat(64),status:'cancelled',completedAt:980}),f.background(source,{id:'d'.repeat(64),status:'indeterminate'})];
  f.observe(f.monitor,jobs,background);const aggregate=f.monitor.stats().aggregate;
  assert.equal(aggregate.evidence,'test_fixture');assert.equal(aggregate.reply_delivered_count,4);assert.equal(aggregate.reply_failed_count,1);assert.equal(aggregate.reply_delivery_success_rate,.8);
  assert.equal(aggregate.terminal_time_unknown_count,1);assert.equal(aggregate.timing_sources.typing.create_response,4);
  assert.equal(aggregate.background_execution_success_rate,.5);assert.equal(aggregate.background_cancelled_count,1);
  assert.deepEqual(aggregate.timings_ms.intake_to_first_card,{count:4,p50:200,p95:400});
  assert.doesNotMatch(JSON.stringify(f.monitor.state.samples),/om_|oc_|ou_|fixture-profile|private|customer|create_time|content|sourceJobId/);
  const before=aggregate.sample_count;f.monitor=f.open();f.observe(f.monitor,jobs,background);assert.equal(f.monitor.stats().aggregate.sample_count,before);
  f.clock.now+=100001;f.observe(f.monitor,[],[]);assert.equal(f.monitor.stats().aggregate.sample_count,0);assert.equal(f.monitor.stats().aggregate.reply_delivery_success_rate,null);
});

test('quantiles exclude unknown/reversed timings and sample selection is bounded',()=>{
  const samples=[{type:'reply',status:'done',at:10,timings:{intake_to_first_card:30}},{type:'reply',status:'done',at:20,timings:{intake_to_first_card:NaN}},
    {type:'reply',status:'done',at:30,timings:{intake_to_first_card:-1}},{type:'reply',status:'done',at:40,timings:{intake_to_first_card:50}},
    {type:'reply',status:'done',at:200,timings:{intake_to_first_card:999}},{type:'secret',status:'done',at:40,timings:{intake_to_first_card:999}}];
  const aggregate=aggregateMonitorSamples(samples,{now:100,windowMs:100,maxSamples:3,evidenceLabel:'test_fixture'});
  assert.equal(aggregate.sample_count,3);assert.deepEqual(aggregate.timings_ms.intake_to_first_card,{count:1,p50:50,p95:50});
});

test('missing phase timestamps remain unknown instead of producing a zero age or alarm',t=>{
  const f=fixture(t),job=f.job('unknown-age',{status:'queued',markerSeen:false,acceptedAt:undefined});
  const stats=f.observe(f.monitor,[job]);assert.equal(stats.snapshot.queued_count,1);assert.equal(stats.snapshot.oldest_queued_seconds,null);
  f.clock.now+=1000;f.observe(f.monitor,[job]);assert.equal(f.monitor.pendingAlerts().length,0);
});

test('binding changes isolate old outbox; corruption and symlinks fail closed',t=>{
  const f=fixture(t),job=f.job(),[alert]=f.mature(f.monitor,[job]);
  f.binding.chat_id='oc_other';const rebound=f.open();assert.equal(rebound.pendingAlerts().length,0);assert.equal(rebound.readAlert(alert.id),null);
  f.binding.chat_id='oc_fixture';const file=f.monitor.file(alert.id),record=f.monitor.readAlert(alert.id);record.public.text='private token raw';fs.writeFileSync(file,JSON.stringify(record),{mode:0o600});
  assert.throws(()=>f.monitor.pendingAlerts(),/monitor_alert_invalid/);
  fs.unlinkSync(file);const outside=path.join(f.root,'outside');fs.writeFileSync(outside,JSON.stringify(record),{mode:0o600});fs.symlinkSync(outside,file);
  assert.throws(()=>f.monitor.pendingAlerts(),/monitor_private_state_invalid/);
});
