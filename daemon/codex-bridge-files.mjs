import fs from 'node:fs';
import path from 'node:path';
import { digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { recordFailure } from './codex-bridge-retry.mjs';
import { bindingSnapshot, isBoundJob } from './codex-bridge-ux.mjs';

const permanent = code => Object.assign(new Error(code), { code, permanent: true });
export function within(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

// The report path is supplied only by the runtime. Neither model text nor a
// callback can supply an arbitrary path to this authorization lane.
export function authorizedFileJob(inboxRoot, binding, jobId, replyKey) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(binding.bot ?? '') || !/^om_[A-Za-z0-9_-]+$/.test(jobId ?? '')) throw permanent('invalid_attachment_request');
  const job = JSON.parse(fs.readFileSync(path.join(inboxRoot, binding.bot, `job-${digest(jobId)}.json`), 'utf8'));
  if (job.id !== jobId || !binding.chat_id || !binding.allowed_sender_id
      || job.event?.chat_id !== binding.chat_id || (!binding.group_access && job.event?.sender_id !== binding.allowed_sender_id)
      || (replyKey !== undefined && (!/^[a-f0-9]{64}$/.test(replyKey) || job.replyKey !== replyKey))) throw permanent('attachment_binding_mismatch');
  if(!isBoundJob(binding,job))throw permanent('attachment_binding_changed');
  return job;
}

const originFor = binding => ({ bot: binding.bot, chatId: binding.chat_id, senderId: binding.allowed_sender_id, profile: binding.profile ?? '' });
const matchesOrigin = (origin, binding) => Object.entries(originFor(binding)).every(([key, value]) => origin?.[key] === value);

function enqueueSnapshot({ root, binding, jobId, mode, name, bytes, preview, key, reportId }) {
  const botRoot = path.join(root, binding.bot), dir = path.join(botRoot, key);
  fs.mkdirSync(botRoot, { recursive: true });
  if (!within(fs.realpathSync(root), fs.realpathSync(botRoot))) throw permanent('attachment_outside_allowed_roots');
  fs.mkdirSync(dir, { recursive: true });
  if (!within(fs.realpathSync(botRoot), fs.realpathSync(dir))) throw permanent('attachment_outside_allowed_roots');
  const manifest = path.join(dir, 'request.json');
  if (fs.existsSync(manifest)) {
    const s = JSON.parse(fs.readFileSync(manifest));
    if (s.hash !== digest(bytes) || (s.origin && !matchesOrigin(s.origin, binding))
        ||(s.deliveryVersion===2&&s.bindingScope!==digest(JSON.stringify(bindingSnapshot(binding))))) throw permanent('attachment_snapshot_changed');
    return { key, status: s.status };
  }
  const payloadDir = path.join(dir, 'payload'); fs.mkdirSync(payloadDir, { recursive: true });
  if (!within(fs.realpathSync(dir), fs.realpathSync(payloadDir))) throw permanent('attachment_outside_allowed_roots');
  const snapshot = (filename, value) => {
    const target = path.join(payloadDir, filename);
    if (fs.existsSync(target)) {
      if (!within(fs.realpathSync(payloadDir), fs.realpathSync(target)) || digest(fs.readFileSync(target)) !== digest(value)) throw permanent('attachment_snapshot_changed');
    } else fs.writeFileSync(target, value, { flag: 'wx', mode: 0o600 });
  };
  snapshot(name, bytes);
  let coverName;
  if (preview) { coverName = `cover-${digest(preview.bytes).slice(0,8)}-${path.basename(preview.real)}`; snapshot(coverName, preview.bytes); }
  atomicWriteJson(manifest, { key, jobId, mode, name, coverName, hash: digest(bytes),
    coverHash: preview ? digest(preview.bytes) : null, bytes: bytes.length, origin: originFor(binding),
    deliveryVersion:2,bindingScope:digest(JSON.stringify(bindingSnapshot(binding))),
    ...(reportId ? { generatedReport: reportId } : {}), status: 'queued', createdAt: Date.now() });
  return { key, status: 'queued' };
}

