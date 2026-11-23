import fs from 'node:fs';
import { digest } from './codex-bridge-inbox.mjs';
import { classifyFailure } from './codex-bridge-retry.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { bindingSnapshot, isBoundJob } from './codex-bridge-ux.mjs';

const OVERLAP_MS = 15000;
const MAX_WINDOW_MS = 5 * 60 * 1000;
const SETTLE_MS = 10000;
const PAGE_SIZE = 25;
const MAX_PAGES = 4;
const MAX_ATTEMPTS = 4;
const EVIDENCE_TTL_MS = 60000;
const positiveTime = value => Number.isSafeInteger(value) && value > 0;
const safeToken = value => typeof value === 'string' && /^[A-Za-z0-9+=/_-]{1,1024}$/.test(value);
const openId = value => typeof value === 'string' && /^ou_[A-Za-z0-9_-]{1,120}$/.test(value);
const chatId = value => typeof value === 'string' && /^oc_[A-Za-z0-9_-]{1,120}$/.test(value);
const messageId = value => typeof value === 'string' && /^om_[A-Za-z0-9_-]{1,120}$/.test(value) && !value.startsWith('om_cb_');
const sameConnection = (a,b) => a.pid === b.pid && a.startedAtMs === b.startedAtMs &&
  a.generation === b.generation && a.connectedAtMs === b.connectedAtMs;
const validAnchor = snapshot => snapshot && [snapshot.pid,snapshot.startedAtMs,snapshot.generation,
  snapshot.connectedAtMs,snapshot.lastPongAtMs].every(positiveTime) &&
  snapshot.startedAtMs <= snapshot.connectedAtMs && snapshot.connectedAtMs <= snapshot.lastPongAtMs;

// identity comes from the supervisor's existing exact process check. A file
// alone cannot attest that the subscriber PID/profile are still current.
export function verifiedRecoveryHeartbeat(snapshot, identity, now = Date.now()) {
  if (!identity || snapshot?.schema !== 1 || snapshot.pid !== identity.pid ||
      snapshot.profile !== identity.profile || !positiveTime(identity.startedAtMs) ||
      Math.abs(snapshot.started_at_ms - identity.startedAtMs) > 10000 ||
      snapshot.state !== 'connected' || snapshot.recovering_since_ms !== 0 ||
      !Number.isSafeInteger(snapshot.pending_ping_since_ms) || snapshot.pending_ping_since_ms < 0 ||
      !positiveTime(snapshot.ping_interval_ms) || snapshot.ping_interval_ms < 1000 || snapshot.ping_interval_ms > 3600000 ||
      !positiveTime(snapshot.updated_at_ms) || snapshot.updated_at_ms > now ||
      !positiveTime(snapshot.pong_count) || snapshot.updated_at_ms < snapshot.last_pong_at_ms) return null;
  if (snapshot.pending_ping_since_ms > 0 &&
      (snapshot.pending_ping_since_ms > now || now - snapshot.pending_ping_since_ms > 30000)) return null;
  const anchor = { pid:snapshot.pid, startedAtMs:snapshot.started_at_ms, generation:snapshot.generation,
    connectedAtMs:snapshot.connected_at_ms, lastPongAtMs:snapshot.last_pong_at_ms };
  if (!validAnchor(anchor) || anchor.lastPongAtMs > now ||
      now - anchor.lastPongAtMs > snapshot.ping_interval_ms * 2 + 30000) return null;
  return anchor;
}

function parseTimestamp(value) {
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) value = Number(value);
  return positiveTime(value) ? value : null;
}

// Live processing continues during history reads. A past command must not be
// appended after a newer live instruction, which might have canceled it.
export function hasNewerLiveInput(binding, event, jobs) {
  const at=parseTimestamp(event?.create_time??event?.timestamp);
  if(!at)return true;
  for(const job of jobs){
    const source=job.event;
    if(job.id===event.message_id || !source || source.history_recovered===true || source.synthetic_callback ||
        source.type!=='im.message.receive_v1' || !isBoundJob(binding,job))continue;
    const liveAt=parseTimestamp(source.timestamp??source.create_time);
    if(liveAt===null || liveAt>=at)return true;
  }
  return false;
}

