import fs from 'node:fs';
import path from 'node:path';
import { digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { recordFailure } from './codex-bridge-retry.mjs';
import { bindingSnapshot, isBoundJob } from './codex-bridge-ux.mjs';
import { isHistoricalFileFailure } from './codex-bridge-file-history.mjs';

const permanent = code => Object.assign(new Error(code), { code, permanent: true });
const resourceKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const messageId = value => typeof value === 'string' && /^om_[A-Za-z0-9_-]+$/.test(value) && !value.startsWith('om_cb_');
const apiCode = error => {
  const value=error?.apiCode??error?.code;
  return (typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)||(typeof value==='string'&&/^\d{1,10}$/.test(value))?String(value):'';
};
const attachmentKey = ({jobId,mode,name,hash,coverHash}) => digest(`file-v3\0${jobId}\0${mode}\0${name}\0${hash}\0${coverHash??''}`);
const scopedDelivery = state => [2,3].includes(state.deliveryVersion);
export function attachmentFailureNotice(state) {
  if(state.sendIntent?.uncertain)return '附件送达状态尚未确认，原文件和发送记录已保留；请先核验原聊天，不要重复提交附件。';
  if(state.deliveryVersion===3) {
    const stage=state.transfer?.stage==='message'?'附件已上传，但聊天消息发送失败':'附件上传未完成';
    const uploadReasons={
      '234001':'上传参数被飞书拒绝，请检查文件类型与请求格式。',
      '234002':'上传身份校验失败，请检查当前机器人认证。',
      '234006':'附件超过飞书上传大小限制，请缩小文件后重新提交。',
      '234007':'当前应用未开通机器人能力，请由管理员检查。',
      '234010':'飞书拒绝了空文件，请重新生成非空文件。',
      '234011':'飞书不支持此图片格式；请转换图片，或明确选择普通文件发送。',
      '234039':'图片分辨率超过飞书限制；请降低分辨率，或明确选择普通文件发送。',
      '234041':'租户密钥状态异常，请联系租户管理员。',
      '234042':'租户存储异常，请联系租户管理员。',
    };
    const reason=['99991672','99991668'].includes(String(state.error))?'请检查当前机器人上传资源及发送消息权限。'
      :state.error==='attachment_audio_requires_opus'?'语音消息需要 Opus 格式；其他音频请作为文件发送。'
      :state.error==='attachment_video_requires_mp4'?'视频消息需要 MP4 格式；其他视频请作为文件发送。'
      :uploadReasons[String(state.error)]??'请检查 bridge 文件队列中记录的错误类别和当前机器人权限。';
    return `${stage}，原文件已保留。${reason}文字答复不代表附件已送达。`;
  }
  return state.generatedReport?'完整报告附件发送未完成，原文已保留。请检查 bridge 文件队列和飞书权限；文字答复不代表附件已送达。':'文件发送失败，附件已保留。请检查 bridge 文件队列和飞书权限；文字答复不代表附件已送达。';
}

// Use a filename on both Windows and macOS without losing its extension. The
// payload is private; no name or path is copied into a diagnostic error.
export function safeAttachmentName(value) {
  let name = path.basename(String(value ?? '')).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[.\s]+$/u, '');
  if (!name || /^\.+$/.test(name)) name = 'attachment';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  let ext = path.extname(name);
  if (Buffer.byteLength(ext) > 32) ext = '';
  let stem = name.slice(0, name.length - ext.length);
  while (Buffer.byteLength(stem + ext) > 180) stem = Array.from(stem).slice(0,-1).join('');
  return (stem || 'attachment') + ext;
}

