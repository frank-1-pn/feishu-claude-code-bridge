import fs from 'node:fs';
import path from 'node:path';
import { digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { recordFailure } from './codex-bridge-retry.mjs';

const permanent = code => Object.assign(new Error(code), { code, permanent: true });
export function within(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

// Explicit delivery only: never infer uploads from links in model text.
// Snapshot files before queuing so later user edits cannot change retry payloads.
export function enqueueFile({ root, inboxRoot, binding, jobId, file, mode = 'file', cover }) {
  if (!/^om_[A-Za-z0-9_-]+$/.test(jobId) || !['file', 'image', 'audio', 'video'].includes(mode)) throw permanent('invalid_attachment_request');
  const job = JSON.parse(fs.readFileSync(path.join(inboxRoot, binding.bot, `job-${digest(jobId)}.json`), 'utf8'));
  if (job.id !== jobId || job.event?.chat_id !== binding.chat_id || job.event?.sender_id !== binding.allowed_sender_id) throw permanent('attachment_binding_mismatch');
  const roots = [binding.cwd, ...(binding.outbound_roots ?? [])].map(p => fs.realpathSync(p));
  const verify = (p, limit) => {
    const real = fs.realpathSync(p);
    if (!roots.some(r => within(r, real))) throw permanent('attachment_outside_allowed_roots');
    const info = fs.statSync(real);
    if (!info.isFile() || info.size < 1 || info.size > limit) throw permanent('attachment_size_invalid');
    const bytes = fs.readFileSync(real);
    if (bytes.length < 1 || bytes.length > limit) throw permanent('attachment_size_invalid');
    return { real, bytes };
  };
  const source = verify(file, (mode === 'image' ? 10 : 30) * 1024 * 1024);
  const preview = mode === 'video' ? verify(cover, 10 * 1024 * 1024) : null;
  const key = digest(`${jobId}\0${mode}\0${path.basename(source.real)}\0${digest(source.bytes)}\0${preview ? digest(preview.bytes) : ''}`);
  const dir = path.join(root, binding.bot, key); fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'request.json');
  if (fs.existsSync(manifest)) return { key, status: JSON.parse(fs.readFileSync(manifest)).status };
  const name = path.basename(source.real).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const payloadDir = path.join(dir, 'payload'); fs.mkdirSync(payloadDir, {recursive:true});
  const snapshot = (name, bytes) => {
    const target=path.join(payloadDir,name);
    if(fs.existsSync(target)) { if(digest(fs.readFileSync(target))!==digest(bytes)) throw permanent('attachment_snapshot_changed'); }
    else fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
  };
  snapshot(name, source.bytes);
  let coverName;
  if (preview) { coverName = `cover-${digest(preview.bytes).slice(0,8)}-${path.basename(preview.real)}`; snapshot(coverName, preview.bytes); }
  atomicWriteJson(manifest, { key, jobId, mode, name, coverName, hash: digest(source.bytes),
    coverHash: preview ? digest(preview.bytes) : null, bytes: source.bytes.length, status: 'queued', createdAt: Date.now() });
  return { key, status: 'queued' };
}

export class FileOutbox {
  constructor(root, binding, request, { now = Date.now, notify } = {}) {
    this.root = path.join(root, binding.bot); this.binding = binding; this.request = request; this.now = now;
    this.notify = notify;
    fs.mkdirSync(this.root, { recursive: true });
  }
  records() {
    return fs.readdirSync(this.root).filter(n => /^[a-f0-9]{64}$/.test(n)).map(n => path.join(this.root, n, 'request.json'))
      .filter(f => fs.existsSync(f)).map(file => ({ file, s: JSON.parse(fs.readFileSync(file)) }))
      .sort((a, b) => a.s.createdAt - b.s.createdAt);
  }
  stats() {
    const states = this.records().map(x => x.s);
    return { file_pending_count: states.filter(s => s.status === 'queued').length,
      file_failed_count: states.filter(s => s.status === 'blocked').length };
  }
  async flush() {
    for (const { file, s } of this.records()) {
      if(s.status==='blocked' && !s.noticeSent && this.notify) {
        s.noticeRetry ??= {};
        if(!s.noticeRetry.blocked && (s.noticeRetry.retryAt??0)<=this.now()) {
          try { await this.notify('文件发送失败，附件已保留。请检查 bridge 文件队列和飞书权限；文字答复不代表附件已送达。',`file-failed:${s.key}`);s.noticeSent=true; }
          catch(error) {recordFailure(s.noticeRetry,error,this.now());}
          atomicWriteJson(file,s);
        }
      }
      if (s.status !== 'queued' || (s.retryAt ?? 0) > this.now()) continue;
      try {
        const dir = path.join(path.dirname(file),'payload'), source = path.resolve(dir, s.name);
        if (!within(dir, fs.realpathSync(source)) || digest(fs.readFileSync(source)) !== s.hash) throw permanent('attachment_snapshot_changed');
        const args = ['im', '+messages-send', '--chat-id', this.binding.chat_id, `--${s.mode}`, `./${s.name}`,
          '--idempotency-key', s.key.slice(0, 32)];
        if (s.mode === 'video') {
          const preview = fs.realpathSync(path.join(dir, s.coverName));
          if (!within(dir, preview) || digest(fs.readFileSync(preview)) !== s.coverHash) throw permanent('attachment_cover_changed');
          args.push('--video-cover', `./${s.coverName}`);
        }
        await this.request(this.binding, args, dir);
        s.status = 'done'; s.completedAt = this.now(); delete s.error;
      } catch (error) { recordFailure(s, error, this.now()); if (s.blocked) s.status = 'blocked'; }
      atomicWriteJson(file, s);
    }
  }
}
