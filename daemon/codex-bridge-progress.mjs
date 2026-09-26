import { createHash } from 'node:crypto';

export function assistantText(payload) {
  if (!Array.isArray(payload?.content)) return '';
  return payload.content
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function rolloutAssistantMessage(item) {
  const payload = item?.payload;
  if (item?.type !== 'response_item'
      || payload?.type !== 'message'
      || payload?.role !== 'assistant') return null;
  if (!['commentary','final_answer','final'].includes(payload.phase)) return null;
  const text = assistantText(payload);
  return text ? { phase: payload.phase === 'final' ? 'final_answer' : payload.phase, text } : null;
}

export function rolloutTaskCompletion(item) {
  const payload = item?.payload;
  if (item?.type !== 'event_msg' || payload?.type !== 'task_complete') return null;

  const lastAgentMessage = typeof payload.last_agent_message === 'string'
    ? payload.last_agent_message.trim()
    : '';
  if (lastAgentMessage) return { kind: 'final', text: lastAgentMessage };

  const errorMessage = typeof payload.error?.message === 'string'
    ? payload.error.message
    : '';
  if (/bad request/i.test(errorMessage)) {
    return { kind: 'retryable_error', error: 'rollout_task_bad_request' };
  }
  if (errorMessage) return { kind: 'error', error: 'rollout_task_error' };
  return { kind: 'empty_complete', error: 'rollout_turn_completed_without_final_answer' };
}

export function progressFingerprint(bot, messageId, text) {
  return createHash('sha256')
    .update(`${bot}\0${messageId}\0${text}`, 'utf8')
    .digest('hex');
}

export function progressGate(state, now, minIntervalMs, maxMessages) {
  if ((state?.sentCount ?? 0) >= maxMessages) return { ok: false, reason: 'max_messages' };
  if ((state?.lastSentAt ?? 0) > 0 && now - state.lastSentAt < minIntervalMs) {
    return { ok: false, reason: 'min_interval' };
  }
  return { ok: true, reason: null };
}

export function formatProgressReply(text, maxCharacters = 1800) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return '';
  const characters = Array.from(normalized);
  const body = characters.length <= maxCharacters
    ? normalized
    : `${characters.slice(0, maxCharacters).join('')}\n…（本次进度已截断，最终答复不受影响）`;
  return body;
}
