import fs from 'node:fs';
import path from 'node:path';
import {digest} from './codex-bridge-inbox.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';
import {bindingSnapshot,isBoundJob} from './codex-bridge-ux.mjs';
import {isAuthorizedMessage} from './codex-bridge-authorization.mjs';
import {performanceMetadata} from './codex-bridge-performance.mjs';
import {privateDirectory,readBackgroundJson,publishBackgroundJson,stableJson} from './codex-bridge-background-store.mjs';

const kinds=new Set(['queued_stalled','delivery_stalled','reply_stalled','reply_blocked','background_queued_stalled','background_blocked','background_indeterminate','transport_unhealthy','delivery_unhealthy']);
const timingNames=['original_to_intake','original_to_marker','original_to_first_card','original_to_first_typing','original_to_final_delivery',
  'intake_to_submit','submit_to_marker','intake_to_final_delivery','intake_to_first_card','intake_to_first_typing','prefetch'];
const messages={queued_stalled:'运营任务排队时间持续偏长',delivery_stalled:'运营任务尚未确认进入会话',reply_stalled:'运营任务的最终回包持续未确认送达',reply_blocked:'运营任务的回包通道持续受阻',
  background_queued_stalled:'后台只读任务超过计划时间仍在排队',background_blocked:'后台只读任务持续受阻',background_indeterminate:'后台只读任务的运行结果持续无法确认',
  transport_unhealthy:'运营任务的传输健康指标持续异常',delivery_unhealthy:'运营任务的交付健康指标持续异常'};
const number=value=>Number.isFinite(value) && value>=0?value:null;
const age=(now,at)=>number(at)!==null && at<=now?now-at:null;
const validId=value=>typeof value==='string' && /^om_[A-Za-z0-9_-]+$/.test(value);
const errors=code=>Object.assign(Error(code),{code});
const readPrivateJson=(file,options)=>{try{return readBackgroundJson(file,options);}catch{throw errors('monitor_private_state_invalid');}};
const quantile=(values,p)=>values.length?values.slice().sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]:null;
const durations=record=>Object.fromEntries(timingNames.map(name=>[name,number(record.timings_ms?.[name])]));
const publicPayload=(kind,phase,oldestSeconds)=>({text:phase==='alert'?`${messages[kind]}；系统保留原任务，不会自动重执行业务。`
  :'相关等待或阻塞条件已恢复；这是监测状态，不代表业务已完成。',affected_count:1,oldest_seconds:oldestSeconds});

// Resolve synthetic continuations to an actually observed human source. A
// queued callback can be monitored without pretending its own marker exists.
export function monitorSource(binding,job,jobs) {
  const seen=new Set();let current=job;
  while(current?.event?.synthetic_callback===true) {
    if(seen.has(current.id) || seen.size>=16 || !isBoundJob(binding,current)
        || stableJson(current.event.bridge_binding)!==stableJson(bindingSnapshot(binding)))return null;
    seen.add(current.id);current=jobs.get(current.event.action_source_job_id);
  }
  if(!current || !validId(current.id) || current.event?.message_id!==current.id
      || !isAuthorizedMessage(binding,current.event) || !isBoundJob(binding,current)
      || stableJson(current.event.bridge_binding)!==stableJson(bindingSnapshot(binding))
      || current.markerSeen!==true || current.feedbackDisposition!=='actionable'
      || current.completionDisposition==='silent' || current.unclassifiedTurnEnded)return null;
  return current;
}

