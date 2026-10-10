import {normalizeEvent} from './codex-bridge-inbox.mjs';
import {isBoundJob} from './codex-bridge-ux.mjs';
import {enqueueActionable,readDisposition} from './codex-bridge-completion.mjs';

// A deliberately small classification hint, never an executor or an intake
// filter. Unknowns still reach the bound session. Only the immutable disposition
// publication may enable feedback, and only after the exact rollout marker.
export function isExplicitOperationalRequest(text) {
  const value=String(text??'').trim();
  if(!value || value.length>300 || /[\n\r"'“”‘’「」『』`<>]/u.test(value)
      || /(?:不|无需|别|没有|取消取消|例如|比如|引用|转发|他说|她说|原话|测试|假设|如果|要是|的话|能否|可不可以|这句话|这个词|指令|意思|是什么|怎么|如何|为什么|是否|还是|或者|顺便|另外|然后|再帮|也帮|已经|做过|完了|之后|的时候|时浏览器)/u.test(value))return false;
  // Punctuation and repeated independent verbs deliberately leave compound
  // requests to the model. Upload + returning its link is one delivery request.
  const body=value.replace(/[。！？!?]$/u,'');
  if(/[。！？!?；;]/u.test(body) || /(?:他|她|别人|客户|同事|群友)(?:们)?(?:说|想|要|问|让|准备)/u.test(body))return false;
  if(/(?:并(?:且)?|同时|再|还|也|[，,])\s*(?:请\s*|帮我\s*)?(?:查|看|创建|新增|安排|添加|修改|更新|取消|删除|整理|生成|上传|预约|约|发送|发给|发到)/u.test(body))return false;
  const verbs=body.match(/查看|查询|查一下|看看|看一下|创建|新增|添加|修改|更新|取消|删除|整理|生成|上传|预约|约(?=.{0,30}会议)|发送|发给|发到/gu)??[];
  if(verbs.length>1)return false;
  const request=body.replace(/^(?:请\s*)?(?:(?:帮我|帮忙)\s*)?/u,'');
  if(/^(?:查(?:一下|下|询|看)?|查看(?:一下|下)?|查询|看看|看一下|看下)\s*(?:(?:我|公司|今天|明天|后天|昨天|现在|最近|本周|这周|本月|(?:\d{4}年)?\d{1,2}月\d{1,2}(?:日|号))(?:的)?\s*)*(?:有什么|有哪些)?(?:新的?)?(?:日程安排|行程安排|安排|日程|行程|会议|待办|任务|邮箱|邮件|考勤|审批|报价)(?:里面?|中)?(?:(?:有什么|有哪些|有)(?:新的?)?(?:邮件|安排|日程|行程|会议|待办|任务))?(?:吗|呢|嘛)?$/u.test(request))return true;
  if(/^(?:现在|今天|最近|目前)?(?:有什么|有哪些|有新)(?:新的?)?(?:邮件|邮箱消息)(?:吗|呢)?$/u.test(request))return true;
  if(/^(?:创建|新增|安排|添加|修改|更新|取消|删除|整理|生成)\s*[^。！？!?\n]*(?:日程|行程|会议|待办|任务|清单|纪要|报价|报告)[^。！？!?\n]*$/u.test(request))return true;
  if(/^(?:约|预约)(?:一下|个|一个)?\s*(?:(?:现在|今天|明天|后天|上午|下午|晚上|中午|早上|\d|月|日|号|点|时|分|半|:|：|\s|个|小时|分钟|一|二|三|四|五|六|七|八|九|十|的))*会议(?:[，,\s]*(?:现在开始|马上开始|(?:群内|本群|群里)(?:所有人|成员|所有成员)(?:参加|参与)))*$/u.test(request))return true;
  // An actual upload/send verb is required; destinations and file-format
  // corrections alone cannot classify a reply or execute any business action.
  if(/^上传(?:一下)?\s*(?:(?:(?:这个|那个|这份|那份|该|最新(?:版)?)(?:的)?)?(?:HTML(?:文件)?|文件|文档|报告)(?:到(?:飞书)?云盘)?|(?:到)?(?:飞书)?云盘)(?:[，,]?\s*(?:并)?(?:返回|提供|给我|放回)(?:文件的|下载)?链接)?(?:吧)?$/iu.test(request))return true;
  return /^(?:把|将)?\s*(?:(?:上面|刚才|之前|这个|那个|已有|现有|最新(?:版)?|的)\s*)*(?:HTML(?:文件)?|文件|文档|报告)(?:作为文件|当作文件)?(?:发到|发送到)(?:本群|这个群|群里|群内)$/iu.test(request);
}

function classificationText(binding,event) {
  const text=normalizeEvent(event).text;
  // Only an exact native mention key may be removed from this local view.
  // Compact name-only mentions, other people and ambiguous keys remain intact.
  if(!Array.isArray(event.mentions) || event.mentions.length!==1)return text;
  const mention=event.mentions[0],id=typeof mention?.id==='string'?mention.id:mention?.id?.open_id;
  if(id!==binding.bot_open_id || !/^@_user_\d+$/u.test(mention?.key??''))return text;
  const value=text.trimStart(),key=mention.key;
  if(!value.startsWith(key) || !/^(?:\s|[，,:：]|$)/u.test(value.slice(key.length)))return text;
  return value.slice(key.length).replace(/^[\s，,:：]+/u,'');
}

export function classifyWithFastFeedback({root,inboxRoot,binding,job}) {
  const prior=readDisposition({root,binding,job});
  if(prior || binding.fast_actionable_classification!==true || binding.group_access!=='all_group_humans'
      || !job.markerSeen || !['submitted','delivered'].includes(job.status) || job.unclassifiedTurnEnded
      || job.event?.synthetic_callback || job.event?.message_type!=='text' || !isBoundJob(binding,job))return prior;
  if(!isExplicitOperationalRequest(classificationText(binding,job.event)))return null;
  try { enqueueActionable({root,inboxRoot,binding,jobId:job.id}); }
  catch(error) { if(error.code!=='completion_disposition_conflict')throw error; }
  // A simultaneous silent winner remains authoritative.
  return readDisposition({root,binding,job});
}