export function attachmentFileType(name, mode = 'file', bytes) {
  const ext = path.extname(name).toLowerCase();
  if (mode === 'audio') {
    // Ogg is a container, not necessarily Opus. Do not silently send Vorbis as
    // a voice message; the caller may explicitly choose mode=file instead.
    if (!['.opus','.ogg'].includes(ext) || (bytes && (!bytes.subarray(0,4).equals(Buffer.from('OggS'))
        || !bytes.subarray(0,512).includes(Buffer.from('OpusHead'))))) throw permanent('attachment_audio_requires_opus');
    return 'opus';
  }
  if (mode === 'video') {
    if (ext !== '.mp4') throw permanent('attachment_video_requires_mp4');
    return 'mp4';
  }
  // The official upload enum has no docx/xlsx/pptx/zip/html/markdown values.
  // Stream preserves those originals instead of guessing an invalid enum.
  return ({'.pdf':'pdf','.doc':'doc','.xls':'xls','.ppt':'ppt','.mp4':'mp4','.opus':'opus'})[ext] ?? 'stream';
}
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

function enqueueSnapshot({ root, binding, jobId, mode, name, bytes, preview, key, reportId, deliveryVersion = 2 }) {
  const botRoot = path.join(root, binding.bot), dir = path.join(botRoot, key);
  fs.mkdirSync(botRoot, { recursive: true });
  if (!within(fs.realpathSync(root), fs.realpathSync(botRoot))) throw permanent('attachment_outside_allowed_roots');
  fs.mkdirSync(dir, { recursive: true });
  if (!within(fs.realpathSync(botRoot), fs.realpathSync(dir))) throw permanent('attachment_outside_allowed_roots');
  const manifest = path.join(dir, 'request.json');
  if (fs.existsSync(manifest)) {
    const s = JSON.parse(fs.readFileSync(manifest));
    if (s.hash !== digest(bytes) || (s.origin && !matchesOrigin(s.origin, binding))
        ||(scopedDelivery(s)&&s.bindingScope!==digest(JSON.stringify(bindingSnapshot(binding))))) throw permanent('attachment_snapshot_changed');
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
  if (preview) { coverName = `cover-${digest(preview.bytes).slice(0,8)}-${deliveryVersion===3?safeAttachmentName(preview.real):path.basename(preview.real)}`; snapshot(coverName, preview.bytes); }
  atomicWriteJson(manifest, { key, jobId, mode, name, coverName, hash: digest(bytes),
    coverHash: preview ? digest(preview.bytes) : null, bytes: bytes.length, origin: originFor(binding),
    deliveryVersion,bindingScope:digest(JSON.stringify(bindingSnapshot(binding))),
    ...(reportId ? { generatedReport: reportId } : {}), status: 'queued', createdAt: Date.now() });
  return { key, status: 'queued' };
}

// Explicit delivery only: never infer uploads from links in model text.
// Snapshot files before queuing so later user edits cannot change retry payloads.
export function enqueueFile({ root, inboxRoot, binding, jobId, file, mode = 'file', cover, deliveryVersion = 2, name: suppliedName }) {
  if (!/^om_[A-Za-z0-9_-]+$/.test(jobId) || !['file', 'image', 'audio', 'video'].includes(mode)) throw permanent('invalid_attachment_request');
  authorizedFileJob(inboxRoot, binding, jobId);
  if (![2,3].includes(deliveryVersion)) throw permanent('invalid_attachment_request');
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
  const name = deliveryVersion===3?safeAttachmentName(suppliedName??source.real):path.basename(source.real).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (deliveryVersion===3) attachmentFileType(name,mode,source.bytes);
  const key = digest(`${deliveryVersion===3?'file-v3\0':''}${jobId}\0${mode}\0${deliveryVersion===3?name:path.basename(source.real)}\0${digest(source.bytes)}\0${preview ? digest(preview.bytes) : ''}`);
  return enqueueSnapshot({ root, binding, jobId, mode, name, bytes: source.bytes, preview, key, deliveryVersion });
}

// The caller is the sole worker after verifying a workspace request and its
// private immutable snapshots. This lane accepts bytes, never a model-selected
// filesystem path, and repeats the business binding and payload checks.
export function enqueueImmutableAttachment({root,inboxRoot,binding,jobId,name,mode='file',bytes,preview}) {
  authorizedFileJob(inboxRoot,binding,jobId);
  if(!['file','image','audio','video'].includes(mode)||typeof name!=='string'||name!==safeAttachmentName(name)
    || !Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>(mode==='image'?10:30)*1024*1024)
    throw permanent('invalid_attachment_snapshot');
  attachmentFileType(name,mode,bytes);
  if(mode==='video') {
    if(!preview||typeof preview.name!=='string'||preview.name!==safeAttachmentName(preview.name)
      ||!Buffer.isBuffer(preview.bytes)||preview.bytes.length<1||preview.bytes.length>10*1024*1024)throw permanent('invalid_attachment_snapshot');
  } else if(preview!==undefined&&preview!==null)throw permanent('invalid_attachment_snapshot');
  const hash=digest(bytes),coverHash=preview?digest(preview.bytes):null,key=attachmentKey({jobId,mode,name,hash,coverHash});
  return enqueueSnapshot({root,binding,jobId,mode,name,bytes,preview:preview?{real:preview.name,bytes:preview.bytes}:null,key,deliveryVersion:3});
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
  constructor(root, binding, request, { now = Date.now, notify, getRoute, resolveHistoricalSource } = {}) {
    this.root = path.join(root, binding.bot); this.binding = binding; this.request = request; this.now = now;
    this.notify = notify;this.getRoute=getRoute;this.resolveHistoricalSource=resolveHistoricalSource;
    this.historicalPayloadDigests=new Map();
    fs.mkdirSync(this.root, { recursive: true });
  }
  records() {
    return fs.readdirSync(this.root).filter(n => /^[a-f0-9]{64}$/.test(n)).map(key => {
      const file=path.join(this.root,key,'request.json');
      try {
        if(!fs.lstatSync(path.dirname(file)).isDirectory() || !fs.lstatSync(file).isFile())throw Error('invalid_file_record');
        const s=JSON.parse(fs.readFileSync(file));
        if(!s || typeof s!=='object' || Array.isArray(s))throw Error('invalid_file_record');
        return {file,key,s};
      } catch {return {file,key,s:null,readError:true};}
    }).sort((a, b) => (a.s?.createdAt??0) - (b.s?.createdAt??0));
  }
  stats() {
    const records=this.records(),failed=records.filter(({s})=>!s || !['queued','done'].includes(s.status));
    const historical=failed.filter(({s,key,file})=>isHistoricalFileFailure({state:s,key,dir:path.dirname(file),binding:this.binding,
      now:this.now(),resolveSource:this.resolveHistoricalSource,payloadDigestCache:this.historicalPayloadDigests})).length;
    return { file_pending_count: records.filter(({s}) => s?.status === 'queued').length,
      file_failed_count: failed.length, file_active_failed_count: failed.length-historical,
      file_historical_failed_count: historical };
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
      if(!s)continue; // Corrupt/missing records remain active diagnostics, untouched.
      if(s.status==='blocked' && !s.noticeSent && this.notify) {
        const noticeFile = s.generatedReport ? path.join(this.root, `report-notice-${s.generatedReport}.json`) : null;
        if (noticeFile && fs.existsSync(noticeFile)) { s.noticeSent = true; atomicWriteJson(file,s); continue; }
        s.noticeRetry ??= {};
        if(!s.noticeRetry.blocked && (s.noticeRetry.retryAt??0)<=this.now()) {
          try {
            await this.notify(attachmentFailureNotice(s),
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
        if(scopedDelivery(s)&&s.bindingScope!==scope)throw permanent('attachment_binding_mismatch');
        const recordDir=fs.realpathSync(path.dirname(file)),dir = fs.realpathSync(path.join(recordDir,'payload')), source = path.resolve(dir, s.name);
        if(!within(fs.realpathSync(this.root),recordDir)||!within(recordDir,dir))throw permanent('attachment_outside_allowed_roots');
        if(s.deliveryVersion===3 && (s.key!==path.basename(path.dirname(file)) || !['file','image','audio','video'].includes(s.mode)
          || s.name!==safeAttachmentName(s.name)||s.key!==attachmentKey(s)))throw permanent('attachment_snapshot_changed');
        if (!within(dir, fs.realpathSync(source)) || digest(fs.readFileSync(source)) !== s.hash) throw permanent('attachment_snapshot_changed');
        const args = ['im', '+messages-send', '--chat-id', this.binding.chat_id, `--${s.mode}`, `./${s.name}`,
          '--idempotency-key', s.key.slice(0, 32)];
        if (s.mode === 'video') {
          const preview = fs.realpathSync(path.join(dir, s.coverName));
          if (!within(dir, preview) || digest(fs.readFileSync(preview)) !== s.coverHash) throw permanent('attachment_cover_changed');
          args.push('--video-cover', `./${s.coverName}`);
        }
        if(s.deliveryVersion===3)await this.sendStaged(file,s,dir,scope);
        else if(this.getRoute)await this.sendRouted(file,s,args,dir,scope);
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
  async sendStaged(file,s,dir,scope) {
    // Uploads cannot create chat messages. A lost upload ACK may leave an unused
    // resource, so retries stay in this stage until a valid resource key is
    // checkpointed. Once message IO begins, its exact content never changes.
    const payloadHash=digest(JSON.stringify([s.key,s.mode,s.name,s.hash,s.coverName??null,s.coverHash??null]));
    const validRoute=route=>route?.version===1&&route.scope===scope&&route.chatId===this.binding.chat_id
      &&['chat','quote','thread'].includes(route.mode)&&(route.mode==='chat'||messageId(route.messageId));
    if(!s.transfer) {
      const route=this.getRoute?await this.getRoute(s.jobId):{version:1,scope,chatId:this.binding.chat_id,mode:'chat'};
      if(!validRoute(route))throw permanent('attachment_reply_route_invalid');
      s.transfer={schema:1,scope,payloadHash,route,createdAt:this.now(),stage:'upload'};
      atomicWriteJson(file,s);
    }
    const transfer=s.transfer;
    if(transfer.schema!==1||transfer.scope!==scope||transfer.payloadHash!==payloadHash||!validRoute(transfer.route)
      || !['upload','message','sent'].includes(transfer.stage)||(transfer.stage!=='upload'&&!s.sendIntent)
      ||(transfer.stage==='sent'&&!s.sendIntent?.sent))throw permanent('attachment_transfer_invalid');
    const upload=async(role,name,image)=>{
      const saved=transfer[role];
      if(saved) {
        if(saved.hash!==(role==='cover'?s.coverHash:s.hash)||!resourceKey(saved.key))throw permanent('attachment_upload_checkpoint_invalid');
        return saved.key;
      }
      if(s.sendIntent)throw permanent('attachment_upload_checkpoint_missing');
      transfer.stage='upload';transfer.uploadRole=role;atomicWriteJson(file,s);
      const args=image?['im','images','create','--data',JSON.stringify({image_type:'message'}),'--file',`image=./${name}`]
        :['im','files','create','--data',JSON.stringify({file_type:attachmentFileType(name,s.mode,fs.readFileSync(path.join(dir,name))),file_name:s.name}),'--file',`file=./${name}`];
      try {
        const result=await this.request(this.binding,args,dir),key=image?result?.image_key:result?.file_key;
        if(!resourceKey(key))throw Object.assign(Error('attachment_upload_ack_invalid'),{code:'attachment_upload_ack_invalid'});
        transfer[role]={key,hash:role==='cover'?s.coverHash:s.hash,uploadedAt:this.now()};
        delete transfer.uploadRole;atomicWriteJson(file,s);return key;
      } catch(error) {
        // These resource failures never imply unknown *message* delivery.
        error.deliveryUncertain=false;
        // Official files/images upload errors require corrected input or admin
        // intervention; 232096 (temporarily stopped) retains normal backoff.
        if(['234001','234002','234006','234007','234010','234011','234039','234041','234042'].includes(apiCode(error)))error.permanent=true;
        throw error;
      }
    };
    const primary=await upload('primary',s.name,s.mode==='image');
    const cover=s.mode==='video'?await upload('cover',s.coverName,true):null;
    const content=JSON.stringify(s.mode==='image'?{image_key:primary}:{file_key:primary,...(cover?{image_key:cover}:{})});
    if(!s.sendIntent) {
      s.sendIntent={schema:2,scope,payloadHash,route:transfer.route,uuid:s.key.slice(0,32),content,msgType:s.mode==='video'?'media':s.mode,uncertain:false};
      transfer.stage='message';atomicWriteJson(file,s);
    }
    const intent=s.sendIntent;
    if(intent.schema!==2||intent.scope!==scope||intent.payloadHash!==payloadHash||intent.content!==content||intent.msgType!==(s.mode==='video'?'media':s.mode)
      ||intent.uuid!==s.key.slice(0,32)||!validRoute(intent.route)||(intent.uncertain&&(!Number.isFinite(intent.uncertainSince)||intent.uncertainSince>this.now())))
      throw permanent('attachment_send_intent_invalid');
    if(intent.sent) {
      if(!messageId(intent.messageId)||intent.result?.message_id!==intent.messageId||intent.result?.chat_id!==this.binding.chat_id)throw permanent('attachment_send_intent_invalid');
      transfer.stage='sent';return;
    }
    for(let step=0;step<3;step++) {
      if(intent.uncertain&&this.now()-intent.uncertainSince>=55*60*1000)
        throw Object.assign(permanent('attachment_delivery_uncertain_expired'),{deliveryUncertain:true});
      const route=intent.route,body={msg_type:intent.msgType,content:intent.content,uuid:intent.uuid};
      const args=route.mode==='chat'?['api','POST','/open-apis/im/v1/messages','--params',JSON.stringify({receive_id_type:'chat_id'}),'--data',JSON.stringify({...body,receive_id:this.binding.chat_id})]
        :['api','POST',`/open-apis/im/v1/messages/${route.messageId}/reply`,'--data',JSON.stringify({...body,reply_in_thread:route.mode==='thread'})];
      const wasUncertain=Boolean(intent.uncertain);
      intent.uncertain=true;intent.uncertainSince??=this.now();intent.lastAttemptAt=this.now();atomicWriteJson(file,s);
      try {
        const result=await this.request(this.binding,args,dir);
        if(!messageId(result?.message_id)||(result.chat_id&&result.chat_id!==this.binding.chat_id))
          throw Object.assign(Error('attachment_ack_invalid'),{code:'attachment_ack_invalid'});
        intent.sent=true;intent.messageId=result.message_id;intent.result={message_id:result.message_id,chat_id:this.binding.chat_id};intent.uncertain=false;transfer.stage='sent';atomicWriteJson(file,s);return;
      } catch(error) {
        const code=apiCode(error);
        if(!wasUncertain&&['230011','230019'].includes(code)&&route.mode!=='chat') {
          intent.route={...route,mode:'chat'};intent.fallback='source_unavailable';intent.uncertain=false;delete intent.uncertainSince;atomicWriteJson(file,s);continue;
        }
        if(!wasUncertain&&['230071','230072'].includes(code)&&route.mode==='thread') {
          intent.route={...route,mode:'quote'};intent.fallback='thread_unsupported';intent.uncertain=false;delete intent.uncertainSince;atomicWriteJson(file,s);continue;
        }
        if(!wasUncertain&&(code==='230020'||['permission','validation','authentication'].includes(error.type)
          ||['230001','230002','230006','230013','230015','230017','230018','230022','230025','230027','230028','230035','230038','230050','230054','230055','230075','230099','230111','232009','99991672','99991668'].includes(code))) {
          intent.uncertain=false;delete intent.uncertainSince;if(code!=='230020')error.permanent=true;
        }
        error.deliveryUncertain=Boolean(intent.uncertain);atomicWriteJson(file,s);throw error;
      }
    }
    throw permanent('attachment_reply_fallback_exhausted');
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
