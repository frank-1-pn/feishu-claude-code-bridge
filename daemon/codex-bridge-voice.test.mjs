import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { NativeVoice, captureAudio, convertVoice, detectVoiceFormat } from './codex-bridge-voice.mjs';
import { createLarkTransport } from './codex-bridge-lark.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const ogg = Buffer.from('OggSfixture audio');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-voice-test-'));
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const binding = { bot: 'fixture', profile: 'chosen', chat_id: 'oc_fixture', allowed_sender_id: 'ou_fixture', codex_thread_id: 'thread-fixture' };
  const event = { message_id: 'om_voice', message_type: 'audio', chat_id: binding.chat_id, sender_id: binding.allowed_sender_id };
  const downloadRoot = path.join(root, 'downloads');
  const dir = path.join(downloadRoot, binding.bot, hash(event.message_id)); fs.mkdirSync(dir, { recursive: true });
  const audioPath = path.join(dir, 'resource-0;$(never-run).ogg'); fs.writeFileSync(audioPath, ogg);
  const calls = [], processes = [];
  const run = async (exe, args, settings) => {
    processes.push({ exe, args, settings });
    return exe === 'ffprobe' ? Buffer.from(JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'opus' }], format: {} })) : Buffer.alloc(32000);
  };
  const request = async (selected, args) => { calls.push({ selected, args }); return { recognition_text: '给出参考剂量 2 毫克，请先解释。' }; };
  const defaults = { stateRoot: path.join(root, 'state'), downloadRoot, binding, request, run, ...options };
  const make = extra => new NativeVoice({ ...defaults, ...extra });
  return { root, binding, event, audioPath, calls, processes, make, defaults };
}

test('bound audio is converted safely, transcribed once, and always requires editable confirmation', async t => {
  const f = fixture(t), voice = f.make();
  const result = await voice.transcribe(f);
  assert.equal(result.status, 'awaiting_confirmation'); assert.equal(result.durationSeconds, 1);
  assert.match(result.confirmation.notice, /药名、剂量、单位/); assert.match(result.confirmation.notice, /提交前不会执行/);
  assert.equal(result.confirmation.fields[0].value, result.transcript);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].selected.profile, 'chosen');
  assert.deepEqual(f.calls[0].args.slice(0, 4), ['api', 'POST', '/open-apis/speech_to_text/v1/speech/file_recognize', '--data']);
  const body = JSON.parse(f.calls[0].args[4]); assert.match(body.config.file_id, /^[a-z0-9]{16}$/);
  assert.deepEqual({ ...body.config, file_id: '' }, { file_id: '', format: 'pcm', engine_type: '16k_auto' });
  assert.equal(Buffer.from(body.speech.speech, 'base64').length, 32000);
  for (const { args, settings } of f.processes) {
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'pipe');
    assert.equal(args[args.indexOf('-i') + 1], 'pipe:0'); assert.equal(args.includes(f.audioPath), false);
    assert.deepEqual(settings.input, ogg); assert.equal(settings.timeoutMs, 20000);
  }
  assert.deepEqual(fs.readFileSync(f.audioPath), ogg); // Original is never rewritten or deleted.
  assert.deepEqual(await voice.transcribe(f), result);
  assert.deepEqual(await f.make().transcribe(f), result); assert.equal(f.calls.length, 1);
});

