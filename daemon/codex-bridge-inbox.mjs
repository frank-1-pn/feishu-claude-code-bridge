import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { rolloutAssistantMessage, rolloutTaskCompletion } from './codex-bridge-progress.mjs';
import { recordFailure } from './codex-bridge-retry.mjs';
import { acceptedDispatchLane, nextDispatchJob, hasPriorDispatchDependency } from './codex-bridge-dispatch-lanes.mjs';

export const digest = (s) => createHash('sha256').update(s).digest('hex');
export const atomicJson = atomicWriteJson;

// Full-group intake is quiet until the original marker and task disposition
// are both verified. Failures of an accepted actionable task remain visible.
export const suppressUnclassifiedNotice = job => !job.markerSeen
  || job.feedbackDisposition !== 'actionable' || job.completionDisposition === 'silent';

// Only execution/public-message metadata renews the inactivity timer. Token
// counters, file mtimes and hidden reasoning are not evidence of task progress.
const executionActivity = item => item?.type === 'response_item'
  && ['function_call','function_call_output','custom_tool_call','custom_tool_call_output'].includes(item.payload?.type);
const eventTime = (item, now) => {
  const value = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN;
  return Number.isFinite(value) && value >= 0 && value <= now ? value : null;
};

export function normalizeEvent(event) {
  const type = event.message_type;
  const raw = typeof event.content === 'string' ? event.content : JSON.stringify(event.content ?? {});
  let obj;
  try { obj = JSON.parse(raw); } catch { obj = null; }
  const resources = [];
  const add = (key, kind, name = '') => {
    if (typeof key !== 'string' || !/^(img|file)_[A-Za-z0-9_-]{1,240}$/.test(key)) return;
    if (!resources.some(r => r.key === key)) resources.push({ key, kind, name });
  };
  const visit = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.image_key) add(o.image_key, 'image');
    if (o.file_key) add(o.file_key, 'file', String(o.file_name ?? '').slice(0, 200));
    for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v);
  };
  if (type !== 'text') visit(obj);
  // lark-cli compact NDJSON uses [Image: img_...] / [File: ... file_...].
  if (type !== 'text' && !obj) for (const m of raw.matchAll(/\b(img|file)_v\d+_[A-Za-z0-9_-]{1,240}/g)) add(m[0], m[1] === 'img' ? 'image' : 'file');
  const supported = ['text', 'image', 'file', 'post', 'audio', 'video', 'media', 'sticker'].includes(type);
  const text = type === 'text' && typeof obj?.text === 'string' ? obj.text : raw;
  return { text, resources, supported, type };
}

