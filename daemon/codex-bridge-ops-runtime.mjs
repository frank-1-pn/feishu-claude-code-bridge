import fs from 'node:fs';
import path from 'node:path';
import {digest} from './codex-bridge-inbox.mjs';
import {bindingSnapshot,isBoundJob} from './codex-bridge-ux.mjs';
import {isAuthorizedMessage} from './codex-bridge-authorization.mjs';
import {readOpsPolicy,readOpsHealth,opsScope} from './codex-bridge-ops-policy.mjs';
import {TaskControl,stripExternalTaskControlFields} from './codex-bridge-task-control.mjs';
import {DurableMonitor} from './codex-bridge-monitor.mjs';
import {OpsDelivery} from './codex-bridge-ops-delivery.mjs';
import {planTaskRoute} from './codex-bridge-task-router.mjs';
import {stripExternalBackgroundFields} from './codex-bridge-prompt.mjs';
import {prepareDispatchNativeContext,nativeContextVerified} from './codex-bridge-native-context.mjs';
import {selectReplyRoute} from './codex-bridge-reply-routing.mjs';
import {sanitizeFeishuReply} from './codex-bridge-sanitize.mjs';
import {CollaborationContext,stripExternalCollaborationFields} from './codex-bridge-collaboration.mjs';
import {readMetricsPolicy} from './codex-bridge-metrics.mjs';
import {readResearchPolicy,safeResearchProtocol} from './codex-bridge-research.mjs';
import {verifyBackgroundCompletion,verifyBackgroundExecution} from './codex-bridge-background.mjs';
import {stableJson,privateDirectory,readBackgroundTask,validateBackgroundTaskSource,readBackgroundJson,privateRead} from './codex-bridge-background-store.mjs';

const same=(a,b)=>stableJson(a)===stableJson(b);
const id=value=>typeof value==='string'&&/^om_[A-Za-z0-9_-]+$/.test(value);
const failure=code=>Object.assign(Error(code),{code,permanent:true,definitelyFailed:true});
const zeros=()=>({ops_control_pending_count:0,ops_control_blocked_count:0,ops_alert_pending_count:0,ops_alert_blocked_count:0,
  ops_policy_blocked_count:0,ops_delivery_pending_count:0,ops_delivery_blocked_count:0,ops_metrics:null,ops_metrics_history:null,
  ops_metrics_status:{enabled:false,status:'missing',reason:'metrics_policy_missing'},metrics_policy_blocked_count:0,research_policy_blocked_count:0,
  collaboration_operation_pending_count:0,collaboration_operation_blocked_count:0,collaboration_policy_blocked_count:0,
  collaboration_decision_waiting_count:0,collaboration_waiting_task_count:0});
export const OPS_DEPLOYMENT_ID='ops-round2-20261003';
export const stripExternalOpsFields=event=>{
  const clean=stripExternalCollaborationFields(stripExternalTaskControlFields(stripExternalBackgroundFields(event)));
  for(const key of ['intakeEpoch','metricsEpoch','finalDeliveryEvidence','researchSources','trustedResearchSources','trustedCollaborationContext'])delete clean[key];
  return clean;
};

