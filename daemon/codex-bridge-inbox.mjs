import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { rolloutAssistantMessage, rolloutTaskCompletion } from './codex-bridge-progress.mjs';

export const digest = (s) => createHash('sha256').update(s).digest('hex');
export const atomicJson = atomicWriteJson;

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
  enqueue(event) {
    const id = event.message_id ?? event.id;
    if (typeof id !== 'string' || !/^om_[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid_message_id');
    if (this.jobs.has(id)) return this.jobs.get(id);
    const job = { id, event, status: 'queued', acceptedAt: this.now(), attempts: 0,
      sequence: Math.max(0,...[...this.jobs.values()].map(j=>j.sequence??0))+1 };
    this.save(job); this.jobs.set(id, job); return job;
  }
  async dispatchOne() {
    const j = [...this.jobs.values()].find(j => j.status === 'queued' && (j.retryAt ?? 0) <= this.now());
    if (!j) return false;
    try {
      // Download errors do not block other messages; retries remain on disk.
      j.prepared ??= await this.io.prepare(j.event);
      const target = await this.io.target();
      if (!target) { this.save(j); return false; }
      j.rollout = target.rollout; j.cursor = fs.statSync(j.rollout).size;
      j.status = 'submitted'; j.submittedAt = this.now();
      this.save(j); // Crash boundary: reconcile rollout, never blindly reinject.
      try { await this.io.inject(j, target); }
      catch { j.transportUncertain = true; this.save(j); }
      return true;
    } catch (error) {
      j.attempts++; j.error = 'attachment_or_target_failed';
      j.retryAt = this.now() + Math.min(60000, 1000 * 2 ** j.attempts);
      if (j.attempts >= 3) {
        j.status = 'failed';
        j.notice = '附件下载或会话定位失败，原消息已保留，未交给 Codex 执行。请检查 bridge 状态后重试。';
      }
      this.save(j); this.io.log?.('inbox_prepare_failed', { bot: this.bot, messageId: j.id, attempts: j.attempts });
      return true;
    }
  }
  scan(j) {
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
      if (item.type === 'response_item' && p?.type === 'message' && p.role === 'user'
          && JSON.stringify(p.content ?? []).includes(`[飞书消息｜${this.bot}｜${j.id}]`)) {
        j.markerSeen = true; j.status = 'delivered'; j.deliveredAt ??= this.now();
      }
      if (!j.markerSeen) continue;
      const message = rolloutAssistantMessage(item);
      if (message?.phase === 'commentary') progress.push(message.text);
      const completion = rolloutTaskCompletion(item);
      if (message?.phase === 'final_answer' || completion?.kind === 'final') {
        j.status = 'reply_pending'; j.reply = message?.text ?? completion.text;
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
    const progress = new Set();
    for (const j of this.jobs.values()) {
      if (!['submitted','delivered'].includes(j.status)) continue;
      try {
        for (const t of this.scan(j)) progress.add(t);
        if(j.error==='rollout_read_failed'){delete j.error;this.save(j);}
      } catch { j.error = 'rollout_read_failed'; this.save(j); }
      // Timed-out jobs remain watched; late delivery/final may still arrive.
      if (this.now() - j.submittedAt > this.timeoutMs && !j.timeoutNotified) {
        j.notice = j.markerSeen ? '消息已送入 Codex，但答复等待超时；仍在跟踪，不会重复执行。' : '消息已保存，但尚未确认进入 Codex；仍在跟踪，请查看桌面会话状态。';
        j.timeoutNotified = true; this.save(j);
      }
    }
    for (const text of [...progress].slice(-1)) await this.io.progress?.(text).catch(() => {});
  }
  async deliverReplies() {
    for (const j of this.jobs.values()) {
      if (j.notice) {
        try { await this.io.send(j.notice, digest(`notice:${j.id}:${j.notice}`)); delete j.notice; this.save(j); } catch {}
      }
      if (j.status !== 'reply_pending') continue;
      const receipt = path.join(this.dir, `sent-${j.replyKey}.json`);
      if (!fs.existsSync(receipt)) {
        try {
          await this.io.send(j.reply, j.replyKey);
          atomicJson(receipt, { sentAt: this.now() });
        } catch { continue; }
      }
      j.status = 'done'; j.completedAt = this.now(); delete j.reply;
      this.save(j); this.io.log?.('inbox_reply_sent', { bot: this.bot, messageId: j.id });
    }
  }
  stats() {
    const all = [...this.jobs.values()];
    const count = (s) => all.filter(j => s.includes(j.status)).length;
    return { queued_count: count(['queued']), awaiting_delivery_count: count(['submitted']),
      awaiting_reply_count: count(['delivered']), reply_pending_count: count(['reply_pending']),
      failed_count: count(['failed']), completed_count: count(['done']),
      watch_error_count: all.filter(j=>j.error==='rollout_read_failed').length,
      oldest_pending_seconds: Math.round(Math.max(0, ...all.filter(j => j.status !== 'done' && j.status !== 'failed').map(j => (this.now()-j.acceptedAt)/1000))),
      oldest_undelivered_seconds: Math.round(Math.max(0, ...all.filter(j => j.status === 'submitted').map(j => (this.now()-j.submittedAt)/1000))),
      last_delivered_at: Math.max(0,...all.map(j=>j.deliveredAt??0)) || null };
  }
}
