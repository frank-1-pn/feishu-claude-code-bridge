import { sanitizeFeishuReply } from './codex-bridge-sanitize.mjs';
import { parseReplyUx, isBoundJob } from './codex-bridge-ux.mjs';
import { prepareReplyReport } from './codex-bridge-report.mjs';
import { getReportDelivery, authorizedFileJob } from './codex-bridge-files.mjs';
import { buildActionElements } from './codex-bridge-action-ui.mjs';
import { replyRouteNotice } from './codex-bridge-reply-routing.mjs';

// One integration owner calls this outside the outbound serial lane: file
// sends use that same lane and must finish before the final-card operation.
export function createReplyDelivery({ binding, actions, outbound, files, reportOptions, cloudDocs, nativeInteractions, getRoute, log=()=>{} }) {
  const unavailable=(name,jobId)=>{try{log(name,{bot:binding.bot,jobId});}catch{/* Feedback must not block the answer. */}};
  const deliver=async (value, replyKey, streamKeys=[], context={}) => {
    if(context.jobId){
      const origin=authorizedFileJob(reportOptions.inboxRoot,binding,context.jobId,replyKey);
      if(!isBoundJob(binding,origin))throw Object.assign(Error('reply_binding_changed'),{permanent:true});
    }
    // Card-only reconciliation must bypass reports, uploads and action setup.
    if(outbound.replyDelivered?.(replyKey)) {
      await deliver.closeCards(replyKey,streamKeys,context);return;
    }
    const clean=sanitizeFeishuReply(value).trim();
    const ux=parseReplyUx(clean);
    const presentation={status:ux.status};
    if(getRoute){
      try{
        const route=await getRoute(context);
        if(route){
          presentation.replyRoute=route;
          const notice=replyRouteNotice(route);
          if(notice)presentation.replyNotice=notice;
        }
      }catch{unavailable('reply_route_unavailable',context.jobId);}
    }
    if (ux.form) {
      presentation.fallbackText=ux.text+'\n\n请一次回复以下条件：\n'+ux.form.fields.map(f=>
        `- ${f.label}${f.required?'（必填）':'（可选）'}${f.options ? `：${f.options.map(o=>o.label).join('／')}` : ''}`).join('\n');
    }
    if (context.jobId && ux.status === 'complete') {
      try {
        const report=prepareReplyReport({...reportOptions,binding,jobId:context.jobId,replyKey,text:clean});
        if(report.generated){
          if(cloudDocs){
            try{cloudDocs.enqueue({jobId:context.jobId,replyKey,text:clean});}
            catch{unavailable('reply_cloud_doc_unavailable',context.jobId);}
          }
          await files.flush();
          const delivery=getReportDelivery({root:reportOptions.fileOutboxRoot,binding,artifacts:report.artifacts});
          presentation.report={fileName:report.artifacts.find(a=>a.name.endsWith('.html'))?.name??'report.html',
            delivered:delivery.status==='done',status:delivery.status};
        }
      } catch {
        // Keep all text deliverable if report rendering/upload is unavailable.
        unavailable('reply_report_unavailable',context.jobId);
      }
      if(cloudDocs){
        try{
          const cloudDoc=cloudDocs.result(replyKey);
          if(cloudDoc?.status==='ready' && typeof cloudDoc.url==='string')presentation.cloudDoc=cloudDoc;
        }catch{unavailable('reply_cloud_doc_unavailable',context.jobId);}
      }
    }
    if(actions && context.jobId && binding.interactions_enabled!==false){
      try {
        const descriptor=actions.registerContext({key:replyKey,sourceJobId:context.jobId,codexThreadId:binding.codex_thread_id,
          chatId:binding.chat_id,allowedSenderId:binding.allowed_sender_id,answer:ux.text,mode:ux.status,form:ux.form});
        const elements=buildActionElements(descriptor,{includeForm:ux.status==='waiting'});
        presentation.actionContext=descriptor.contextId;presentation.interactions=elements;
      } catch { unavailable('reply_actions_unavailable',context.jobId); }
    }
    if(nativeInteractions && context.jobId && ux.status==='complete' && binding.interactions_enabled!==false){
      try{
        const native=await nativeInteractions.taskButton({jobId:context.jobId,replyKey,text:ux.text});
        if(native){
          if(typeof native.contextId!=='string' || !native.contextId || !native.element || typeof native.element!=='object')
            throw Error('invalid_native_task_button');
          presentation.nativeContext=native.contextId;
          presentation.interactions=[...(presentation.interactions??[]),native.element];
        }
      }catch{unavailable('reply_native_actions_unavailable',context.jobId);}
    }
    await outbound.final(ux.form && !presentation.actionContext ? presentation.fallbackText : ux.text,replyKey,streamKeys,presentation);
  };
  deliver.closeCards=async (replyKey,streamKeys=[],context={})=>{
    const keys=[];
    for(const peer of context.jobs??[]) {
      const job=authorizedFileJob(reportOptions.inboxRoot,binding,peer.id,replyKey);
      if(!job.markerSeen || job.completionDisposition==='silent' || job.unclassifiedTurnEnded
          || !['reply_pending','done'].includes(job.status)
          || (binding.group_access==='all_group_humans' && !job.event?.synthetic_callback && job.feedbackDisposition!=='actionable'))
        throw Object.assign(Error('reply_card_job_not_actionable'),{permanent:true});
      if(job.streamKey && streamKeys.includes(job.streamKey))keys.push(job.streamKey);
    }
    await outbound.closeReplyCards(replyKey,keys);
  };
  return deliver;
}