test('confirmation accepts completely corrected content and is idempotent across retry and restart', async t => {
  const f = fixture(t), voice = f.make(); const result = await voice.transcribe(f);
  const confirmation = { voiceId: result.voiceId, chatId: f.binding.chat_id, senderId: f.binding.allowed_sender_id, text: '其实是整理明天出差行程，不涉及药物。' };
  const confirmed = voice.confirm(confirmation);
  assert.equal(confirmed.confirmedText, confirmation.text); assert.equal(confirmed.sourceMessageId, f.event.message_id);
  assert.deepEqual(voice.confirm(confirmation), confirmed); assert.deepEqual(f.make().confirm(confirmation), confirmed);
  assert.throws(() => voice.confirm({ ...confirmation, text: 'changed after submit' }), { code: 'voice_confirmation_already_submitted' });
  assert.throws(() => voice.confirm({ ...confirmation, chatId: 'oc_other' }), { code: 'voice_confirmation_not_authorized' });
  assert.throws(() => voice.confirm({ ...confirmation, senderId: 'ou_other' }), { code: 'voice_confirmation_not_authorized' });
  assert.throws(() => voice.confirm({ ...confirmation, voiceId: '../../state' }), { code: 'voice_id_invalid' });
  assert.throws(() => voice.confirm({ ...confirmation, text: ' ' }), { code: 'voice_confirmation_invalid' });
  assert.throws(() => f.make({ binding: { ...f.binding, codex_thread_id: 'rebound-thread' } }).confirm(confirmation), { code: 'voice_confirmation_unavailable' });
  assert.equal((await f.make().transcribe(f)).alreadyConfirmed, true); assert.equal(f.calls.length, 1);
});

test('wrong sender, chat, thread, non-audio and synthetic events cannot invoke ASR', async t => {
  const f = fixture(t), voice = f.make();
  for (const patch of [{ sender_id: 'ou_other' }, { chat_id: 'oc_other' }, { codex_thread_id: 'other' }, { message_type: 'file' }, { synthetic_callback: true }, { message_id: '../bad' }]) {
    await assert.rejects(voice.transcribe({ ...f, event: { ...f.event, ...patch } }), { code: 'voice_event_not_authorized' });
  }
  assert.equal(f.calls.length, 0); assert.equal(f.processes.length, 0);
});

test('only the real downloaded message directory is allowed, including traversal and junction escape', async t => {
  const f = fixture(t), voice = f.make();
  const outside = path.join(f.root, 'other.ogg'); fs.writeFileSync(outside, ogg);
  assert.equal((await voice.transcribe({ ...f, audioPath: outside })).code, 'voice_source_outside_download');
  const otherMessage = path.join(f.defaults.downloadRoot, f.binding.bot, hash('om_other')); fs.mkdirSync(otherMessage);
  const elsewhere = path.join(otherMessage, 'audio.ogg'); fs.writeFileSync(elsewhere, ogg);
  assert.equal((await voice.transcribe({ ...f, audioPath: elsewhere })).code, 'voice_source_outside_download');
  const link = path.join(path.dirname(f.audioPath), 'escaped');
  fs.symlinkSync(otherMessage, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await voice.transcribe({ ...f, audioPath: path.join(link, 'audio.ogg') })).code, 'voice_source_outside_download');
  const f2 = fixture(t), expectedRoot = path.dirname(f2.audioPath);
  fs.unlinkSync(f2.audioPath); fs.rmdirSync(expectedRoot);
  const redirected = path.join(f2.defaults.downloadRoot, f2.binding.bot, hash('om_redirected')); fs.mkdirSync(redirected);
  fs.writeFileSync(path.join(redirected, path.basename(f2.audioPath)), ogg);
  fs.symlinkSync(redirected, expectedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f2.make().transcribe(f2)).code, 'voice_source_outside_download');
  assert.equal(f.calls.length, 0); assert.equal(f.processes.length, 0);
});

test('empty, oversized and unsupported inputs never upload and preserve the original', async t => {
  const f = fixture(t), voice = f.make();
  fs.writeFileSync(f.audioPath, ''); assert.equal((await voice.transcribe(f)).code, 'voice_source_size_invalid');
  const fd = fs.openSync(f.audioPath, 'w'); fs.ftruncateSync(fd, 50 * 1024 * 1024 + 1); fs.closeSync(fd);
  assert.equal((await voice.transcribe(f)).code, 'voice_source_size_invalid');
  const playlist = '#EXTM3U\nhttps://example.invalid/audio.mp3\n'; fs.writeFileSync(f.audioPath, playlist);
  assert.equal((await voice.transcribe(f)).code, 'voice_format_unsupported'); assert.equal(fs.readFileSync(f.audioPath, 'utf8'), playlist);
  assert.equal(f.calls.length, 0); assert.equal(f.processes.length, 0);
});

