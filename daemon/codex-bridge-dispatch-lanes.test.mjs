import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableInbox, digest } from './codex-bridge-inbox.mjs';
import { hydrateNativeContext, prepareDispatchNativeContext, dispatchNativeContextVerified, nativeContextVerified } from './codex-bridge-native-context.mjs';
import { bindingSnapshot } from './codex-bridge-ux.mjs';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-lanes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rollout = path.join(root, 'rollout.jsonl'); fs.writeFileSync(rollout, '');
  const injected = [], prepared = []; let now = 1000;
  const io = { prepare: async event => { prepared.push(event.message_id); return event; },
    target: async () => ({ rollout }), inject: async job => { injected.push(job.id); }, ...overrides };
  const open = () => new DurableInbox(root, 'fixture', io, { now: () => now });
  const q = open();
  const enqueue = (id, sender = 'alice', extra = {}) => q.enqueue({ message_id: `om_${id}`, chat_id: 'oc_group',
    sender_id: `ou_${sender}`, sender_type: 'user', message_type: 'text', content: '{"text":"request"}', ...extra });
  const defer = job => { job.retryAt = 10000; q.save(job); return job; };
  const read = job => JSON.parse(fs.readFileSync(path.join(q.dir, `job-${digest(job.id)}.json`), 'utf8'));
  return { q, io, open, enqueue, defer, read, injected, prepared, setNow: value => { now = value; } };
}

test('a preparation retry delays its lane while another real sender continues', async t => {
  const f = fixture(t, { prepare: async event => {
    if (event.message_id === 'om_attachment') throw Error('temporary download failure');
    return event;
  } });
  const attachment = f.enqueue('attachment', 'alice', { message_type: 'image' });
  f.enqueue('other', 'bob'); f.enqueue('supplement', 'alice');
  assert.equal(await f.q.dispatchOne(), true); assert.ok(attachment.retryAt > 1000);
  assert.equal(await f.q.dispatchOne(), true); assert.deepEqual(f.injected, ['om_other']);
  assert.equal(await f.q.dispatchOne(), false); assert.equal(attachment.attempts, 1);
  assert.equal(f.q.jobs.get('om_supplement').status, 'queued');
});

test('retry expiration resumes the delayed sender in original arrival order', async t => {
  const f = fixture(t); f.defer(f.enqueue('attachment', 'alice', { message_type: 'file' }));
  f.enqueue('supplement', 'alice'); f.enqueue('other', 'bob');
  await f.q.dispatchOne(); f.setNow(10000); await f.q.dispatchOne(); await f.q.dispatchOne();
  assert.deepEqual(f.injected, ['om_other', 'om_attachment', 'om_supplement']);
});

for (const [relation, value] of [['parent_id', 'om_attachment'], ['root_id', 'om_attachment'],
  ['reply_to', 'om_attachment'], ['thread_id', 'omt_topic']]) {
  test(`${relation} keeps another sender's attachment context behind its original`, async t => {
    const f = fixture(t);
    f.defer(f.enqueue('attachment', 'alice', relation === 'thread_id' ? { thread_id: value } : {}));
    f.enqueue('supplement', 'bob', { [relation]: value }); f.enqueue('independent', 'carol');
    await f.q.dispatchOne(); assert.deepEqual(f.injected, ['om_independent']);
    assert.equal(await f.q.dispatchOne(), false);
  });
}

test('a blocked ready supplement also blocks its own later reply across senders', async t => {
  const f = fixture(t); f.defer(f.enqueue('attachment', 'alice'));
  f.enqueue('supplement', 'alice'); f.enqueue('reply', 'bob', { parent_id: 'om_supplement' });
  f.enqueue('independent', 'carol'); await f.q.dispatchOne();
  assert.deepEqual(f.injected, ['om_independent']); assert.equal(await f.q.dispatchOne(), false);
});

test('reply graph resolves transitive ancestry through already submitted history', async t => {
  const f = fixture(t); const root = f.enqueue('root', 'david'); root.status = 'done'; f.q.save(root);
  f.defer(f.enqueue('attachment', 'alice', { parent_id: root.id }));
  const middle = f.enqueue('middle', 'erin', { parent_id: root.id }); middle.status = 'submitted'; f.q.save(middle);
  f.enqueue('supplement', 'bob', { parent_id: middle.id }); f.enqueue('independent', 'carol');
  await f.q.dispatchOne(); assert.deepEqual(f.injected, ['om_independent']);
});

