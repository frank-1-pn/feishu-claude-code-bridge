import { sanitizeFeishuReply } from './codex-bridge-sanitize.mjs';
import { parseReplyUx, isBoundJob } from './codex-bridge-ux.mjs';
import { prepareReplyReport } from './codex-bridge-report.mjs';
import { getReportDelivery, authorizedFileJob } from './codex-bridge-files.mjs';
import { buildActionElements } from './codex-bridge-action-ui.mjs';

// One integration owner calls this outside the outbound serial lane: file
// sends use that same lane and must finish before the final-card operation.
export function createReplyDelivery({ binding, actions, outbound, files, reportOptions, log=()=>{} }) {
  return async (value, replyKey, streamKeys=[], context={}) => {
    if(context.jobId){
      const origin=authorizedFileJob(reportOptions.inboxRoot,binding,context.jobId,replyKey);
      if(!isBoundJob(binding,origin))throw Object.assign(Error('reply_binding_changed'),{permanent:true});
    }
    const clean=sanitizeFeishuReply(value).trim();
    const ux=parseReplyUx(clean);
    const presentation={status:ux.status};
    if (ux.form) {
      presentation.fallbackText=ux.text+'\n\n请一次回复以下条件：\n'+ux.form.fields.map(f=>
        `- ${f.label}${f.required?'（必填）':'（可选）'}${f.options ? `：${f.options.map(o=>o.label).join('／')}` : ''}`).join('\n');
    }
    if (context.jobId && ux.status === 'complete') {
      try {
        const report=prepareReplyReport({...reportOptions,binding,jobId:context.jobId,replyKey,text:clean});
        if(report.generated){
          await files.flush();
          const delivery=getReportDelivery({root:reportOptions.fileOutboxRoot,binding,artifacts:report.artifacts});
          presentation.report={fileName:report.artifacts.find(a=>a.name.endsWith('.html'))?.name??'report.html',
            delivered:delivery.status==='done',status:delivery.status};
        }
      } catch {
        // Keep all text deliverable if report rendering/upload is unavailable.
        log('reply_report_unavailable',{bot:binding.bot,jobId:context.jobId});
      }
    }
    if(actions && context.jobId && binding.interactions_enabled!==false){
      try {
        const descriptor=actions.registerContext({key:replyKey,sourceJobId:context.jobId,codexThreadId:binding.codex_thread_id,
          chatId:binding.chat_id,allowedSenderId:binding.allowed_sender_id,answer:ux.text,mode:ux.status,form:ux.form});
        const elements=buildActionElements(descriptor,{includeForm:ux.status==='waiting'});
        presentation.actionContext=descriptor.contextId;presentation.interactions=elements;
      } catch { log('reply_actions_unavailable',{bot:binding.bot,jobId:context.jobId}); }
    }
    await outbound.final(ux.form && !presentation.actionContext ? presentation.fallbackText : ux.text,replyKey,streamKeys,presentation);
  };
}
