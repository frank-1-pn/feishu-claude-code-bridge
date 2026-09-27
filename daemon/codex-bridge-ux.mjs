import { sanitizeFeishuReply } from './codex-bridge-sanitize.mjs';
import { normalizeForm } from './codex-bridge-actions.mjs';

// This suffix is an explicit output contract, not a guess based on question marks.
// Invalid/quoted examples remain visible, so parsing never silently loses output.
export function parseReplyUx(value) {
  const text = sanitizeFeishuReply(value).trim();
  const match = /(?:^|\n)```feishu-form\s*\n([^]*?)\n```\s*$/u.exec(text);
  if (!match) return { text, status: 'complete' };
  let form;
  try { form = JSON.parse(match[1]); } catch { return { text, status: 'complete' }; }
  if (form?.version !== 1 || typeof form.title !== 'string' || !form.title.trim()
      || form.title.length > 80 || !Array.isArray(form.fields) || !form.fields.length || form.fields.length > 6) {
    return { text, status: 'complete' };
  }
  let validated;
  try { validated=normalizeForm(form); } catch { return {text,status:'complete'}; }
  return { text: text.slice(0, match.index).trim() || '请一次补充以下条件，我会据此继续。', status: 'waiting',
    form:validated };
}

export function publicPhase(text) {
  // Recognize only the explicit public labels described in the ingress prompt.
  if (/^\s*\[检索\]/u.test(text)) return 'searching';
  if (/^\s*\[整理\]/u.test(text)) return 'organizing';
  if (/^\s*\[等待\]/u.test(text)) return 'waiting';
  return 'working';
}

export function bindingSnapshot(binding) {
  return {bot:binding.bot,profile:binding.profile??'',chat_id:binding.chat_id,
    allowed_sender_id:binding.allowed_sender_id,codex_thread_id:binding.codex_thread_id};
}

export function isBoundJob(binding, job) {
  if(job?.event?.chat_id!==binding.chat_id || job.event.sender_id!==binding.allowed_sender_id) return false;
  if(job.event.codex_thread_id && job.event.codex_thread_id!==binding.codex_thread_id)return false;
  if(job.event.bridge_binding && Object.entries(bindingSnapshot(binding)).some(([k,v])=>job.event.bridge_binding[k]!==v)) return false;
  // Old records have no binding snapshot. A submitted record still has its
  // rollout filename, whose session UUID must match the current destination.
  if(job.rollout && /^[0-9a-f-]{36}$/i.test(binding.codex_thread_id??'') && !job.rollout.includes(binding.codex_thread_id))return false;
  return true;
}

export const UX_PROMPT = '飞书输出请先给结论，再给3–5个确有必要的要点；简单答复不凑条目。'
  + '依据使用真实HTTP(S)来源链接，明确区分已验证、推断和待确认，不伪造来源或验证状态；表格和代码使用标准Markdown。'
  + '公开进度可用[检索]、[整理]或[等待]标明实际阶段，bridge只展示公开进度，不展示隐藏思考。'
  + '确需用户一次补充多个条件时，最终答复末尾可附一个feishu-form代码块，JSON格式为'
  + '{"version":1,"title":"补充条件","fields":[{"name":"purpose","label":"使用目的","type":"text","required":true},'
  + '{"name":"format","label":"输出格式","type":"select","required":false,"options":[{"label":"简明文字","value":"text"},{"label":"对比表格","value":"table"}]}]}。'
  + '只列本次确实缺少的条件，最多6项；这是等待补充，不得声称任务已完成。'
  + '无需补充时不要生成该代码块。较长答复由bridge生成完整HTML和Markdown附件，原始附件仍按既有发送工具显式交付。';
