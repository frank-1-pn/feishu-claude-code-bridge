import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {opsScope} from './codex-bridge-ops-policy.mjs';
import {privateDirectory,readBackgroundJson,stableJson} from './codex-bridge-background-store.mjs';

const hash=value=>createHash('sha256').update(stableJson(value)).digest('hex');
const plain=value=>value && typeof value==='object' && !Array.isArray(value);
const exact=(value,keys)=>plain(value) && Object.keys(value).every(k=>keys.includes(k));
const timestamp=value=>Number.isSafeInteger(value) && value>=946684800000?value:null;

// Feishu event times are epoch milliseconds. ISO must carry an explicit zone;
// absent/bad dates remain unknown instead of using the time of observation.
export function sourceTimestamp(event) {
  const value=event?.create_time??event?.timestamp;
  if(typeof value==='number')return timestamp(value);
  if(typeof value!=='string')return null;
  if(/^\d{12,16}$/.test(value))return timestamp(Number(value));
  if(!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
  const day=Date.parse(`${value.slice(0,10)}T00:00:00Z`);
  if(!Number.isFinite(day) || new Date(day).toISOString().slice(0,10)!==value.slice(0,10))return null;
  return timestamp(Date.parse(value));
}

export function normalizeMetricsEpoch(value,{now=Date.now()}={}) {
  if(!exact(value,['deploymentId','versionRef','startedAt','frozenAt'])
      || !/^[A-Za-z0-9_-]{1,80}$/.test(value.deploymentId??'')
      || !/^[a-f0-9]{40}$/.test(value.versionRef??'')
      || timestamp(value.startedAt)===null || value.startedAt>now
      || value.frozenAt!==undefined && (timestamp(value.frozenAt)===null || value.frozenAt<value.startedAt || value.frozenAt>now))return null;
  return {...value};
}
export function metricsEpochKey(epoch) {
  // Freezing an existing deployment closes its window, not a second epoch.
  return hash({deploymentId:epoch.deploymentId,versionRef:epoch.versionRef,startedAt:epoch.startedAt});
}

export function readMetricsPolicy({root,binding,codexHome,now=Date.now(),expectedDeploymentId}) {
  const disabled=(status,reason)=>({enabled:false,status,reason,metricsEpoch:null});
  try {
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(binding?.bot??''))return disabled('invalid','metrics_policy_invalid');
    const dir=path.join(path.resolve(root),binding.bot),file=path.join(dir,'policy.json');
    if(!fs.existsSync(file))return disabled('missing','metrics_policy_missing');
    privateDirectory(path.resolve(root));privateDirectory(dir);
    if([path.resolve(root),dir].some(d=>(fs.lstatSync(d).mode&0o777)!==0o700) || fs.lstatSync(file).nlink!==1)return disabled('invalid','metrics_policy_invalid');
    const policy=readBackgroundJson(file,{mode:0o600,maxBytes:16384});
    const epoch=normalizeMetricsEpoch(policy?.epoch,{now});
    if(!exact(policy,['schema','scope','epoch']) || policy.schema!==1 || !epoch
        || expectedDeploymentId!==undefined && epoch.deploymentId!==expectedDeploymentId
        || stableJson(policy.scope)!==stableJson(opsScope(binding,codexHome)))return disabled('invalid','metrics_policy_invalid');
    return {enabled:true,status:epoch.frozenAt===undefined?'enabled':'frozen',reason:null,metricsEpoch:epoch,epochKey:metricsEpochKey(epoch)};
  }catch{return disabled('invalid','metrics_policy_invalid');}
}
export function intakeEpochMatches(job,epoch) {
  return job?.intakeEpoch?.deploymentId===epoch.deploymentId && job?.intakeEpoch?.versionRef===epoch.versionRef;
}

// Caller invokes this at the actual successful platform response. Recovery
// observations are useful proof of current delivery, never first-send timing.
export function buildFinalDeliveryEvidence({at,source}={}) {
  if(timestamp(at)===null || !['send_response','create_response','reconciled_observation'].includes(source))return null;
  return {schema:1,at,source};
}
export function finalDeliveryEvidence(job) {
  const value=job?.finalDeliveryEvidence;
  return value?.schema===1?buildFinalDeliveryEvidence(value):null;
}
export function finalTiming(job) {
  const evidence=finalDeliveryEvidence(job);
  const sourceAt=sourceTimestamp(job?.event);
  if(evidence && (sourceAt!==null && evidence.at<sourceAt || Number.isFinite(job?.acceptedAt) && evidence.at<job.acceptedAt))return {at:null,source:'missing'};
  return {at:evidence && evidence.source!=='reconciled_observation'?evidence.at:null,
    source:evidence?.source??(Number.isFinite(job?.completedAt)?'completion_checkpoint':'missing')};
}

