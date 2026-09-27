import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { authorizedFileJob, within } from './codex-bridge-files.mjs';
import { reportPolicy } from './codex-bridge-report.mjs';
import { sanitizeFeishuReply } from './codex-bridge-sanitize.mjs';
import { bindingSnapshot, isBoundJob } from './codex-bridge-ux.mjs';
import { classifyFailure, retryDelay } from './codex-bridge-retry.mjs';
import { normalizeCloudMarkdown } from './codex-bridge-cloud-markdown.mjs';
import { presentCloudDoc, CLOUD_DOC_PRESENTATION_VERSION } from './codex-bridge-cloud-presentation.mjs';

export const CLOUD_DOC_POLICY = Object.freeze({ maxSourceBytes: 512 * 1024, maxBlocks: 5000, batchBlocks: 1000,
  maxBatchBytes: 1024 * 1024, maxAttempts: 5 });
export const CLOUD_DOC_SCOPES = Object.freeze(['docx:document:create', 'docx:document.block:convert',
  'docx:document:write_only', 'docs:permission.setting:read', 'docs:permission.setting:write_only',
  'docs:permission.member:retrieve', 'docs:permission.member:create', 'drive:drive.metadata:readonly']);
const fail = code => Object.assign(Error(code), { code, permanent: true });
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const idKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const openId = value => typeof value === 'string' && /^ou_[A-Za-z0-9_-]+$/.test(value);
const allowedTypes = new Set([2,3,4,5,6,7,8,9,10,11,12,13,14,15,17,19,22,31,32,34]);
const privacy = Object.freeze({ external_access_entity:'closed', link_share_entity:'closed',
  manage_collaborator_entity:'collaborator_full_access', comment_entity:'anyone_can_view' });
const permissionCodes = new Set(['99991672','99991668','1770032','1770040','1063002','1063004']);
const rejectedCreateCodes = new Set(['1770001','1770039','1770040','1770032','1770036','1770037','99991672','99991668','99991400']);
const fixedError = error => {
  const code = String(error?.apiCode ?? error?.code ?? '');
  return /^\d{1,12}$/.test(code) || /^(?:ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|INVALID_RESPONSE)$/.test(code)
    || /^cloud_doc_[a-z_]{1,60}$/.test(code) ? code : 'cloud_doc_request_failed';
};

function safeHttpUrl(value) {
  try { const u = new URL(value); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; }
  catch { return null; }
}
function documentUrl(value, documentId) {
  const safe = safeHttpUrl(value); if (!safe) return null;
  const u = new URL(safe);
  return u.protocol === 'https:' && /(?:^|\.)(?:feishu\.cn|larksuite\.com)$/i.test(u.hostname)
    && u.pathname === `/docx/${documentId}` && !u.search && !u.hash ? u.href : null;
}