// Explicit delivery only: never infer uploads from links in model text.
// Snapshot files before queuing so later user edits cannot change retry payloads.
export function enqueueFile({ root, inboxRoot, binding, jobId, file, mode = 'file', cover }) {
  if (!/^om_[A-Za-z0-9_-]+$/.test(jobId) || !['file', 'image', 'audio', 'video'].includes(mode)) throw permanent('invalid_attachment_request');
  authorizedFileJob(inboxRoot, binding, jobId);
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
  const name = path.basename(source.real).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  return enqueueSnapshot({ root, binding, jobId, mode, name, bytes: source.bytes, preview, key });
}

// Only two renderer-owned filenames are accepted. The immutable report manifest
// binds their exact bytes to the same originating message and final reply.
export function enqueueGeneratedReport({ root, inboxRoot, reportRoot, binding, jobId, replyKey, name }) {
  const job = authorizedFileJob(inboxRoot, binding, jobId, replyKey);
  if (!['report.html', 'answer.md'].includes(name)) throw permanent('invalid_report_artifact');
  const reportId = digest(replyKey), botRoot = fs.realpathSync(path.join(reportRoot, binding.bot));
  if (!within(fs.realpathSync(reportRoot), botRoot)) throw permanent('report_outside_allowed_root');
  const dir = fs.realpathSync(path.join(botRoot, reportId));
  if (!within(botRoot, dir)) throw permanent('report_outside_allowed_root');
  const manifestPath = fs.realpathSync(path.join(dir, 'manifest.json'));
  if (!within(dir, manifestPath)) throw permanent('report_outside_allowed_root');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.kind !== 'codex-generated-report-v1' || manifest.replyKey !== replyKey || manifest.jobId !== jobId
      || !matchesOrigin(manifest.origin, binding) || (typeof job.reply === 'string' && digest(job.reply) !== manifest.sourceHash)) throw permanent('report_binding_mismatch');
  const artifact = manifest.artifacts?.find(a => a.name === name);
  if (!artifact || artifact.name !== name) throw permanent('invalid_report_artifact');
  const file = fs.realpathSync(path.join(dir, name));
  if (!within(dir, file)) throw permanent('report_outside_allowed_root');
  const limit = (name === 'report.html' ? 12 : 30) * 1024 * 1024;
  const info = fs.statSync(file);
  if (!info.isFile() || info.size < 1 || info.size > limit) throw permanent('report_size_invalid');
  const bytes = fs.readFileSync(file);
  if (bytes.length !== artifact.bytes || bytes.length > limit || digest(bytes) !== artifact.hash) throw permanent('report_snapshot_changed');
  if (name === 'answer.md' && artifact.hash !== manifest.answerHash) throw permanent('report_snapshot_changed');
  const key = digest(`generated-report\0${binding.bot}\0${replyKey}\0${name}\0${artifact.hash}`);
  return { name, ...enqueueSnapshot({ root, binding, jobId, mode: 'file', name, bytes, key, reportId }) };
}

export function getReportDelivery({ root, binding, artifacts }) {
  const states = artifacts.map(({ key }) => {
    if (!/^[a-f0-9]{64}$/.test(key ?? '')) throw permanent('invalid_report_artifact');
    const file = path.join(root, binding.bot, key, 'request.json');
    if (!fs.existsSync(file)) return 'missing';
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s.generatedReport || !matchesOrigin(s.origin, binding)) throw permanent('report_binding_mismatch');
    return s.status;
  });
  return { status: states.length && states.every(s => s === 'done') ? 'done' : states.includes('blocked') ? 'blocked' : 'pending',
    total: states.length, done: states.filter(s => s === 'done').length };
}