export function aggregateMonitorSamples(samples,{now=Date.now(),windowMs=86400000,maxSamples=2048,evidenceLabel='runtime_observation'}={}) {
  const selected=samples.filter(s=>number(s.at)!==null && s.at<=now && now-s.at<=windowMs
    && (s.type==='reply' && ['done','failed'].includes(s.status) || s.type==='background' && ['completed','failed','timed_out','cancelled'].includes(s.status)))
    .sort((a,b)=>b.at-a.at).slice(0,maxSamples);
  const replies=selected.filter(s=>s.type==='reply'),background=selected.filter(s=>s.type==='background');
  const count=(items,status)=>items.filter(s=>s.status===status).length;
  const delivered=count(replies,'done'),failed=count(replies,'failed'),completed=count(background,'completed'),backgroundFailed=count(background,'failed')+count(background,'timed_out');
  return {evidence:evidenceLabel,sample_window_ms:windowMs,sample_count:selected.length,
    terminal_time_basis:'completion_or_first_observation',terminal_time_unknown_count:selected.filter(s=>s.atSource==='first_observation').length,
    reply_delivered_count:delivered,reply_failed_count:failed,reply_delivery_success_rate:delivered+failed?delivered/(delivered+failed):null,
    background_completed_count:completed,background_failed_count:backgroundFailed,background_cancelled_count:count(background,'cancelled'),
    background_execution_success_rate:completed+backgroundFailed?completed/(completed+backgroundFailed):null,
    timing_sources:Object.fromEntries(['card','typing'].map(field=>[field,Object.fromEntries(['send_response','create_response','reconciled_observation','reconciled','unknown']
      .map(source=>[source,replies.filter(s=>s.status==='done' && (s.sources?.[field]??'unknown')===source).length]))])),
    timings_ms:Object.fromEntries(timingNames.map(name=>{
      const values=replies.filter(s=>s.status==='done').map(s=>number(s.timings?.[name])).filter(v=>v!==null);
      return [name,{count:values.length,p50:quantile(values,.5),p95:quantile(values,.95)}];
    }))};
}