test('magic allowlist handles common voice containers, never file extensions or playlists', () => {
  const formats = [ ['OggS123', 'ogg'], ['RIFF0000WAVE', 'wav'], ['fLaC', 'flac'], ['0000ftyp', 'mov'], ['#!AMR\n', 'amr'], ['#!AMR-WB\n', 'amr'], ['ID3', 'mp3'] ];
  for (const [magic, expected] of formats) assert.equal(detectVoiceFormat(Buffer.from(magic)), expected);
  assert.equal(detectVoiceFormat(Buffer.from([255, 241, 0, 0])), 'aac');
  assert.equal(detectVoiceFormat(Buffer.from([255, 251, 0, 0])), 'mp3');
  for (const source of ['#EXTM3U', '[playlist]', 'file C:/private.txt', '', 'MZ']) assert.throws(() => detectVoiceFormat(Buffer.from(source)), { code: 'voice_format_unsupported' });
});

test('metadata over 60 seconds and decoded overrun are rejected without truncating or uploading', async t => {
  const f = fixture(t);
  const long = f.make({ run: async () => Buffer.from(JSON.stringify({ streams: [{ codec_type: 'audio', duration: '60.01' }] })) });
  assert.equal((await long.transcribe(f)).code, 'voice_duration_exceeded'); assert.equal(f.calls.length, 0);
  // Separate message cache: a second result cannot overwrite the first cache.
  const f2 = fixture(t);
  const hiddenLength = f2.make({ run: async (exe) => exe === 'ffprobe' ? Buffer.from('{"streams":[{"codec_type":"audio"}]}') : Buffer.alloc(1920002) });
  assert.equal((await hiddenLength.transcribe(f2)).code, 'voice_duration_exceeded'); assert.equal(f2.calls.length, 0);
  const pcm = await convertVoice(ogg, { run: async exe => exe === 'ffprobe' ? Buffer.from('{"streams":[{"codec_type":"audio"}]}') : Buffer.alloc(1920000) });
  assert.equal(pcm.durationSeconds, 60);
});

test('video, malformed probe and bad PCM fail closed', async () => {
  for (const streams of [[], [{ codec_type: 'video' }], [{ codec_type: 'audio' }, { codec_type: 'video' }]]) {
    await assert.rejects(convertVoice(ogg, { run: async () => Buffer.from(JSON.stringify({ streams })) }), { code: 'voice_audio_only_required' });
  }
  await assert.rejects(convertVoice(ogg, { run: async () => Buffer.from('invalid') }), { code: 'voice_probe_invalid' });
  for (const bytes of [0, 3]) await assert.rejects(convertVoice(ogg, { run: async exe => exe === 'ffprobe' ? Buffer.from('{"streams":[{"codec_type":"audio"}]}') : Buffer.alloc(bytes) }), { code: 'voice_pcm_invalid' });
});

test('permission, plan, disabled and empty ASR failures give explicit fallbacks without repeated uploads', async t => {
  const f = fixture(t); let uploads = 0;
  const request = async () => { uploads++; throw Object.assign(Error('private diagnostics must not persist'), { apiCode: 99991672, type: 'permission' }); };
  const voice = f.make({ request }); const result = await voice.transcribe(f);
  assert.equal(result.code, 'voice_permission_required'); assert.match(result.fallback, /speech_to_text:speech/);
  assert.deepEqual(await f.make({ request }).transcribe(f), result); assert.equal(uploads, 1);
  assert.equal(fs.readFileSync(path.join(voice.dir, fs.readdirSync(voice.dir)[0]), 'utf8').includes('private diagnostics'), false);
  assert.equal((await f.make({ planSupported: false }).transcribe(f)).code, 'voice_plan_unsupported');
  assert.equal((await f.make({ enabled: false }).transcribe(f)).code, 'voice_disabled');
  const f2 = fixture(t); assert.equal((await f2.make({ request: async () => ({ recognition_text: ' ' }) }).transcribe(f2)).code, 'voice_asr_empty');
});

