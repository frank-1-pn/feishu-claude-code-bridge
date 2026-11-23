import fs from 'node:fs';
import path from 'node:path';
import { digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { sanitizeFeishuReply } from './codex-bridge-sanitize.mjs';
import { classifyFailure, recordFailure } from './codex-bridge-retry.mjs';
import { updateStreamCard, streamCard } from './codex-bridge-cardkit.mjs';
import { bindingSnapshot, publicPhase } from './codex-bridge-ux.mjs';
import { safeMessageAppLink } from './codex-bridge-status-query.mjs';

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
  constructor(root, binding, request, { now = Date.now, minIntervalMs = 10000, presentationEnabled = false, onCardMessage, sendMessage, resolveMessageLink } = {}) {
    this.root = path.join(root, binding.bot); this.binding = binding; this.request = request;
    this.now = now; this.minIntervalMs = minIntervalMs; this.tail = Promise.resolve();
    this.presentationEnabled = presentationEnabled; this.onCardMessage = onCardMessage;
    this.sendMessage=sendMessage;
    this.resolveMessageLink=resolveMessageLink;
    this.scope=digest(JSON.stringify(bindingSnapshot(binding)));
    fs.mkdirSync(this.root, { recursive: true });
  }
  file(kind, key) { return path.join(this.root, `${kind}-${digest(key)}.json`); }
  read(file, fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  serial(fn) { const p = this.tail.then(fn); this.tail = p.catch(() => {}); return p; }
  cardPaths() {
    return fs.readdirSync(this.root).filter(name => /^card-[a-f0-9]{64}\.json$/.test(name))
      .map(name => path.join(this.root, name));
  }
  cardRecords() { return this.cardPaths().map(file => this.read(file)); }
  inScope(card) { return card?.route?.scope === this.scope && card.route.chatId === this.binding.chat_id; }
  async text(text, key, route) {
    return this.serial(async () => {
      const file = this.file('text', key);
      const state = this.read(file, { parts: splitText(sanitizeFeishuReply(text).trim() || '本次没有可发送的正文。'), next: 0, ...(route?{route}:{}) });
      if (!fs.existsSync(file)) atomicWriteJson(file, state);
      for (; state.next < state.parts.length;) {
        const result = state.route && this.sendMessage
          ? await this.sendMessage({key:`text:${key}:${state.next}`,route:state.route,msgType:'text',content:{text:state.parts[state.next]}})
          : await this.request(this.binding, ['im', '+messages-send', '--chat-id', this.binding.chat_id,
            '--text', state.parts[state.next], '--idempotency-key', digest(`${key}:${state.next}`).slice(0, 32)]);
        state.next++; state.lastMessageId = result?.message_id; atomicWriteJson(file, state);
      }
    });
  }
  progress(text, key, route, metadata = {}) {
    const file = this.file('card', key);
    const s = this.read(file, { key, revision: 0, ...(route?{route}:{}) });
    if (s.final) return;
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
  handoffProgress(text,key,route,metadata) {
    return this.serial(()=>{
      for(const older of metadata.supersededKeys??[])if(older!==key)this.supersede(older,key);
      this.progress(text,key,route,metadata);
    });
  }
  supersede(key, successor) {
    const file=this.file('card',key), state=this.read(file);
    if(!state || state.final || state.supersededBy)return;
    state.supersededBy=successor;
    state.final=true;
    state.text='后续进度和结果请看本次任务的最新卡片。';
    state.presentation={status:'superseded',interactions:[]};
    state.revision++;
    atomicWriteJson(file,state);
  }
  async flushCards({retiredOnly=false}={}) {
    const cards=this.cardPaths();
    const retiring=cards.filter(file=>this.read(file).supersededBy);
    for (const file of retiredOnly?retiring:[...new Set([...retiring,...cards])]) {
      await this.serial(async () => {
        const s=this.read(file);
        const retiring=Boolean(s.supersededBy && (s.messageId || s.deliveryUncertain));
        if (retiring && s.successorLink?.url) return; // The optional link patch has its own retry lane.
        if ((s.final && !retiring) || s.blocked || s.sentRevision === s.revision || (s.retryAt ?? 0) > this.now()
            || (!retiring && s.lastSentAt && this.now() - s.lastSentAt < this.minIntervalMs)) return;
        if(!retiring && !s.messageId && cards.some(other=>{
          const old=this.read(other);
          return old.supersededBy===s.key && (old.messageId || old.deliveryUncertain) && !old.blocked && old.sentRevision!==old.revision;
        }))return;
        try { await this.updateCard(file, s, retiring); }
        catch (error) {
          // Merge failures with progress that may have arrived during network I/O.
          const latest = this.read(file); recordFailure(latest, error, this.now());
          if(error.deliveryUncertain)latest.deliveryUncertain=true;
          atomicWriteJson(file, latest);
        }
      });
    }
  }
  async flushSuccessorLinks() {
    if (!this.resolveMessageLink) return;
    const records = this.cardPaths().map(file => ({ file, card: this.read(file) }));
    const inScope = new Map(records.filter(({ card }) => this.inScope(card)).map(({ card }) => [card.key, card]));
    const currentSuccessor = key => {
      const visited = new Set();
      let card = inScope.get(key);
      while (card?.supersededBy) {
        if (visited.has(card.key) || visited.size >= 32) return;
        visited.add(card.key);
        card = inScope.get(card.supersededBy);
      }
      return card;
    };
    let attempted = 0;
    for (const { file, card } of records) {
      if (!this.inScope(card) || !card.final || !card.supersededBy || !card.messageId
          || !card.sentRevision || (card.revision !== card.sentRevision && !card.successorLink?.url)) continue;
      const next = currentSuccessor(card.supersededBy);
      if (!next?.messageId || !next.sentRevision || next.messageId === card.messageId || !/^om_[A-Za-z0-9_-]+$/.test(next.messageId)) continue;
      const prior = card.successorLink?.messageId === next.messageId ? card.successorLink : { messageId: next.messageId };
      if (prior.done || (prior.retryAt ?? 0) > this.now()) continue;
      if (++attempted > 3) break;
      let link = prior.url;
      let lookupError;
      if (!link) {
        try { link = safeMessageAppLink(await this.resolveMessageLink(next.messageId), this.binding.chat_id); }
        catch (error) { lookupError = error; }
      }
      await this.serial(async () => {
        const state = this.read(file);
        if (!this.inScope(state) || state.messageId !== card.messageId || state.supersededBy !== card.supersededBy
            || state.revision !== card.revision || JSON.stringify(state.successorLink) !== JSON.stringify(card.successorLink)) return;
        const failure = error => {
          recordFailure(prior, error, this.now());
          if (prior.blocked || prior.attempts >= 4) prior.done = true;
          const current = this.read(file);
          current.successorLink = prior;
          atomicWriteJson(file, current);
        };
        if (lookupError) { failure(lookupError); return; }
        if (!link) {
          state.successorLink = { ...prior, done: true }; // CLI may not have a jump link for this message.
          atomicWriteJson(file, state);
          return;
        }
        if (state.successorLink?.url !== link) {
          prior.url = link;
          state.successorLink = prior;
          state.presentation = { ...state.presentation, interactions: [{
            tag: 'button', element_id: 'latest_task_card', text: { tag: 'plain_text', content: '打开最新卡片' },
            type: 'default', size: 'small', behaviors: [{ type: 'open_url', default_url: link }],
          }] };
          state.revision++;
          atomicWriteJson(file, state);
        }
        try { await this.updateCard(file, state, true); }
        catch (error) { failure(error); return; }
        const updated = this.read(file);
        updated.successorLink = { messageId: next.messageId, url: link, done: true };
        atomicWriteJson(file, updated);
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
    if (s.messageId) await this.onCardMessage?.(s.messageId,s.presentation);
    if (s.messageId) {
      await this.request(this.binding, ['api', 'PATCH', `/open-apis/im/v1/messages/${s.messageId}`,
        '--data', JSON.stringify({ content: JSON.stringify(card) })]);
    } else {
      const shellRequired=Boolean(s.route && this.sendMessage || s.presentation?.actionContext || s.presentation?.nativeContext);
      const content=JSON.stringify(shellRequired ? streamCard('正在准备结果…',false) : card);
      const result = s.route && this.sendMessage
        ? await this.sendMessage({key:`card:${s.key}`,route:s.route,msgType:'interactive',content})
        : await this.request(this.binding, ['api', 'POST', '/open-apis/im/v1/messages',
        '--params', JSON.stringify({ receive_id_type: 'chat_id' }), '--data', JSON.stringify({ receive_id: this.binding.chat_id,
          msg_type: 'interactive', content, uuid: digest(`card:${s.key}`).slice(0, 32) })]);
      if (!/^om_[A-Za-z0-9_-]+$/.test(result?.message_id ?? '')) throw new Error('card_message_id_missing');
      s.messageId = result.message_id;
      // Persist before exposing controls, including across an uncertain patch.
      const created=this.read(file,s);created.messageId=s.messageId;atomicWriteJson(file,created);
      await this.onCardMessage?.(s.messageId,s.presentation);
      if(shellRequired) await this.request(this.binding,['api','PATCH',`/open-apis/im/v1/messages/${s.messageId}`,
        '--data',JSON.stringify({content:JSON.stringify(card)})]);
    }
    const latest = this.read(file, s);
    Object.assign(latest, { messageId: s.messageId, sentRevision: s.revision, lastSentAt: this.now(), attempts: 0, retryAt: 0 });
    delete latest.deliveryUncertain;
    if (final) latest.final = true;
    atomicWriteJson(file, latest);
  }
  async final(text, replyKey, streamKeys = [], presentation) {
    const clean = sanitizeFeishuReply(text).trim() || '本次没有可发送的正文。';
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
    if(keys.length>1){
      const [latest,...older]=keys;
      await this.serial(()=>{for(const key of older)this.supersede(key,latest);});
      await this.flushCards({retiredOnly:true});
      keys=[latest];
    }
    if(!keys.length && this.presentationEnabled) keys.push(`reply:${replyKey}`);
    for (const key of keys) {
      await this.serial(async () => {
        const file = this.file('card', key), s = this.read(file, { key, revision:0, ...(route?{route}:{}) });
        if (s.finalReplyKey === replyKey && s.finalDelivered) { delivered = true; return; }
        if(s.blocked && s.deliveryUncertain)throw Object.assign(Error('card_delivery_uncertain'),{permanent:true,deliveryUncertain:true});
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
        s.revision++; atomicWriteJson(file, s);
        try {
          if (!s.blocked) {
            await this.updateCard(file, s, true);
            if (!delivered && fits) {
              const latest = this.read(file); latest.finalDelivered = true; atomicWriteJson(file, latest); delivered = true;
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

  attachReport(replyKey, update) {
    return this.serial(async () => {
      if (!['done', 'blocked'].includes(update?.status) || typeof update.fileName !== 'string') return false;
      for (const file of this.cardPaths()) {
        const state = this.read(file);
        if (!this.inScope(state) || state.finalReplyKey !== replyKey || !state.finalDelivered || !state.messageId) continue;
        const previous = state.presentation?.report;
        const delivered = update.status === 'done' && update.delivered === true;
        // A late failure may belong to an earlier attempt. It cannot undo an
        // already confirmed delivery.
        if (previous?.delivered && !delivered) return true;
        const metadata = {
          fileName: update.fileName, status: update.status, delivered,
          ...(update.uncertain === true ? {uncertain:true} : {}),
          url: safeMessageAppLink(update.url, this.binding.chat_id) ?? previous?.url ?? null,
          ...(Number.isInteger(update.done) ? { done: update.done } : {}),
          ...(Number.isInteger(update.total) ? { total: update.total } : {}),
        };
        if (JSON.stringify(previous) !== JSON.stringify(metadata)) {
          state.presentation = { ...state.presentation, report: metadata };
          state.revision++;
          atomicWriteJson(file, state);
        }
        if (state.sentRevision !== state.revision) await this.updateCard(file, state, true);
        return true;
      }
      return false;
    });
  }
}
