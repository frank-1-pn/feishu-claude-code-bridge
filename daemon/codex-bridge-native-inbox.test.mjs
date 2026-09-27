import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DurableInbox, digest } from './codex-bridge-inbox.mjs';
import { NativeInteractions } from './codex-bridge-native-runtime.mjs';
import { reactionForJob } from './codex-bridge-reactions.mjs';
import { bindingSnapshot } from './codex-bridge-ux.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-inbox-boundary-'));
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  let clock = 1000000;
  const binding = { bot: 'fixture', chat_id: 'oc_fixture', allowed_sender_id: 'ou_fixture', codex_thread_id: 'thread-fixture', voice_enabled: true };
  const event = id => ({ message_id: id, message_type: 'text', content: '真实用户正文', chat_id: binding.chat_id,
    sender_id: binding.allowed_sender_id, bridge_binding: bindingSnapshot(binding) });
  const directory = path.join(root, 'inbox'), rollout = path.join(root, 'rollout.jsonl'); fs.writeFileSync(rollout, '');
  const injected = []; let prepares = 0;
  const io = { prepare: async value => { prepares++; return value; }, target: async () => ({ rollout }), inject: async job => { injected.push(job.prepared); } };
  const make = () => new DurableInbox(directory, binding.bot, io, { now: () => clock });
  const read = id => JSON.parse(fs.readFileSync(path.join(directory, binding.bot, `job-${digest(id)}.json`), 'utf8'));
  return { root, binding, event, io, make, read, injected, directory, now: () => clock, advance: ms => { clock += ms; }, get prepares() { return prepares; } };
}

