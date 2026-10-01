import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeInteractions } from './codex-bridge-native-runtime.mjs';
import { DurableInbox } from './codex-bridge-inbox.mjs';
import { DurableOutbound } from './codex-bridge-outbound.mjs';
import { bindingSnapshot } from './codex-bridge-ux.mjs';

function fixture(t, { voiceEnabled = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-runtime-'));
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const binding = { bot: 'fixture', profile: 'chosen', chat_id: 'oc_fixture', allowed_sender_id: 'ou_fixture', codex_thread_id: 'thread-fixture', voice_enabled: voiceEnabled };
  const rollout = path.join(root, 'rollout.jsonl'); fs.writeFileSync(rollout, '');
  const calls = [], sent = [], injected = [], patches = [], server = new Map(); let clock = 1000000, sequence = 0, native, inbox, outbound;
  let taskCall = async () => ({ task: { guid: '00000000-0000-0000-0000-000000000001', url: 'https://applink.feishu.cn/client/todo/detail?guid=00000000-0000-0000-0000-000000000001' } });
  let transcript = '给药 2 毫克，每天一次。', patchHook = async () => {};
  const request = async (_binding, args, cwd) => {
    calls.push(args);
    if (args[1] === '+messages-resources-download') {
      const saved_path = path.join(cwd, 'audio-resource'); fs.writeFileSync(saved_path, 'OggSfixture'); return { saved_path };
    }
    if (args[0] === 'task') return taskCall();
    if (args[2] === '/open-apis/speech_to_text/v1/speech/file_recognize') return { recognition_text: transcript };
    if (args[1] === 'PATCH') { patches.push(JSON.parse(JSON.parse(args.at(-1)).content)); await patchHook(); return {}; }
    throw Error('unexpected network request');
  };
  const sendMessage = async payload => {
    if (server.has(payload.key)) { assert.deepEqual(server.get(payload.key).payload, payload); return server.get(payload.key).result; }
    const result = { message_id: `om_sent${++sequence}` }; server.set(payload.key, { payload, result }); sent.push(payload); return result;
  };
  const restart = () => {
    outbound = new DurableOutbound(path.join(root, 'out'), binding, request, { sendMessage, now: () => clock });
    inbox = new DurableInbox(path.join(root, 'inbox'), binding.bot, {
      prepare: event => native.prepare(event), target: async () => ({ rollout }), inject: async job => { injected.push(job.prepared); },
    }, { now: () => clock });
    native = new NativeInteractions({ root: path.join(root, 'native'), binding, downloadRoot: path.join(root, 'download'),
      request, outbound, getInbox: () => inbox, getRoute: jobId => ({ mode: 'quote', messageId: jobId, chatId: binding.chat_id }) });
    native.actions.now = () => clock; native.tasks.now = () => clock;
    native.voice.options.run = async exe => exe === 'ffprobe' ? Buffer.from('{"streams":[{"codec_type":"audio"}]}') : Buffer.alloc(32000);
    return native;
  };
  restart();
  const add = (type = 'text', id = 'om_source') => inbox.enqueue({ message_id: id, message_type: type, chat_id: binding.chat_id,
    sender_id: binding.allowed_sender_id, content: type === 'audio' ? JSON.stringify({ file_key: 'file_fixture' }) : '请整理', bridge_binding: bindingSnapshot(binding) });
  const contexts = kind => fs.readdirSync(native.actions.contexts).map(name => JSON.parse(fs.readFileSync(path.join(native.actions.contexts, name), 'utf8'))).filter(context => !kind || context.kind === kind);
  const callback = (contextId, values = {}, overrides = {}) => {
    const context = JSON.parse(fs.readFileSync(native.actions.contextFile(contextId), 'utf8'));
    return { type: 'card.action.trigger', event_id: `evt_${++sequence}`, operator: { open_id: binding.allowed_sender_id },
      context: { open_chat_id: binding.chat_id, open_message_id: context.messageId }, action: { tag: 'button', value: { bridge_native: 'v1', context_id: contextId }, form_value: values }, ...overrides };
  };
  const openTask = async (job = add()) => {
    const control = native.taskButton({ jobId: job.id, replyKey: `reply:${job.id}`, text: '核对库存\n\n完整来源答复。' });
    native.bindMessage(control.contextId, 'om_answer');
    assert.equal(native.acceptCallback(callback(control.contextId)).accepted, true); await native.drain();
    return contexts('task_create').at(-1);
  };
  return { root, binding, calls, sent, injected, patches, add, contexts, callback, restart, openTask,
    get native() { return native; }, get inbox() { return inbox; },
    advance: ms => { clock += ms; }, task: fn => { taskCall = fn; }, transcript: value => { transcript = value; }, onPatch: fn => { patchHook = fn; } };
}

test('disabled ASR downloads and preserves audio, replies once, and closes actual inbox without model dispatch', async t => {
  const f = fixture(t), job = f.add('audio');
  await f.inbox.dispatchOne(); assert.equal(job.status, 'done'); assert.equal(job.localReply, true);
  assert.equal(f.injected.length, 0); assert.equal(f.calls.filter(args => args[2]?.includes('speech_to_text')).length, 0);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].content.text, /语音转写未启用/); assert.equal(f.sent[0].route.messageId, job.id);
  const audio = JSON.parse(fs.readFileSync(path.join(f.root, 'download', f.binding.bot,
    fs.readdirSync(path.join(f.root, 'download', f.binding.bot))[0], 'resource-0.json'), 'utf8')).saved_path;
  assert.equal(fs.readFileSync(audio, 'utf8'), 'OggSfixture');
  f.restart(); await f.inbox.dispatchOne(); assert.equal(f.sent.length, 1); assert.equal(f.injected.length, 0);
});

