import { digest } from './codex-bridge-inbox.mjs';
import { sanitizeFeishuReply } from './codex-bridge-sanitize.mjs';
import { bindingSnapshot, isBoundJob } from './codex-bridge-ux.mjs';

const ALIASES = new Map([
  ['/status', 'status'], ['当前任务', 'status'], ['查看进度', 'status'], ['现在进度', 'status'],
  ['/files', 'files'], ['附件发了吗', 'files'], ['文件发了吗', 'files'],
  ['/last', 'last'], ['上一轮完成了什么', 'last'], ['最近产物', 'last'],
]);
const ACTIVE = new Set(['queued', 'submitted', 'delivered', 'reply_pending', 'waiting_input']);
const PHASE = {
  queued: '等待进 Codex', submitted: '已提交，等待会话确认', delivered: 'Codex 正在处理',
  reply_pending: '已生成答复，等飞书送达', waiting_input: '等待补充', failed: '任务中断',
};
const PUBLIC_PHASE = { searching: '正在检索', organizing: '正在整理', working: '正在处理', waiting: '等待补充' };
const APP_LINK_HOSTS = new Set(['applink.feishu.cn', 'applink.larksuite.com']);
const MESSAGE_ID = /^om_(?!cb_)[A-Za-z0-9_-]{1,160}$/;
const TIME = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