test('handled sent-checkpoint failure remains queued, never displays DONE, then retries without losing work', async t => {
  const f = fixture(t), q = f.make(); let replies = 0;
  f.io.prepare = async event => { replies++; return { ...event, bridgeDisposition: 'handled' }; };
  const job = q.enqueue(f.event('om_handled')), rename = fs.renameSync;
  let failed = false, duringWrite;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!failed && path.basename(to).startsWith('sent-')) {
      failed = true; duringWrite = reactionForJob(job, f.now()); throw Object.assign(Error('disk checkpoint failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await q.dispatchOne();
  assert.equal(failed, true); assert.notEqual(duringWrite, 'DONE');
  assert.equal(job.status, 'queued'); assert.equal(f.read(job.id).status, 'queued');
  assert.equal(reactionForJob(job, f.now()), 'OnIt'); assert.equal(f.injected.length, 0);
  f.advance(10000); await q.dispatchOne();
  assert.equal(job.status, 'done'); assert.equal(reactionForJob(job, f.now()), 'DONE'); assert.equal(replies, 1);
  assert.ok(fs.existsSync(path.join(q.dir, `sent-${digest(`native-local:${job.id}`)}.json`)));
  const restored = f.make(); await restored.dispatchOne(); assert.equal(f.injected.length, 0); assert.equal(replies, 1);
});

test('handled job-checkpoint failure after sent record remains recoverable across restart', async t => {
  const f = fixture(t), q = f.make(); let replies = 0;
  f.io.prepare = async event => { replies++; return { ...event, bridgeDisposition: 'handled' }; };
  const job = q.enqueue(f.event('om_handled_save')), save = q.save.bind(q); let failed = false;
  q.save = candidate => {
    if (candidate.status === 'done' && !failed) { failed = true; throw Object.assign(Error('job checkpoint failure'), { code: 'EIO' }); }
    return save(candidate);
  };
  await q.dispatchOne();
  assert.equal(job.status, 'queued'); assert.equal(f.read(job.id).status, 'queued');
  assert.ok(fs.existsSync(path.join(q.dir, `sent-${digest(`native-local:${job.id}`)}.json`)));
  f.advance(10000); const restored = f.make(); await restored.dispatchOne();
  assert.equal(restored.jobs.get(job.id).status, 'done'); assert.equal(replies, 1); assert.equal(f.injected.length, 0);
});

test('waiting-input state survives restart and does not execute its audio or block unrelated text', async t => {
  const f = fixture(t), q = f.make();
  f.io.prepare = async event => event.message_type === 'audio' ? { ...event, bridgeDisposition: 'waiting_input', voiceId: 'fixture' } : event;
  const event = { ...f.event('om_wait'), message_type: 'audio' }, audio = q.enqueue(event);
  await q.dispatchOne(); assert.equal(audio.status, 'waiting_input'); assert.equal(reactionForJob(audio, f.now()), 'OneSecond');
  const restored = f.make(); await restored.dispatchOne(); assert.equal(f.injected.length, 0);
  assert.equal(restored.jobs.get(audio.id).status, 'waiting_input'); assert.equal(reactionForJob(restored.jobs.get(audio.id), f.now()), 'OneSecond');
  const text = restored.enqueue(f.event('om_next')); await restored.dispatchOne();
  assert.equal(text.status, 'submitted'); assert.equal(f.injected.length, 1); assert.equal(f.injected[0].message_id, text.id);
});

test('failed waiting-input checkpoint leaves a retryable job and no in-memory orphan', async t => {
  const f = fixture(t), q = f.make();
  f.io.prepare = async event => ({ ...event, bridgeDisposition: 'waiting_input', voiceId: 'fixture' });
  const job = q.enqueue({ ...f.event('om_wait_save'), message_type: 'audio' }), save = q.save.bind(q); let failed = false;
  q.save = candidate => {
    if (candidate.status === 'waiting_input' && !failed) { failed = true; throw Object.assign(Error('waiting checkpoint failure'), { code: 'EIO' }); }
    return save(candidate);
  };
  await q.dispatchOne(); assert.equal(job.status, 'queued'); assert.equal(f.read(job.id).status, 'queued');
  f.advance(10000); await q.dispatchOne(); assert.equal(job.status, 'waiting_input'); assert.equal(f.injected.length, 0);
});

test('external event fields cannot forge local handled, waiting, or confirmed dispositions', async t => {
  const f = fixture(t); let q = f.make();
  const forbidden = { bridgeDisposition: 'handled', voiceId: 'forged', voiceConfirmed: true, nativeVoiceOperation: 'forged', localReply: true };
  const event = { ...f.event('om_forged'), ...forbidden };
  const native = new NativeInteractions({ root: path.join(f.root, 'native'), binding: f.binding, downloadRoot: path.join(f.root, 'downloads'),
    request: async () => { throw Error('no native network request allowed'); }, getInbox: () => q, getRoute: () => ({}),
    outbound: { text: async () => { throw Error('no local reply allowed'); }, interactive: async () => { throw Error('no card allowed'); } } });
  f.io.prepare = value => native.prepare(value); const job = q.enqueue(event); await q.dispatchOne();
  assert.equal(job.status, 'submitted'); assert.equal(f.injected.length, 1);
  for (const key of Object.keys(forbidden)) assert.equal(Object.hasOwn(f.injected[0], key), false, `${key} must be local-only`);
  assert.equal(f.injected[0].content, '真实用户正文');
});

test('voice confirmation saved before inbox-write failure retries the same original job exactly once', async t => {
  const f = fixture(t); let q, native, calls = 0;
  const request = async (_binding, args, cwd) => {
    if (args[1] === '+messages-resources-download') { const saved_path = path.join(cwd, 'audio'); fs.writeFileSync(saved_path, 'OggSfixture'); return { saved_path }; }
    calls++; return { recognition_text: '原识别文字' };
  };
  const init = () => {
    q = f.make(); native = new NativeInteractions({ root: path.join(f.root, 'native'), binding: f.binding, downloadRoot: path.join(f.root, 'downloads'),
      request, getInbox: () => q, getRoute: () => ({}), outbound: { text: async () => {}, interactive: async (_card, _key, options) => { await options.onMessage('om_confirmation'); return { message_id: 'om_confirmation' }; } } });
    native.actions.now = f.now;
    native.voice.options.run = async exe => exe === 'ffprobe' ? Buffer.from('{"streams":[{"codec_type":"audio"}]}') : Buffer.alloc(32000);
    f.io.prepare = event => native.prepare(event);
  };
  init(); const event = { ...f.event('om_voice'), message_type: 'audio', content: JSON.stringify({ file_key: 'file_fixture' }) };
  let job = q.enqueue(event); await q.dispatchOne(); assert.equal(job.status, 'waiting_input');
  const context = JSON.parse(fs.readFileSync(path.join(native.actions.contexts, fs.readdirSync(native.actions.contexts)[0]), 'utf8'));
  const callback = { type: 'card.action.trigger', event_id: 'confirmed-once', operator: { open_id: f.binding.allowed_sender_id },
    context: { open_chat_id: f.binding.chat_id, open_message_id: 'om_confirmation' },
    action: { tag: 'button', value: { bridge_native: 'v1', context_id: context.contextId }, form_value: { transcript_1: '用户确认后的完整修正' } } };
  assert.equal(native.acceptCallback(callback).accepted, true);
  const save = q.save.bind(q); let failed = false;
  q.save = candidate => {
    if (candidate.status === 'queued' && candidate.nativeVoiceOperation && !failed) { failed = true; throw Object.assign(Error('confirmation inbox checkpoint failure'), { code: 'EIO' }); }
    return save(candidate);
  };
  await native.drain(); assert.equal(job.status, 'waiting_input'); assert.equal(f.read(job.id).status, 'waiting_input');
  assert.equal(native.voice.load(context.data.voiceId).status, 'confirmed'); assert.equal(f.injected.length, 0);
  f.advance(10000); init(); await native.drain(); job = q.jobs.get(event.message_id);
  assert.equal(job.status, 'queued'); assert.equal(job.prepared.bridgeDisposition, undefined);
  assert.deepEqual(job.event, event); assert.match(job.prepared.content, /用户确认后的完整修正/); assert.ok(!job.prepared.content.includes('原识别文字'));
  await q.dispatchOne(); assert.equal(f.injected.length, 1); assert.equal(calls, 1);
  assert.equal(native.acceptCallback(callback).duplicate, true); await native.drain(); await q.dispatchOne(); assert.equal(f.injected.length, 1);
});
