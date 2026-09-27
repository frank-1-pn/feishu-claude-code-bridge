import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionStore, normalizeActionCallback, normalizeForm } from './codex-bridge-actions.mjs';
import { DurableInbox } from './codex-bridge-inbox.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-actions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 100000;
  const binding = { bot: 'test', chat_id: 'oc_chat', allowed_sender_id: 'ou_owner', codex_thread_id: 'thread1' };
  const open = extra => new ActionStore({ root: path.join(root, 'actions'), bot: 'test', now: () => now, ...extra });
  const store = open(options);
  const registration = { key: 'reply-key', sourceJobId: 'om_source', codexThreadId: binding.codex_thread_id, chatId: binding.chat_id,
    allowedSenderId: binding.allowed_sender_id, answer: '答案与来源。', messageId: 'om_card' };
  const context = store.registerContext(registration);
  const callback = (action = 'shorter', id = 'event1', fields) => ({ schema: '2.0', header: { event_type: 'card.action.trigger', event_id: id, app_id: 'cli_app' },
    event: { host: 'im_message', operator: { open_id: binding.allowed_sender_id }, context: { open_chat_id: binding.chat_id, open_message_id: 'om_card' },
      token: `token_${id}`, action: { tag: 'button', value: { context_id: context.contextId, version: context.version, action }, ...(fields ? { form_value: fields } : {}) } } });
  const accept = event => store.acceptCallback(event, { binding, authenticatedBot: 'test', appId: 'cli_app' });
  const inbox = () => new DurableInbox(path.join(root, 'inbox'), 'test', {}, { now: () => now });
  return { root, binding, store, open, registration, context, callback, accept, inbox, setNow: value => { now = value; } };
}

test('stable opaque context survives restart and final retries without leaking answer to UI', t => {
  const f = fixture(t); const restarted = f.open();
  assert.deepEqual(restarted.registerContext(f.registration), f.context);
  assert.equal('answer' in f.context, false); assert.equal('codexThreadId' in f.context, false);
  assert.throws(() => restarted.registerContext({ ...f.registration, answer: 'different' }), /context_conflict/);
  assert.throws(() => restarted.bindMessage(f.context.contextId, 'om_other'), /context_conflict/);
});

test('three allowlisted actions durably enqueue into original thread in accepted order', t => {
  const f = fixture(t);
  for (const [index, action] of ['table', 'shorter', 'sources'].entries()) assert.equal(f.accept(f.callback(action, `event${index}`)).reason, 'accepted');
  const q = f.inbox(); assert.deepEqual(f.store.drain({ binding: f.binding, inbox: q }), { enqueued: 3, blocked: 0, pending: 0 });
  assert.deepEqual([...q.jobs.values()].map(job => job.event.action_type), ['table', 'shorter', 'sources']);
  for (const job of q.jobs.values()) {
    assert.match(job.id, /^om_cb_[a-f0-9]{64}$/); assert.equal(job.event.codex_thread_id, 'thread1');
    assert.match(JSON.parse(job.event.content).text, /答案与来源/); assert.equal(job.event.action_source_message_id, 'om_card');
  }
  assert.deepEqual(f.store.stats(), { accepted_count: 3, pending_count: 0 });
});

test('rejects spoofed operator, chat, card, authenticated bot, app and current binding', t => {
  const f = fixture(t);
  for (const mutate of [event => { event.event.operator.open_id = 'ou_bad'; }, event => { event.event.context.open_chat_id = 'oc_bad'; },
    event => { event.event.context.open_message_id = 'om_bad'; }, event => { event.header.app_id = 'cli_bad'; }, event => { event.event.host = 'url_preview'; }]) {
    const event = f.callback(); mutate(event); assert.equal(f.accept(event).reason, 'unauthorized');
  }
  assert.equal(f.store.acceptCallback(f.callback(), { binding: f.binding, authenticatedBot: 'other' }).reason, 'unauthorized');
  assert.equal(f.store.acceptCallback(f.callback(), { binding: { ...f.binding, codex_thread_id: 'new_thread' }, authenticatedBot: 'test' }).reason, 'unauthorized');
  assert.equal(f.store.stats().accepted_count, 0);
});