// Use the official converter's tree, not a hand-written Markdown renderer.
// Each complete top-level subtree remains in one request; a table is never split.
export function cloudDocBatches(converted) {
  const roots = converted?.first_level_block_ids, blocks = converted?.blocks;
  if (!Array.isArray(roots) || !roots.length || !Array.isArray(blocks) || !blocks.length
      || blocks.length > CLOUD_DOC_POLICY.maxBlocks) throw fail('cloud_doc_invalid_conversion');
  const imageUrls = new Map((converted.block_id_to_image_urls ?? []).map(x => [x.block_id,x.image_url]));
  const byId = new Map(); let imageCount = 0;
  for (const original of blocks) {
    if (!token(original?.block_id) || byId.has(original.block_id)) throw fail('cloud_doc_invalid_conversion');
    const b = structuredClone(original); delete b.parent_id; delete b.revision_id;
    if (b.block_type === 27) {
      const url = safeHttpUrl(imageUrls.get(b.block_id)); imageCount++;
      byId.set(b.block_id, { block_id:b.block_id, block_type:2, text:{ elements:[{text_run:{content:
        url ? `图片来源：${url}（原图请查看原始附件）` : '图片请查看原始附件或 HTML/Markdown 报告。'}}] } });
      continue;
    }
    if (!allowedTypes.has(b.block_type)) throw fail('cloud_doc_unsupported_block');
    if (b.table) { delete b.table.cells; delete b.table.merge_info; if (b.table.property) delete b.table.property.merge_info; }
    // Markdown must not manufacture user notifications or external resource embeds.
    for (const value of Object.values(b)) if (value && Array.isArray(value.elements)) {
      value.elements = value.elements.map(e => {
        if (e.mention_user || e.reminder || e.file || e.inline_block || e.undefined) throw fail('cloud_doc_unsupported_inline');
        const clean = structuredClone(e);
        for (const item of Object.values(clean)) if (item && typeof item === 'object') delete item.comment_ids;
        return clean;
      });
    }
    if (b.children !== undefined && (!Array.isArray(b.children) || b.children.some(x => !token(x)))) throw fail('cloud_doc_invalid_conversion');
    byId.set(b.block_id,b);
  }
  const seen = new Set(), batches = []; let current = {children_id:[], descendants:[], index:-1};
  const collect = (id, depth=0) => {
    if (depth > 32 || seen.has(id) || !byId.has(id)) throw fail('cloud_doc_invalid_conversion');
    seen.add(id); const b = byId.get(id);
    return [b,...(b.children ?? []).flatMap(child => collect(child,depth+1))];
  };
  for (const id of roots) {
    const subtree = collect(id);
    if (subtree.length > CLOUD_DOC_POLICY.batchBlocks || Buffer.byteLength(JSON.stringify(subtree)) > CLOUD_DOC_POLICY.maxBatchBytes)
      throw fail('cloud_doc_subtree_too_large');
    const candidate = {children_id:[...current.children_id,id],descendants:[...current.descendants,...subtree],index:-1};
    if (current.children_id.length && (candidate.descendants.length > CLOUD_DOC_POLICY.batchBlocks
      || Buffer.byteLength(JSON.stringify(candidate)) > CLOUD_DOC_POLICY.maxBatchBytes)) {
      batches.push(current); current={children_id:[id],descendants:subtree,index:-1};
    } else current=candidate;
  }
  if (seen.size !== byId.size) throw fail('cloud_doc_orphan_conversion');
  batches.push(current); return {batches,imageCount};
}