test('actual inbox waits for editable voice confirmation; crash after queue and callback replay execute once', async t => {
  const f = fixture(t, { voiceEnabled: true }), original = f.add('audio');
  await f.inbox.dispatchOne(); assert.equal(original.status, 'waiting_input'); assert.equal(f.injected.length, 0);
  const voiceContext = f.contexts('voice_confirm')[0]; assert.ok(voiceContext.messageId);
  assert.match(JSON.stringify(f.patches[0]), /药名、剂量、单位/);
  const correction = '完全修正：请整理明天的会议，不涉及给药。';
  const click = f.callback(voiceContext.contextId, { transcript_1: correction });
  assert.equal(f.native.acceptCallback(click).accepted, true);
  f.native.actions.afterHandle = () => { throw Error('crash after inbox checkpoint'); };
  await f.native.drain(); assert.equal(original.status, 'queued'); assert.ok(original.nativeVoiceOperation);
  assert.equal(original.event.message_type, 'audio'); assert.match(original.event.content, /file_fixture/);
  assert.equal(original.prepared.bridgeDisposition, undefined); assert.match(original.prepared.content, /完全修正/); assert.ok(!original.prepared.content.includes('2 毫克'));
  f.restart(); assert.equal(f.inbox.jobs.get(original.id).status, 'queued');
  await f.inbox.dispatchOne(); assert.equal(f.injected.length, 1); assert.equal(f.injected[0].voiceConfirmed, true);
  f.advance(10000); assert.equal(f.native.acceptCallback(click).duplicate, true); await f.native.drain();
  await f.inbox.dispatchOne(); assert.equal(f.injected.length, 1); assert.equal(f.inbox.jobs.get(original.id).status, 'submitted');
  assert.equal(f.native.actions.stats().native_action_done_count, 1);
});

test('foreign callback and rebound source cannot confirm voice or create tasks', async t => {
  const f = fixture(t, { voiceEnabled: true }), job = f.add('audio'); await f.inbox.dispatchOne();
  const context = f.contexts('voice_confirm')[0];
  assert.equal(f.native.acceptCallback(f.callback(context.contextId, { transcript_1: '执行' }, { operator: { open_id: 'ou_other' } })).accepted, false);
  const click = f.callback(context.contextId, { transcript_1: '只整理' }); assert.equal(f.native.acceptCallback(click).accepted, true);
  job.event.bridge_binding.codex_thread_id = 'other'; f.inbox.save(job); await f.native.drain();
  assert.equal(f.injected.length, 0); assert.equal(job.status, 'waiting_input');
  assert.equal(f.native.actions.stats().native_action_blocked_count, 1);
  assert.throws(() => f.native.taskButton({ jobId: job.id, replyKey: 'bad', text: 'task' }), { code: 'native_source_binding_mismatch' });
});

