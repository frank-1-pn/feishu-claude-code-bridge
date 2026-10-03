import path from 'node:path';
import {digest,normalizeEvent} from './codex-bridge-inbox.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {opsScope} from './codex-bridge-ops-policy.mjs';
import {verifyOpsMessage} from './codex-bridge-ops-delivery.mjs';
import {verifyBackgroundCompletion} from './codex-bridge-background.mjs';
import {backgroundControlApi,parseTaskControl} from './codex-bridge-task-control.mjs';
import {privateDirectory,readBackgroundJson,readBackgroundSource,readBackgroundTask,validateBackgroundTaskSource,stableJson} from './codex-bridge-background-store.mjs';
import {normalizeMetricsEpoch,sourceTimestamp,finalTiming,intakeEpochMatches} from './codex-bridge-metrics.mjs';

const same=(a,b)=>stableJson(a)===stableJson(b);
const identityFields=['type','message_id','message_type','content','chat_id','chat_type','sender_id','sender_type',
  'parent_id','root_id','reply_to','thread_id','create_time','timestamp','synthetic_callback','bridge_binding','codex_thread_id','action_source_job_id','action_source_message_id'];
const identity=event=>Object.fromEntries(identityFields.filter(k=>event[k]!==undefined).map(k=>[k,event[k]]));
const safeId=id=>/^om_[A-Za-z0-9_-]+$/.test(id??'');
const read=(root,binding,...parts)=>{
  privateDirectory(path.resolve(root));privateDirectory(path.join(path.resolve(root),binding.bot));
  const file=path.join(root,binding.bot,...parts);privateDirectory(path.dirname(file));
  return readBackgroundJson(file,{mode:0o600,maxBytes:8*1024*1024});
};