// No subscriber, writer, model turn or business API is created here. Existing
// worker loops supply fresh inbox records and the original serialized router.
export class OpsRuntime {
  constructor(options) {
    Object.assign(this,options);this.now=options.now??Date.now;this.binding={...options.binding};
    this.policyRoot=path.join(options.stateDir,'ops-v1');
    const scope=digest(stableJson(opsScope(this.binding,this.codexHome)));
    this.controlRoot=path.join(options.stateDir,'ops-controls-v1',scope);
    this.monitorRoot=path.join(options.stateDir,'ops-monitor-v1',scope);
    this.deliveryRoot=path.join(options.stateDir,'ops-delivery-v1',scope);
    this.metricsRoot=path.join(options.stateDir,'metrics-v1');
    this.collaboration=new CollaborationContext({root:path.join(options.stateDir,'collaboration-v1'),inboxRoot:this.inboxRoot,
      completionRoot:this.completionRoot,binding:this.binding,codexHome:this.codexHome,now:this.now});
    this.errors={control:0,alert:0,delivery:0};this.refresh();
  }
  refresh() {
    this.policy=readOpsPolicy({root:this.policyRoot,binding:this.binding,codexHome:this.codexHome});
    this.metricsPolicy=readMetricsPolicy({root:this.metricsRoot,binding:this.binding,codexHome:this.codexHome,now:this.now(),expectedDeploymentId:OPS_DEPLOYMENT_ID});
    this.researchPolicy=readResearchPolicy({root:this.backgroundRoot,binding:this.binding,codexHome:this.codexHome});
    const enabled=this.policy.enabled===true;
    // Existing same-scope receipts still fence audits after policy disable.
    // Fresh bots without the private opt-in create no feature state at all.
    if(!this.controls && (enabled&&this.policy.taskControls || fs.existsSync(path.join(this.controlRoot,this.binding.bot)))) {
      try {this.controls=new TaskControl({root:this.controlRoot,binding:this.binding,backgroundRoot:this.backgroundRoot,
        inboxRoot:this.inboxRoot,completionRoot:this.completionRoot,now:this.now});this.errors.control=0;}catch{this.errors.control=1;}
    }
    const metricsConfig=stableJson({epoch:this.metricsPolicy.metricsEpoch,status:this.metricsPolicy.status});
    this.desiredMonitorMetricsConfig=metricsConfig;
    if((!this.monitor||this.monitorMetricsConfig!==metricsConfig) && (enabled&&this.policy.monitoring || fs.existsSync(path.join(this.monitorRoot,this.binding.bot)))) {
      try {this.monitor=new DurableMonitor({root:this.monitorRoot,binding:this.binding,now:this.now,...this.monitorOptions,
        metricsEpoch:this.metricsPolicy.metricsEpoch??undefined,metricsStatus:this.metricsPolicy});this.monitorMetricsConfig=metricsConfig;this.errors.alert=0;}catch{this.errors.alert=1;}
    }
    if(!this.delivery && (enabled&&(this.policy.taskControls||this.policy.monitoring) || fs.existsSync(path.join(this.deliveryRoot,this.binding.bot)))) {
      try {this.delivery=new OpsDelivery({root:this.deliveryRoot,binding:this.binding,codexHome:this.codexHome,router:this.router,
        outbound:this.outbound,request:this.request,resolveAppId:this.resolveAppId,now:this.now,getRoute:jobId=>this.validatedDeliveryRoute(jobId)});this.errors.delivery=0;}catch{this.errors.delivery=1;}
    }
    return this.policy;
  }
  jobs() {
    if(typeof this.getJobs!=='function')return undefined;
    const value=this.getJobs();if(value===undefined||value===null)return undefined;
    return [...value];
  }
  intakeMetadata(event) {
    const job={id:event?.message_id??event?.id,event};
    this.refresh();if(!this.metricsPolicy.enabled||this.metricsPolicy.status!=='enabled'||job?.event?.synthetic_callback===true||!this.bound(job)
      ||!isAuthorizedMessage(this.binding,job.event)||this.monitor?.metricsStatus?.status==='frozen')return {};
    return {intakeEpoch:{deploymentId:this.metricsPolicy.metricsEpoch.deploymentId,versionRef:this.metricsPolicy.metricsEpoch.versionRef}};
  }
  collaborationProtocol(job) {
    if(!this.collaboration.policy().enabled||!this.bound(job)||job.event.synthetic_callback===true||this.privateControl(job.event))return null;
    return {schema:1,enabled:true,readOnly:true,context:this.collaboration.promptProtocol(job)};
  }
  researchProtocol(){this.refresh();return safeResearchProtocol(this.researchPolicy);}
  bound(job){return !!job && job.id===(job.event?.message_id??job.event?.id) && isBoundJob(this.binding,job)
    && same(job.event.bridge_binding,bindingSnapshot(this.binding));}
  privateControl(event) {
    this.refresh();const record=this.controls?.receipt(event);
    if(!record || !same(event.bridge_binding,bindingSnapshot(this.binding))
        || event.codex_thread_id!==undefined && event.codex_thread_id!==this.binding.codex_thread_id)return null;
    if(event.synthetic_callback===true) {
      if(!record.callbackContext || !record.routeMessageId || event.codex_thread_id!==this.binding.codex_thread_id)return null;
      try {
        const context=readBackgroundJson(this.controls.cardFile(record.callbackContext),{mode:0o600});
        const identity=Object.fromEntries(['schema','binding','taskId','sourceJobId','taskKey','keyHash'].map(k=>[k,context[k]]));
        if(this.controls.contextSignature(identity)!==record.callbackContext || !same(context.binding,bindingSnapshot(this.binding))
            || context.messageId!==record.routeMessageId || event.action_source_job_id!==context.sourceJobId
            || event.action_source_message_id!==context.messageId || event.parent_id!==context.sourceJobId
            || record.command.sourceJobId!==context.sourceJobId || record.command.taskId!==context.taskId
            || record.sourceTask && record.sourceTask.sourceJobId!==context.sourceJobId)return null;
      }catch{return null;}
    } else if(record.callbackContext || event.action_source_job_id!==undefined || event.action_source_message_id!==undefined
        || !isAuthorizedMessage(this.binding,event))return null;
    return record;
  }
  controlProtocol(event) {
    const record=this.privateControl(event);if(!record)return null;
    return {handled:true,receiptId:record.id,visible:record.visible===true,delivery:record.delivery.state,
      operation:record.operation??'query',instruction:this.controls.protocol(event).instruction};
  }
  confirmVisible(job) {
    if(job?.markerSeen!==true || !this.bound(job) || !this.privateControl(job.event))return false;
    return this.controls.confirmVisible(job);
  }
  async acceptHuman(jobOrEvent) {
    this.refresh();if(!this.policy.enabled||!this.policy.taskControls||!this.controls)return {accepted:false,reason:'ops_disabled'};
    const event=jobOrEvent?.event??jobOrEvent;
    if(!event || event.synthetic_callback || !same(event.bridge_binding,bindingSnapshot(this.binding)))return {accepted:false,reason:'untrusted_source'};
    try {return await this.controls.accept(event);}catch{this.errors.control=1;return {accepted:false,reason:'ops_control_storage_unavailable'};}
  }
  async acceptCallback(envelope,{authenticatedBot}={}) {
    this.refresh();if(!this.policy.enabled||!this.policy.taskControls||!this.controls)return {accepted:false,reason:'ops_disabled'};
    if(authenticatedBot!==this.binding.bot)return {accepted:false,reason:'unauthorized'};
    try {
      let decoded=envelope,allowMissingHost=false,appId;
      // The installed adapter predates schema/host preservation. Only this
      // exact selected-subscriber envelope may use the private missing-host gate.
      if(envelope?.schema===undefined && envelope.header?.event_type==='card.action.trigger' && envelope.event
          && typeof envelope.header.event_id==='string' && envelope.event.action && envelope.event.operator && envelope.event.context) {
        decoded={...envelope,schema:'2.0'};allowMissingHost=envelope.event.host===undefined;
      }
      if(decoded?.schema==='2.0' && decoded.header?.app_id!==undefined) {
        appId=await this.resolveAppId?.();if(typeof appId!=='string'||!appId)return {accepted:false,reason:'app_unverified'};
      }
      const result=await this.controls.acceptCallback(decoded,{authenticatedBot,appId,allowMissingHost});
      if(result.accepted && !this.privateControl(result.auditEvent))return {accepted:false,reason:'audit_unverified'};
      return result;
    }catch{this.errors.control=1;return {accepted:false,reason:'ops_control_storage_unavailable'};}
  }
  routePlan(event) {
    this.refresh();if(!this.policy.enabled||!this.policy.routing||this.privateControl(event))return null;
    const plan=planTaskRoute({binding:this.binding,event,timezone:this.policy.timezone});return plan.lane==='background'?plan:null;
  }
  async validatedDeliveryRoute(jobId) {
    const jobs=this.jobs(),known=new Map((jobs??[]).map(j=>[j.id,j])),selected=known.get(jobId);
    if(!this.bound(selected))throw failure('ops_delivery_source_missing');
    const copies=new Map(jobs.map(j=>[j.id,structuredClone(j)]));let current=selected,seen=new Set();
    while(current.event.synthetic_callback===true) {
      if(seen.has(current.id)||seen.size>=16 || !this.bound(current))throw failure('ops_delivery_source_invalid');
      if(current.id===jobId && !this.privateControl(current.event))throw failure('ops_delivery_control_unverified');
      seen.add(current.id);current=known.get(current.event.action_source_job_id);
      if(!this.bound(current))throw failure('ops_delivery_source_missing');
    }
    const context=await prepareDispatchNativeContext(this.binding,current,this.request);
    if(!nativeContextVerified(this.binding,context.event))throw failure('ops_delivery_context_unknown');
    copies.get(current.id).event=context.event;
    return selectReplyRoute(this.binding,[copies.get(jobId)],{allJobs:copies.values()});
  }
  bindCard(contextId,messageId) {
    const records=this.controls?.records()??[];
    const record=records.find(r=>this.controls.valid(r)&&r.contextId===contextId);
    if(!record)throw failure('ops_delivery_context_owner_missing');return this.controls.bindCard(contextId,messageId);
  }
  async controlsTick() {
    this.refresh();if(!this.policy.enabled||!this.policy.taskControls||!this.controls||!this.delivery)return this.stats();
    try {await this.controls.drain((text,key,context)=>this.delivery.send(text,key,{...context,ownerKind:'control',ownerId:digest(context.receiptId),
      cardMarker:context.contextId??'后台任务',onMessage:(c,m)=>this.bindCard(c,m)}));this.errors.control=0;}catch{this.errors.control=1;}
    return this.stats();
  }
  async backgroundProjection() {
    try {
      const dir=path.join(this.backgroundRoot,this.binding.bot);if(!fs.existsSync(dir))return undefined;
      privateDirectory(this.backgroundRoot);privateDirectory(dir);
      const ids=fs.readdirSync(dir).filter(i=>/^[a-f0-9]{64}$/.test(i));
      if(this.getBackgroundTasks) {
        const supplied=await this.getBackgroundTasks();
        if(!Array.isArray(supplied)||!same(supplied.map(t=>t.id??t.task?.id).sort(),ids.slice().sort()))return undefined;
      }
      return ids.map(taskId=>{
        const task=readBackgroundTask(this.backgroundRoot,this.binding,taskId);
        validateBackgroundTaskSource(task,{inboxRoot:this.inboxRoot,binding:this.binding,completionRoot:this.completionRoot});
        const taskDir=path.join(dir,taskId),state=readBackgroundJson(path.join(taskDir,'schedule.json'),{optional:true,maxBytes:8*1024*1024});
        if(state&&(state.schema!==1||state.taskId!==task.id||state.requestHash!==task.requestHash
            || !['queued','claimed','running','indeterminate','blocked','completed','failed','cancelled','timed_out'].includes(state.status)))throw failure('ops_background_state_invalid');
        const claim=readBackgroundJson(path.join(taskDir,'claim.json'),{optional:true}),run=readBackgroundJson(path.join(taskDir,'run.json'),{optional:true});
        const validClaim=claim?.schema===1 && claim.taskId===task.id && typeof claim.nonce==='string' && /^[a-f0-9-]{36}$/.test(claim.nonce);
        let status=claim&&!validClaim?'indeterminate':state?.status??(claim||run?'indeterminate':'queued');
        const validRun=run?.schema===1 && validClaim && run.taskId===task.id && run.nonce===claim.nonce
          && run.taskSha256===digest(privateRead(path.join(taskDir,'task.json'),{maxBytes:128*1024})) && run.status===status;
        const execution=verifyBackgroundExecution(this.binding,task.id,this.backgroundRoot);
        if(['completed','failed','timed_out','cancelled'].includes(status) && (!execution?.verified||execution.status!==status))status='indeterminate';
        const callback=(this.jobs()??[]).find(j=>j.id===state?.notification?.jobId);
        const resultVerified=status==='completed'&&validRun&&execution?.verified&&callback?.status==='done'&&callback.markerSeen===true&&this.bound(callback)
          &&callback.event.background_task_id===task.id&&callback.event.action_source_job_id===task.sourceJobId
          &&callback.event.background_nonce===run.nonce&&verifyBackgroundCompletion(this.binding,callback.event,this.backgroundRoot);
        return {id:task.id,sourceJobId:task.sourceJobId,status,createdAt:task.createdAt,runAt:task.runAt,
          ...(state?.claimedAt!==undefined?{claimedAt:state.claimedAt}:{}),...(execution?.verified&&execution.status===status&&execution.completedAt!==null?{completedAt:execution.completedAt}:{}),
          executionBlocked:!!state?.executionBlocked,notificationBlocked:!!state?.notificationBlocked,
          ...(resultVerified?{resultDeliveryVerified:true,resultDeliveryStatus:'done',resultDeliveryEvidence:callback.finalDeliveryEvidence}: {})};
      });
    }catch{return undefined;}
  }
  async monitorTick() {
    this.refresh();if(!this.policy.enabled||!this.policy.monitoring||!this.monitor||!this.delivery
      ||this.monitorMetricsConfig!==this.desiredMonitorMetricsConfig)return this.stats();
    try {
      const results=await Promise.allSettled([Promise.resolve().then(()=>this.jobs()),this.backgroundProjection(),
        Promise.resolve().then(()=>this.getBackgroundStats?.()),Promise.resolve().then(()=>typeof this.health==='function'?this.health():this.health??readOpsHealth({daemonDir:this.daemonDir,binding:this.binding,now:this.now()}))]);
      const value=i=>results[i].status==='fulfilled'?results[i].value:undefined;
      const jobs=value(0),backgroundTasks=value(1),rawStats=value(2),rawHealth=value(3);
      const fields=['background_queued_count','background_running_count','background_result_pending_count','background_blocked_count'];
      const backgroundStats=fields.every(k=>Number.isSafeInteger(rawStats?.[k])&&rawStats[k]>=0)?Object.fromEntries(fields.map(k=>[k,rawStats[k]])):undefined;
      const health=Object.fromEntries(['transport_healthy','delivery_healthy'].filter(k=>typeof rawHealth?.[k]==='boolean').map(k=>[k,rawHealth[k]]));
      this.monitor.observe({jobs,backgroundTasks,backgroundStats,health});
      for(const pending of this.monitor.pendingAlerts()) {
        const condition=this.monitor.state.conditions[pending.conditionKey];
        if(!jobs || condition?.domain==='background'&&backgroundTasks===undefined
            || ['transport_healthy','delivery_healthy'].includes(condition?.domain)&&typeof health[condition.domain]!=='boolean')continue;
        const fresh=this.jobs(),alert=this.monitor.beginSubmission(pending.id,{jobs:fresh});if(!alert)continue;
        let result;try {result=await this.delivery.send(alert.public.text,`ops-alert:${alert.id}`,{ownerKind:'alert',ownerId:alert.id,jobId:alert.sourceJobId});}catch(error){result={definitelyFailed:error?.definitelyFailed===true};}
        this.monitor.recordDelivery(alert.id,result.delivered===true?'sent':result.definitelyFailed===true?'rejected':'unknown');
      }
      this.errors.alert=0;
    }catch{this.errors.alert=1;}
    return this.stats();
  }
  async deliveryTick() {
    this.refresh();if(!this.policy.enabled||!this.delivery)return this.stats();
    try {
      await this.delivery.reconcile({onMessage:(c,m)=>this.bindCard(c,m),onVerified:state=>{
        if(state.ownerKind==='control' && this.controls) {
          const record=this.controls.records().find(r=>this.controls.valid(r)&&digest(r.id)===state.ownerId&&r.delivery.key===state.key&&r.id===state.jobId);
          if(!record || (record.contextId??null)!==(state.contextId??null)
              || !same(state.content,record.card??{text:sanitizeFeishuReply(record.text).trim()}))throw failure('ops_delivery_owner_mismatch');
          this.controls.reconcileDelivery(record.id,{verified:true,messageId:state.messageId,key:state.key});
        }else if(state.ownerKind==='alert' && this.monitor) {
          const alert=this.monitor.readAlert(state.ownerId);
          if(!alert || state.key!==`ops-alert:${alert.id}` || state.jobId!==alert.sourceJobId || !this.monitor.claimed(alert.id)
              || !same(state.content,{text:sanitizeFeishuReply(alert.public.text).trim()}))throw failure('ops_delivery_owner_mismatch');
          this.monitor.recordDelivery(alert.id,'sent',{verified:true});
        }else throw failure('ops_delivery_owner_missing');
      }});this.errors.delivery=0;
    }catch{this.errors.delivery=1;}
    return this.stats();
  }
  stats() {
    this.refresh();const out=zeros();out.ops_policy_blocked_count=this.policy.reason?1:0;
    const metricsCurrent=!this.monitor||this.monitorMetricsConfig===this.desiredMonitorMetricsConfig;
    out.metrics_policy_blocked_count=this.metricsPolicy.status==='invalid'||!metricsCurrent?1:0;
    out.ops_metrics_status={enabled:this.metricsPolicy.enabled,status:this.metricsPolicy.status,reason:this.metricsPolicy.reason};
    if(!metricsCurrent)out.ops_metrics_status={enabled:false,status:'invalid',reason:'metrics_runtime_unavailable'};
    out.research_policy_blocked_count=this.researchPolicy.reason&&this.researchPolicy.reason!=='research_policy_missing'?1:0;
    try {Object.assign(out,this.collaboration.stats());}catch{out.collaboration_operation_pending_count=1;out.collaboration_operation_blocked_count=1;}
    try {if(this.controls){const s=this.controls.stats();out.ops_control_pending_count=s.task_control_pending_count;out.ops_control_blocked_count=s.task_control_blocked_count;}}catch{this.errors.control=1;}
    try {if(this.monitor){const s=this.monitor.stats();out.ops_alert_pending_count=s.monitor_pending_alert_count+s.monitor_submitted_alert_count+s.monitor_unknown_alert_count;
      out.ops_alert_blocked_count=s.monitor_unknown_alert_count+s.monitor_rejected_alert_count;out.ops_metrics=metricsCurrent?s.epochAggregate:null;out.ops_metrics_history=s.aggregate;}}catch{this.errors.alert=1;}
    if(this.monitor&&metricsCurrent)out.ops_metrics_status={...this.monitor.metricsStatus};
    try {if(this.delivery){const s=this.delivery.stats();out.ops_delivery_pending_count=s.ops_delivery_pending_count+s.ops_delivery_blocked_count;out.ops_delivery_blocked_count=s.ops_delivery_blocked_count;}}catch{this.errors.delivery=1;}
    for(const [kind,prefix] of [['control','ops_control'],['alert','ops_alert'],['delivery','ops_delivery']]) {
      out[`${prefix}_blocked_count`]+=this.errors[kind];out[`${prefix}_pending_count`]+=this.errors[kind];
    }
    return out;
  }
}
export const createOpsRuntime=options=>new OpsRuntime(options);