export function historyRequestArgs({startSeconds,endSeconds,pageToken,pageSize}, binding) {
  if (!positiveTime(startSeconds) || !positiveTime(endSeconds) || startSeconds > endSeconds ||
      endSeconds - startSeconds > MAX_WINDOW_MS / 1000 + 2 || !chatId(binding?.chat_id) ||
      !positiveTime(pageSize) || pageSize > PAGE_SIZE || (pageToken != null && !safeToken(pageToken)))
    throw Error('history_recovery_request_invalid');
  return ['api','GET','/open-apis/im/v1/messages','--params',JSON.stringify({
    container_id_type:'chat', container_id:binding.chat_id, sort_type:'ByCreateTimeAsc',
    start_time:String(startSeconds), end_time:String(endSeconds), page_size:pageSize,
    ...(pageToken ? {page_token:pageToken} : {}),
  })];
}

// History can include app-authored cards, deleted/edited messages and topic
// roots. Preserve an ID for auditing only after matching the exact human scope.
function inspectItem(item, binding, startMs, endMs, maxInboundBytes) {
  const id = item?.message_id, timestamp = parseTimestamp(item?.create_time);
  const sender = item?.sender;
  if (!messageId(id) || !timestamp || timestamp < startMs || timestamp > endMs ||
      item.chat_id !== binding.chat_id || sender?.sender_type !== 'user' ||
      sender.id_type !== 'open_id' || sender.id !== binding.allowed_sender_id ||
      !openId(sender.id) || item.deleted !== false) return null;
  const receipt = { id, timestamp };
  if (item.msg_type !== 'text' || item.updated !== false || item.thread_id || item.root_id || item.parent_id ||
      (item.mentions != null && (!Array.isArray(item.mentions) || item.mentions.length > 0)) ||
      (item.update_time != null && parseTimestamp(item.update_time) !== timestamp) ||
      typeof item.body?.content !== 'string' || Buffer.byteLength(item.body.content) > maxInboundBytes) return receipt;
  let body;
  try { body = JSON.parse(item.body.content); } catch { return receipt; }
  if (typeof body?.text !== 'string' || !body.text.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(body.text) ||
      Object.keys(body).length !== 1) return receipt;
  const event = {type:'im.message.receive_v1', message_type:'text', message_id:id, chat_id:binding.chat_id,
    sender_type:'user', sender_id:sender.id, create_time:timestamp, timestamp, content:JSON.stringify({text:body.text})};
  if (Buffer.byteLength(JSON.stringify(event)) <= maxInboundBytes) receipt.event = event;
  return receipt;
}

const scopeFor = binding => digest(JSON.stringify(['history-recovery-v1',bindingSnapshot(binding)]));
const isNewConnection = (old,next) =>
  next.connectedAtMs > old.connectedAtMs && next.connectedAtMs >= old.lastPongAtMs &&
  (old.pid !== next.pid || old.startedAtMs !== next.startedAtMs
    ? next.startedAtMs >= old.lastPongAtMs : next.generation > old.generation);

function validPending(job, anchor) {
  return job && validAnchor(job.connection) && sameConnection(job.connection,anchor) &&
    [job.startMs,job.endMs,job.readyAfter].every(positiveTime) && job.startMs < job.endMs &&
    job.endMs - job.startMs <= MAX_WINDOW_MS && job.readyAfter >= job.endMs &&
    Number.isSafeInteger(job.attempts) && job.attempts >= 0 && job.attempts <= MAX_ATTEMPTS &&
    Number.isSafeInteger(job.retryAt) && job.retryAt >= 0 &&
    Array.isArray(job.replayed) && job.replayed.length <= PAGE_SIZE * MAX_PAGES && job.replayed.every(messageId);
}