const quantile=(values,p)=>values.length?values.slice().sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;
export function aggregateEpochMetrics(state,epoch,{now=Date.now(),evidenceLabel='runtime_observation'}={}) {
  const cutoff=epoch.frozenAt??now,requests=Object.values(state?.requests??{}),samples=Object.values(state?.samples??{});
  const dated=r=>r.sourceAt!==null && r.sourceAt>=epoch.startedAt && r.sourceAt<=cutoff && r.observedAt<=cutoff;
  const eligible=r=>r.intakeVerified===true && dated(r);
  const members=requests.filter(eligible),unknown=requests.filter(r=>r.intakeVerified===true && r.sourceAt===null && r.observedAt>=epoch.startedAt && r.observedAt<=cutoff);
  const selected=samples.filter(eligible),replies=selected.filter(s=>s.type==='reply'),background=selected.filter(s=>s.type==='background');
  const results=Object.values(state?.resultDeliveries??{}).filter(eligible),resultValues=results.filter(s=>s.status==='done' && ['send_response','create_response'].includes(s.source))
    .map(s=>s.durationMs).filter(v=>Number.isFinite(v)&&v>=0);
  const count=(items,status)=>items.filter(s=>s.status===status).length;
  const delivered=count(replies,'done'),failed=count(replies,'failed'),completed=count(background,'completed'),bgFailed=count(background,'failed')+count(background,'timed_out');
  const names=['original_to_intake','original_to_marker','original_to_first_card','original_to_first_typing','original_to_final_delivery',
    'intake_to_submit','submit_to_marker','intake_to_final_delivery','intake_to_first_card','intake_to_first_typing','prefetch'];
  return {evidence:evidenceLabel,scope:'deployment_epoch',epoch:{...epoch},coverage:'observed_actionable_human_sources',
    source_count:members.length,source_time_unknown_count:unknown.length,pending_source_count:members.filter(s=>s.statusObservedAt>cutoff || !['done','failed'].includes(s.status)).length,
    intake_epoch_unverified_count:requests.filter(r=>dated(r) && r.intakeState==='missing').length,
    other_intake_epoch_count:requests.filter(r=>dated(r) && r.intakeState==='other').length,
    sample_count:selected.length,reply_sample_count:replies.length,background_sample_count:background.length,
    reply_delivered_count:delivered,reply_failed_count:failed,reply_delivery_success_rate:delivered+failed?delivered/(delivered+failed):null,
    reply_success_rate_denominator:delivered+failed,
    final_timestamp_count:replies.filter(s=>['send_response','create_response'].includes(s.sources?.final)).length,
    final_reconciled_observation_count:replies.filter(s=>s.sources?.final==='reconciled_observation').length,
    final_checkpoint_only_count:replies.filter(s=>s.sources?.final==='completion_checkpoint').length,
    final_timestamp_missing_count:replies.filter(s=>s.sources?.final==='missing').length,
    background_completed_count:completed,background_failed_count:bgFailed,background_cancelled_count:count(background,'cancelled'),
    background_terminal_time_unknown_count:background.filter(s=>s.atSource==='first_observation').length,
    background_execution_success_rate:completed+bgFailed?completed/(completed+bgFailed):null,
    background_success_rate_denominator:completed+bgFailed,
    background_result_delivery_count:results.filter(s=>s.status==='done').length,
    background_result_delivery_timestamp_count:resultValues.length,
    background_result_delivery_reconciled_count:results.filter(s=>s.source==='reconciled_observation').length,
    background_result_delivery_unknown_count:results.filter(s=>s.status!=='done' || s.source==='missing').length,
    timings_ms:{...Object.fromEntries(names.map(name=>{
      const values=replies.filter(s=>s.status==='done').map(s=>s.timings?.[name]).filter(v=>Number.isFinite(v)&&v>=0);
      return [name,{count:values.length,p50:quantile(values,.5),p95:quantile(values,.95)}];
    })),original_to_background_result_delivery:{count:resultValues.length,p50:quantile(resultValues,.5),p95:quantile(resultValues,.95)}}};
}