// Explicit source IDs only: no automatic discovery of customer messages, no
// writes, no synthetic test traffic, and a hard GET-only transport wrapper.
export async function collectBridgeAcceptance({binding,codexHome,inboxRoot,backgroundRoot,controlRoot,deliveryRoot,
  completionRoot,cases=[],request,appId,metricsEpoch,now=Date.now(),evidenceLabel='runtime_observation'}) {
  if(!Array.isArray(cases) || cases.length>32 || !['runtime_observation','test_fixture'].includes(evidenceLabel))throw Error('acceptance_options_invalid');
  const epoch=normalizeMetricsEpoch(metricsEpoch,{now}),results=[];
  const get=async(b,args)=>{
    if(!same(b,binding) || args.length!==3 || args[0]!=='api' || args[1]!=='GET'
        || !/^\/open-apis\/im\/v1\/messages\/om_[A-Za-z0-9_-]+$/.test(args[2]))throw Error('acceptance_get_only');
    if(typeof request!=='function')throw Error('acceptance_get_unavailable');
    return request(b,args);
  };
  for(const item of cases) {
    const result={caseKey:digest(stableJson(item)),status:'pending',source_marker:false,source_platform_verified:false,
      background:null,control:null,delivery:null,reason:null};
    try {
      if(!item || Object.keys(item).some(k=>!['sourceJobId','taskId','controlJobId','callbackJobId'].includes(k)) || !safeId(item.sourceJobId))throw Error();
      const source=readBackgroundSource({inboxRoot,binding,jobId:item.sourceJobId,completionRoot});
      result.source_marker=source.markerSeen===true;
      result.source_time_known=sourceTimestamp(source.event)!==null;
      const sourceAt=sourceTimestamp(source.event),cutoff=epoch?.frozenAt??now;
      result.epoch_member=epoch?intakeEpochMatches(source,epoch) && sourceAt!==null && sourceAt>=epoch.startedAt && sourceAt<=cutoff:null;
      if(epoch && !result.epoch_member){result.reason='source_outside_epoch_or_time_unknown';results.push(result);continue;}
      const response=await get(binding,['api','GET',`/open-apis/im/v1/messages/${source.id}`]);
      const matches=response?.items?.filter(m=>m.message_id===source.id)??[],message=matches.length===1?matches[0]:null;
      let body;try{body=JSON.parse(message?.body?.content);}catch{}
      result.source_platform_verified=message?.chat_id===binding.chat_id && message?.deleted===false && message?.sender?.sender_type==='user'
        && message?.sender?.id_type==='open_id' && message?.sender?.id===source.event.sender_id && message?.msg_type===source.event.message_type
        && ['parent_id','root_id','thread_id'].every(k=>!source.event[k] || message?.[k]===source.event[k])
        && (sourceAt===null || sourceTimestamp(message)===sourceAt)
        && (source.event.message_type!=='text' || body?.text===normalizeEvent(source.event).text);
      result.final_timing_source=finalTiming(source).source;
      if(item.taskId) {
        const task=readBackgroundTask(backgroundRoot,binding,item.taskId),original=validateBackgroundTaskSource(task,{inboxRoot,binding,completionRoot});
        if(original.id!==source.id)throw Error();
        const descriptor=backgroundControlApi({root:backgroundRoot,inboxRoot,binding,completionRoot}).readTask({taskId:item.taskId});
        result.background={record_verified:true,status:['queued','claimed','running','completed','failed','timed_out','cancelled','blocked','indeterminate'].includes(descriptor.status)?descriptor.status:'unknown',notification:descriptor.notification,callback_verified:false};
        if(item.callbackJobId) {
          if(!safeId(item.callbackJobId))throw Error();
          const job=read(inboxRoot,binding,`job-${digest(item.callbackJobId)}.json`);
          result.background.callback_verified=job.id===item.callbackJobId && job.event?.action_source_job_id===source.id
            && verifyBackgroundCompletion(binding,job.event,backgroundRoot);
          result.background.callback_done=result.background.callback_verified && job.status==='done';
        }
      } else if(item.callbackJobId)throw Error();
      if(item.controlJobId) {
        if(item.controlJobId!==source.id)throw Error();
        const receipt=read(controlRoot,binding,'receipts',`${digest(source.id)}.json`);
        const auditHash=digest(stableJson(identity(source.event)));
        if(receipt.schema!==1 || receipt.id!==source.id || !same(receipt.binding,bindingSnapshot(binding))
            || receipt.auditHash!==auditHash || digest(stableJson(identity(receipt.auditEvent)))!==auditHash
            || !parseTaskControl(source.event) || !same(receipt.command,parseTaskControl(source.event)))throw Error();
        result.control={record_verified:true,action:['list','status','cancel'].includes(receipt.command?.action)?receipt.command.action:'unknown',visible:receipt.visible===true};
        const key=`task-control:${digest(`${binding.bot}\0${source.id}`)}`;
        if(receipt.delivery?.key!==key)throw Error();
        const state=read(deliveryRoot,binding,`delivery-${digest(key)}.json`);
        if(state.schema!==1 || !same(state.scope,opsScope(binding,codexHome)) || state.key!==key || state.ownerKind!=='control'
            || state.ownerId!==digest(source.id) || state.jobId!==source.id || !same(state.intent,{...state.intent,scope:state.scope,key:state.key,
              ownerKind:state.ownerKind,ownerId:state.ownerId,jobId:state.jobId,msgType:state.msgType,content:state.content,route:state.route}))throw Error();
        if(!['chat','quote','thread'].includes(state.route?.mode) || state.route.mode!=='chat' && state.route.messageId!==source.id)throw Error();
        result.delivery={checkpoint:['pending','submitting','acknowledged','verified','rejected','unknown'].includes(state.status)?state.status:'unknown',platform_verified:false};
        if(state.messageId)result.delivery.platform_verified=await verifyOpsMessage({binding,messageId:state.messageId,msgType:state.msgType,
          text:state.content?.text,card:state.msgType==='interactive'?state.content:undefined,appId,route:state.route,request:get});
      }
      const confirmed=(item.taskId || item.controlJobId) && result.source_marker && result.source_platform_verified
        && (!result.control || result.control.visible && result.delivery?.platform_verified)
        && (!result.background || result.background.callback_verified && result.background.callback_done);
      result.status=confirmed?'verified':'pending';result.reason=confirmed?null:'required_evidence_pending';
    }catch{result.status='unknown';result.reason='acceptance_evidence_unavailable_or_invalid';}
    results.push(result);
  }
  return {evidence:evidenceLabel,status:results.length && results.every(r=>r.status==='verified')?'verified':'pending',
    case_count:results.length,verified_count:results.filter(r=>r.status==='verified').length,unknown_count:results.filter(r=>r.status==='unknown').length,
    reason:results.length?null:'no_real_cases_selected',results};
}