/** A second read API on the original app identity. Owns neither subscription nor subscriber offset. */
export class HistoryRecovery {
  constructor({stateFile,binding,readHeartbeat,readHistory,drainIntake,hasSeen,enqueue,
    mode='audit',now=Date.now,maxEventAgeMs=MAX_WINDOW_MS,maxInboundBytes=32768}) {
    if (!chatId(binding?.chat_id) || !openId(binding?.allowed_sender_id) ||
        !['audit','replay','off'].includes(mode) || !positiveTime(maxEventAgeMs) || !positiveTime(maxInboundBytes) ||
        typeof stateFile !== 'string' || ![readHeartbeat,readHistory,drainIntake,hasSeen,enqueue].every(fn=>typeof fn==='function'))
      throw Error('history_recovery_config_invalid');
    Object.assign(this,{stateFile,binding,readHeartbeat,readHistory,drainIntake,hasSeen,enqueue,mode,now});
    this.maxEventAgeMs = Math.min(MAX_WINDOW_MS,maxEventAgeMs);
    this.maxInboundBytes = Math.min(32768,maxInboundBytes);
    this.scope = scopeFor(binding);
    this.state = { schema:1, scope:this.scope, mode };
    if (fs.existsSync(stateFile)) {
      try {
        const previous = JSON.parse(fs.readFileSync(stateFile,'utf8'));
        if (previous?.schema !== 1 || typeof previous.scope !== 'string' || !['off','audit','replay'].includes(previous.mode) ||
            (previous.anchor && !validAnchor(previous.anchor)) ||
            (previous.pending && (!previous.anchor || !validPending(previous.pending,previous.anchor)))) this.blocked = 'state_invalid';
        else if (previous.scope !== this.scope) this.blocked = 'scope_changed';
        // Changing mode renews the baseline on the next verified connection.
        // A candidate observed in audit mode is never silently replayed.
        else if (previous.mode === mode) this.state = previous;
      } catch { this.blocked = 'state_invalid'; }
    }
  }

  save(next) {
    atomicWriteJson(this.stateFile,next);
    this.state = next;
  }

  finish(outcome, extra = {}) {
    const {pending,...rest} = this.state;
    this.save({...rest, result:{outcome, at:this.now(), ...extra}});
  }

  stats() {
    // No message IDs, connection fingerprints, paths, exception text or payload.
    const result = this.state.result;
    const count = value => Number.isSafeInteger(value) && value >= 0 && value <= PAGE_SIZE * MAX_PAGES ? value : 0;
    return {history_recovery_mode:this.mode, history_recovery_pending_count:this.state.pending ? 1 : 0,
      history_recovery_state:this.blocked ?? (this.mode==='off' ? 'off' : this.state.pending ? 'pending' :
        ['reconciled','window_expired','window_superseded','page_limit','response_invalid','history_rejected','attempts_exhausted'].includes(result?.outcome) ? result.outcome : 'idle'),
      history_recovery_last_check_at:positiveTime(result?.at) ? result.at : null,
      history_recovery_seen_count:count(result?.seen),history_recovery_missing_count:count(result?.missing),
      history_recovery_replayed_count:count(result?.replayed),history_recovery_audit_only_count:count(result?.auditOnly)};
  }

  tick() {
    if (!this.flight) this.flight = this.observe().finally(()=>{this.flight = null;});
    return this.flight;
  }

  async observe() {
    if (this.blocked || this.mode === 'off') return;
    const {anchor,pending} = this.state;
    if (pending && this.now() - pending.startMs > this.maxEventAgeMs)
      this.finish('window_expired',{replayed:pending.replayed.length});
    const next = await this.readHeartbeat(), now = this.now();
    if (!validAnchor(next) || next.lastPongAtMs > now) return;
    if (!anchor) {
      this.save({...this.state,anchor:next});
      return;
    }
    if (!sameConnection(anchor,next)) {
      if (!isNewConnection(anchor,next)) return;
      if (this.state.pending) {
        // An outage while the last window is unresolved destroys a reliable
        // coverage boundary. Audit evidence remains in the logs/queues.
        this.finish('window_superseded',{replayed:this.state.pending.replayed.length});
        this.save({...this.state,anchor:next});
        return;
      }
      const startMs = Math.max(anchor.startedAtMs,anchor.lastPongAtMs - OVERLAP_MS);
      const endMs = next.connectedAtMs;
      if (endMs <= startMs || endMs - startMs > this.maxEventAgeMs || now - startMs > this.maxEventAgeMs) {
        this.save({...this.state,anchor:next,result:{outcome:'window_expired',at:now}});
        return;
      }
      this.save({...this.state,anchor:next,pending:{connection:next,startMs,endMs,readyAfter:endMs+SETTLE_MS,
        attempts:0,retryAt:0,replayed:[]}});
    } else if (next.lastPongAtMs > anchor.lastPongAtMs) this.save({...this.state,anchor:next});
    const job = this.state.pending;
    if (!job) return;
    if (now - job.startMs > this.maxEventAgeMs) { this.finish('window_expired',{replayed:job.replayed.length}); return; }
    if (now < job.readyAfter || now < job.retryAt || await this.drainIntake() !== true) return;
    await this.reconcile(job);
  }