test('a callback arriving before prepare checkpoints waiting state remains pending then resumes safely', async t => {
  const f = fixture(t, { voiceEnabled: true }), job = f.add('audio');
  f.onPatch(async () => {
    const context = f.contexts('voice_confirm')[0];
    assert.equal(job.status, 'queued'); assert.equal(job.prepared, undefined);
    assert.equal(f.native.acceptCallback(f.callback(context.contextId, { transcript_1: '已核对后的文字' })).accepted, true);
    await f.native.drain(); assert.equal(f.native.actions.stats().native_action_pending_count, 1);
  });
  await f.inbox.dispatchOne(); assert.equal(job.status, 'waiting_input'); assert.equal(f.injected.length, 0);
  f.advance(6000); await f.native.drain(); assert.equal(job.status, 'queued');
  await f.inbox.dispatchOne(); assert.equal(f.injected.length, 1); assert.match(f.injected[0].content, /已核对后的文字/);
});

test('overlong voice confirmation is not truncated and never reaches the model', async t => {
  const f = fixture(t, { voiceEnabled: true }); f.transcript('字'.repeat(6001)); const job = f.add('audio');
  await f.inbox.dispatchOne(); assert.equal(job.status, 'done'); assert.equal(f.contexts('voice_confirm').length, 0);
  assert.match(f.sent[0].content.text, /未截断或执行/); assert.equal(f.injected.length, 0);
});

test('native task button opens a bound form, then creates for self and delivers the task link once', async t => {
  const f = fixture(t), form = await f.openTask();
  assert.ok(form.messageId); assert.match(JSON.stringify(f.patches[0]), /北京时间/);
  assert.match(JSON.stringify(f.patches[0]), /picker_datetime/);
  const click = f.callback(form.contextId, { summary: '明天核对库存', due: '2026-10-01 09:00 +0800', reminder: '15' });
  assert.equal(f.native.acceptCallback(click).accepted, true); await f.native.drain();
  const taskCalls = f.calls.filter(args => args[0] === 'task'); assert.equal(taskCalls.length, 1);
  const body = JSON.parse(taskCalls[0].at(-1)); assert.deepEqual(body.members, [{ id: f.binding.allowed_sender_id, type: 'user', role: 'assignee' }]);
  assert.equal(body.due.timestamp, String(Date.parse('2026-10-01T09:00:00+08:00'))); assert.deepEqual(body.reminders, [{ relative_fire_minute: 15 }]);
  assert.match(f.sent.at(-1).content.text, /打开待办/); assert.equal(f.sent.at(-1).route.messageId, 'om_source'); assert.equal(f.injected.length, 0);
  f.restart(); assert.equal(f.native.acceptCallback(click).duplicate, true); await f.native.drain();
  assert.equal(f.calls.filter(args => args[0] === 'task').length, 1); assert.equal(f.sent.filter(value => value.msgType === 'text').length, 1);
});

test('task transient failure stays pending and retries its original operation without claiming done', async t => {
  const f = fixture(t); let calls = 0;
  f.task(async () => { if (++calls === 1) throw Object.assign(Error('offline'), { code: 'ECONNRESET' }); return { task: { guid: '00000000-0000-0000-0000-000000000001', url: 'https://applink.feishu.cn/client/todo/detail?guid=00000000-0000-0000-0000-000000000001' } }; });
  const form = await f.openTask(); assert.equal(f.native.acceptCallback(f.callback(form.contextId, { summary: '检查', due: '', reminder: 'none' })).accepted, true);
  await f.native.drain(); assert.equal(f.native.actions.stats().native_action_pending_count, 1); assert.equal(f.sent.filter(value => value.msgType === 'text').length, 0);
  f.restart(); f.advance(10000); await f.native.drain(); assert.equal(calls, 2); assert.equal(f.native.actions.stats().native_action_pending_count, 0);
  const requests = f.calls.filter(args => args[0] === 'task'); assert.deepEqual(requests[0], requests[1]);
});

test('task permanent and expired-uncertain results notify once and stop automatic creation', async t => {
  for (const uncertain of [false, true]) {
    const f = fixture(t);
    f.task(async () => { throw Object.assign(Error('not retained'), uncertain ? { code: 'ETIMEDOUT' } : { apiCode: 99991672, type: 'permission' }); });
    const form = await f.openTask(); const click = f.callback(form.contextId, { summary: '检查', due: '', reminder: 'none' });
    assert.equal(f.native.acceptCallback(click).accepted, true); await f.native.drain();
    if (uncertain) { f.advance(250000); await f.native.drain(); }
    assert.equal(f.native.actions.stats().native_action_blocked_count, 1); assert.equal(f.calls.filter(args => args[0] === 'task').length, 1);
    const notice = f.sent.filter(value => value.msgType === 'text'); assert.equal(notice.length, 1);
    assert.match(notice[0].content.text, uncertain ? /结果尚未确认/ : /权限/);
    f.restart(); f.native.acceptCallback(click); await f.native.drain(); assert.equal(f.sent.filter(value => value.msgType === 'text').length, 1);
  }
});