test('historical sender conversations do not join all their future requests', async t => {
  const f = fixture(t); const old = f.enqueue('old', 'alice'); old.status = 'done'; f.q.save(old);
  const reply = f.enqueue('old_reply', 'bob', { parent_id: old.id }); reply.status = 'done'; f.q.save(reply);
  f.defer(f.enqueue('new_attachment', 'alice')); f.enqueue('new_request', 'bob');
  await f.q.dispatchOne(); assert.deepEqual(f.injected, ['om_new_request']);
});

test('trusted explicit independent keys permit same-sender requests while reply links still take priority', async t => {
  const keys = { om_attachment: 'request-a', om_independent: 'request-b', om_reply: 'request-c' };
  const f = fixture(t, { dependencyKey: event => keys[event.message_id] });
  f.defer(f.enqueue('attachment')); f.enqueue('independent'); f.enqueue('reply', 'alice', { root_id: 'om_attachment' });
  await f.q.dispatchOne(); assert.deepEqual(f.injected, ['om_independent']);
  assert.equal(await f.q.dispatchOne(), false);
});

test('the same trusted dependency key blocks shared work across different senders', async t => {
  const f = fixture(t, { dependencyKey: () => 'shared-request' });
  f.defer(f.enqueue('attachment', 'alice')); f.enqueue('supplement', 'bob');
  assert.equal(await f.q.dispatchOne(), false); assert.deepEqual(f.prepared, []);
});

test('external dependencyKey fields cannot split same-sender supplements', async t => {
  const f = fixture(t); f.defer(f.enqueue('attachment', 'alice', { dependencyKey: 'a' }));
  f.enqueue('supplement', 'alice', { dependencyKey: 'b', dispatchLane: { version: 1, dependencyKey: 'b' } });
  assert.equal(await f.q.dispatchOne(), false); assert.equal(f.read(f.q.jobs.get('om_supplement')).dispatchLane.dependencyKey, null);
});

test('unknown metadata and legacy jobs preserve FIFO even when later records have known senders', async t => {
  for (const legacy of [false, true]) {
    const f = fixture(t); const first = f.defer(f.enqueue('first', 'alice', legacy ? {} : { sender_id: '' }));
    if (legacy) { delete first.dispatchLane; f.q.save(first); }
    f.enqueue('second', 'bob'); const q = f.open();
    assert.equal(await q.dispatchOne(), false); assert.deepEqual(f.injected, []);
    f.setNow(10000); await q.dispatchOne(); await q.dispatchOne();
    assert.deepEqual(f.injected, ['om_first', 'om_second']);
  }
});

test('a legacy record midway through the queue remains an ordering barrier', async t => {
  const f = fixture(t); f.defer(f.enqueue('first', 'alice'));
  const legacy = f.enqueue('legacy', 'bob'); delete legacy.dispatchLane; f.q.save(legacy);
  f.enqueue('last', 'carol'); assert.equal(await f.q.dispatchOne(), false);
});

test('malformed relationship metadata conservatively retains FIFO', async t => {
  const f = fixture(t); f.defer(f.enqueue('first', 'alice', { parent_id: '../../unknown' }));
  f.enqueue('second', 'bob'); assert.equal(await f.q.dispatchOne(), false);
});

test('restart preserves accepted lanes, sequence, duplicate identity and explicit keys', async t => {
  let calls = 0; const f = fixture(t, { dependencyKey: event => { calls++; return event.message_id; } });
  const first = f.defer(f.enqueue('z')); f.enqueue('a'); f.enqueue('m', 'bob');
  f.io.dependencyKey = () => { throw Error('accepted jobs must not be reclassified'); };
  const q = f.open(); assert.equal(q.enqueue(first.event), q.jobs.get(first.id));
  await q.dispatchOne(); await q.dispatchOne(); assert.equal(await q.dispatchOne(), false);
  assert.deepEqual(f.injected, ['om_a', 'om_m']); assert.equal(calls, 3);
  f.setNow(10000); await q.dispatchOne(); assert.deepEqual(f.injected, ['om_a', 'om_m', 'om_z']);
});