// One private durable record per message. Intake advances its byte cursor only
// after enqueue; dispatch waits for transport submission, never for the answer.
export class DurableInbox {
  constructor(root, bot, io, { now = Date.now, timeoutMs = 1800000 } = {}) {
    this.dir = path.join(root, bot); this.bot = bot; this.io = io;
    this.now = now; this.timeoutMs = timeoutMs; this.jobs = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
    for (const name of fs.readdirSync(this.dir).filter(n => /^job-[a-f0-9]{64}\.json$/.test(n))) {
      // Corrupt state must not be silently treated as an unseen event.
      const job = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
      this.jobs.set(job.id, job);
    }
    this.jobs = new Map([...this.jobs].sort((a,b) => (a[1].sequence ?? a[1].acceptedAt)-(b[1].sequence ?? b[1].acceptedAt)));
  }
  save(j) { atomicJson(path.join(this.dir, `job-${digest(j.id)}.json`), j); }
  recordFeedbackTiming(id, field, at, source) {
    const job=this.jobs.get(id);
    if(!job || !['firstTypingAppliedAt','firstTypingVerifiedAt','firstCardSentAt'].includes(field) || job[field]!==undefined || !Number.isFinite(at))return;
    const sourceField=field==='firstCardSentAt'?'firstCardTimingSource':field==='firstTypingAppliedAt'?'firstTypingTimingSource':'firstTypingVerifiedTimingSource';
    const candidate={...job,[field]:at,...(source?{[sourceField]:source}:{})};this.save(candidate);Object.assign(job,candidate);
  }
  progressKey(j) {
    // Once published, the key belongs to this exact message for its lifetime.
    // A later turn_context must not detach the final from its initial card.
    if(this.io.classifiedFeedback && this.io.initialFeedbackCard && j.streamKey)return j.streamKey;
    return digest(`${this.bot}\0${j.rollout}\0${j.turnId ?? j.id}${this.io.classifiedFeedback?'\0'+j.id:''}`);
  }
  queueInitialFeedback(j) {
    if(!this.io.initialFeedbackCard || !this.io.classifiedFeedback || !j.markerSeen || j.feedbackDisposition!=='actionable'
        || j.event?.synthetic_callback || j.initialFeedbackQueuedAt!==undefined || !['submitted','delivered'].includes(j.status) || j.unclassifiedTurnEnded)return;
    j.streamKey=this.progressKey(j);
    const progress={text:'正在处理…',key:j.streamKey,at:null,observedAt:this.now(),initialFeedback:true};
    const prior=j.pendingProgress?.events??(j.pendingProgress?[j.pendingProgress]:[]);
    const candidate={...j,initialFeedbackQueuedAt:this.now(),pendingProgress:{...progress,events:[progress,...prior]}};
    this.save(candidate);Object.assign(j,candidate);
  }
  enqueue(event, {intakeEpoch} = {}) {
    const id = event.message_id ?? event.id;
    if (typeof id !== 'string' || !/^om_[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid_message_id');
    if (this.jobs.has(id)) return this.jobs.get(id);
    if(intakeEpoch!==undefined && (event.synthetic_callback===true || !intakeEpoch || Object.keys(intakeEpoch).some(k=>!['deploymentId','versionRef'].includes(k))
      || !/^[A-Za-z0-9_-]{1,80}$/.test(intakeEpoch.deploymentId??'') || !/^[a-f0-9]{40}$/.test(intakeEpoch.versionRef??'')))throw new Error('invalid_private_intake_epoch');
    const job = { id, event, status: 'queued', acceptedAt: this.now(), attempts: 0,
      ...(intakeEpoch?{intakeEpoch:{...intakeEpoch}}:{}),
      dispatchLane: acceptedDispatchLane(event, this.io.dependencyKey?.(event)),
      sequence: Math.max(0,...[...this.jobs.values()].map(j=>j.sequence??0))+1 };
    this.save(job); this.jobs.set(id, job);
    this.io.onQueued?.(); // Wake only after the private durable accept succeeds.
    return job;
  }
  async dispatchOne() {
    if (this.dispatching) return false;
    const j = nextDispatchJob(this.jobs.values(), this.now(), this.io.dispatchContextVerified);
    if (!j) return false;
    this.dispatching = true;
    try {
      // Preparation remains serialized; only independent pending lanes may pass
      // an earlier lane's preparation backoff.
      let targetResult;
      if(this.io.parallelPreparation?.(j.event)) {
        // Opt in only for unambiguous text reads. Both operations are reads;
        // native callbacks/handled/waiting-input preserve their old sequence.
        const results=await Promise.allSettled([
          Promise.resolve().then(async()=>{j.prepared??=await this.io.prepare(j.event);return j.prepared;}),
          Promise.resolve().then(()=>this.io.target()),
        ]);
        if(results[0].status==='rejected')throw results[0].reason;
        targetResult=results[1];
      } else j.prepared ??= await this.io.prepare(j.event);
      if (hasPriorDispatchDependency(this.jobs.values(), j, this.io.dispatchContextVerified)) {
        // A native context lookup may discover an omitted reply/thread relation.
        // Retain preparation, then let the next dispatch choose another lane.
        this.save(j); return true;
      }
      // Native voice confirmation is a local user interaction. No unconfirmed
      // transcript reaches the model; its handler resumes this same durable job.
      if(j.prepared.bridgeDisposition==='waiting_input') {
        const candidate={...j,status:'waiting_input',waitingSince:this.now()};
        this.save(candidate);Object.assign(j,candidate);return true;
      }
      if(j.prepared.bridgeDisposition==='handled') {
        const candidate={...j,status:'done',completedAt:this.now(),localReply:true,replyKey:digest(`native-local:${j.id}`)};
        atomicJson(path.join(this.dir,`sent-${candidate.replyKey}.json`),{sentAt:this.now(),local:true});
        this.save(candidate);Object.assign(j,candidate);return true;
      }
      if(targetResult?.status==='rejected')throw targetResult.reason;
      const target = targetResult?targetResult.value:await this.io.target();
      if (!target) { this.save(j); return false; }
      j.rollout = target.rollout; j.cursor = fs.statSync(j.rollout).size;
      j.status = 'submitted'; j.submittedAt = this.now();
      this.save(j); // Crash boundary: reconcile rollout, never blindly reinject.
      try { await this.io.inject(j, target); }
      catch { j.transportUncertain = true; this.save(j); }
      return true;
    } catch (error) {
      recordFailure(j, error, this.now());
      if (j.blocked) {
        j.status = 'failed';
        j.notice = '附件下载或会话定位失败，原消息已保留，未交给 Codex 执行。请检查 bridge 状态后重试。';
      } else if(j.attempts>=3 && !j.preparationNotified) {
        j.preparationNotified=true;
        j.notice='消息已保存，附件下载或会话连接暂未恢复；系统会继续重试，后续消息按顺序保留。';
      }
      this.save(j); this.io.log?.('inbox_prepare_failed', { bot: this.bot, messageId: j.id, attempts: j.attempts });
      return true;
    } finally { this.dispatching = false; }
  }
  completeSilently(j) {
    if(!j.markerSeen)return false;
    const disposition=this.io.classification?.(j);
    if(disposition==='actionable' && j.feedbackDisposition!=='actionable') {
      const candidate={...j,feedbackDisposition:'actionable',feedbackAcceptedAt:this.now()};this.save(candidate);Object.assign(j,candidate);
      this.io.onActionable?.(j);
    }
    this.queueInitialFeedback(j);
    if(disposition!=='silent' && !this.io.silentCompletion?.(j))return false;
    const candidate={...j,status:'done',completedAt:this.now(),completionDisposition:'silent',feedbackDisposition:'silent'};
    for(const key of ['reply','replyKey','replyRetry','notice','noticeRetry','pendingProgress','timeoutNotice','timeoutNotified','timeoutNotifiedAt','receiptRetry','error'])delete candidate[key];
    this.save(candidate);
    for(const key of Object.keys(j))if(!(key in candidate))delete j[key];
    Object.assign(j,candidate);this.io.log?.('inbox_silent_completed',{bot:this.bot,messageId:j.id});return true;
  }
  scan(j) {
    if(j.unclassifiedTurnEnded)return [];
    const stat = fs.statSync(j.rollout, { throwIfNoEntry: false });
    if (!stat || stat.size < j.cursor) throw new Error('rollout_missing_or_truncated');
    if (stat.size === j.cursor) return [];
    const available = stat.size-j.cursor;
    let b = Buffer.alloc(Math.min(available, 1024*1024));
    const fd = fs.openSync(j.rollout, 'r');
    let n;
    try {
      for (;;) {
        n = fs.readSync(fd, b, 0, b.length, j.cursor);
        if (b.subarray(0,n).includes(10) || n < b.length || b.length >= available || b.length >= 64*1024*1024) break;
        b = Buffer.alloc(Math.min(available,b.length*2,64*1024*1024));
      }
    } finally { fs.closeSync(fd); }
    const progress = []; let pos = 0;
    for (;;) {
      const end = b.indexOf(10, pos); if (end < 0 || end >= n) break;
      const absoluteEnd = j.cursor + end + 1;
      let item; try { item = JSON.parse(b.subarray(pos, end).toString('utf8')); } catch { pos=end+1; continue; }
      pos = end+1;
      const p = item.payload;
      if ((item.type === 'turn_context' || (item.type === 'event_msg' && p?.type === 'task_started')) && p?.turn_id) {
        j.turnId = p.turn_id;
      }
      if (item.type === 'response_item' && p?.type === 'message' && p.role === 'user'
          && JSON.stringify(p.content ?? []).includes(`[飞书消息｜${this.bot}｜${j.id}]`)) {
        j.markerSeen = true; j.status = 'delivered'; j.deliveredAt ??= this.now();
      }
      if (!j.markerSeen) continue;
      if(this.completeSilently(j))break;
      const message = rolloutAssistantMessage(item);
      const observedAt=this.now(), at=eventTime(item,observedAt);
      if(message || executionActivity(item)) {
        const activityAt=Math.max(j.lastActivityAt??j.submittedAt,at??observedAt);
        j.lastActivityAt=activityAt;
        if(j.timeoutNotified && activityAt>(j.timeoutNotifiedAt??j.submittedAt+this.timeoutMs)) {
          j.timeoutNotified=false;delete j.timeoutNotifiedAt;
          if(j.timeoutNotice && j.notice===j.timeoutNotice){delete j.notice;delete j.noticeRetry;}
        }
      }
      if (message?.phase === 'commentary') {
        let text=message.text;
        if(this.io.classifiedFeedback && !j.event?.synthetic_callback) {
          const tagged=/^\s*\[飞书进度｜(om_[A-Za-z0-9_-]+)\]\s*([^]*)$/.exec(text);
          if(j.feedbackDisposition!=='actionable' || tagged?.[1]!==j.id)continue;
          text=tagged[2];
        }
        j.streamKey = this.progressKey(j);
        const progress={text,key:j.streamKey,at,observedAt,position:absoluteEnd};
        const prior=j.pendingProgress?.events??(j.pendingProgress?[j.pendingProgress]:[]);
        j.pendingProgress={...progress,events:[...prior,progress].slice(-12)};
      }
      const completion = rolloutTaskCompletion(item);
      if (message?.phase === 'final_answer' || completion?.kind === 'final') {
        if(this.io.classifiedFeedback && !j.event?.synthetic_callback && j.feedbackDisposition!=='actionable') {j.unclassifiedTurnEnded=true;break;}
        j.status = 'reply_pending'; j.reply = message?.text ?? completion.text;
        if(j.timeoutNotice && j.notice===j.timeoutNotice){delete j.notice;delete j.noticeRetry;}
        // All steer messages consumed by one turn share exactly one outbox key.
        j.replyKey = digest(`${this.bot}\0${j.rollout}\0${absoluteEnd}`);
        break;
      }
      if (completion?.error) {
        j.status = 'failed'; j.error = completion.error;
        j.notice = 'Codex 已收到消息，但本轮未正常完成。原消息已保留，bridge 不会自动重复执行可能已完成的操作。';
        break;
      }
    }
    if (!pos && n >= 64*1024*1024) throw new Error('oversize_rollout_record');
    j.cursor += pos; this.save(j); return progress;
  }
  async watch() {
    for (const j of this.jobs.values()) {
      if (!['submitted','delivered'].includes(j.status)) continue;
      try {
        if(!this.completeSilently(j))this.scan(j);
        if(j.error==='rollout_read_failed'){delete j.error;this.save(j);}
      } catch { j.error = 'rollout_read_failed'; this.save(j); }
      // Timed-out jobs remain watched; late delivery/final may still arrive.
      const activityAt=j.markerSeen?(j.lastActivityAt??j.submittedAt):j.submittedAt;
      const caughtUp=fs.statSync(j.rollout,{throwIfNoEntry:false})?.size===j.cursor;
      if (caughtUp && ['submitted','delivered'].includes(j.status) && this.now() - activityAt > this.timeoutMs && !j.timeoutNotified) {
        const minutes=Math.max(1,Math.round(this.timeoutMs/60000));
        j.notice = j.markerSeen ? `Codex 已收到消息，但连续 ${minutes} 分钟未观察到新的执行活动或公开进度；仍在跟踪，任务未自动取消，也不会重复执行。` : '消息已保存，但尚未确认进入 Codex；仍在跟踪，请查看桌面会话状态。';
        j.timeoutNotice=j.notice;j.timeoutNotifiedAt=this.now();
        j.timeoutNotified = true; this.save(j);
      }
    }
    for (const j of this.jobs.values()) {
      if (!j.pendingProgress) continue;
      try {
        for(const progress of j.pendingProgress.events??[j.pendingProgress])
          await this.io.progress?.(progress.text,progress.key,{jobId:j.id,job:j,at:progress.at,observedAt:progress.observedAt,position:progress.position,initialFeedback:progress.initialFeedback});
        delete j.pendingProgress; this.save(j);
      } catch { /* Saved snapshot is retried after restart. */ }
    }
  }
  async deliverReplies() {
    for (const j of this.jobs.values()) {
      if(j.notice && this.io.suppressNotices?.(j)) {
        j.noticeSuppressed=true;delete j.notice;delete j.noticeRetry;this.save(j);
      }
      if (j.notice) {
        j.noticeRetry ??= {};
        if (!j.noticeRetry.blocked && (j.noticeRetry.retryAt ?? 0) <= this.now()) {
          const notice=j.notice,retry=j.noticeRetry;
          // Rollout scanning can cancel or replace this warning during network
          // I/O. Its old result must not clear or revive a newer warning.
          const current=()=>j.notice===notice && j.noticeRetry===retry;
          try {
            await (this.io.notice ?? this.io.send)(notice, digest(`notice:${j.id}:${notice}`),
              {jobId:j.id,job:j,streamKey:j.streamKey,terminal:j.status==='failed'});
            if(current()){delete j.notice; delete j.noticeRetry; delete j.noticeSuppressed;}
          }
          catch (error) { if(current())recordFailure(retry, error, this.now()); }
          this.save(j);
        }
      }
      // Upgrade recovery: older versions marked late peers done as soon as
      // the shared answer receipt existed, leaving their visible cards open.
      const recoverCard=j.status==='done' && this.io.closeReplyCards && j.markerSeen && j.streamKey && j.replyKey
        && j.replyCardsClosedAt===undefined && j.completionDisposition!=='silent' && !j.unclassifiedTurnEnded
        && (!this.io.classifiedFeedback || j.event?.synthetic_callback || j.feedbackDisposition==='actionable');
      if (j.status !== 'reply_pending' && !recoverCard) continue;
      const receipt = path.join(this.dir, `sent-${j.replyKey}.json`);
      if(recoverCard) {
        if(!fs.existsSync(receipt))continue; // Never replay an old business answer.
        j.status='reply_pending';delete j.completedAt;this.save(j);
      }
      if (!fs.existsSync(receipt)) {
        const retryFile = path.join(this.dir, `reply-retry-${j.replyKey}.json`);
        j.replyRetry = fs.existsSync(retryFile) ? JSON.parse(fs.readFileSync(retryFile, 'utf8')) : (j.replyRetry ?? {});
        if (j.replyRetry.blocked || (j.replyRetry.retryAt ?? 0) > this.now()) continue;
        try {
          const streamKeys = [...this.jobs.values()].filter(other => other.replyKey === j.replyKey).map(other => other.streamKey).filter(Boolean);
          const peers=[...this.jobs.values()].filter(other=>other.replyKey===j.replyKey);
          const proof=await (this.io.final ?? this.io.send)(j.reply, j.replyKey, streamKeys, {jobId:j.id,replyKey:j.replyKey,jobs:peers});
          const evidence=proof?.schema===1 && Number.isFinite(proof.at) && proof.at>=0
            && ['send_response','create_response','reconciled_observation'].includes(proof.source)?{schema:1,at:proof.at,source:proof.source}:null;
          atomicJson(receipt, { sentAt: this.now(),finalDeliveryEvidence:evidence });
        } catch (error) { recordFailure(j.replyRetry, error, this.now()); atomicJson(retryFile,j.replyRetry); this.save(j); continue; }
      }
      const sent=JSON.parse(fs.readFileSync(receipt,'utf8')),proof=sent.finalDeliveryEvidence;
      if(proof?.schema===1 && Number.isFinite(proof.at) && proof.at>=0
          && ['send_response','create_response','reconciled_observation'].includes(proof.source))j.finalDeliveryEvidence={schema:1,at:proof.at,source:proof.source};
      // A reply receipt deduplicates the answer, not the per-message cards.
      // Late rollout cursors discover peers after that receipt was committed.
      if(this.io.closeReplyCards && j.streamKey && j.replyCardsClosedAt===undefined) {
        j.replyCardRetry??={};
        if(j.replyCardRetry.blocked || (j.replyCardRetry.retryAt??0)>this.now())continue;
        try {
          await this.io.closeReplyCards(j.replyKey,[j.streamKey],{jobId:j.id,replyKey:j.replyKey,jobs:[j]});
          j.replyCardsClosedAt=this.now();delete j.replyCardRetry;
        } catch(error) {recordFailure(j.replyCardRetry,error,this.now());this.save(j);continue;}
      }
      j.status = 'done'; j.completedAt = this.now(); delete j.reply; delete j.replyRetry;
      this.save(j); this.io.log?.('inbox_reply_sent', { bot: this.bot, messageId: j.id });
    }
  }
  stats() {
    const all = [...this.jobs.values()];
    const count = (s) => all.filter(j => s.includes(j.status)).length;
    return { queued_count: count(['queued']), awaiting_delivery_count: count(['submitted']),
      awaiting_reply_count: count(['delivered']), reply_pending_count: count(['reply_pending']),
      failed_count: count(['failed']), completed_count: count(['done']), silent_completed_count:all.filter(j=>j.status==='done' && j.completionDisposition==='silent').length, actionable_count:all.filter(j=>j.feedbackDisposition==='actionable').length, waiting_input_count: count(['waiting_input']),
      watch_error_count: all.filter(j=>j.error==='rollout_read_failed').length,
      outbound_blocked_count: all.filter(j => j.replyRetry?.blocked || j.replyCardRetry?.blocked || j.noticeRetry?.blocked || j.receiptRetry?.blocked).length,
      oldest_queued_seconds: Math.round(Math.max(0, ...all.filter(j => j.status === 'queued').map(j => (this.now()-j.acceptedAt)/1000))),
      oldest_pending_seconds: Math.round(Math.max(0, ...all.filter(j => j.status !== 'done' && j.status !== 'failed').map(j => (this.now()-j.acceptedAt)/1000))),
      oldest_undelivered_seconds: Math.round(Math.max(0, ...all.filter(j => j.status === 'submitted').map(j => (this.now()-j.submittedAt)/1000))),
      last_delivered_at: Math.max(0,...all.map(j=>j.deliveredAt??0)) || null };
  }
}
