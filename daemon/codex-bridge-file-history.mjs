import fs from 'node:fs';
import path from 'node:path';
import { digest } from './codex-bridge-inbox.mjs';
import { bindingSnapshot, isBoundJob } from './codex-bridge-ux.mjs';
import { isAuthorizedMessage } from './codex-bridge-authorization.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (actual, expected) => actual && Object.keys(actual).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, value]) => actual[key] === value);
const finiteTime = (value, now) => Number.isFinite(value) && value >= 0 && value <= now;
const within = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
const fileSignature = s => ['dev','ino','size','mtimeNs','ctimeNs','mode','uid','gid','nlink'].map(k=>String(s[k])).join(':');
const privatePayload = s => s.isFile() && s.nlink===1n && (s.mode&0o777n)===0o600n
  && (typeof process.getuid!=='function' || s.uid===BigInt(process.getuid())) && s.size>0n && s.size<=30n*1024n*1024n;

// Cache content digests only. Every hit still reopens the current regular file
// and verifies owner, mode, link count, namespace and both high-resolution stat
// identities. Source authorization and queue records are never cached.
function payloadMatches(payload, name, expected, cache) {
  if (typeof name !== 'string' || !name || path.basename(name) !== name || !hash(expected)) return false;
  const entry=path.join(payload,name),cacheKey=`${entry}\0${expected}`;
  const reject=()=>{cache?.delete(cacheKey);return false;};
  let fd;
  try {
    const named=fs.lstatSync(entry,{bigint:true}),real=fs.realpathSync(entry);
    if(!privatePayload(named) || !within(payload,real))return reject();
    fd=fs.openSync(entry,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    const before=fs.fstatSync(fd,{bigint:true}),signature=fileSignature(before);
    if(!privatePayload(before) || signature!==fileSignature(named))return reject();
    const previous=cache?.get(cacheKey);
    const actual=previous?.signature===signature?previous.digest:digest(fs.readFileSync(fd));
    const after=fs.fstatSync(fd,{bigint:true}),latest=fs.lstatSync(entry,{bigint:true});
    if(!privatePayload(after) || !privatePayload(latest) || fileSignature(after)!==signature
        || fileSignature(latest)!==signature || fs.realpathSync(entry)!==real)return reject();
    if(cache){
      cache.delete(cacheKey);cache.set(cacheKey,{signature,digest:actual});
      while(cache.size>32)cache.delete(cache.keys().next().value);
    }
    return actual===expected;
  } catch {cache?.delete(cacheKey);return false;}
  finally {if(fd!==undefined)fs.closeSync(fd);}
}

// This only changes health diagnostics. Unknown attachment delivery remains
// unknown; no request, receipt, notification or retry state is ever updated.
// The injected resolver is synchronous and must read current private source
// and final-reply evidence on every call, never a cached inbox projection.
export function isHistoricalFileFailure({ state: s, key, dir, binding, now, resolveSource, payloadDigestCache }) {
  try {
    if (!s || s.status !== 'blocked' || s.blocked !== true || s.retryAt !== null
        || s.error !== 'attachment_delivery_uncertain_expired' || s.noticeSent !== true
        || s.noticeRetry && Object.keys(s.noticeRetry).length !== 0
        || s.completedAt !== undefined || !finiteTime(s.createdAt, now)
        || !Number.isInteger(s.attempts) || s.attempts < 1
        || !hash(key) || s.key !== key || !hash(s.hash)
        || !['file', 'image', 'audio', 'video'].includes(s.mode)
        || typeof s.name !== 'string' || !s.name || path.basename(s.name) !== s.name
        || !/^om_[A-Za-z0-9_-]+$/.test(s.jobId ?? '') || s.jobId.startsWith('om_cb_')) return false;
    const snapshot = bindingSnapshot(binding), scope = digest(JSON.stringify(snapshot));
    const origin = { bot: binding.bot, chatId: binding.chat_id, senderId: binding.allowed_sender_id, profile: binding.profile ?? '' };
    if (!same(s.origin, origin) || s.deliveryVersion !== 2 || s.bindingScope !== scope) return false;
    const intent = s.sendIntent, route = intent?.route;
    if (intent?.schema !== 1 || intent.scope !== scope || intent.uncertain !== true || intent.sent !== undefined
        || intent.messageId !== undefined || intent.uuid !== key.slice(0, 32)
        || !finiteTime(intent.uncertainSince, now) || now - intent.uncertainSince < 55 * 60 * 1000
        || intent.payloadHash !== digest(JSON.stringify([s.key, s.mode, s.name, s.hash, s.coverName ?? null, s.coverHash ?? null]))
        || route?.version !== 1 || route.scope !== scope || route.chatId !== binding.chat_id
        || !['chat', 'quote', 'thread'].includes(route.mode)
        || route.mode !== 'chat' && route.messageId !== s.jobId) return false;
    const job = typeof resolveSource === 'function' ? resolveSource(s.jobId) : null;
    if (!job || job.id !== s.jobId || job.id !== (job.event?.message_id ?? job.event?.id)
        || job.event?.synthetic_callback || job.event?.sender_type !== 'user'
        || !isAuthorizedMessage(binding, job.event) || !isBoundJob(binding, job)
        || !same(job.event.bridge_binding, snapshot) || job.markerSeen !== true
        || job.feedbackDisposition !== 'actionable' || job.completionDisposition === 'silent'
        || job.unclassifiedTurnEnded || job.localReply || job.status !== 'done'
        || job.taskResultPending || job.replyRetry || job.replyCardRetry || job.taskResultReadError
        || !finiteTime(job.completedAt, now) || !hash(job.replyKey)) return false;
    const proof=job.finalDeliveryEvidence;
    if(proof?.schema!==1 || !Number.isInteger(proof.at) || !finiteTime(proof.at,now)
        || !['send_response','create_response','reconciled_observation'].includes(proof.source)
        || job.completedAt<proof.at)return false;
    if (s.generatedReport !== undefined) {
      if (!hash(s.generatedReport) || s.generatedReport !== digest(job.replyKey) || s.mode !== 'file'
          || !['answer.md', 'report.html'].includes(s.name)
          || key !== digest(`generated-report\0${binding.bot}\0${job.replyKey}\0${s.name}\0${s.hash}`)) return false;
    } else if (key !== digest(`${s.jobId}\0${s.mode}\0${s.name}\0${s.hash}\0${s.mode === 'video' ? s.coverHash : ''}`)) return false;
    if(!fs.lstatSync(path.join(dir,'payload')).isDirectory())return false;
    const realDir = fs.realpathSync(dir), payload = fs.realpathSync(path.join(dir, 'payload'));
    if (!within(realDir, payload)) return false;
    const verify = (name, expected) => payloadMatches(payload,name,expected,payloadDigestCache);
    return verify(s.name, s.hash) && (s.mode !== 'video' || verify(s.coverName, s.coverHash));
  } catch { return false; }
}
