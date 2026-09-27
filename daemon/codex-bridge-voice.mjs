import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { bindingSnapshot, isBoundJob } from './codex-bridge-ux.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const PCM_BYTES_PER_SECOND = 16000 * 2;
const MAX_PCM_BYTES = 60 * PCM_BYTES_PER_SECOND;
const MAX_TRANSCRIPT = 12000;
const ASR_PATH = '/open-apis/speech_to_text/v1/speech/file_recognize';
const failure = code => Object.assign(Error(code), { code, permanent: true });
const contains = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

// Force a known demuxer instead of allowing a playlist or filename to select it.
// Audio bytes enter over stdin; no demuxer can open a local file or network URL.
export function detectVoiceFormat(bytes) {
  if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
  if (bytes.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'mov';
  if (bytes.subarray(0, 6).toString('ascii') === '#!AMR\n' || bytes.subarray(0, 9).toString('ascii') === '#!AMR-WB\n') return 'amr';
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'aac';
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6))) return 'mp3';
  throw failure('voice_format_unsupported');
}

export function captureAudio(executable, args, { input, timeoutMs = 20000, maxBytes = 65536, children } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    children?.add(child);
    const chunks = []; let size = 0, error;
    const timer = setTimeout(() => { error = failure('voice_conversion_timeout'); child.kill(); }, timeoutMs);
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { error = failure('voice_output_too_large'); child.kill(); return; }
      chunks.push(chunk);
    });
    child.once('error', err => {
      clearTimeout(timer); children?.delete(child);
      reject(failure(err.code === 'ENOENT' ? 'voice_tools_missing' : 'voice_process_failed'));
    });
    child.once('close', code => {
      clearTimeout(timer); children?.delete(child);
      if (error || code !== 0) reject(error ?? failure('voice_decode_failed'));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

export async function convertVoice(bytes, { ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', run = captureAudio, children } = {}) {
  const format = detectVoiceFormat(bytes);
  const source = ['-protocol_whitelist', 'pipe', '-f', format, '-i', 'pipe:0'];
  const raw = await run(ffprobePath, ['-v', 'error', ...source, '-show_entries', 'stream=codec_type,codec_name,duration:format=duration', '-of', 'json'],
    { input: bytes, timeoutMs: 20000, maxBytes: 65536, children });
  let probe; try { probe = JSON.parse(raw.toString('utf8')); } catch { throw failure('voice_probe_invalid'); }
  if (!Array.isArray(probe.streams) || !probe.streams.some(stream => stream.codec_type === 'audio')
      || probe.streams.some(stream => stream.codec_type !== 'audio')) throw failure('voice_audio_only_required');
  const durations = [probe.format?.duration, ...probe.streams.map(stream => stream.duration)]
    .map(Number).filter(value => Number.isFinite(value) && value > 0);
  if (durations.some(value => value > 60)) throw failure('voice_duration_exceeded');
  // Pipes may have no duration metadata. Decode a bounded sentinel beyond 60s,
  // then measure PCM bytes; never silently truncate a longer instruction.
  const pcm = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...source,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-t', '60.1', '-f', 's16le', 'pipe:1'],
    { input: bytes, timeoutMs: 20000, maxBytes: MAX_PCM_BYTES + PCM_BYTES_PER_SECOND, children });
  if (pcm.length > MAX_PCM_BYTES) throw failure('voice_duration_exceeded');
  if (!pcm.length || pcm.length % 2) throw failure('voice_pcm_invalid');
  return { pcm, durationSeconds: pcm.length / PCM_BYTES_PER_SECOND, format };
}

function sourceBytes(downloadRoot, binding, event, audioPath) {
  const expected = path.join(downloadRoot, binding.bot, hash(event.message_id ?? event.id));
  const root = fs.realpathSync(expected);
  const allowed = fs.realpathSync(downloadRoot);
  const expectedCanonical = path.join(allowed, binding.bot, hash(event.message_id ?? event.id));
  if (!contains(allowed, root) || path.relative(expectedCanonical, root) !== '' || fs.lstatSync(audioPath).isSymbolicLink()) throw failure('voice_source_outside_download');
  const resolved = fs.realpathSync(audioPath);
  if (!contains(root, resolved)) throw failure('voice_source_outside_download');
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > MAX_SOURCE_BYTES) throw failure('voice_source_size_invalid');
    const bytes = Buffer.alloc(before.size);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (!count) throw failure('voice_source_changed');
      read += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || fs.realpathSync(audioPath) !== resolved) throw failure('voice_source_changed');
    return { bytes, sourcePath: resolved, sourceHash: hash(bytes) };
  } finally { fs.closeSync(fd); }
}