// Prefer the CLI's message-scoped AppLink. Keep the exact returned URL only
// after restricting the protocol, destination chat, and message position.
export function safeMessageAppLink(value, chatId) {
  if (typeof value !== 'string' || !chatId || value.length > 1024 || /[\s<>()"\\]/u.test(value)) return;
  let url;
  try { url = new URL(value); } catch { return; }
  if (url.protocol !== 'https:' || !APP_LINK_HOSTS.has(url.hostname)
      || url.username || url.password || url.port || url.hash) return;
  const params = url.searchParams;
  const chatKeys = ['openChatId', 'openchatid', 'open_chat_id'];
  const threadKeys = ['openThreadId', 'openthreadid', 'open_thread_id'];
  const positionKeys = ['position', 'thread_position'];
  const chat = chatKeys.flatMap(key => params.getAll(key));
  const thread = threadKeys.flatMap(key => params.getAll(key));
  const positions = positionKeys.flatMap(key => params.getAll(key));
  if (!chat.length || chat.some(id => id !== chatId) || positions.length !== 1 || !/^\d{1,19}$/.test(positions[0])) return;
  const allowedKeys = new Set([...chatKeys, ...threadKeys, ...positionKeys]);
  if ([...params.keys()].some(key => !allowedKeys.has(key) || params.getAll(key).length !== 1)) return;
  if (url.pathname === '/client/chat/open' && !thread.length && params.has('position')) return value;
  if (url.pathname === '/client/thread/open' && params.has('thread_position') && thread.length && new Set(thread).size === 1
      && /^(?:omt|om)_[A-Za-z0-9_-]{1,160}$/.test(thread[0])) return value;
}

export async function lookupMessageAppLink(binding, messageId, request) {
  if (!MESSAGE_ID.test(messageId ?? '')) return;
  const result = await request(binding, ['im', '+messages-mget', '--message-ids', messageId, '--format', 'json', '--no-reactions']);
  const messages = result?.messages;
  if (!Array.isArray(messages)) return;
  const exact = messages.filter(message => message?.message_id === messageId);
  if (exact.length !== 1 || (exact[0].chat_id !== undefined && exact[0].chat_id !== binding.chat_id)) return;
  const message = exact[0];
  if (message.deleted) return;
  const link = safeMessageAppLink(message.message_app_link, binding.chat_id);
  if (!link) return;
  const url = new URL(link), thread = url.pathname === '/client/thread/open';
  const expectedPosition = thread ? message.thread_message_position : message.message_position;
  if ((Number.isSafeInteger(expectedPosition) || (typeof expectedPosition === 'string' && /^\d{1,19}$/.test(expectedPosition)))
      && BigInt(expectedPosition) !== BigInt(url.searchParams.get(thread ? 'thread_position' : 'position'))) return;
  const threadId = url.searchParams.get('openthreadid') ?? url.searchParams.get('open_thread_id') ?? url.searchParams.get('openThreadId');
  if (thread && message.thread_id !== undefined && message.thread_id !== threadId) return;
  return link;
}

export function parseStatusQuery(event) {
  if (event?.type !== 'im.message.receive_v1' || event.message_type !== 'text'
      || event.synthetic_callback || (event.sender_type && event.sender_type !== 'user')) return null;
  let body = event.content;
  if (typeof body === 'string') {
    if (body.length > 512) return null;
    if (body.trimStart().startsWith('{')) {
      try { body = JSON.parse(body); } catch { return null; }
    }
  }
  if (body && typeof body === 'object') body = body.text;
  if (typeof body !== 'string' || body.length > 64) return null;
  return ALIASES.get(body.trim().replace(/[?？]$/u, '').toLowerCase()) ?? null;
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value > 0 && value < 8.64e15 ? value : 0;
}
function publicLine(value, maxLength) {
  const text = sanitizeFeishuReply(value).replace(/^\s*[*#>]+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  const chars = [...text];
  return chars.length > maxLength ? chars.slice(0, maxLength).join('') + '…' : text;
}
const visibleCard = card => MESSAGE_ID.test(card?.messageId ?? '') && (card.sentRevision ?? 0) > 0;
const deliveredFile = file => file.status === 'done' && file.sendIntent?.sent === true && MESSAGE_ID.test(file.sendIntent?.messageId ?? '');

function scopedFile(file, scope, binding) {
  return file?.deliveryVersion === 2 && file.bindingScope === scope
    && file.origin?.bot === binding.bot && file.origin.chatId === binding.chat_id
    && file.origin.senderId === binding.allowed_sender_id && file.origin.profile === (binding.profile ?? '');
}

function fileSummary(files, details) {
  if (!files.length) return '附件：这项任务没有附件交付记录。';
  const counts = { 已送达: 0, 等待发送: 0, 发送失败: 0, 送达待核对: 0 };
  const lines = [];
  for (const file of files) {
    const label = deliveredFile(file) ? '已送达' : file.sendIntent?.uncertain || file.status === 'done' ? '送达待核对'
      : file.status === 'blocked' ? '发送失败' : file.status === 'queued' ? '等待发送' : '送达待核对';
    counts[label]++;
    if (details && lines.length < 5 && typeof file.name === 'string') {
      const name = publicLine(file.name.replace(/^.*[/\\]/u, ''), 72);
      if (name) lines.push(`- ${name}：${label}`);
    }
  }
  const labels = Object.entries(counts).filter(([, count]) => count).map(([label, count]) => `${label} ${count}`);
  return [`附件：${labels.join('、')}。`, ...lines].join('\n');
}

export function buildStatusReply({ binding, queryJob, jobs, cards = [], files = [], hasReplyReceipt = () => false }) {
  const kind = parseStatusQuery(queryJob?.event);
  const reply = (text, card) => ({ kind, text, ...(visibleCard(card) ? { messageId: card.messageId } : {}) });
  if (!kind || !binding?.chat_id || !binding.allowed_sender_id || !binding.codex_thread_id
      || !MESSAGE_ID.test(queryJob.id ?? '') || queryJob.id !== (queryJob.event.message_id ?? queryJob.event.id)
      || !isBoundJob(binding, queryJob)) return null;
  const scope = digest(JSON.stringify(bindingSnapshot(binding)));
  const scopedCards = [...cards].filter(card => typeof card?.key === 'string'
    && card.route?.scope === scope && card.route?.chatId === binding.chat_id);
  const byCardKey = new Map(scopedCards.map(card => [card.key, card]));
  const finalCards = new Map(scopedCards.filter(card => card.finalDelivered && visibleCard(card) && card.finalReplyKey)
    .map(card => [card.finalReplyKey, card]));
  function successorKey(key) {
    const visited = new Set();
    while (key && byCardKey.get(key)?.supersededBy) {
      if (visited.has(key) || visited.size >= 32) return;
      visited.add(key);
      key = byCardKey.get(key).supersededBy;
    }
    return key;
  }

  const taskByKey = new Map(), taskByJob = new Map(), taskByReply = new Map(), taskByStream = new Map();
  for (const job of jobs) {
    if (!job?.id || job.id === queryJob.id || job.localReply || job.event?.synthetic_callback
        || job.id !== (job.event?.message_id ?? job.event?.id) || !isBoundJob(binding, job) || parseStatusQuery(job.event)) continue;
    const stream = successorKey(job.streamKey);
    const key = job.replyKey ? `reply:${job.replyKey}` : stream ? `stream:${stream}` : `job:${job.id}`;
    const task = taskByKey.get(key) ?? { jobs: [], active: false, at: 0, completedAt: 0 };
    task.jobs.push(job);
    task.card ??= finalCards.get(job.replyKey) ?? byCardKey.get(stream);
    task.active ||= ACTIVE.has(job.status);
    task.at = Math.max(task.at, timestamp(job.acceptedAt));
    task.completedAt = Math.max(task.completedAt, timestamp(job.completedAt));
    taskByKey.set(key, task);
    taskByJob.set(job.id, task);
    if (job.replyKey) taskByReply.set(job.replyKey, task);
    if (stream) {
      if (taskByStream.has(stream) && taskByStream.get(stream) !== task) taskByStream.set(stream, null);
      else taskByStream.set(stream, task);
    }
  }

  const reference = queryJob.event.parent_id || queryJob.event.root_id;
  let selected;
  if (reference) {
    selected = taskByJob.get(reference);
    if (!selected) {
      const matches = new Set(scopedCards.filter(card => card.messageId === reference).map(card =>
        taskByReply.get(card.finalReplyKey) ?? taskByStream.get(successorKey(card.key))).filter(Boolean));
      if (matches.size === 1) selected = [...matches][0];
    }
    if (!selected) return reply('这条引用没有明确对应的任务。请回复任务原消息或结果卡片再查。');
  } else {
    const topic = queryJob.event.thread_id ?? null;
    const scopedTasks = [...taskByKey.values()].filter(task => task.jobs.some(job => (job.event.thread_id ?? null) === topic));
    const active = scopedTasks.filter(task => task.active);
    if (kind !== 'last' && active.length > 1) {
      return reply(`这段会话有 ${active.length} 项任务还在处理。请回复要查的任务原消息或卡片。`);
    }
    selected = (kind !== 'last' && active[0]) || scopedTasks
      .filter(task => kind !== 'last' || task.completedAt > 0)
      .sort((a, b) => kind === 'last' ? b.completedAt - a.completedAt || b.at - a.at : b.at - a.at)[0];
  }
  if (!selected) return reply(kind === 'last' ? '这段会话还没有完成的任务记录。' : '这段会话还没有可查询的任务。');

  const { card } = selected;
  const taskJobIds = new Set(selected.jobs.map(job => job.id));
  const taskFiles = [...files].filter(file => taskJobIds.has(file?.jobId) && scopedFile(file, scope, binding));
  if (kind === 'files') return reply(fileSummary(taskFiles, true), card);

  const job = selected.jobs.slice().sort((a, b) => (b.sequence ?? b.acceptedAt ?? 0) - (a.sequence ?? a.acceptedAt ?? 0))[0];
  const arrived = selected.jobs.some(item => item.markerSeen === true);
  const answerDelivered = arrived && (card?.finalDelivered === true || selected.jobs.some(item =>
    item.status === 'done' && item.replyKey && hasReplyReceipt(item.replyKey)));
  const phase = job.status === 'done' ? (answerDelivered ? '答复已送达' : '答复送达待核对')
    : job.status === 'delivered' && !arrived ? '等待会话确认'
    : job.status === 'reply_pending' && job.replyRetry?.blocked ? '答复送达受阻'
    : PHASE[job.status] ?? '状态待核对';
  const lastAt = Math.max(...selected.jobs.map(item => Math.max(timestamp(item.lastActivityAt),
    timestamp(item.completedAt), timestamp(item.deliveredAt), timestamp(item.acceptedAt))), timestamp(card?.lastSentAt));
  const lines = [`任务状态：${phase}。`, `Codex 入站：${arrived ? '已确认' : '尚未确认'}。`];
  if (lastAt) lines.push(`最近更新：${TIME.format(lastAt)}（北京时间）。`);
  if (!answerDelivered && visibleCard(card) && !card.final && card.sentRevision === card.revision) {
    const publicPhase = PUBLIC_PHASE[card.presentation?.status];
    if (publicPhase) lines.push(`最近公开进度：${publicPhase}。`);
  }
  if (kind === 'last' && answerDelivered && card?.finalDelivered && card.sentRevision === card.revision) {
    const summary = publicLine(card.text, 150);
    if (summary) lines.push(`答复摘要：${summary}`);
  }
  lines.push(fileSummary(taskFiles, false));
  return reply(lines.join('\n'), card);
}