export class FileOutbox {
  constructor(root, binding, request, { now = Date.now, notify, getRoute } = {}) {
    this.root = path.join(root, binding.bot); this.binding = binding; this.request = request; this.now = now;
    this.notify = notify;this.getRoute=getRoute;
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
  flush() {
    // Final reply delivery and the periodic worker can request a flush together.
    // Share the complete operation, including reads/checkpoints, so a stale
    // queued snapshot cannot overwrite a successfully delivered one.
    if (!this.flushing) this.flushing = this.flushOnce().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async flushOnce() {
    for (const { file, s } of this.records()) {
      if(s.status==='blocked' && !s.noticeSent && this.notify) {
        const noticeFile = s.generatedReport ? path.join(this.root, `report-notice-${s.generatedReport}.json`) : null;
        if (noticeFile && fs.existsSync(noticeFile)) { s.noticeSent = true; atomicWriteJson(file,s); continue; }
        s.noticeRetry ??= {};
        if(!s.noticeRetry.blocked && (s.noticeRetry.retryAt??0)<=this.now()) {
          try {
            await this.notify(s.sendIntent?.uncertain ? '附件送达状态尚未确认，原文件和发送记录已保留；请先核验原聊天，不要重复提交附件。' : s.generatedReport ? '完整报告附件发送未完成，原文已保留。请检查 bridge 文件队列和飞书权限；文字答复不代表附件已送达。' : '文件发送失败，附件已保留。请检查 bridge 文件队列和飞书权限；文字答复不代表附件已送达。',
              s.generatedReport ? `report-failed:${s.generatedReport}` : `file-failed:${s.key}`,s.jobId);
            s.noticeSent=true;
            if (noticeFile) atomicWriteJson(noticeFile, { sentAt: this.now() });
          }
          catch(error) {recordFailure(s.noticeRetry,error,this.now());}
          atomicWriteJson(file,s);
        }
      }
      if (s.status !== 'queued' || (s.retryAt ?? 0) > this.now()) continue;
      try {
        if ((s.origin && !matchesOrigin(s.origin, this.binding)) || (s.generatedReport && !s.origin)) throw permanent('attachment_binding_mismatch');
        const scope=digest(JSON.stringify(bindingSnapshot(this.binding)));
        if(s.deliveryVersion===2&&s.bindingScope!==scope)throw permanent('attachment_binding_mismatch');
        const dir = path.join(path.dirname(file),'payload'), source = path.resolve(dir, s.name);
        if (!within(dir, fs.realpathSync(source)) || digest(fs.readFileSync(source)) !== s.hash) throw permanent('attachment_snapshot_changed');
        const args = ['im', '+messages-send', '--chat-id', this.binding.chat_id, `--${s.mode}`, `./${s.name}`,
          '--idempotency-key', s.key.slice(0, 32)];
        if (s.mode === 'video') {
          const preview = fs.realpathSync(path.join(dir, s.coverName));
          if (!within(dir, preview) || digest(fs.readFileSync(preview)) !== s.coverHash) throw permanent('attachment_cover_changed');
          args.push('--video-cover', `./${s.coverName}`);
        }
        if(this.getRoute)await this.sendRouted(file,s,args,dir,scope);
        else {
          // An optional-routing upgrade later must retain the endpoint of a
          // chat send that may have succeeded before the response was lost.
          s.legacySendStartedAt??=this.now();atomicWriteJson(file,s);
          await this.request(this.binding, args, dir);
        }
        s.status = 'done'; s.completedAt = this.now(); delete s.error;
      } catch (error) { recordFailure(s, error, this.now()); if (s.blocked) s.status = 'blocked'; }
      atomicWriteJson(file, s);
    }
  }
  async sendRouted(file,s,legacyArgs,dir,scope){
    const validRoute=route=>route?.version===1&&route.scope===scope&&route.chatId===this.binding.chat_id
      &&['chat','quote','thread'].includes(route.mode)&&(route.mode==='chat'||(/^om_[A-Za-z0-9_-]+$/.test(route.messageId??'')&&!route.messageId.startsWith('om_cb_')));
    const payloadHash=digest(JSON.stringify([s.key,s.mode,s.name,s.hash,s.coverName??null,s.coverHash??null]));
    if(!s.sendIntent){
      // Every pre-upgrade request keeps its original chat endpoint and UUID.
      // Its old format did not checkpoint first IO; creation time is the only
      // conservative bound for an unknown request that may already have sent.
      const legacy=s.deliveryVersion!==2||s.legacySendStartedAt!==undefined;
      const route=legacy?{version:1,scope,chatId:this.binding.chat_id,mode:'chat'}:await this.getRoute(s.jobId);
      if(!validRoute(route))throw permanent('attachment_reply_route_invalid');
      s.sendIntent={schema:1,scope,payloadHash,route,uuid:s.key.slice(0,32),legacy,
        uncertain:legacy,uncertainSince:legacy?(s.legacySendStartedAt??s.createdAt):undefined};
      atomicWriteJson(file,s);
    }
    const intent=s.sendIntent;
    if(intent.schema!==1||intent.scope!==scope||intent.payloadHash!==payloadHash||intent.uuid!==s.key.slice(0,32)||!validRoute(intent.route)
      ||(intent.uncertain&&(!Number.isFinite(intent.uncertainSince)||intent.uncertainSince>this.now())))throw permanent('attachment_send_intent_invalid');
    if(intent.sent){if(!/^om_[A-Za-z0-9_-]+$/.test(intent.messageId??''))throw permanent('attachment_send_intent_invalid');return;}
    for(let step=0;step<3;step++){
      if(intent.uncertain&&this.now()-intent.uncertainSince>=55*60*1000){
        throw Object.assign(permanent('attachment_delivery_uncertain_expired'),{deliveryUncertain:true});
      }
      const route=intent.route;
      const args=route.mode==='chat'?[...legacyArgs]:['im','+messages-reply','--message-id',route.messageId,
        ...(route.mode==='thread'?['--reply-in-thread']:[]),...legacyArgs.slice(4)];
      const wasUncertain=Boolean(intent.uncertain);
      intent.uncertain=true;intent.uncertainSince??=this.now();intent.lastAttemptAt=this.now();atomicWriteJson(file,s);
      try{
        const result=await this.request(this.binding,args,dir);
        if(!/^om_[A-Za-z0-9_-]+$/.test(result?.message_id??'')||(result.chat_id&&result.chat_id!==this.binding.chat_id))
          throw Object.assign(Error('attachment_ack_invalid'),{code:'attachment_ack_invalid'});
        intent.sent=true;intent.messageId=result.message_id;intent.uncertain=false;atomicWriteJson(file,s);return;
      }catch(error){
        const code=String(error.apiCode??error.code??'');
        if(!wasUncertain&&['230011','230019'].includes(code)&&route.mode!=='chat'){
          intent.route={...route,mode:'chat'};intent.fallback='source_unavailable';intent.uncertain=false;delete intent.uncertainSince;
          atomicWriteJson(file,s);continue;
        }
        if(!wasUncertain&&['230071','230072'].includes(code)&&route.mode==='thread'){
          intent.route={...route,mode:'quote'};intent.fallback='thread_unsupported';intent.uncertain=false;delete intent.uncertainSince;
          atomicWriteJson(file,s);continue;
        }
        if(!wasUncertain&&(code==='230020'||['permission','validation','authentication'].includes(error.type)
          ||['230001','230002','230006','230013','230017','230018','230022','230025','230027','230028','230035','230038','230050','230054','230055','230075','230111','232009','99991672','99991668'].includes(code))){
          intent.uncertain=false;delete intent.uncertainSince;
          if(code!=='230020')error.permanent=true;
        }
        error.deliveryUncertain=Boolean(intent.uncertain);atomicWriteJson(file,s);throw error;
      }
    }
    throw permanent('attachment_reply_fallback_exhausted');
  }
}