// A monitor never calls the platform or advances a model/business task. The
// caller submits its private outbox on the original source route, once only.
export class DurableMonitor {
  constructor({root,binding,now=Date.now,thresholds={},persistMs=30000,recoveryMs=30000,cooldownMs=1800000,
    windowMs=86400000,maxSamples=2048,evidenceLabel='runtime_observation'}) {
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(binding?.bot??'') || !['runtime_observation','test_fixture'].includes(evidenceLabel))throw errors('monitor_config_invalid');
    for(const value of [persistMs,recoveryMs,cooldownMs,windowMs,maxSamples])if(!Number.isSafeInteger(value) || value<1)throw errors('monitor_config_invalid');
    this.binding=binding;this.scope=digest(stableJson(bindingSnapshot(binding)));this.now=now;
    Object.assign(this,{persistMs,recoveryMs,cooldownMs,windowMs,maxSamples,evidenceLabel});
    this.thresholds={queued:120000,delivery:120000,reply:120000,backgroundQueued:120000,...thresholds};
    if(Object.keys(this.thresholds).some(k=>!['queued','delivery','reply','backgroundQueued'].includes(k)) || Object.values(this.thresholds).some(v=>!Number.isSafeInteger(v) || v<1))throw errors('monitor_config_invalid');
    this.root=path.resolve(root);this.dir=path.join(this.root,binding.bot,this.scope);
    for(const dir of [this.root,path.join(this.root,binding.bot),this.dir])privateDirectory(dir,{create:true});
    this.stateFile=path.join(this.dir,'monitor.json');
    this.state=readPrivateJson(this.stateFile,{optional:true,maxBytes:8*1024*1024,mode:0o600})??{schema:1,scope:this.scope,evidence:evidenceLabel,conditions:{},samples:{}};
    if(this.state.schema!==1 || this.state.scope!==this.scope || this.state.evidence!==evidenceLabel
      || !this.state.conditions || typeof this.state.conditions!=='object' || Array.isArray(this.state.conditions)
      || !this.state.samples || typeof this.state.samples!=='object' || Array.isArray(this.state.samples))throw errors('monitor_state_invalid');
    // The claim may have reached disk before the mutable submitted checkpoint.
    for(const alert of this.alerts())if(alert.status==='pending' && this.claimed(alert.id)) {
      alert.status='unknown';alert.errorCategory='submission_interrupted';this.saveAlert(alert);
    }
  }
  save() {privateDirectory(this.dir);atomicWriteJson(this.stateFile,this.state);
    const back=readPrivateJson(this.stateFile,{maxBytes:8*1024*1024,mode:0o600});if(back.schema!==1 || back.scope!==this.scope)throw errors('monitor_readback_failed');}
  file(id){if(!/^[a-f0-9]{64}$/.test(id??''))throw errors('monitor_alert_invalid');return path.join(this.dir,`alert-${id}.json`);}
  readAlert(id){const value=readPrivateJson(this.file(id),{optional:true,maxBytes:16384,mode:0o600});
    if(value && (value.schema!==1 || value.id!==id || value.scope!==this.scope || !kinds.has(value.kind) || !['alert','recovery'].includes(value.phase)
      || !/^[a-f0-9]{64}$/.test(value.conditionKey??'') || number(value.episode)===null || !['pending','submitted','sent','unknown','rejected','suppressed'].includes(value.status)
      || !validId(value.sourceJobId) || !Number.isSafeInteger(value.public?.oldest_seconds) || value.public.oldest_seconds<0
      || stableJson(value.public)!==stableJson(publicPayload(value.kind,value.phase,value.public.oldest_seconds))
      || value.payloadSha256!==digest(stableJson(value.public))))throw errors('monitor_alert_invalid');return value;}
  saveAlert(alert){privateDirectory(this.dir);atomicWriteJson(this.file(alert.id),alert);if(this.readAlert(alert.id).status!==alert.status)throw errors('monitor_readback_failed');}
  claimed(id){const claim=readPrivateJson(path.join(this.dir,`submit-${id}.json`),{optional:true,maxBytes:8192,mode:0o600});
    if(claim && (claim.schema!==1 || claim.id!==id || claim.scope!==this.scope || claim.payloadSha256!==this.readAlert(id)?.payloadSha256))throw errors('monitor_submission_invalid');return claim!==null;}
  alerts(){return fs.readdirSync(this.dir).filter(n=>/^alert-[a-f0-9]{64}\.json$/.test(n)).map(n=>this.readAlert(n.slice(6,-5)));}
  createAlert(condition,phase) {
    const previous=condition.lastAlertId && this.readAlert(condition.lastAlertId);
    if(phase==='alert' && previous && previous.episode===condition.episode && ['pending','submitted','unknown','rejected'].includes(previous.status))return;
    if(number(condition.lastPublishedAt)!==null && this.now()-condition.lastPublishedAt<this.cooldownMs)return;
    const sequence=(condition.emissions??0)+1;
    const id=digest(`${this.scope}\0${condition.key}\0${condition.episode}\0${phase}\0${sequence}`);
    const payload=publicPayload(condition.kind,phase,Math.floor((condition.ageMs??0)/1000));
    const alert={schema:1,id,scope:this.scope,conditionKey:condition.key,episode:condition.episode,kind:condition.kind,phase,
      sourceJobId:condition.sourceJobId,createdAt:this.now(),status:'pending',public:payload,payloadSha256:digest(stableJson(payload))};
    publishBackgroundJson(this.file(id),alert);
    const back=this.readAlert(id);
    if(back.conditionKey!==condition.key || back.episode!==condition.episode || back.phase!==phase || back.sourceJobId!==condition.sourceJobId)throw errors('monitor_alert_collision');
    condition.lastAlertId=id;condition.emissions=sequence;condition.lastPublishedAt=back.createdAt;
    if(phase==='alert')condition.exposed=condition.exposed || previous?.episode===condition.episode && ['submitted','sent','unknown'].includes(previous.status)
      || ['submitted','sent','unknown'].includes(back.status);else condition.recoveryQueued=true;
  }
  observe({jobs,backgroundTasks,backgroundStats,health}={}) {
    const at=this.now(),all=jobs===undefined?null:new Map([...jobs].map(j=>[j.id,j]));
    const backgrounds=Array.isArray(backgroundTasks)?backgroundTasks:null,candidates=new Map();
    const add=(kind,entity,source,ageMs,domain)=>{
      const key=digest(`${this.scope}\0${kind}\0${entity}`),human=all&&monitorSource(this.binding,source,all);
      candidates.set(key,{key,kind,domain,sourceJobId:human?.id??null,ageMs:ageMs??0});
    };
    if(all)for(const job of all.values()) {
      const queuedAge=age(at,job.acceptedAt),deliveryAge=age(at,job.submittedAt);
      const replyAge=age(at,job.replyPendingAt??job.lastActivityAt??job.deliveredAt??job.submittedAt??job.acceptedAt);
      if(job.status==='queued' && queuedAge!==null && queuedAge>=this.thresholds.queued)add('queued_stalled',job.id,job,queuedAge,'jobs');
      if(job.status==='submitted' && deliveryAge!==null && deliveryAge>=this.thresholds.delivery)add('delivery_stalled',job.id,job,deliveryAge,'jobs');
      const replyBlocked=job.replyRetry?.blocked===true || job.replyCardRetry?.blocked===true || job.noticeRetry?.blocked===true;
      if(replyBlocked)add('reply_blocked',job.id,job,replyAge,'jobs');
      else if(job.status==='reply_pending' && replyAge!==null && replyAge>=this.thresholds.reply)add('reply_stalled',job.id,job,replyAge,'jobs');
      const source=monitorSource(this.binding,job,all);
      if(source && ['done','failed'].includes(job.status)) {
        const key=digest(`monitor-sample\0${this.scope}\0reply\0${job.id}`),prior=this.state.samples[key];
        const record=performanceMetadata(this.binding.bot,job);
        this.state.samples[key]={key,type:'reply',status:job.status,at:number(job.completedAt)??prior?.at??at,
          atSource:number(job.completedAt)===null?'first_observation':'completion',timings:durations(record),sources:record.sources};
      }
    }
    if(backgrounds)for(const task of backgrounds) {
      if(typeof task.id!=='string' || !/^[a-f0-9]{64}$/.test(task.id))continue;
      const source=all?.get(task.sourceJobId),queuedAge=age(at,task.runAt??task.createdAt),taskAge=age(at,task.claimedAt??task.createdAt);
      if(task.status==='queued' && queuedAge!==null && queuedAge>=this.thresholds.backgroundQueued)add('background_queued_stalled',task.id,source,queuedAge,'background');
      if(task.status==='indeterminate')add('background_indeterminate',task.id,source,taskAge,'background');
      else if(task.status==='blocked' || task.executionBlocked || task.notificationBlocked)add('background_blocked',task.id,source,taskAge,'background');
      if(all && monitorSource(this.binding,source,all) && ['completed','failed','timed_out','cancelled'].includes(task.status)) {
        const key=digest(`monitor-sample\0${this.scope}\0background\0${task.id}`),prior=this.state.samples[key];
        this.state.samples[key]={key,type:'background',status:task.status,at:number(task.completedAt)??prior?.at??at,
          atSource:number(task.completedAt)===null?'first_observation':'completion'};
      }
    }
    const activeSources=all?[...all.values()].filter(j=>['queued','submitted','delivered','reply_pending'].includes(j.status) || j.replyRetry?.blocked || j.replyCardRetry?.blocked):[];
    if(backgrounds && all)for(const task of backgrounds)if(['queued','claimed','running','blocked','indeterminate'].includes(task.status))activeSources.push(all.get(task.sourceJobId));
    const healthSource=activeSources.find(j=>j && monitorSource(this.binding,j,all));
    for(const [field,kind] of [['transport_healthy','transport_unhealthy'],['delivery_healthy','delivery_unhealthy']])if(health?.[field]===false)add(kind,'health',healthSource,0,field);
    const complete={jobs:all!==null,background:backgrounds!==null,transport_healthy:typeof health?.transport_healthy==='boolean',delivery_healthy:typeof health?.delivery_healthy==='boolean'};
    for(const [key,candidate] of candidates) {
      let condition=this.state.conditions[key];
      if(!condition)condition=this.state.conditions[key]={...candidate,episode:at,firstSeenAt:at,breaching:true,emissions:0};
      else if(!condition.breaching) {condition.episode=at;condition.firstSeenAt=at;condition.breaching=true;condition.recoveryQueued=false;condition.exposed=false;delete condition.clearedAt;}
      Object.assign(condition,candidate,{lastObservedAt:at});
      if(condition.sourceJobId && at-condition.firstSeenAt>=this.persistMs)this.createAlert(condition,'alert');
    }
    const observedAlerts=this.alerts();
    for(const condition of Object.values(this.state.conditions))if(!candidates.has(condition.key) && complete[condition.domain]) {
      if(condition.breaching) {condition.breaching=false;condition.clearedAt=at;}
      const prior=condition.lastAlertId && this.readAlert(condition.lastAlertId);
      if(prior?.status==='pending' && prior.phase==='alert') {prior.status='suppressed';prior.errorCategory='condition_cleared';this.saveAlert(prior);}
      condition.exposed=observedAlerts.some(a=>a.conditionKey===condition.key && a.episode===condition.episode && a.phase==='alert' && ['submitted','sent','unknown'].includes(a.status));
      if(condition.exposed && !condition.recoveryQueued && at-condition.clearedAt>=this.recoveryMs && condition.sourceJobId)this.createAlert(condition,'recovery');
    }
    for(const alert of this.alerts())if(alert.status==='pending') {
      const condition=this.state.conditions[alert.conditionKey];
      if(!condition || condition.episode!==alert.episode || all && condition.sourceJobId!==alert.sourceJobId || alert.phase==='recovery' && condition.breaching) {
        alert.status='suppressed';alert.errorCategory='condition_changed';this.saveAlert(alert);
      }
    }
    const samples=Object.values(this.state.samples).filter(s=>age(at,s.at)!==null && at-s.at<=this.windowMs).sort((a,b)=>b.at-a.at).slice(0,this.maxSamples);
    this.state.samples=Object.fromEntries(samples.map(s=>[s.key,s]));
    const jobList=all?[...all.values()]:null;
    const oldest=(items,time)=>{if(!items)return null;if(!items.length)return 0;const values=items.map(j=>age(at,time(j))).filter(v=>v!==null);return values.length?Math.floor(Math.max(...values)/1000):null;};
    const activeBackground=backgrounds?.filter(t=>['claimed','running','indeterminate'].includes(t.status));
    this.state.snapshot={observedAt:at,jobs_available:all!==null,background_tasks_available:backgrounds!==null,background_stats_available:backgroundStats!==undefined,
      queued_count:jobList?.filter(j=>j.status==='queued').length??null,reply_pending_count:jobList?.filter(j=>j.status==='reply_pending').length??null,
      oldest_queued_seconds:oldest(jobList?.filter(j=>j.status==='queued'),j=>j.acceptedAt),
      oldest_delivery_seconds:oldest(jobList?.filter(j=>j.status==='submitted'),j=>j.submittedAt),
      oldest_reply_pending_seconds:oldest(jobList?.filter(j=>j.status==='reply_pending'),j=>j.replyPendingAt??j.lastActivityAt??j.deliveredAt??j.acceptedAt),
      oldest_background_due_queue_seconds:oldest(backgrounds?.filter(t=>t.status==='queued' && number(t.runAt)!==null && t.runAt<=at),t=>t.runAt),
      oldest_background_active_seconds:number(backgroundStats?.background_running_count)!==null && backgroundStats.background_running_count>(activeBackground?.length??0)
        ?null:oldest(activeBackground,t=>t.claimedAt??t.createdAt),
      background_blocked_count:number(backgroundStats?.background_blocked_count),background_running_count:number(backgroundStats?.background_running_count),
      transport_healthy:typeof health?.transport_healthy==='boolean'?health.transport_healthy:null,delivery_healthy:typeof health?.delivery_healthy==='boolean'?health.delivery_healthy:null};
    this.save();return this.stats();
  }
  pendingAlerts(){return this.alerts().filter(a=>a.status==='pending' && !this.claimed(a.id));}
  beginSubmission(id,{jobs}={}) {
    const alert=this.readAlert(id);if(!alert || alert.status!=='pending' || this.claimed(id))return null;
    const condition=this.state.conditions[alert.conditionKey];
    if(!condition || condition.episode!==alert.episode || condition.sourceJobId!==alert.sourceJobId
        || alert.phase==='alert' && !condition.breaching || alert.phase==='recovery' && condition.breaching) {
      alert.status='suppressed';alert.errorCategory='condition_changed';this.saveAlert(alert);return null;
    }
    const all=jobs===undefined?null:new Map([...jobs].map(j=>[j.id,j]));
    if(!all || !monitorSource(this.binding,all.get(alert.sourceJobId),all)) {
      alert.status='suppressed';alert.errorCategory='source_not_actionable';this.saveAlert(alert);return null;
    }
    const claim={schema:1,id,scope:this.scope,payloadSha256:alert.payloadSha256,submittedAt:this.now()};
    if(!publishBackgroundJson(path.join(this.dir,`submit-${id}.json`),claim))return null;
    alert.status='submitted';alert.submittedAt=claim.submittedAt;this.saveAlert(alert);
    condition.lastPublishedAt=claim.submittedAt;if(alert.phase==='alert')condition.exposed=true;this.save();return alert;
  }
  recordDelivery(id,status,{verified=false}={}) {
    if(!['sent','unknown','rejected'].includes(status))throw errors('monitor_delivery_invalid');
    const alert=this.readAlert(id);if(!alert || !this.claimed(id))throw errors('monitor_submission_missing');
    if(alert.status===status)return alert;
    if(alert.status==='sent' || alert.status==='rejected' || !['submitted','unknown'].includes(alert.status)
        || alert.status==='unknown' && !verified)throw errors('monitor_delivery_reconciliation_required');
    alert.status=status;alert.deliveryRecordedAt=this.now();this.saveAlert(alert);return alert;
  }
  stats() {
    const alerts=this.alerts(),count=status=>alerts.filter(a=>a.status===status).length,conditions=Object.values(this.state.conditions);
    return {monitor_pending_alert_count:count('pending'),monitor_submitted_alert_count:count('submitted'),monitor_unknown_alert_count:count('unknown'),
      monitor_rejected_alert_count:alerts.filter(a=>a.status==='rejected' && this.state.conditions[a.conditionKey]?.breaching && this.state.conditions[a.conditionKey]?.episode===a.episode).length,
      monitor_sent_alert_count:count('sent'),monitor_recovered_condition_count:conditions.filter(c=>!c.breaching && (age(this.now(),c.clearedAt)??-1)>=this.recoveryMs).length,
      monitor_recovering_condition_count:conditions.filter(c=>!c.breaching && (age(this.now(),c.clearedAt)??-1)<this.recoveryMs).length,monitor_active_condition_count:conditions.filter(c=>c.breaching).length,
      monitor_private_diagnostic_count:conditions.filter(c=>c.breaching && !c.sourceJobId).length,
      snapshot:this.state.snapshot??null,aggregate:aggregateMonitorSamples(Object.values(this.state.samples),{now:this.now(),windowMs:this.windowMs,maxSamples:this.maxSamples,evidenceLabel:this.evidenceLabel})};
  }
}
