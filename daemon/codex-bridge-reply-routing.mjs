import fs from 'node:fs';
import path from 'node:path';
import { digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { bindingSnapshot, isBoundJob } from './codex-bridge-ux.mjs';

const messageId = value => typeof value === 'string' && /^om_[A-Za-z0-9_-]+$/.test(value) && !value.startsWith('om_cb_');
const threadId = value => typeof value === 'string' && /^(?:omt|om)_[A-Za-z0-9_-]+$/.test(value);
const scopeFor = binding => digest(JSON.stringify(bindingSnapshot(binding)));
const failure = code => Object.assign(Error(code), { code, permanent: true });
const forbidden = new Set(['230001','230002','230006','230013','230015','230017','230018','230022',
  '230025','230027','230028','230035','230038','230050','230054','230055','230075','230099','230111','232009',
  '99991672','99991668']);
const sourceGone = new Set(['230011','230019']);
const threadUnsupported = new Set(['230071','230072']);
const definitelyRejected = code => forbidden.has(code) || sourceGone.has(code) || threadUnsupported.has(code) || code === '230020';

// Native Feishu topic IDs are distinct from the configured Codex thread UUID.
// root_id/parent_id can also describe ordinary quotes: only thread_id implies a topic.
export function nativeMessageContext(envelope = {}) {
  const message = envelope.event?.message ?? envelope.message ?? envelope;
  return {
    messageId: messageId(message.message_id ?? message.id) ? (message.message_id ?? message.id) : null,
    rootId: messageId(message.root_id) ? message.root_id : null,
    parentId: messageId(message.parent_id) ? message.parent_id : null,
    threadId: threadId(message.thread_id) ? message.thread_id : null,
  };
}

export function chatReplyRoute(binding, reason = 'no_source') {
  return { version: 1, scope: scopeFor(binding), mode: 'chat', chatId: binding.chat_id,
    sourceMessageIds: [], sourceCount: 0, reason };
}

// Pass trusted durable inbox records, never a model-supplied message ID. Callback
// card IDs are accepted only when their originating job still belongs to this binding.
export function selectReplyRoute(binding, jobs, { allJobs = jobs, mode = binding.native_reply_mode ?? 'quote' } = {}) {
  const selected = [...(jobs ?? [])];
  if (!selected.length) return chatReplyRoute(binding);
  if (!['quote','thread','off'].includes(mode)) throw failure('invalid_native_reply_mode');
  const known = new Map([...(allJobs ?? [])].map(job => [job.id, job]));
  const resolve = (job, seen = new Set()) => {
    if (!job || !isBoundJob(binding, job) || job.id !== (job.event.message_id ?? job.event.id)
        || seen.has(job.id) || seen.size >= 16) throw failure('reply_source_binding_mismatch');
    const event = job.event;
    if (!event.synthetic_callback) {
      const source = nativeMessageContext(event);
      if (!source.messageId) throw failure('reply_source_invalid');
      return source;
    }
    seen.add(job.id);
    const parent = resolve(known.get(event.action_source_job_id), seen);
    if (!messageId(event.action_source_message_id)) throw failure('reply_callback_source_invalid');
    return { ...parent, messageId: event.action_source_message_id };
  };
  const ordered = selected.sort((a,b) => (a.sequence ?? a.acceptedAt ?? 0) - (b.sequence ?? b.acceptedAt ?? 0)
    || a.id.localeCompare(b.id));
  const sources = ordered.map(job => resolve(job));
  const sourceMessageIds = [...new Set(sources.map(source => source.messageId))];
  const common = { version: 1, scope: scopeFor(binding), chatId: binding.chat_id,
    sourceMessageIds, sourceCount: sourceMessageIds.length };
  if (mode === 'off') return { ...common, mode: 'chat', reason: 'disabled' };
  // One Codex turn may consume several messages. Preserve the single final reply,
  // but do not pretend its answer belongs to one of several distinct topics.
  if (new Set(sources.map(source => source.threadId ?? '')).size > 1)
    return { ...common, mode: 'chat', reason: 'mixed_topics' };
  const first = sources[0];
  return { ...common, mode: first.threadId || mode === 'thread' ? 'thread' : 'quote',
    messageId: first.messageId, threadId: first.threadId, rootId: first.rootId, parentId: first.parentId,
    reason: sources.length > 1 ? 'grouped_turn' : 'source_message' };
}

export function replyRouteNotice(route) {
  if (route?.reason === 'mixed_topics') return `本次合并答复涉及 ${route.sourceCount} 条消息（来自不同话题），统一展示在主聊天。`;
  if (route?.sourceCount > 1) return `本次合并答复对应 ${route.sourceCount} 条连续消息，引用其中第一条。`;
  return '';
}

function validateRoute(binding, route) {
  if (route?.version !== 1 || route.scope !== scopeFor(binding) || route.chatId !== binding.chat_id
      || !['chat','quote','thread'].includes(route.mode)
      || (route.mode !== 'chat' && !messageId(route.messageId))) throw failure('reply_route_binding_mismatch');
}

function sendArgs(state) {
  const body = { msg_type: state.msgType, content: state.content, uuid: state.uuid };
  if (state.route.mode === 'chat') return ['api','POST','/open-apis/im/v1/messages',
    '--params',JSON.stringify({ receive_id_type:'chat_id' }),
    '--data',JSON.stringify({ ...body, receive_id:state.route.chatId })];
  return ['api','POST',`/open-apis/im/v1/messages/${state.route.messageId}/reply`,
    '--data',JSON.stringify({ ...body, reply_in_thread:state.route.mode === 'thread' })];
}

// One immutable delivery intention per existing outbox key. A 55-minute fence
// leaves headroom inside Feishu's documented one-hour UUID deduplication window.
// The caller owns scheduling/backoff; this class never reruns the model.
export class DurableReplyRouter {
  constructor({ root, binding, request, now = Date.now, uncertainWindowMs = 55 * 60 * 1000 }) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(binding?.bot ?? '')) throw failure('reply_binding_invalid');
    this.root = path.join(root, binding.bot); this.binding = binding; this.request = request; this.now = now;
    this.uncertainWindowMs = Math.min(55 * 60 * 1000, Math.max(1, uncertainWindowMs));
    this.scope = scopeFor(binding); this.inflight = new Map();
    fs.mkdirSync(this.root, { recursive:true });
  }
  send({ key, route = chatReplyRoute(this.binding), msgType = 'text', content }) {
    if (typeof key !== 'string' || !key) return Promise.reject(failure('reply_key_invalid'));
    const keyHash = digest(`${this.scope}\0${key}`);
    const promise = (this.inflight.get(keyHash) ?? Promise.resolve()).catch(() => {}).then(() =>
      this.sendOnce({ keyHash, route, msgType, content }));
    this.inflight.set(keyHash, promise);
    return promise.finally(() => { if (this.inflight.get(keyHash) === promise) this.inflight.delete(keyHash); });
  }
  async sendOnce({ keyHash, route, msgType, content }) {
    validateRoute(this.binding, route);
    if (!['text','post','image','file','audio','media','sticker','interactive','share_chat','share_user'].includes(msgType))
      throw failure('reply_message_type_invalid');
    if (typeof content !== 'string') content = JSON.stringify(content);
    try { if (!content || typeof JSON.parse(content) !== 'object') throw Error(); }
    catch { throw failure('reply_content_invalid'); }
    const payloadHash = digest(JSON.stringify({ msgType, content, route }));
    const file = path.join(this.root, `send-${keyHash}.json`);
    let state;
    if (fs.existsSync(file)) {
      try { state = JSON.parse(fs.readFileSync(file,'utf8')); } catch { throw failure('reply_state_corrupt'); }
      if (state.schema !== 1 || state.scope !== this.scope || state.keyHash !== keyHash || state.payloadHash !== payloadHash
          || state.msgType !== msgType || state.content !== content || state.uuid !== digest(`native-reply:${keyHash}`).slice(0,40)
          || !['pending','sent','blocked'].includes(state.status)
          || (state.uncertain && !Number.isFinite(state.uncertainSince)))
        throw failure('reply_intent_changed');
      validateRoute(this.binding, state.route);
    } else {
      state = { schema:1, scope:this.scope, keyHash, payloadHash, route, msgType, content,
        uuid:digest(`native-reply:${keyHash}`).slice(0,40), status:'pending', createdAt:this.now(), attempts:0 };
      atomicWriteJson(file,state);
    }
    if (state.status === 'sent') return state.result;
    if (state.status === 'blocked') throw Object.assign(failure(state.error ?? 'reply_delivery_blocked'), { deliveryUncertain:Boolean(state.uncertain) });
    for (let step = 0; step < 3; step++) {
      if (state.uncertain && this.now() - state.uncertainSince >= this.uncertainWindowMs) {
        state.status = 'blocked'; state.error = 'reply_delivery_uncertain_expired'; atomicWriteJson(file,state);
        throw Object.assign(failure(state.error), { deliveryUncertain:true });
      }
      const priorUncertain = Boolean(state.uncertain);
      state.uncertain = true; state.uncertainSince ??= this.now(); state.attempts++;
      atomicWriteJson(file,state); // Persist before even the first network attempt.
      try {
        const result = await this.request(this.binding, sendArgs(state));
        if (!messageId(result?.message_id) || (result.chat_id && result.chat_id !== this.binding.chat_id))
          throw Object.assign(Error('reply_ack_invalid'), { code:'reply_ack_invalid' });
        // Retain only delivery identifiers, never the returned message body or credentials.
        state.result = { message_id:result.message_id, chat_id:this.binding.chat_id,
          ...nativeMessageContext(result), fallback:state.fallback ?? null };
        state.status = 'sent'; state.sentAt = this.now(); state.uncertain = false; delete state.error;
        atomicWriteJson(file,state); return state.result;
      } catch (error) {
        const code = String(error?.apiCode ?? error?.code ?? 'transport_error');
        state.error = /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : 'request_failed';
        // A later rejection cannot establish whether a preceding timed-out request
        // already created a message. Never change destination or body after uncertainty.
        if (!priorUncertain && definitelyRejected(code)) {
          state.uncertain = false; delete state.uncertainSince;
          if (state.route.mode !== 'chat' && sourceGone.has(code)) {
            state.route = { ...state.route, mode:'chat' }; state.fallback = 'source_unavailable';
            atomicWriteJson(file,state); continue;
          }
          if (state.route.mode === 'thread' && threadUnsupported.has(code)) {
            state.route = { ...state.route, mode:'quote' }; state.fallback = 'thread_unsupported';
            atomicWriteJson(file,state); continue;
          }
          if (code !== '230020') { state.status = 'blocked'; error.permanent = true; }
        } else if (forbidden.has(code) || ['permission','authentication'].includes(error?.type)) {
          // Permission errors never trigger an unquoted send to work around visibility.
          state.status = 'blocked'; error.permanent = true;
        }
        error.deliveryUncertain = Boolean(state.uncertain);
        atomicWriteJson(file,state); throw error;
      }
    }
    throw failure('reply_fallback_exhausted');
  }
  stats() {
    let pending = 0, blocked = 0;
    for (const name of fs.readdirSync(this.root).filter(name => /^send-[a-f0-9]{64}\.json$/.test(name))) {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(this.root,name),'utf8'));
        if (state.scope !== this.scope) continue;
        if (state.status === 'pending') pending++;
        if (state.status === 'blocked') blocked++;
      } catch { blocked++; }
    }
    return { native_reply_pending_count:pending, native_reply_blocked_count:blocked };
  }
}