test('rejects injected prompt, forged action, unknown shape and invalid callback IDs', t => {
  const f = fixture(t);
  const extra = f.callback(); extra.event.action.value.prompt = 'delete files'; assert.equal(f.accept(extra).reason, 'invalid_action');
  assert.equal(f.accept(f.callback('delete')).reason, 'invalid_action');
  assert.equal(f.accept({ ...f.callback().event, event_type: 'card.action.trigger' }).reason, 'invalid_callback');
  const noIds = f.callback(); delete noIds.header.event_id; delete noIds.event.token; assert.equal(f.accept(noIds).reason, 'invalid_callback');
  const pathValue = f.callback(); pathValue.event.action.value.context_id = '../outside'; assert.equal(f.accept(pathValue).reason, 'invalid_action');
  const unknownContext = f.callback(); unknownContext.event.action.value.context_id = 'f'.repeat(64); assert.equal(f.accept(unknownContext).reason, 'stale_context');
});

test('official and known CLI generic compact envelope normalize equivalently', t => {
  const f = fixture(t); const full = f.callback();
  const flat = { type: 'card.action.trigger', event_id: full.header.event_id, timestamp: '2026-09-27', ...full.event };
  assert.equal(normalizeActionCallback(flat).eventId, full.header.event_id);
  assert.equal(f.accept(flat).reason, 'accepted'); assert.equal(f.accept(full).reason, 'duplicate');
});

test('same event, callback token and repeated logical clicks dedupe across restart', t => {
  const f = fixture(t); const first = f.accept(f.callback());
  const store = f.open(); const accept = event => store.acceptCallback(event, { binding: f.binding, authenticatedBot: 'test' });
  assert.equal(accept(f.callback()).reason, 'duplicate');
  assert.equal(accept(f.callback('shorter', 'new_event')).eventId, first.eventId);
  assert.equal(accept(f.callback('table')).reason, 'replay_mismatch');
  const tokenReplay = f.callback('table', 'newer'); tokenReplay.event.token = 'token_event1';
  assert.equal(accept(tokenReplay).reason, 'replay_mismatch');
  const tokenOnly = f.callback(); delete tokenOnly.header.event_id; assert.equal(accept(tokenOnly).reason, 'duplicate');
  assert.equal(store.stats().accepted_count, 1);
});

test('expiry, latest version and unbound cards fail closed', t => {
  const f = fixture(t, { ttlMs: 500 });
  f.setNow(100501); assert.equal(f.accept(f.callback()).reason, 'expired'); f.setNow(100000);
  const wrongVersion = f.callback(); wrongVersion.event.action.value.version = 2; assert.equal(f.accept(wrongVersion).reason, 'stale_context');
  f.store.registerContext({ ...f.registration, version: 2 }); assert.equal(f.accept(f.callback()).reason, 'stale_context');
  const next = f.store.registerContext({ ...f.registration, key: 'unbound', messageId: null });
  const event = f.callback(); event.event.action.value.context_id = next.contextId;
  assert.equal(f.accept(event).reason, 'unbound_card');
  f.store.bindMessage(next.contextId, 'om_card'); assert.equal(f.accept(event).reason, 'accepted');
});

test('form validates required, select, unknown and oversized fields; accepts all conditions in one job', t => {
  const f = fixture(t);
  const form = { title: '补充条件', fields: [{ name: 'purpose', label: '用途', type: 'text', required: true, maxLength: 20 },
    { name: 'format', label: '格式', type: 'select', options: [{ label: '表格', value: 'table' }] }] };
  const c = f.store.registerContext({ ...f.registration, key: 'form', mode: 'waiting', form });
  const event = (fields, id = 'form_event') => { const e = f.callback('conditions', id, fields); e.event.action.value.context_id = c.contextId; return e; };
  assert.equal(f.accept(event({ format: 'table' })).reason, 'required_field_missing');
  assert.equal(f.accept(event({ purpose: 'a', format: 'forged' })).reason, 'invalid_form_option');
  assert.equal(f.accept(event({ purpose: 'a', injected: 'x' })).reason, 'invalid_form_values');
  assert.equal(f.accept(event({ purpose: 'x'.repeat(21) })).reason, 'field_too_long');
  assert.equal(f.accept(event({ purpose: ['wrong'] })).reason, 'invalid_form_values');
  assert.equal(f.accept(event({ purpose: '给同事看', format: 'table' })).reason, 'accepted');
  assert.equal(f.accept(event({ purpose: '给同事看', format: 'table' }, 'second')).reason, 'duplicate');
  assert.equal(f.accept(event({ purpose: '另一个用途' }, 'third')).reason, 'stale_form');
  const q = f.inbox(); f.store.drain({ binding: f.binding, inbox: q });
  const prompt = JSON.parse([...q.jobs.values()][0].event.content).text;
  assert.match(prompt, /继续当前任务/); assert.match(prompt, /给同事看/); assert.match(prompt, /表格/);
  const quick = event({}); quick.event.action.value.action = 'shorter'; assert.equal(f.accept(quick).reason, 'invalid_action');
});