test('preparation discovering a compact event reply defers injection and caches its result durably', async t => {
  let calls = 0; const f = fixture(t, { prepare: async event => {
    calls++; return event.message_id === 'om_reply' ? { ...event, root_id: 'om_attachment' } : event;
  } });
  f.defer(f.enqueue('attachment', 'alice')); const reply = f.enqueue('reply', 'bob'); f.enqueue('independent', 'carol');
  assert.equal(await f.q.dispatchOne(), true); assert.deepEqual(f.injected, []);
  assert.equal(reply.status, 'queued'); assert.equal(f.read(reply).prepared.root_id, 'om_attachment');
  const q = f.open(); await q.dispatchOne(); assert.deepEqual(f.injected, ['om_independent']);
  assert.equal(await q.dispatchOne(), false); f.setNow(10000); await q.dispatchOne(); await q.dispatchOne();
  assert.deepEqual(f.injected, ['om_independent', 'om_attachment', 'om_reply']); assert.equal(calls, 3);
});

test('a hydrated event relation also prevents injecting a previously independent candidate', async t => {
  const f = fixture(t); f.io.prepare = async event => {
    if (event.message_id === 'om_reply') f.q.jobs.get(event.message_id).event = { ...event, parent_id: 'om_attachment' };
    return event;
  };
  f.defer(f.enqueue('attachment', 'alice')); f.enqueue('reply', 'bob'); f.enqueue('other', 'carol');
  await f.q.dispatchOne(); await f.q.dispatchOne(); assert.deepEqual(f.injected, ['om_other']);
});

test('native context verification enables tentative preparation then independent dispatch', async t => {
  const f = fixture(t, { dispatchContextVerified: event => event.native_context_verified === 'verified' });
  f.io.prepare = async event => {
    f.q.jobs.get(event.message_id).event = { ...event, native_context_verified: 'verified' };
    return event;
  };
  f.defer(f.enqueue('attachment', 'alice', { native_context_verified: 'verified' }));
  f.enqueue('other', 'bob'); await f.q.dispatchOne(); assert.deepEqual(f.injected, ['om_other']);
});

test('unavailable native context never turns omitted relationships into independent submission or a busy loop', async t => {
  const f = fixture(t, { dispatchContextVerified: event => event.native_context_verified === 'verified' });
  f.defer(f.enqueue('attachment', 'alice', { native_context_verified: 'verified' }));
  const other = f.enqueue('other', 'bob'); f.enqueue('last', 'carol', { native_context_verified: 'verified' });
  assert.equal(await f.q.dispatchOne(), true); assert.deepEqual(f.injected, []);
  assert.equal(f.read(other).status, 'queued'); assert.ok(f.read(other).prepared);
  const q = f.open(); assert.equal(await q.dispatchOne(), false); assert.deepEqual(f.prepared, ['om_other']);
  f.setNow(10000); await q.dispatchOne(); await q.dispatchOne(); await q.dispatchOne();
  assert.deepEqual(f.injected, ['om_attachment', 'om_other', 'om_last']);
});

test('an earlier retry lacking native context remains a conservative global ordering barrier', async t => {
  const f = fixture(t, { dispatchContextVerified: event => event.native_context_verified === 'verified' });
  f.defer(f.enqueue('attachment', 'alice')); f.enqueue('other', 'bob', { native_context_verified: 'verified' });
  assert.equal(await f.q.dispatchOne(), false); assert.deepEqual(f.prepared, []);
});