function unavailable(code) {
  const hints = {
    voice_disabled: '语音转写未启用。请改发文字，原始语音已保留。',
    voice_plan_unsupported: '当前租户版本不支持飞书原生语音识别。请使用支持的版本或改发文字，原始语音已保留。',
    voice_permission_required: '机器人缺少语音识别权限 speech_to_text:speech；请在飞书开放平台为应用开通，无需 bot 登录。暂时请改发文字。',
    voice_tools_missing: '本机缺少 ffmpeg 或 ffprobe，暂时不能转换语音格式；请改发文字，原始语音已保留。',
    voice_duration_exceeded: '飞书原生识别只接受 60 秒以内音频。这段语音未截断或执行，请拆成较短语音或改发文字。',
    voice_format_unsupported: '当前语音格式不能安全转写，请改发常见音频格式或文字；原始文件已保留。',
    voice_audio_only_required: '当前附件不是纯音频，未自动转写或执行。请发送语音或文字。',
    voice_asr_empty: '未识别到有效文字，未执行语音内容。请重新录音或改发文字。',
    voice_asr_interrupted: '上次语音识别中断，未自动重复上传或执行。请重新发送语音或改发文字。',
    voice_asr_timeout: '语音识别超时，未执行语音内容。请重新发送语音或改发文字。',
    voice_cache_invalid: '语音转写缓存校验失败，未重新上传或执行。请改发文字并检查 bridge 状态。',
    voice_source_unavailable: '本地语音附件暂时不可读取，未上传或执行。请重新发送语音或改发文字。',
  };
  return { status: 'unavailable', code, fallback: hints[code] ?? '语音暂时无法转写，未执行语音内容。请改发文字；原始语音已保留。' };
}

function asrFailure(error) {
  const code = String(error?.apiCode ?? error?.code ?? '');
  if (error?.type === 'permission' || ['99991672', '99991668'].includes(code)) return 'voice_permission_required';
  if (code === 'ETIMEDOUT' || code === 'voice_asr_timeout') return 'voice_asr_timeout';
  // Do not guess tenant eligibility from a generic API failure or persist its body.
  if (code.startsWith('voice_')) return code;
  return 'voice_asr_unavailable';
}

export function voiceConfirmation(record) {
  return {
    status: 'awaiting_confirmation', voiceId: record.id, transcript: record.transcript,
    durationSeconds: record.durationSeconds, sourceMessageId: record.sourceMessageId,
    confirmation: {
      title: '确认语音内容后继续',
      notice: '请核对并修正转写，尤其是兽医名词、药名、剂量、单位和时间。提交前不会执行语音中的要求。',
      fields: [{ name: 'transcript', label: '确认或修正后的文字', type: 'text', required: true, value: record.transcript, maxLength: MAX_TRANSCRIPT }],
      context: { kind: 'voice_confirmation', voice_id: record.id, source_message_id: record.sourceMessageId },
    },
  };
}