test('invalid task date offers a fresh correction form without a create API call', async t => {
  const f = fixture(t), form = await f.openTask();
  assert.equal(f.native.acceptCallback(f.callback(form.contextId, { summary: '检查', due: 'wrong', reminder: '15' })).accepted, true);
  await f.native.drain(); assert.equal(f.calls.filter(args => args[0] === 'task').length, 0);
  const correction = f.contexts('task_create').find(context => context.contextId !== form.contextId); assert.ok(correction);
  assert.match(JSON.stringify(f.patches.at(-1)), /尚未创建待办/);
  assert.equal(f.native.acceptCallback(f.callback(correction.contextId, { summary: '检查', due: '', reminder: 'none' })).accepted, true);
  await f.native.drain(); assert.equal(f.calls.filter(args => args[0] === 'task').length, 1);
});

test('regular text uses normal preparation and actual inbox dispatch without native API calls', async t => {
  const f = fixture(t), job = f.add(); await f.inbox.dispatchOne();
  assert.equal(job.status, 'submitted'); assert.equal(f.injected.length, 1); assert.equal(f.injected[0].content, '请整理');
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
  await assert.rejects(f.native.prepare({ ...job.event, sender_id: 'ou_other' }), { code: 'native_source_binding_mismatch' });
});

test('all-human group audio is visible with verified attachment reference and no preclassification ASR or UI',async t=>{
 const f=fixture(t,{voiceEnabled:true});Object.assign(f.binding,{group_access:'all_group_humans',bot_open_id:'ou_bot'});f.restart();
 const job=f.inbox.enqueue({type:'im.message.receive_v1',message_id:'om_group_audio',message_type:'audio',chat_id:f.binding.chat_id,
   chat_type:'group',sender_type:'user',sender_id:'ou_member',content:JSON.stringify({file_key:'file_fixture'}),bridge_binding:bindingSnapshot(f.binding)});
 await f.inbox.dispatchOne();assert.equal(job.status,'submitted');assert.equal(f.injected.length,1);assert.equal(f.sent.length,0);
 assert.match(f.injected[0].content,/已下载文件/);assert.match(f.injected[0].content,/尚无已确认文字/);
 assert.equal(f.calls.filter(args=>args[2]?.includes('speech_to_text')).length,0);assert.equal(f.contexts('voice_confirm').length,0);
});
test('failed group attachment remains visible without using rejected paths or emitting fallback',async t=>{
 const f=fixture(t);Object.assign(f.binding,{group_access:'all_group_humans',bot_open_id:'ou_bot'});f.restart();
 const job=f.inbox.enqueue({type:'im.message.receive_v1',message_id:'om_group_badfile',message_type:'file',chat_id:f.binding.chat_id,
   chat_type:'group',sender_type:'user',sender_id:'ou_member',content:JSON.stringify({file_name:'missing'}),bridge_binding:bindingSnapshot(f.binding)});
 await f.inbox.dispatchOne();assert.equal(job.status,'submitted');assert.equal(f.injected.length,1);assert.equal(f.sent.length,0);
 assert.equal(f.injected[0].attachmentPreparationError,'attachment_resource_key_missing');assert.match(f.injected[0].content,/不能假装已读/);
});
test('group visibility fallback never exposes or uses a rejected attachment path',async t=>{
 const f=fixture(t);Object.assign(f.binding,{group_access:'all_group_humans',bot_open_id:'ou_bot'});f.restart();
 const outside=path.join(f.root,'private-outside.txt');fs.writeFileSync(outside,'private outside contents');
 f.native.request=async()=>({saved_path:outside});
 const job=f.inbox.enqueue({type:'im.message.receive_v1',message_id:'om_group_escape',message_type:'file',chat_id:f.binding.chat_id,
   chat_type:'group',sender_type:'user',sender_id:'ou_member',content:JSON.stringify({file_key:'file_fixture'}),bridge_binding:bindingSnapshot(f.binding)});
 await f.inbox.dispatchOne();assert.equal(job.status,'submitted');assert.equal(f.sent.length,0);assert.equal(f.injected.length,1);
 assert.equal(f.injected[0].attachmentPreparationError,'attachment_outside_download_root');
 assert.ok(!f.injected[0].content.includes(outside));assert.ok(!f.injected[0].content.includes('private outside contents'));
});
