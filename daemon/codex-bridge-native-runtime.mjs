import fs from 'node:fs';
import path from 'node:path';
import { NativeActionStore, button, formCard } from './codex-bridge-native-actions.mjs';
import { NativeTasks, TASK_FORM_FIELDS } from './codex-bridge-tasks.mjs';
import { NativeVoice } from './codex-bridge-voice.mjs';
import { prepareInbound } from './codex-bridge-media.mjs';
import { digest, normalizeEvent } from './codex-bridge-inbox.mjs';
import { atomicWriteText } from './codex-bridge-storage.mjs';
import { isBoundJob } from './codex-bridge-ux.mjs';
import { safeHttpUrl } from './codex-bridge-presentation.mjs';

const fail = code => { throw Object.assign(Error(code), { code, permanent: true }); };
const voiceFields = [{ name: 'transcript', label: '确认或修正后的文字', type: 'text', required: true, maxLength: 6000 }];
const taskNotice = '负责人仅为你自己；截止时间使用北京时间。留空表示不设截止时间；设置提醒必须同时填写截止时间。确认后才创建待办。';
function taskSummary(answer) {
  const first = String(answer).split(/\r?\n/).find(line => line.trim())?.replace(/^\s*[#>*-]+\s*/u, '').trim() ?? '';
  let value = '';
  for (const char of first) { if (value.length + char.length > 200) break; value += char; }
  return value;
}

// Native callbacks perform explicit operations in their durable queue. They do
// not create a second subscription or run a model to interpret form values.
export class NativeInteractions {
  constructor({ root, binding, downloadRoot, request, taskRequest = request, voiceRequest = request,
    children, getInbox, getRoute, outbound }) {
    Object.assign(this, { binding, downloadRoot, request, getInbox, getRoute, outbound });
    this.actions = new NativeActionStore({ root: path.join(root, 'actions'), binding });
    this.tasks = new NativeTasks({ root: path.join(root, 'tasks'), binding, request: taskRequest });
    this.voice = new NativeVoice({ stateRoot: path.join(root, 'voice'), downloadRoot, binding,
      request: voiceRequest, children, enabled: binding.voice_enabled === true });
  }
  source(jobId) {
    const inbox = this.getInbox(), job = inbox?.jobs?.get(jobId);
    if (!job || !isBoundJob(this.binding, job) || job.id !== (job.event.message_id ?? job.event.id)) fail('native_source_binding_mismatch');
    return { inbox, job };
  }
  route(jobId) { this.source(jobId); return this.getRoute(jobId); }
  taskButton({ jobId, replyKey, text }) {
    this.source(jobId);
    const context = this.actions.register({ key: `task-open:${replyKey}`, kind: 'task_open', sourceJobId: jobId,
      data: { answer: text, replyKey }, form: { fields: [] } });
    return { contextId: context.contextId, element: button(context, '转待办', { elementId: 'native_task_open', type: 'default' }) };
  }
  bindMessage(contextId, messageId) { return this.actions.bindMessage(contextId, messageId); }
  acceptCallback(event) { return this.actions.acceptCallback(event, { binding: this.binding, authenticatedBot: this.binding.bot }); }
  drain() {
    return this.actions.drain({ handlers: {
      task_open: operation => this.openTask(operation),
      task_create: operation => this.createTask(operation),
      voice_confirm: operation => this.confirmVoice(operation),
    } });
  }
  async showForm(context, card, key, jobId) {
    return this.outbound.interactive(card, key, { route: this.route(jobId), onMessage: messageId => this.actions.bindMessage(context.contextId, messageId) });
  }
  async taskForm(operation, { correction = false, notice = taskNotice } = {}) {
    this.source(operation.sourceJobId);
    const route = this.route(operation.sourceJobId);
    // Only use a link supplied by trusted routing. Do not invent a message
    // deep link or derive a publication target from the answer text.
    const sourceUrl = safeHttpUrl(operation.data.sourceUrl ?? route?.sourceUrl);
    const context = this.actions.register({ key: `${correction ? 'task-correct' : 'task-form'}:${operation.id}`,
      kind: 'task_create', sourceJobId: operation.sourceJobId, data: { answer: operation.data.answer,
        replyKey: operation.data.replyKey, ...(sourceUrl ? { sourceUrl } : {}) }, form: { fields: TASK_FORM_FIELDS } });
    const defaults = { summary: correction ? operation.values.summary : taskSummary(operation.data.answer), due: correction ? operation.values.due ?? '' : '' };
    const card = formCard(context, { title: correction ? '修正待办条件' : '确认创建待办', notice, defaults,
      submitLabel: '确认创建' });
    await this.showForm(context, card, `native-task-form:${context.contextId}`, operation.sourceJobId);
    return { status: 'done' };
  }
  openTask(operation) { return this.taskForm(operation); }
  async createTask(operation) {
    this.source(operation.sourceJobId);
    let result;
    try { result = await this.tasks.create({ key: operation.id, values: operation.values, answer: operation.data.answer, sourceUrl: operation.data.sourceUrl }); }
    catch (error) {
      if (['invalid_task_due', 'invalid_task_reminder', 'invalid_task_summary', 'invalid_task_fields'].includes(error.code)) {
        await this.taskForm(operation, { correction: true,
          notice: '尚未创建待办。请检查事项、截止时间和提醒：时间示例 2026-10-01 09:00，均按北京时间；没有截止时间时不能设置提醒。' });
        return { status: 'blocked', error: error.code };
      }
      throw error;
    }
    if (['pending', 'queued', 'running'].includes(result.status)) return result;
    let text;
    if (result.status === 'done') text = `待办已创建，负责人为你自己。\n\n[打开待办](<${result.url}>)`;
    else if (result.status === 'uncertain') text = '待办创建结果尚未确认，为避免重复已停止自动重试。请在飞书任务中核对；原答复和提交条件已保留。';
    else if (result.status === 'blocked') text = ['99991672', '99991668', '1470403'].includes(String(result.error))
      ? '机器人暂时没有创建待办的权限，请在飞书开放平台检查任务权限。未确认创建成功，原答复和提交条件已保留。'
      : '这次待办尚未确认创建成功，已停止重试；原答复和提交条件已保留，请检查 bridge 状态。';
    else fail('native_task_result_invalid');
    await this.outbound.text(text, `native-task-result:${operation.id}`, this.route(operation.sourceJobId));
    return result;
  }
  async prepare(event) {
    // These fields are local workflow state, never instructions from a message.
    event={...event};
    for(const key of ['bridgeDisposition','voiceConfirmed','voiceId','voiceError','nativeVoiceOperation','localReply'])delete event[key];
    const jobId = event.message_id ?? event.id;
    this.source(jobId);
    if (!isBoundJob(this.binding, { event })) fail('native_source_binding_mismatch');
    const prepared = await prepareInbound(this.binding, event, { download: this.request, downloadRoot: this.downloadRoot, writeText: atomicWriteText });
    if (event.message_type !== 'audio') return prepared;
    const resources = normalizeEvent(event).resources;
    const files = resources.map((resource, index) => ({ resource, index })).filter(({ resource }) => resource.kind === 'file');
    let result;
    if (files.length !== 1) result = { status: 'unavailable', code: 'voice_resource_ambiguous', fallback: '这条语音包含无法确定的音频资源，未自动执行。请重新发送一条语音或改发文字。' };
    else {
      const cache = path.join(this.downloadRoot, this.binding.bot, digest(jobId), `resource-${files[0].index}.json`);
      const audioPath = JSON.parse(fs.readFileSync(cache, 'utf8')).saved_path;
      result = await this.voice.transcribe({ event, audioPath });
    }
    if (result.status === 'awaiting_confirmation' && result.transcript.length > 6000) result = {
      status: 'unavailable', code: 'voice_confirmation_too_long', fallback: '转写内容超过当前确认表单的长度上限，未截断或执行。请分成较短语音，或改发你确认过的文字。' };
    if (result.status === 'unavailable') {
      await this.outbound.text(result.fallback, `native-voice-unavailable:${jobId}`, this.route(jobId));
      return { ...prepared, bridgeDisposition: 'handled', voiceError: result.code };
    }
    if (result.status !== 'awaiting_confirmation') fail('native_voice_result_invalid');
    if (result.alreadyConfirmed) {
      // The source inbox remains authoritative. Never recreate a fresh request
      // just because a prior confirmation is already present in the ASR cache.
      const { job } = this.source(jobId);
      if (job.nativeVoiceOperation && job.prepared?.voiceConfirmed) return job.prepared;
    }
    const context = this.actions.register({ key: `voice-confirm:${result.voiceId}`, kind: 'voice_confirm', sourceJobId: jobId,
      data: { voiceId: result.voiceId }, form: { fields: voiceFields } });
    const card = formCard(context, { title: result.confirmation.title, notice: result.confirmation.notice,
      defaults: { transcript: result.transcript }, submitLabel: '确认文字并继续' });
    await this.showForm(context, card, `native-voice-form:${context.contextId}`, jobId);
    return { ...prepared, bridgeDisposition: 'waiting_input', voiceId: result.voiceId };
  }
  confirmVoice(operation) {
    const { inbox, job } = this.source(operation.sourceJobId);
    if (job.nativeVoiceOperation === operation.id) return { status: 'done' };
    if (job.nativeVoiceOperation) return { status: 'blocked', error: 'voice_source_already_confirmed' };
    if (job.status === 'queued' && !job.prepared) return { status: 'pending' }; // Card callback may beat prepare's final checkpoint.
    if (job.status !== 'waiting_input' || job.prepared?.voiceId !== operation.data.voiceId
      || job.event.message_type !== 'audio' || job.event.synthetic_callback) return { status: 'blocked', error: 'voice_source_not_waiting' };
    const confirmed = this.voice.confirm({ voiceId: operation.data.voiceId, chatId: this.binding.chat_id,
      senderId: this.binding.allowed_sender_id, text: operation.values.transcript });
    if (confirmed.sourceMessageId !== job.id) fail('voice_source_message_mismatch');
    const prepared = { ...job.event, content: `${confirmed.context}\n\n${confirmed.confirmedText}`,
      voiceId: confirmed.voiceId, voiceConfirmed: true };
    delete prepared.bridgeDisposition;
    const candidate = { ...job, status: 'queued', prepared, nativeVoiceOperation: operation.id, retryAt: 0, attempts: 0 };
    delete candidate.bridgeDisposition;
    inbox.save(candidate); // Persist before making the queued job visible to dispatch.
    Object.assign(job, candidate); delete job.bridgeDisposition;
    return { status: 'done' };
  }
}