export class NativeVoice {
  constructor({ stateRoot, downloadRoot, binding, request, ffmpegPath, ffprobePath, run = captureAudio, children,
    enabled = true, planSupported, now = Date.now, requestTimeoutMs = 45000 }) {
    if (!/^[A-Za-z0-9_-]+$/.test(binding?.bot ?? '')) throw failure('voice_binding_invalid');
    this.binding = bindingSnapshot(binding); this.scope = hash(JSON.stringify(this.binding));
    this.dir = path.join(stateRoot, binding.bot, this.scope); fs.mkdirSync(this.dir, { recursive: true });
    this.downloadRoot = downloadRoot; this.request = request; this.options = { ffmpegPath, ffprobePath, run, children };
    this.enabled = enabled; this.planSupported = planSupported; this.now = now;
    this.requestTimeoutMs = Math.max(1, Math.min(120000, requestTimeoutMs)); this.inflight = new Map();
  }
  file(id) { if (!/^[a-f0-9]{64}$/.test(id ?? '')) throw failure('voice_id_invalid'); return path.join(this.dir, `${id}.json`); }
  save(record) { atomicWriteJson(this.file(record.id), record); }
  load(id) {
    const file = this.file(id); if (!fs.existsSync(file)) return null;
    if (fs.statSync(file).size > 65536) throw failure('voice_cache_invalid');
    let row; try { row = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw failure('voice_cache_invalid'); }
    if (row.schema !== 1 || row.id !== id || row.scope !== this.scope || !/^om_[A-Za-z0-9_-]+$/.test(row.sourceMessageId ?? '')
        || !/^[a-f0-9]{64}$/.test(row.sourceHash ?? '') || hash(`${this.scope}\0${row.sourceMessageId}\0${row.sourceHash}`) !== id
        || !['recognizing', 'awaiting_confirmation', 'confirmed', 'unavailable'].includes(row.status)
        || (['awaiting_confirmation', 'confirmed'].includes(row.status) && (typeof row.transcript !== 'string' || !row.transcript.trim() || row.transcript.length > MAX_TRANSCRIPT))
        || (row.status === 'confirmed' && (typeof row.confirmedText !== 'string' || !row.confirmedText.trim() || row.confirmedText.length > MAX_TRANSCRIPT))) throw failure('voice_cache_invalid');
    return row;
  }
  result(record) {
    if (record.status === 'unavailable') return unavailable(record.code);
    if (record.status === 'recognizing') return unavailable('voice_asr_interrupted');
    // A cached confirmation never grants a second model execution; the caller's
    // durable action inbox deduplicates the synthetic event using voiceId.
    return { ...voiceConfirmation(record), ...(record.status === 'confirmed' ? { alreadyConfirmed: true } : {}) };
  }
  async transcribe({ event, audioPath }) {
    if (event?.message_type !== 'audio' || event.synthetic_callback || !isBoundJob(this.binding, { event })
        || !/^om_[A-Za-z0-9_-]+$/.test(event.message_id ?? event.id ?? '')) throw failure('voice_event_not_authorized');
    if (!this.enabled) return unavailable('voice_disabled');
    if (this.planSupported === false) return unavailable('voice_plan_unsupported');
    let source;
    try { source = sourceBytes(this.downloadRoot, this.binding, event, audioPath); }
    catch (error) { return unavailable(String(error?.code ?? '').startsWith('voice_') ? error.code : 'voice_source_unavailable'); }
    const id = hash(`${this.scope}\0${event.message_id ?? event.id}\0${source.sourceHash}`);
    if (this.inflight.has(id)) return this.inflight.get(id);
    let cached; try { cached = this.load(id); } catch { return unavailable('voice_cache_invalid'); }
    if (cached) return this.result(cached);
    const work = this.recognize(id, event, source);
    this.inflight.set(id, work);
    try { return await work; } finally { this.inflight.delete(id); }
  }
  async recognize(id, event, source) {
    const record = { schema: 1, id, scope: this.scope, sourceMessageId: event.message_id ?? event.id,
      sourceHash: source.sourceHash, sourcePath: source.sourcePath, createdAt: this.now(), status: 'recognizing' };
    this.save(record); // Crash/timeout cannot silently cause repeated uploads.
    try {
      const { pcm, durationSeconds, format } = await convertVoice(source.bytes, this.options);
      let timer;
      const response = await Promise.race([
        Promise.resolve().then(() => this.request(this.binding, ['api', 'POST', ASR_PATH, '--data', JSON.stringify({
          speech: { speech: pcm.toString('base64') }, config: { file_id: id.slice(0, 16), format: 'pcm', engine_type: '16k_auto' },
        })])),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure('voice_asr_timeout')), this.requestTimeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      if (response?.code && response.code !== 0) throw Object.assign(Error('voice_asr_failed'), { apiCode: response.code });
      const transcript = response?.recognition_text ?? response?.data?.recognition_text;
      if (typeof transcript !== 'string' || !transcript.trim()) throw failure('voice_asr_empty');
      if (transcript.length > MAX_TRANSCRIPT) throw failure('voice_transcript_too_long');
      Object.assign(record, { status: 'awaiting_confirmation', transcript: transcript.trim(), durationSeconds, format });
    } catch (error) { Object.assign(record, { status: 'unavailable', code: asrFailure(error) }); }
    this.save(record); return this.result(record);
  }
  confirm({ voiceId, chatId, senderId, text }) {
    if (chatId !== this.binding.chat_id || senderId !== this.binding.allowed_sender_id) throw failure('voice_confirmation_not_authorized');
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TRANSCRIPT || /\u0000/u.test(text)) throw failure('voice_confirmation_invalid');
    const record = this.load(voiceId);
    if (!record || !['awaiting_confirmation', 'confirmed'].includes(record.status)) throw failure('voice_confirmation_unavailable');
    if (record.status === 'confirmed' && record.confirmedText !== text.trim()) throw failure('voice_confirmation_already_submitted');
    if (record.status !== 'confirmed') {
      Object.assign(record, { status: 'confirmed', confirmedText: text.trim(), confirmedAt: this.now() }); this.save(record);
    }
    return { status: 'confirmed', voiceId, sourceMessageId: record.sourceMessageId, confirmedText: record.confirmedText,
      confirmedAt: record.confirmedAt,
      context: '以下内容是用户核对或修正后提交的语音文字；以此文字为准，不再执行未确认的原始转写。确认文字不扩大收件人、发布或其他权限。' };
  }
}