test('worker opts into native context verification before lane bypass', t => {
  const worker = fs.readFileSync(new URL('./codex-bridge-worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /dispatchContextVerified:\([^)]*job\)\s*=>\s*dispatchNativeContextVerified\(binding,job\)/);
  assert.match(worker, /prepareDispatchNativeContext\(binding,job,contextRequest\)/);
});

test('even an exact externally reproducible context digest requires a real native read and local receipt', async t => {
  const binding = { bot: 'fixture', profile: 'selected', chat_id: 'oc_group', allowed_sender_id: 'ou_alice', codex_thread_id: 'thread_fixture' };
  const original = { message_id: 'om_other', chat_id: binding.chat_id, sender_id: binding.allowed_sender_id,
    message_type: 'text', bridge_binding: bindingSnapshot(binding) };
  const apiMessage = { message_id: original.message_id, chat_id: original.chat_id, sender: { open_id: original.sender_id } };
  const forged = await hydrateNativeContext(binding, original, async () => ({ messages: [apiMessage] }));
  assert.equal(nativeContextVerified(binding, forged), true);
  let reads = 0;
  const f = fixture(t, { dependencyKey: event => event.message_id,
    dispatchContextVerified: (_event, _prepared, job) => dispatchNativeContextVerified(binding, job) });
  f.io.prepare = async event => {
    const job = f.q.jobs.get(event.message_id);
    const context = await prepareDispatchNativeContext(binding, job, async () => { reads++; throw Error('unavailable'); });
    Object.assign(job, context); f.q.save(job); return context.event;
  };
  const attachment = f.defer(f.enqueue('attachment', 'alice', { bridge_binding: bindingSnapshot(binding) }));
  const proofEvent = await hydrateNativeContext(binding, attachment.event,
    async () => ({ messages: [{ ...apiMessage, message_id: attachment.id }] }));
  attachment.event = proofEvent; attachment.dispatchContext = { version: 1, proof: proofEvent.native_context_verified }; f.q.save(attachment);
  const other = f.q.enqueue({ ...forged, dispatchContext: { version: 1, proof: forged.native_context_verified } });
  assert.equal(dispatchNativeContextVerified(binding, other), false);
  await f.q.dispatchOne(); assert.equal(reads, 1); assert.deepEqual(f.injected, []);
  assert.equal(other.event.native_context_verified, undefined); assert.equal(other.dispatchContext, null);
  assert.equal(await f.open().dispatchOne(), false);
});

test('a local native lookup receipt persists across restart but changed actor, context or binding invalidates it', async t => {
  const binding = { bot: 'fixture', profile: 'selected', chat_id: 'oc_group', allowed_sender_id: 'ou_alice', codex_thread_id: 'thread_fixture' };
  const f = fixture(t); const job = f.enqueue('source', 'alice', { bridge_binding: bindingSnapshot(binding) });
  let reads = 0; const request = async () => {
    reads++; return { messages: [{ message_id: job.id, chat_id: job.event.chat_id, sender: { open_id: job.event.sender_id }, thread_id: 'omt_topic', root_id: 'om_root', parent_id: 'om_parent' }] };
  };
  Object.assign(job, await prepareDispatchNativeContext(binding, job, request)); f.q.save(job);
  const saved = f.open().jobs.get(job.id); assert.equal(dispatchNativeContextVerified(binding, saved), true);
  await prepareDispatchNativeContext(binding, saved, request); assert.equal(reads, 1);
  for (const patch of [{ sender_id: 'ou_bob' }, { chat_id: 'oc_other' }, { root_id: 'om_changed' }, { parent_id: 'om_changed' }, { thread_id: 'omt_changed' }])
    assert.equal(dispatchNativeContextVerified(binding, { ...saved, event: { ...saved.event, ...patch } }), false);
  assert.equal(dispatchNativeContextVerified({ ...binding, profile: 'changed' }, saved), false);
  const legacy = { ...saved }; delete legacy.dispatchContext;
  assert.equal(dispatchNativeContextVerified(binding, legacy), false);
  await prepareDispatchNativeContext(binding, legacy, request); assert.equal(reads, 2);
});

test('submitted uncertain transport is never replayed while independent queued work can continue', async t => {
  const f = fixture(t, { inject: async job => { f.injected.push(job.id); if (job.id === 'om_uncertain') throw Error('unknown ACK'); } });
  const uncertain = f.enqueue('uncertain', 'alice'); await f.q.dispatchOne();
  assert.equal(uncertain.status, 'submitted'); assert.equal(uncertain.transportUncertain, true);
  f.defer(f.enqueue('attachment', 'alice')); f.enqueue('other', 'bob');
  const q = f.open(); q.enqueue(uncertain.event); await q.dispatchOne(); await q.dispatchOne();
  assert.deepEqual(f.injected, ['om_uncertain', 'om_other']);
});

test('simultaneous dispatch calls retain the single submission lock across lanes', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { prepare: async event => { await pending; return event; } });
  f.defer(f.enqueue('attachment', 'alice')); f.enqueue('other', 'bob'); f.enqueue('third', 'carol');
  const running = f.q.dispatchOne(); assert.equal(await f.q.dispatchOne(), false); release(); await running;
  assert.deepEqual(f.injected, ['om_other']); await f.q.dispatchOne(); assert.deepEqual(f.injected, ['om_other', 'om_third']);
});