// Private durable state only. The caller continues to enqueue/deliver original
// HTML/Markdown attachments and final answers independently of this outbox.
export class CloudDocOutbox {
  constructor({root,inboxRoot,binding,request,resolveAppId,notify,now=Date.now}) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(binding.bot ?? '')) throw fail('cloud_doc_invalid_binding');
    Object.assign(this,{root,inboxRoot,binding,request,resolveAppId,notify,now});
    this.origin=bindingSnapshot(binding); this.scope=digest(JSON.stringify(this.origin));
    this.enabled=binding.cloud_docs !== false && binding.cloud_docs?.enabled !== false;
    this.dir=path.join(root,binding.bot); fs.mkdirSync(this.dir,{recursive:true});
    if (!within(fs.realpathSync(root),fs.realpathSync(this.dir))) throw fail('cloud_doc_outside_root');
    this.rows=new Map(); this.corrupt=0;
    for (const name of fs.readdirSync(this.dir).filter(n=>/^doc-[a-f0-9]{64}\.json$/.test(n))) {
      try {
        const file=path.join(this.dir,name);
        if (!within(fs.realpathSync(this.dir),fs.realpathSync(file))) throw fail('cloud_doc_outside_root');
        const s=JSON.parse(fs.readFileSync(file,'utf8'));
        if (s.scope!==this.scope) continue;
        if (s.schema!==1 || !idKey(s.key) || !idKey(s.replyKey) || name!==`doc-${s.key}.json`
            || s.key!==this.key(s.replyKey)) throw fail('cloud_doc_invalid_state');
        this.rows.set(s.replyKey,s);
      } catch { this.corrupt++; }
    }
  }
  key(replyKey) { return digest(`${this.scope}\0${replyKey}`); }
  save(s) { atomicWriteJson(path.join(this.dir,`doc-${s.key}.json`),s); }
  job(s) {
    const j=authorizedFileJob(this.inboxRoot,this.binding,s.jobId,s.replyKey);
    if (!isBoundJob(this.binding,j)) throw fail('cloud_doc_binding_mismatch');
    if (s.answerHash && typeof j.reply==='string' && digest(sanitizeFeishuReply(j.reply).trim())!==s.answerHash)
      throw fail('cloud_doc_final_changed');
    return j;
  }
  enqueue({jobId,replyKey,text,force=false}) {
    if (!this.enabled) return {status:'disabled'};
    if (this.corrupt) throw fail('cloud_doc_state_corrupt');
    const j=this.job({jobId,replyKey}), existing=this.rows.get(replyKey);
    if (existing) {
      if (existing.answerHash!==digest(text)) throw fail('cloud_doc_final_changed');
      return this.result(replyKey);
    }
    if (typeof j.reply!=='string' || sanitizeFeishuReply(j.reply).trim()!==text) throw fail('cloud_doc_final_not_authorized');
    const policy=reportPolicy(text,{force});
    if (!policy.generate) return {status:'skipped',reason:policy.reason};
    const settings=this.binding.cloud_docs ?? {};
    if (settings.folder_token && !token(settings.folder_token)) throw fail('cloud_doc_invalid_folder');
    if (!openId(this.binding.allowed_sender_id)) throw fail('cloud_doc_invalid_recipient');
    const key=this.key(replyKey), s={schema:1,key,scope:this.scope,origin:this.origin,jobId,replyKey,
      answerHash:digest(text),text,createdAt:this.now(),title:`完整答复报告 · ${key.slice(0,8)}`,
      folderToken:settings.folder_token ?? '',status:'queued',phase:'convert',batch:0,attempts:0};
    if (Buffer.byteLength(text)>CLOUD_DOC_POLICY.maxSourceBytes) {
      s.status='blocked';s.error='cloud_doc_size_limit';delete s.text;
    }
    this.save(s);this.rows.set(replyKey,s);return this.result(replyKey);
  }
  result(replyKey) {
    const s=this.rows.get(replyKey); if (!s) return {status:this.enabled?'missing':'disabled'};
    return {replyKey:s.replyKey,jobId:s.jobId,title:s.title,status:s.status,phase:s.phase,error:s.error,
      ...(s.status==='ready'?{url:s.url,imageCount:s.imageCount??0}:{}),noticeSent:Boolean(s.noticeSent)};
  }
  retry(replyKey) {
    const s=this.rows.get(replyKey);
    if (!this.enabled || this.corrupt || !s || s.status!=='blocked') return false;
    this.job(s);
    // No reset can turn an ambiguous, non-idempotent create into a second one.
    if (s.createPending || s.error==='cloud_doc_create_uncertain' || s.error==='cloud_doc_size_limit') return false;
    s.status='queued';s.attempts=0;delete s.retryAt;delete s.error;delete s.noticeSent;delete s.noticeRetryAt;
    this.save(s);return true;
  }
  stats() {
    const rows=[...this.rows.values()];
    return {cloud_doc_pending_count:rows.filter(s=>s.status==='queued').length,
      cloud_doc_failed_count:this.corrupt+rows.filter(s=>s.status==='blocked').length,
      cloud_doc_ready_count:rows.filter(s=>s.status==='ready').length,
      cloud_doc_last_error:rows.filter(s=>s.error).at(-1)?.error??(this.corrupt?'cloud_doc_state_corrupt':null)};
  }
  api(method,endpoint,params,data) {
    return this.request(this.binding,['api',method,endpoint,...(params?['--params',JSON.stringify(params)]:[]),
      ...(data?['--data',JSON.stringify(data)]:[])]);
  }
  async ownOpenId() {
    if (!this.botOpenId) {
      const data=await this.api('GET','/open-apis/bot/v3/info');
      if (!openId(data?.bot?.open_id)) throw fail('cloud_doc_bot_identity_unavailable');
      this.botOpenId=data.bot.open_id;
    }
    return this.botOpenId;
  }
  async members(s) {
    const data=await this.api('GET',`/open-apis/drive/v1/permissions/${s.documentId}/members`,{type:'docx'});
    if (!Array.isArray(data.items)) throw fail('cloud_doc_members_unverified');
    const own=await this.ownOpenId();
    // Live Drive responses include the owning app as `appid`, although older
    // member-list schemas omit that enum. Match the selected profile exactly.
    if (data.items.some(m=>m.member_type==='appid') && !this.appId) {
      const id=await this.resolveAppId?.();
      if (!/^cli_[A-Za-z0-9]+$/.test(id??'')) throw fail('cloud_doc_app_identity_unavailable');
      this.appId=id;
    }
    if (data.items.some(m=> !(m.member_type==='openid' && [own,this.binding.allowed_sender_id].includes(m.member_id))
      && !(m.member_type==='appid' && m.member_id===this.appId)))
      throw fail('cloud_doc_unexpected_collaborator');
    return data.items;
  }
  async verifyPrivacy(s) {
    const data=await this.api('GET',`/open-apis/drive/v2/permissions/${s.documentId}/public`,{type:'docx'});
    if (Object.entries(privacy).some(([k,v])=>data.permission_public?.[k]!==v)) throw fail('cloud_doc_privacy_unverified');
    return this.members(s);
  }
  flush() {
    if (!this.flushing) this.flushing=this.flushOnce().finally(()=>{this.flushing=null;});
    return this.flushing;
  }
  async flushOnce() {
    if (!this.enabled || this.corrupt) return;
    for (const s of this.rows.values()) {
      if (s.status==='queued' && (s.retryAt??0)<=this.now()) {
        try { this.job(s); await this.advance(s); }
        catch (error) {
          s.error=fixedError(error); s.attempts=(s.attempts??0)+1;
          const code=String(error?.apiCode??error?.code??'');
          if (s.createPending) {s.status='blocked';s.error='cloud_doc_create_uncertain';}
          else if (classifyFailure(error).kind==='permanent' || permissionCodes.has(code)
            || /^(?:17700|10630)/.test(code) && !['1770036','1063006'].includes(code)
            || s.attempts>=CLOUD_DOC_POLICY.maxAttempts) s.status='blocked';
          else s.retryAt=this.now()+Math.max(3000,retryDelay(s.attempts,error.retryAfterMs));
          this.save(s);
        }
      }
      if (['ready','blocked'].includes(s.status) && !s.noticeSent && this.notify && (s.noticeRetryAt??0)<=this.now()) {
        // Never race the authoritative final answer or notify a rebound session.
        let job; try { job=this.job(s); } catch { continue; }
        if (job.status!=='done') continue;
        const value=this.result(s.replyKey);
        const text=s.status==='ready' ? `完整报告已生成飞书云文档：[打开完整报告](${s.url})。HTML 和 Markdown 原文仍保留。`
          : '飞书云文档生成未完成，已保留 HTML 和 Markdown 原文；请查看报告附件。';
        try { await this.notify(text,`cloud-doc:${s.key}:${s.status}`,value);s.noticeSent=true;this.save(s); }
        catch { s.noticeRetryAt=this.now()+30000;this.save(s); }
      }
    }
  }
  async advance(s) {
    if (s.phase==='convert') {
      const converted=await this.api('POST','/open-apis/docx/v1/documents/blocks/convert',{user_id_type:'open_id'},
        {content_type:'markdown',content:normalizeCloudMarkdown(s.text)});
      // Persist the exact styled payload before any remote creation. Pending
      // writes from older versions keep their saved batches and idempotency key.
      Object.assign(s,cloudDocBatches(presentCloudDoc(converted)),{presentationVersion:CLOUD_DOC_PRESENTATION_VERSION});
      delete s.text;s.phase='create';this.save(s);
    }
    if (s.phase==='create') {
      if (s.createPending) throw fail('cloud_doc_create_uncertain');
      s.createPending=true;this.save(s); // Native create has no idempotency token.
      let data;
      try { data=await this.api('POST','/open-apis/docx/v1/documents',null,
        {title:s.title,...(s.folderToken?{folder_token:s.folderToken}:{})}); }
      catch (error) {
        if (rejectedCreateCodes.has(String(error?.apiCode??error?.code??''))) {s.createPending=false;this.save(s);}
        throw error;
      }
      if (!token(data?.document?.document_id) || !Number.isInteger(data.document.revision_id) || data.document.revision_id<1)
        throw fail('cloud_doc_create_response_unverified');
      s.documentId=data.document.document_id;s.revision=data.document.revision_id;
      s.createPending=false;s.phase='restrict';this.save(s); // Save before further remote mutation.
    }
    if (s.phase==='restrict') {
      await this.api('PATCH',`/open-apis/drive/v2/permissions/${s.documentId}/public`,{type:'docx'},privacy);
      await this.verifyPrivacy(s);s.phase='write';this.save(s);
    }
    if (s.phase==='write') {
      // Recheck after restart/retry; folder inheritance or user edits must not
      // make private report contents readable to unapproved collaborators.
      await this.verifyPrivacy(s);
      while (s.batch<s.batches.length) {
        const body=s.batches[s.batch];
        s.pendingWrite??={clientToken:randomUUID(),revision:s.revision,batch:s.batch};this.save(s);
        const data=await this.api('POST',`/open-apis/docx/v1/documents/${s.documentId}/blocks/${s.documentId}/descendant`,
          {document_revision_id:s.pendingWrite.revision,client_token:s.pendingWrite.clientToken,user_id_type:'open_id'},body);
        const mappings=new Map((data.block_id_relations??[]).map(x=>[x.temporary_block_id,x.block_id]));
        if (body.descendants.some(b=>!token(mappings.get(b.block_id))) || !Number.isInteger(data.document_revision_id)
          || data.document_revision_id<s.revision) throw fail('cloud_doc_write_unverified');
        s.revision=data.document_revision_id;s.batch++;delete s.pendingWrite;this.save(s);
      }
      s.phase='share';this.save(s);
    }
    if (s.phase==='share') {
      const members=await this.verifyPrivacy(s);
      const hasReader=members.some(m=>m.member_id===this.binding.allowed_sender_id && ['view','edit','full_access'].includes(m.perm));
      if (!hasReader) {
        const data=await this.api('POST',`/open-apis/drive/v1/permissions/${s.documentId}/members`,{type:'docx',need_notification:false},
          {member_type:'openid',member_id:this.binding.allowed_sender_id,perm:'view',type:'user'});
        if (data.member?.member_type!=='openid' || data.member.member_id!==this.binding.allowed_sender_id || data.member.perm!=='view')
          throw fail('cloud_doc_share_unverified');
      }
      const after=await this.members(s);
      if (!after.some(m=>m.member_id===this.binding.allowed_sender_id && ['view','edit','full_access'].includes(m.perm)))
        throw fail('cloud_doc_access_unverified');
      s.accessVerifiedAt=this.now();s.phase='url';this.save(s);
    }
    if (s.phase==='url') {
      const data=await this.api('POST','/open-apis/drive/v1/metas/batch_query',{user_id_type:'open_id'},
        {request_docs:[{doc_token:s.documentId,doc_type:'docx'}],with_url:true});
      const meta=data.metas?.find(x=>x.doc_token===s.documentId);
      const url=documentUrl(meta?.url,s.documentId);
      if (!url) throw fail('cloud_doc_url_unverified');
      s.url=url;s.status='ready';s.phase='complete';s.completedAt=this.now();delete s.error;delete s.retryAt;
      // Keep immutable source hashes and durable IDs; blocks are no longer needed.
      delete s.batches;this.save(s);
    }
  }
}
