import fs from 'node:fs';
import path from 'node:path';
import { digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { sanitizeFeishuReply } from './codex-bridge-sanitize.mjs';
import { classifyFailure, recordFailure } from './codex-bridge-retry.mjs';
import { updateStreamCard, streamCard } from './codex-bridge-cardkit.mjs';
import { publicPhase } from './codex-bridge-ux.mjs';

export function splitText(text, maxBytes = 12000) {
  const parts = []; let part = '', bytes = 0;
  for (const char of String(text)) {
    const n = Buffer.byteLength(char);
    if (bytes + n > maxBytes) { parts.push(part); part = ''; bytes = 0; }
    part += char; bytes += n;
  }
  if (part) parts.push(part);
  return parts;
}

export function makeCard(text, final = false) {
  return { config: { wide_screen_mode: true, update_multi: true },
    header: { template: final ? 'green' : 'blue', title: { tag: 'plain_text', content: final ? '处理完成' : '正在处理' } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: text || '正在处理…' } }] };
}

// One serialized output lane per bot. Full snapshots coalesce; latest state is
// durable before network I/O. The final flush cannot be overwritten by old progress.
export class DurableOutbound {
  constructor(root, binding, request, { now = Date.now, minIntervalMs = 10000, presentationEnabled = false, onCardMessage, sendMessage } = {}) {
    this.root = path.join(root, binding.bot); this.binding = binding; this.request = request;
    this.now = now; this.minIntervalMs = minIntervalMs; this.tail = Promise.resolve();
    this.presentationEnabled = presentationEnabled; this.onCardMessage = onCardMessage;
    this.sendMessage=sendMessage;
    fs.mkdirSync(this.root, { recursive: true });
  }
  file(kind, key) { return path.join(this.root, `${kind}-${digest(key)}.json`); }
  read(file, fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  serial(fn) { const p = this.tail.then(fn); this.tail = p.catch(() => {}); return p; }
  async text(text, key, route) {
    return this.serial(async () => {
      const file = this.file('text', key);
      const state = this.read(file, { parts: splitText(sanitizeFeishuReply(text).trim() || '本次没有可发送的正文。'), next: 0, ...(route?{route}:{}) });
      // Older journals can already have a native ACK while next is unchanged.
      // Without an attempt checkpoint, recovery cannot prove a fresh response.
      let legacyRecovery=fs.existsSync(file) && state.partSubmitted===undefined && state.finalDeliveryEvidence===undefined;
      if (!fs.existsSync(file)) atomicWriteJson(file, state);
      for (; state.next < state.parts.length;) {
        const timingSource=legacyRecovery || state.partSubmitted?.index===state.next?'reconciled_observation':'send_response';
        state.partSubmitted={index:state.next,at:this.now()};atomicWriteJson(file,state);
        const result = state.route && this.sendMessage
          ? await this.sendMessage({key:`text:${key}:${state.next}`,route:state.route,msgType:'text',content:{text:state.parts[state.next]}})
          : await this.request(this.binding, ['im', '+messages-send', '--chat-id', this.binding.chat_id,
            '--text', state.parts[state.next], '--idempotency-key', digest(`${key}:${state.next}`).slice(0, 32)]);
        state.next++; state.lastMessageId = result?.message_id;
        state.finalDeliveryEvidence={schema:1,at:this.now(),source:timingSource};delete state.partSubmitted;atomicWriteJson(file, state);
        legacyRecovery=false;
      }
    });
  }
  async notice(text, key, {streamKey, route, terminal=false, jobId} = {}) {
    const clean=sanitizeFeishuReply(text).trim();
    const handled=await this.serial(async()=>{
      const receipt=this.file('notice',key);
      if(this.read(receipt)?.delivered)return true;
      const file=streamKey && this.file('card',streamKey),s=file && this.read(file);
      if(!s)return false;
      // A business answer owns the card once its final intent is committed.
      // Same-warning retries may close a fault card only before that handoff.
      if(s.finalDelivered || s.finalReplyKey || s.finalClosedReplyKey
          || ((s.final || s.cardClosed) && s.noticeKey!==key))return true;
      if(s.noticeKey!==key) {
        s.noticeKey=key;s.text=clean;s.revision++;
        s.jobId??=jobId;
        s.presentation={...s.presentation,status:terminal?'error':'working',interactions:[]};
        delete s.presentation.actionContext;delete s.presentation.nativeContext;
        if(terminal)s.final=true;
        atomicWriteJson(file,s);
      }
      try { await this.updateCard(file,s,terminal); }
      catch(error) {
        const latest=this.read(file,s);
        // A definite rejection of an existing-card patch can use a safe text
        // warning. Unknown creation/delivery must keep its original route/key.
        if(error.deliveryUncertain || !latest.messageId || classifyFailure(error).kind!=='permanent')throw error;
        recordFailure(latest,error,this.now());latest.noticeCardFailed=true;atomicWriteJson(file,latest);
        return false;
      }
      // This receipt acknowledges only the bridge warning, never a business
      // answer. The inbox stays failed, or watched for a late final on timeout.
      atomicWriteJson(receipt,{delivered:true,deliveredAt:this.now(),terminal});
      return true;
    });
    if(!handled)await this.text(clean,key,route);
  }
  progress(text, key, route, metadata = {}) {
    const file = this.file('card', key);
    const s = this.read(file, { key, revision: 0, ...(route?{route}:{}) });
    if (s.final) return;
    // Replayed initial intents cannot regress a newer snapshot after a crash.
    if(metadata.initialFeedback && s.revision>0)return;
    if(metadata.jobId)s.jobId??=metadata.jobId;
    if(metadata.initialFeedback)s.initialFeedback=true;
    const positioned=Number.isSafeInteger(metadata.position) && metadata.position>=0;
    if(positioned && metadata.position<=(s.progressPosition??-1))return;
    const clean = sanitizeFeishuReply(text).trim();
    if (!clean || (!positioned && s.text === clean)) return;
    if (this.presentationEnabled) {
      const at=Number.isFinite(metadata.at) && metadata.at>=0?metadata.at:null;
      const observedAt=Number.isFinite(metadata.observedAt)?metadata.observedAt:this.now();
      const history = [...(s.presentation?.publicProgress ?? []), {channel:'commentary', text:splitText(clean,4000)[0],at,observedAt}].slice(-6);
      s.presentation = {...s.presentation, status:publicPhase(clean), publicProgress:history};
    }
    if(positioned)s.progressPosition=metadata.position;
    s.text = splitText(clean, 16000)[0];
    if(s.presentation) {
      // Full-card updates include sources and history. Budget their actual JSON,
      // not only the answer string, before a validation failure blocks the lane.
      while(Buffer.byteLength(JSON.stringify(streamCard(s.text,false,s.presentation)))>26000) {
        if(s.presentation.publicProgress.length) s.presentation.publicProgress.shift();
        else {
          const limit=Math.max(256,Math.floor(Buffer.byteLength(s.text)/2));
          s.text=splitText(s.text,limit)[0]+'\n…（本次进度已缩短，最终答复不受影响）';
          if(limit===256)break;
        }
      }
    }
    s.revision++; atomicWriteJson(file, s);
  }
  async flushCards() {
    for (const name of fs.readdirSync(this.root).filter(n => /^card-[a-f0-9]+\.json$/.test(n))) {
      await this.serial(async () => {
        const file = path.join(this.root, name), s = this.read(file);
        if (s.final || s.blocked || s.sentRevision === s.revision || (s.retryAt ?? 0) > this.now()
            || (s.lastSentAt && this.now() - s.lastSentAt < this.minIntervalMs)) return;
        try { await this.updateCard(file, s, false); }
        catch (error) {
          // Merge failures with progress that may have arrived during network I/O.
          const latest = this.read(file); recordFailure(latest, error, this.now());
          if(error.deliveryUncertain)latest.deliveryUncertain=true;
          atomicWriteJson(file, latest);
        }
      });
    }
  }
  async updateCard(file, s, final) {
    if(this.binding.cardkit_enabled!==false && !s.cardkitDisabled){
      try {
        const result=await updateStreamCard({file,s,final,binding:this.binding,request:this.request,now:this.now,onMessage:this.onCardMessage,sendMessage:this.sendMessage});
        const latest=this.read(file,s);if(latest.deliveryUncertain){delete latest.deliveryUncertain;atomicWriteJson(file,latest);}return result;
      }
      catch(error){
        const latest=this.read(file,s);
        // Only fall back before a visible CardKit message exists. Never send a
        // second progress card after uncertain delivery of the first one.
        if(error.deliveryUncertain || classifyFailure(error).kind!=='permanent' || latest.messageId || latest.cardId)throw error;
        latest.cardkitDisabled=true;latest.cardkitFallbackCode=String(error.apiCode??error.code??'permission_or_validation');
        atomicWriteJson(file,latest);Object.assign(s,latest);
      }
    }
    const card = s.presentation ? streamCard(s.text, final, s.presentation) : makeCard(s.text, final);
    // Bind an existing card before exposing actionable controls. On the first
    // raw-card send, create a non-actionable shell and only then patch controls.
    if (s.messageId) await this.onCardMessage?.(s.messageId,s.presentation,s);
    const before=this.read(file,s),timingSource=before.rawCardAttempt?.revision===s.revision?'reconciled_observation':'send_response';
    before.rawCardAttempt={revision:s.revision,at:this.now()};atomicWriteJson(file,before);
    if (s.messageId) {
      await this.request(this.binding, ['api', 'PATCH', `/open-apis/im/v1/messages/${s.messageId}`,
        '--data', JSON.stringify({ content: JSON.stringify(card) })]);
    } else {
      const shellRequired=Boolean(s.route && this.sendMessage || s.presentation?.actionContext || s.presentation?.nativeContext);
      const content=JSON.stringify(shellRequired ? streamCard(s.initialFeedback?'正在处理…':'正在准备结果…',false) : card);
      const result = s.route && this.sendMessage
        ? await this.sendMessage({key:`card:${s.key}`,route:s.route,msgType:'interactive',content})
        : await this.request(this.binding, ['api', 'POST', '/open-apis/im/v1/messages',
        '--params', JSON.stringify({ receive_id_type: 'chat_id' }), '--data', JSON.stringify({ receive_id: this.binding.chat_id,
          msg_type: 'interactive', content, uuid: digest(`card:${s.key}`).slice(0, 32) })]);
      if (!/^om_[A-Za-z0-9_-]+$/.test(result?.message_id ?? '')) throw new Error('card_message_id_missing');
      s.messageId = result.message_id;
      // Persist before exposing controls, including across an uncertain patch.
      const created=this.read(file,s);created.messageId=s.messageId;created.firstCardSentAt??=this.now();created.firstCardTimingSource??='send_response';atomicWriteJson(file,created);
      await this.onCardMessage?.(s.messageId,s.presentation,created);
      if(shellRequired) await this.request(this.binding,['api','PATCH',`/open-apis/im/v1/messages/${s.messageId}`,
        '--data',JSON.stringify({content:JSON.stringify(card)})]);
    }
    const latest = this.read(file, s);
    Object.assign(latest, { messageId: s.messageId, sentRevision: s.revision, lastSentAt: this.now(), attempts: 0, retryAt: 0 });
    latest.lastAppliedEvidence={schema:1,at:latest.lastSentAt,source:timingSource,revision:s.revision};delete latest.rawCardAttempt;
    delete latest.deliveryUncertain;
    if (final) latest.final = true;
    atomicWriteJson(file, latest);
  }
  async final(text, replyKey, streamKeys = [], presentation) {
    if(presentation?.taskResult)return this.taskFinal(text,replyKey,streamKeys,presentation);
    const clean = sanitizeFeishuReply(text).trim() || '本次没有可发送的正文。';
    const replyFile=this.file('reply',replyKey);
    if(this.replyDelivered(replyKey)) {
      if(!fs.existsSync(replyFile))atomicWriteJson(replyFile,{deliveredAt:this.now(),status:this.replyStatus(replyKey),finalDeliveryEvidence:this.replyDeliveryEvidence(replyKey)});
      await this.closeReplyCards(replyKey,streamKeys);return this.replyDeliveryEvidence(replyKey);
    }
    let delivered = false;
    let keys=[...new Set(streamKeys)];
    const route=presentation?.replyRoute;
    // If steering merged formerly separate native topics after progress was
    // already visible, close those progress cards and send one final in chat.
    if(route?.reason==='mixed_topics' && keys.some(key=>this.read(this.file('card',key),{}).route?.mode==='thread')) {
      for(const key of keys)await this.serial(async()=>{
        const file=this.file('card',key),s=this.read(file);if(!s || s.finalDelivered)return;
        s.final=true;s.text='本轮包含不同话题，合并答复见主聊天。';s.presentation={status:'complete'};s.revision++;
        atomicWriteJson(file,s);
        if(s.messageId)try{await this.updateCard(file,s,true);}catch{}
      });
      keys=[];
    }
    if(!keys.length && this.presentationEnabled) keys.push(`reply:${replyKey}`);
    for (const key of keys) {
      await this.serial(async () => {
        const file = this.file('card', key), s = this.read(file, { key, revision:0, ...(route?{route}:{}) });
        if (s.finalReplyKey === replyKey && s.finalDelivered) { delivered = true; return; }
        if(s.blocked && s.deliveryUncertain)throw Object.assign(Error('card_delivery_uncertain'),{permanent:true,deliveryUncertain:true});
        const sameFrozenAnswer=s.final===true && s.finalReplyKey===replyKey && s.text===clean && !delivered;
        // Freeze the card before awaiting: queued progress must not regress it.
        s.final = true; s.finalReplyKey = replyKey;
        if(presentation) s.presentation={...s.presentation,...presentation};
        if(this.presentationEnabled) s.presentation={...s.presentation,status:presentation?.status??'complete'};
        if((delivered || key!==keys[0]) && s.presentation) {
          s.presentation={...s.presentation,interactions:[]};delete s.presentation.actionContext;delete s.presentation.nativeContext;
        }
        const cardBytes=()=>Buffer.byteLength(JSON.stringify(s.presentation ? streamCard(clean,true,s.presentation) : makeCard(clean, true)));
        while(s.presentation?.publicProgress?.length && cardBytes()>=28000) s.presentation.publicProgress.shift();
        const fits = cardBytes() < 28000;
        s.text = !delivered && fits ? clean : delivered ? '处理完成，完整答复已发送。' : '处理完成，完整答复见后续消息。';
        if(!sameFrozenAnswer)s.revision++; atomicWriteJson(file, s);
        try {
          if (!s.blocked) {
            await this.updateCard(file, s, true);
            if (!delivered && fits) {
              const latest = this.read(file); latest.finalDelivered = true;
              const proof=latest.lastAppliedEvidence;
              latest.finalDeliveryEvidence=proof?.revision===s.revision?{schema:1,at:proof.at,source:proof.source}:{schema:1,at:this.now(),source:'reconciled_observation'};
              atomicWriteJson(file, latest); delivered = true;
            }
          }
        } catch (error) {
          const latest = this.read(file); recordFailure(latest, error, this.now());
          if(error.deliveryUncertain)latest.deliveryUncertain=true;
          latest.finalCardFailed = true; atomicWriteJson(file, latest);
          if(error.deliveryUncertain)throw error;
          // Final text is authoritative; failed card patch falls back.
        }
      });
    }
    if (!delivered) await this.text(presentation?.fallbackText??clean, replyKey,route);
    const evidence=this.replyDeliveryEvidence(replyKey);
    atomicWriteJson(replyFile,{deliveredAt:this.now(),status:presentation?.status??'complete',finalDeliveryEvidence:evidence});return evidence;
  }
  // The model turn is not a business task. Structured task results own one
  // existing card, and each confirmed revision keeps its own immutable receipt.
  async taskFinal(text,replyKey,streamKeys,presentation) {
    const task=presentation.taskResult,keys=[...new Set(streamKeys)];
    const fail=code=>{throw Object.assign(Error(code),{permanent:true});};
    if(task.schema!==1 || !/^om_[A-Za-z0-9_-]+$/.test(task.ownerJobId??'')
        || !Number.isSafeInteger(task.revision) || task.revision<1 || typeof task.resultKey!=='string'
        || !['complete','waiting','failed','background'].includes(task.status)
        || task.updateKind!==undefined && task.updateKind!=='answer_revision' || keys.length!==1)
      fail('invalid_task_card_result');
    const clean=sanitizeFeishuReply(text).trim();if(!clean)fail('empty_task_card_result');
    return this.serial(async()=>{
      const file=this.file('card',keys[0]),s=this.read(file,{key:keys[0],revision:0,jobId:task.ownerJobId,...(presentation.replyRoute?{route:presentation.replyRoute}:{})});
      if(s.jobId && s.jobId!==task.ownerJobId)fail('task_card_owner_changed');
      if(s.taskResult && s.taskResult.ownerJobId!==task.ownerJobId)fail('task_card_owner_changed');
      const delivered=this.replyDelivered(replyKey),prior=s.taskResult;
      if(prior && task.revision<prior.revision) {
        if(delivered)return this.replyDeliveryEvidence(replyKey);
        fail('task_card_revision_stale');
      }
      if(prior && task.revision===prior.revision && (s.finalReplyKey!==replyKey || prior.resultKey!==task.resultKey
          || prior.status!==task.status || prior.updateKind!==task.updateKind || s.text!==clean))fail('task_card_result_changed');
      if(delivered)return this.replyDeliveryEvidence(replyKey);
      const same=prior?.revision===task.revision;
      if(!same) {
        if(prior) {
          if(task.revision!==prior.revision+1 || (!['waiting','background'].includes(prior.status)
              && !(prior.status==='complete' && task.updateKind==='answer_revision'))
              || !this.replyDelivered(s.finalReplyKey))fail('task_card_prior_unconfirmed');
        } else if(task.revision!==1 || s.finalReplyKey || s.finalDelivered || s.finalClosedReplyKey)
          fail('task_card_legacy_or_revision_changed');
        // Never let the preceding answer's proof acknowledge a new snapshot.
        for(const field of ['finalDelivered','finalDeliveryEvidence','finalClosedReplyKey','finalClosedAt','finalCardFailed',
          'blocked','retryAt','attempts','noticeKey','noticeCardFailed'])delete s[field];
        s.revision++;
      }
      if(s.blocked)throw Object.assign(Error('task_card_delivery_unconfirmed'),{permanent:true,deliveryUncertain:Boolean(s.deliveryUncertain)});
      s.jobId=task.ownerJobId;s.final=true;s.finalReplyKey=replyKey;s.taskResult={...task};s.text=clean;
      // A later business revision must not retain a former form, report link
      // or action context. Only this task's public progress history persists.
      s.presentation={...(s.presentation?.publicProgress?{publicProgress:s.presentation.publicProgress}:{}),
        ...(s.presentation?.taskTitle?{taskTitle:s.presentation.taskTitle}:{}),...presentation,taskResult:{...task}};
      atomicWriteJson(file,s);
      try {await this.updateCard(file,s,true);}
      catch(error) {
        const latest=this.read(file);recordFailure(latest,error,this.now());latest.finalCardFailed=true;
        if(error.deliveryUncertain)latest.deliveryUncertain=true;
        atomicWriteJson(file,latest);throw error;
      }
      const latest=this.read(file),proof=latest.lastAppliedEvidence;
      const evidence=proof?.revision===s.revision?{schema:1,at:proof.at,source:proof.source}
        :{schema:1,at:this.now(),source:'reconciled_observation'};
      latest.finalDelivered=true;latest.finalDeliveryEvidence=evidence;
      latest.finalClosedReplyKey=replyKey;latest.finalClosedAt=this.now();atomicWriteJson(file,latest);
      atomicWriteJson(this.file('reply',replyKey),{deliveredAt:this.now(),status:presentation.status??'complete',finalDeliveryEvidence:evidence});
      return evidence;
    });
  }
  async linkTaskCard(sourceKey,ownerKey,{jobId}={}) {
    if(!sourceKey || sourceKey===ownerKey)return;
    return this.serial(async()=>{
      const file=this.file('card',sourceKey),s=this.read(file);
      if(!s)return; // No extra card is created for a supplemental message.
      if(s.jobId!==jobId || s.taskResult || s.finalReplyKey)throw Object.assign(Error('task_link_card_changed'),{permanent:true});
      if(s.linkedTaskKey===ownerKey && s.sentRevision===s.revision)return;
      if(s.linkedTaskKey && s.linkedTaskKey!==ownerKey)throw Object.assign(Error('task_link_owner_changed'),{permanent:true});
      if(!s.linkedTaskKey){s.linkedTaskKey=ownerKey;s.final=true;s.text='补充已关联到原任务，后续进度和结果请查看原任务卡。';
        s.presentation={...s.presentation,status:'waiting',interactions:[]};delete s.presentation.actionContext;delete s.presentation.nativeContext;s.revision++;atomicWriteJson(file,s);}
      await this.updateCard(file,s,true);
    });
  }

  replyDeliveryEvidence(replyKey) {
    const valid=value=>value?.schema===1 && Number.isFinite(value.at) && value.at>=0
      && ['send_response','create_response','reconciled_observation'].includes(value.source);
    const receipt=this.read(this.file('reply',replyKey));if(valid(receipt?.finalDeliveryEvidence))return receipt.finalDeliveryEvidence;
    const text=this.read(this.file('text',replyKey));
    if(text?.parts?.length>0 && text.next===text.parts.length && valid(text.finalDeliveryEvidence))return text.finalDeliveryEvidence;
    for(const name of fs.readdirSync(this.root).filter(n=>/^card-[a-f0-9]+\.json$/.test(n))) {
      const card=this.read(path.join(this.root,name));if(card.finalReplyKey===replyKey && card.finalDelivered && valid(card.finalDeliveryEvidence))return card.finalDeliveryEvidence;
    }
    return this.replyDelivered(replyKey)?{schema:1,at:this.now(),source:'reconciled_observation'}:null;
  }

  replyDelivered(replyKey) {
    // Recover the crash gap between a successful card/text delivery and its
    // aggregate receipt, even if the next scan discovers an earlier peer.
    if(this.read(this.file('reply',replyKey))?.deliveredAt!==undefined)return true;
    const textState=this.read(this.file('text',replyKey));
    if(textState?.parts?.length>0 && textState.next===textState.parts.length)return true;
    return fs.readdirSync(this.root).filter(n=>/^card-[a-f0-9]+\.json$/.test(n)).some(name=>{
      const card=this.read(path.join(this.root,name));return card.finalReplyKey===replyKey && card.finalDelivered;
    });
  }

  replyStatus(replyKey) {
    const receipt=this.read(this.file('reply',replyKey));
    if(receipt?.status)return receipt.status;
    for(const name of fs.readdirSync(this.root).filter(n=>/^card-[a-f0-9]+\.json$/.test(n))) {
      const card=this.read(path.join(this.root,name));
      if(card.finalReplyKey===replyKey && card.finalDelivered)return card.presentation?.status??'complete';
    }
    return 'complete';
  }

  async closeReplyCards(replyKey,streamKeys=[]) {
    const status=this.replyStatus(replyKey);
    for(const key of new Set(streamKeys))await this.serial(async()=>{
      const file=this.file('card',key),s=this.read(file);
      if(!s)return; // No initial/progress intent; never create a late card.
      if(s.finalReplyKey && s.finalReplyKey!==replyKey)
        throw Object.assign(Error('card_reply_key_changed'),{permanent:true});
      if(s.finalClosedReplyKey===replyKey)return;
      if(s.final && s.finalReplyKey===replyKey && s.sentRevision===s.revision) {
        s.finalClosedReplyKey=replyKey;s.finalClosedAt=this.now();atomicWriteJson(file,s);return;
      }
      if(s.deliveryUncertain)throw Object.assign(Error('card_delivery_uncertain'),{permanent:true,deliveryUncertain:true});
      if(s.messageId && s.blocked)throw Object.assign(Error('card_close_blocked'),{permanent:true,code:s.error});
      // The answer has already been delivered. This lane only patches the
      // existing source card and never recreates actions or repeats the answer.
      s.final=true;s.finalReplyKey=replyKey;s.text=status==='waiting'?'等待补充，完整答复已发送。':'处理完成，完整答复已发送。';
      s.presentation={...s.presentation,status,interactions:[]};
      delete s.presentation.actionContext;delete s.presentation.nativeContext;
      s.revision++;atomicWriteJson(file,s);
      if(s.messageId) {
        try {await this.updateCard(file,s,true);}
        catch(error) {
          const latest=this.read(file);recordFailure(latest,error,this.now());
          if(error.deliveryUncertain)latest.deliveryUncertain=true;
          latest.finalCardFailed=true;atomicWriteJson(file,latest);throw error;
        }
      }
      const latest=this.read(file);latest.finalClosedReplyKey=replyKey;latest.finalClosedAt=this.now();atomicWriteJson(file,latest);
    });
  }

  interactive(card,key,{route,onMessage,renderVersion=1}={}) {
    return this.serial(async()=>{
      const file=this.file('interactive',key),hash=digest(JSON.stringify(card));
      if(!Number.isSafeInteger(renderVersion)||renderVersion<1)throw Object.assign(Error('interactive_render_version_invalid'),{permanent:true});
      const s=this.read(file,{hash,route,renderVersion});
      if(s.hash!==hash){
        if(renderVersion<=(s.renderVersion??1))throw Object.assign(Error('interactive_payload_changed'),{permanent:true});
        // Explicit renderer upgrades reuse the same bound message and callback
        // context. Only its presentation changes; the create shell is immutable.
        s.hash=hash;s.renderVersion=renderVersion;s.patched=false;atomicWriteJson(file,s);
      }
      else if(renderVersion>(s.renderVersion??1)){s.renderVersion=renderVersion;atomicWriteJson(file,s);}
      if(!fs.existsSync(file))atomicWriteJson(file,s);
      if(!s.messageId){
        const shell=streamCard('正在准备确认表单…',false);
        const result=await this.sendMessage({key:`interactive:${key}`,route:s.route,msgType:'interactive',content:shell});
        s.messageId=result.message_id;atomicWriteJson(file,s);
      }
      await onMessage?.(s.messageId);
      if(!s.patched){await this.request(this.binding,['api','PATCH',`/open-apis/im/v1/messages/${s.messageId}`,'--data',JSON.stringify({content:JSON.stringify(card)})]);s.patched=true;atomicWriteJson(file,s);}
      return {message_id:s.messageId};
    });
  }

  attachCloudDoc(replyKey,record) {
    return this.serial(async()=>{
      let attached=false;
      for(const name of fs.readdirSync(this.root).filter(n=>/^card-[a-f0-9]+\.json$/.test(n))){
        const file=path.join(this.root,name),s=this.read(file);
        if(s.finalReplyKey!==replyKey||!s.finalDelivered||!s.messageId)continue;
        const metadata={status:record.status,url:record.url??null,title:record.title??'',error:record.error??null};
        if(JSON.stringify(s.presentation?.cloudDoc)!==JSON.stringify(metadata)){
          s.presentation={...s.presentation,cloudDoc:metadata};s.revision++;atomicWriteJson(file,s);
        }
        if(s.sentRevision!==s.revision)await this.updateCard(file,s,true);
        attached=true;
      }
      return attached;
    });
  }
}