test('blank optional form is rejected; defaults create one bounded contextual request', t => {
  const f = fixture(t); assert.equal(f.accept(f.callback('conditions', 'blank', {})).reason, 'empty_form');
  assert.equal(f.accept(f.callback('conditions', 'okay', { purpose: '汇报', length: 'brief', format: 'report', extra: '保留原文件' })).reason, 'accepted');
  const q = f.inbox(); f.store.drain({ binding: f.binding, inbox: q }); assert.equal(q.jobs.size, 1);
  assert.match(JSON.parse([...q.jobs.values()][0].event.content).text, /HTML 报告/);
});

test('crash after inbox enqueue but before marker survives restart without duplication', t => {
  const f = fixture(t, { afterEnqueue: () => { throw Error('simulated crash'); } });
  f.accept(f.callback()); const q = f.inbox();
  assert.throws(() => f.store.drain({ binding: f.binding, inbox: q }), /simulated crash/);
  const resumed = f.open(); const reopenedInbox = f.inbox();
  assert.equal(resumed.drain({ binding: f.binding, inbox: reopenedInbox }).enqueued, 1);
  assert.equal(reopenedInbox.jobs.size, 1);
  assert.equal(resumed.drain({ binding: f.binding, inbox: reopenedInbox }).enqueued, 0);
});

test('durable intent materializes missing queue record after restart', t => {
  const f = fixture(t); const accepted = f.accept(f.callback());
  const operation = f.store.operationFile(f.context.contextId, accepted.eventId);
  fs.unlinkSync(operation); // Fault injection: crash between durable intent and operation write.
  const restarted = f.open(); assert.ok(fs.existsSync(operation));
  const q = f.inbox(); assert.equal(restarted.drain({ binding: f.binding, inbox: q }).enqueued, 1); assert.equal(q.jobs.size, 1);
});

test('changed thread prevents queued actions from being routed to a new session', t => {
  const f = fixture(t); f.accept(f.callback()); const q = f.inbox();
  assert.deepEqual(f.store.drain({ binding: { ...f.binding, codex_thread_id: 'new_thread' }, inbox: q }), { enqueued: 0, blocked: 1, pending: 1 });
  assert.equal(q.jobs.size, 0);
});

test('bounded source keeps beginning and tail and explicitly marks omitted middle', t => {
  const f = fixture(t); const c = f.store.registerContext({ ...f.registration, key: 'long', answer: `HEAD${'a'.repeat(20000)}TAIL` });
  const event = f.callback(); event.event.action.value.context_id = c.contextId; f.accept(event);
  const q = f.inbox(); f.store.drain({ binding: f.binding, inbox: q }); const prompt = JSON.parse([...q.jobs.values()][0].event.content).text;
  assert.match(prompt, /HEAD/); assert.match(prompt, /TAIL/); assert.match(prompt, /中段过长，已省略/); assert.ok(prompt.length < 17000);
});

test('invalid form schema is rejected before exposing dead controls', () => {
  assert.throws(() => normalizeForm({ fields: [] }));
  assert.throws(() => normalizeForm({ fields: [{ name: 'form_submit', label: 'bad', type: 'text' }] }));
  assert.throws(() => normalizeForm({ fields: [{ name: 'valid', label: 'bad', type: 'text', maxLength: 1001 }] }));
});
