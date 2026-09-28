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
}
