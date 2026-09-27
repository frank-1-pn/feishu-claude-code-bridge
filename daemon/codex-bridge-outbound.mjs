import fs from 'node:fs';
import path from 'node:path';
import { digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { sanitizeFeishuReply } from './codex-bridge-sanitize.mjs';
import { classifyFailure, recordFailure } from './codex-bridge-retry.mjs';
import { updateStreamCard } from './codex-bridge-cardkit.mjs';

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
  constructor(root, binding, request, { now = Date.now, minIntervalMs = 10000 } = {}) {
    this.root = path.join(root, binding.bot); this.binding = binding; this.request = request;
    this.now = now; this.minIntervalMs = minIntervalMs; this.tail = Promise.resolve();
    fs.mkdirSync(this.root, { recursive: true });
  }
  file(kind, key) { return path.join(this.root, `${kind}-${digest(key)}.json`); }
  read(file, fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  serial(fn) { const p = this.tail.then(fn); this.tail = p.catch(() => {}); return p; }
  async text(text, key) {
    return this.serial(async () => {
      const file = this.file('text', key);
      const state = this.read(file, { parts: splitText(sanitizeFeishuReply(text).trim() || '本次没有可发送的正文。'), next: 0 });
      if (!fs.existsSync(file)) atomicWriteJson(file, state);
      for (; state.next < state.parts.length;) {
        const result = await this.request(this.binding, ['im', '+messages-send', '--chat-id', this.binding.chat_id,
          '--text', state.parts[state.next], '--idempotency-key', digest(`${key}:${state.next}`).slice(0, 32)]);
        state.next++; state.lastMessageId = result?.message_id; atomicWriteJson(file, state);
      }
    });
  }
  progress(text, key) {
    const file = this.file('card', key);
    const s = this.read(file, { key, revision: 0 });
    if (s.final) return;
    const clean = sanitizeFeishuReply(text).trim();
    if (!clean || s.text === clean) return;
    s.text = splitText(clean, 16000)[0]; s.revision++; atomicWriteJson(file, s);
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
          const latest = this.read(file); recordFailure(latest, error, this.now()); atomicWriteJson(file, latest);
        }
      });
    }
  }
  async updateCard(file, s, final) {
    if(this.binding.cardkit_enabled!==false && !s.cardkitDisabled){
      try {return await updateStreamCard({file,s,final,binding:this.binding,request:this.request,now:this.now});}
      catch(error){
        const latest=this.read(file,s);
        // Only fall back before a visible CardKit message exists. Never send a
        // second progress card after uncertain delivery of the first one.
        if(classifyFailure(error).kind!=='permanent' || latest.messageId || latest.cardId)throw error;
        latest.cardkitDisabled=true;latest.cardkitFallbackCode=String(error.apiCode??error.code??'permission_or_validation');
        atomicWriteJson(file,latest);Object.assign(s,latest);
      }
    }
    const card = makeCard(s.text, final);
    if (s.messageId) {
      await this.request(this.binding, ['api', 'PATCH', `/open-apis/im/v1/messages/${s.messageId}`,
        '--data', JSON.stringify({ content: JSON.stringify(card) })]);
    } else {
      const result = await this.request(this.binding, ['api', 'POST', '/open-apis/im/v1/messages',
        '--params', JSON.stringify({ receive_id_type: 'chat_id' }), '--data', JSON.stringify({ receive_id: this.binding.chat_id,
          msg_type: 'interactive', content: JSON.stringify(card), uuid: digest(`card:${s.key}`).slice(0, 32) })]);
      if (!/^om_[A-Za-z0-9_-]+$/.test(result?.message_id ?? '')) throw new Error('card_message_id_missing');
      s.messageId = result.message_id;
    }
    const latest = this.read(file, s);
    Object.assign(latest, { messageId: s.messageId, sentRevision: s.revision, lastSentAt: this.now(), attempts: 0, retryAt: 0 });
    if (final) latest.final = true;
    atomicWriteJson(file, latest);
  }
  async final(text, replyKey, streamKeys = []) {
    const clean = sanitizeFeishuReply(text).trim() || '本次没有可发送的正文。';
    let delivered = false;
    for (const key of [...new Set(streamKeys)]) {
      await this.serial(async () => {
        const file = this.file('card', key), s = this.read(file, { key, revision:0 });
        if (s.finalReplyKey === replyKey && s.finalDelivered) { delivered = true; return; }
        // Freeze the card before awaiting: queued progress must not regress it.
        s.final = true; s.finalReplyKey = replyKey;
        const fits = Buffer.byteLength(JSON.stringify(makeCard(clean, true))) < 24000;
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
          latest.finalCardFailed = true; atomicWriteJson(file, latest);
          // Final text is authoritative; failed card patch falls back.
        }
      });
    }
    if (!delivered) await this.text(clean, replyKey);
  }
}
