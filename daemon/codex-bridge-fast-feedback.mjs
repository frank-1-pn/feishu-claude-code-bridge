import {normalizeEvent} from './codex-bridge-inbox.mjs';
import {isBoundJob} from './codex-bridge-ux.mjs';
import {enqueueActionable,readDisposition} from './codex-bridge-completion.mjs';

// A deliberately small classification hint, never an executor or an intake
// filter. Unknowns still reach the bound session. Only the immutable disposition
// publication may enable feedback, and only after the exact rollout marker.
export function isExplicitOperationalRequest(text) {
  const value=String(text??'').trim();
  if(!value || value.length>300 || /[\n\r"'“”‘’「」『』`<>]/u.test(value)
      || /(?:不|无需|别|没有|取消取消|例如|比如|引用|转发|他说|她说|原话|测试|假设|如果|能否|可不可以|这句话|这个词|指令|意思|是否|还是|或者)/u.test(value))return false;
  if(/^(?:(?:请|帮我|帮忙)\s*)?(?:查(?:一下|询|看)?|查看|查询)\s*[^。！？!\n]*(?:安排|日程|行程|会议|待办|任务|邮箱|邮件|考勤|审批|报价)[^。！!\n]*[？?]?$/u.test(value))return true;
  return /^(?:(?:请|帮我|帮忙)\s*)?(?:创建|新增|安排|添加|修改|更新|取消|删除|整理|生成)\s*[^。！？!?\n]*(?:日程|行程|会议|待办|任务|清单|纪要|报价|报告)[^。！？!?\n]*[。！!]?$/u.test(value);
}

export function classifyWithFastFeedback({root,inboxRoot,binding,job}) {
  const prior=readDisposition({root,binding,job});
  if(prior || binding.fast_actionable_classification!==true || binding.group_access!=='all_group_humans'
      || !job.markerSeen || !['submitted','delivered'].includes(job.status) || job.unclassifiedTurnEnded
      || job.event?.synthetic_callback || job.event?.message_type!=='text' || !isBoundJob(binding,job))return prior;
  if(!isExplicitOperationalRequest(normalizeEvent(job.event).text))return null;
  try { enqueueActionable({root,inboxRoot,binding,jobId:job.id}); }
  catch(error) { if(error.code!=='completion_disposition_conflict')throw error; }
  // A simultaneous silent winner remains authoritative.
  return readDisposition({root,binding,job});
}