test('concurrent duplicate, process interruption, timeout and corrupt cache never cause automatic repeat upload', async t => {
  const f = fixture(t); let release, calls = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const request = async () => { calls++; await wait; return { recognition_text: 'confirmed later' }; };
  const voice = f.make({ request }); const first = voice.transcribe(f), second = voice.transcribe(f);
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(calls, 1);
  assert.equal((await f.make({ request }).transcribe(f)).code, 'voice_asr_interrupted');
  release(); assert.deepEqual(await first, await second); assert.equal(calls, 1);
  fs.writeFileSync(path.join(voice.dir, fs.readdirSync(voice.dir)[0]), 'broken');
  assert.equal((await f.make({ request }).transcribe(f)).code, 'voice_cache_invalid'); assert.equal(calls, 1);
  const f2 = fixture(t); let timeouts = 0;
  const late = async () => { timeouts++; await new Promise(resolve => setTimeout(resolve, 30)); return { recognition_text: 'late text' }; };
  const timed = f2.make({ request: late, requestTimeoutMs: 2 });
  assert.equal((await timed.transcribe(f2)).code, 'voice_asr_timeout');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await timed.transcribe(f2)).code, 'voice_asr_timeout'); assert.equal(timeouts, 1);
});

test('existing Lark transport keeps encoded audio off argv and uses bot stdin with the request timeout', async t => {
  const f = fixture(t); let call;
  const request = createLarkTransport('lark-fixture', { timeoutMs: 45000, run: async (exe, args, options) => {
    call = { exe, args, options }; return { code: 0, stdout: JSON.stringify({ code: 0, data: { recognition_text: 'hello' } }) };
  } });
  await f.make({ request }).transcribe(f);
  assert.equal(call.args[call.args.indexOf('--data') + 1], '-'); assert.equal(call.args[call.args.indexOf('--as') + 1], 'bot');
  assert.equal(call.args[call.args.indexOf('--profile') + 1], 'chosen'); assert.equal(call.options.timeoutMs, 45000);
  assert.ok(JSON.parse(call.options.input).speech.speech.length > 8000);
  assert.equal(call.args.some(arg => arg.includes('recognition_text') || arg.includes('speech_to_text:speech')), false);
});

test('local child process limits terminate timed-out and oversized output without leaving children', async () => {
  const children = new Set();
  await assert.rejects(captureAudio(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 30, children }), { code: 'voice_conversion_timeout' });
  assert.equal(children.size, 0);
  await assert.rejects(captureAudio(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(1000))'], { maxBytes: 100, children }), { code: 'voice_output_too_large' });
  assert.equal(children.size, 0);
  await assert.rejects(captureAudio(path.join(os.tmpdir(), 'voice-nonexistent-executable'), [], { children }), { code: 'voice_tools_missing' });
  assert.equal(children.size, 0);
});

test('installed ffmpeg converts actual WAV and Ogg Opus via pipe, with no external ASR call', async t => {
  for (const exe of ['ffmpeg', 'ffprobe']) {
    const probe = spawnSync(exe, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    if (probe.status !== 0) { t.skip('ffmpeg/ffprobe are optional runtime dependencies'); return; }
  }
  const header = Buffer.alloc(44), samples = Buffer.alloc(32000);
  header.write('RIFF'); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(samples.length, 40);
  const wav = Buffer.concat([header, samples]);
  const converted = await convertVoice(wav); assert.equal(converted.durationSeconds, 1); assert.deepEqual(converted.pcm, samples);
  const opus = await captureAudio('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'wav', '-i', 'pipe:0', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], { input: wav });
  const speech = await convertVoice(opus); assert.equal(speech.durationSeconds, 1); assert.equal(speech.format, 'ogg');
});