  async reconcile(job) {
    const candidates = new Map(), tokens = new Set();
    let token = null;
    try {
      // Restart reads a fresh bounded window. Do not resume with a stale
      // server cursor or dispatch partial pages before the complete range is known.
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await this.readHistory({startSeconds:Math.floor(job.startMs/1000),
          endSeconds:Math.ceil(job.endMs/1000),pageSize:PAGE_SIZE,pageToken:token});
        if (!data || typeof data.has_more !== 'boolean' || (data.items !== undefined && !Array.isArray(data.items)) ||
            (!data.items && data.has_more) || (data.items?.length ?? 0) > PAGE_SIZE) {
          this.finish('response_invalid',{replayed:job.replayed.length}); return;
        }
        for (const item of data.items ?? []) {
          const entry = inspectItem(item,this.binding,job.startMs,job.endMs,this.maxInboundBytes);
          if (!entry) continue;
          const prior = candidates.get(entry.id);
          if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) {
            this.finish('response_invalid',{replayed:job.replayed.length}); return;
          }
          candidates.set(entry.id,entry);
        }
        if (!data.has_more) {
          await this.apply(job,[...candidates.values()].sort((a,b)=>a.timestamp-b.timestamp));
          return;
        }
        if (!safeToken(data.page_token) || tokens.has(data.page_token)) {
          this.finish('response_invalid',{replayed:job.replayed.length}); return;
        }
        token = data.page_token;
        tokens.add(token);
      }
      this.finish('page_limit',{replayed:job.replayed.length});
    } catch (error) {
      // Never persist arbitrary API or storage errors. Each retry first
      // refetches history and checks the normal intake's durable dedup index.
      const latest=this.state.pending;
      if (!latest) throw Error('history_recovery_checkpoint_failed');
      const attempts=latest.attempts+1;
      const code=String(error?.apiCode ?? error?.code ?? '');
      if (classifyFailure(error).kind==='permanent' || ['230002','230013','230027','231203','231204','99991679'].includes(code))
        this.finish('history_rejected',{replayed:latest.replayed.length});
      else if (attempts >= MAX_ATTEMPTS) this.finish('attempts_exhausted',{replayed:latest.replayed.length});
      else {
        const backoff=10000*2**(attempts-1);
        const retryAfter=Number.isFinite(error?.retryAfterMs) ? Math.min(MAX_WINDOW_MS,error.retryAfterMs) : 0;
        this.save({...this.state,pending:{...latest,attempts,retryAt:Math.round(this.now()+Math.max(backoff,retryAfter))}});
      }
    }
  }

  async apply(job, entries) {
    // Recheck after the history calls, which may have crossed another
    // reconnect or let an ordinary live append catch up.
    const heartbeat = await this.readHeartbeat();
    const now = this.now();
    if (now - job.startMs > this.maxEventAgeMs) { this.finish('window_expired',{replayed:job.replayed.length}); return; }
    if (!validAnchor(heartbeat) || !sameConnection(job.connection,heartbeat) ||
        heartbeat.lastPongAtMs > now || await this.drainIntake() !== true) {
      this.save({...this.state,pending:{...job,retryAt:now+EVIDENCE_TTL_MS}});
      return;
    }
    const summary={seen:0,missing:0,replayed:job.replayed.length,auditOnly:0};
    for (const item of entries) {
      if (await this.hasSeen(item.id) || this.state.pending.replayed.includes(item.id)) { summary.seen++; continue; }
      summary.missing++;
      if (this.mode !== 'replay' || !item.event || this.now() - item.timestamp > this.maxEventAgeMs) {
        summary.auditOnly++;
        continue;
      }
      // Must be a durable enqueue, not a model dispatch. The adapter reuses
      // the live path's authorization, age check and message-ID dedup.
      if (await this.enqueue({...item.event,bridge_binding:bindingSnapshot(this.binding)}) !== true) {
        summary.auditOnly++;
        continue;
      }
      const pending=this.state.pending;
      this.save({...this.state,pending:{...pending,replayed:[...pending.replayed,item.id]}});
      summary.replayed++;
    }
    this.finish('reconciled',summary);
  }
}
