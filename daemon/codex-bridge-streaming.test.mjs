import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { streamCard, planCardUpdate, updateStreamCard } from './codex-bridge-cardkit.mjs';
import { DurableOutbound } from './codex-bridge-outbound.mjs';

const presentation = text => ({ status: 'searching', publicProgress: [{ channel: 'commentary', text }] });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-streaming-'));
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'card.json'), binding = { bot: 'fixture', chat_id: 'oc_fixture', cardkit_enabled: true };
  const calls = []; let hook = async () => {};
  const request = async (_binding, args) => {
    calls.push(args); await hook(args);
    if (args[1] === 'POST') return args[2].includes('cardkit') ? { card_id: 'card_fixture' } : { message_id: 'om_fixture' };
    return {};
  };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = value => fs.writeFileSync(file, JSON.stringify(value));
  const update = (state, final = false) => { write({ ...(fs.existsSync(file) ? read() : {}), ...state }); return updateStreamCard({ file, s: read(), final, binding, request, now: () => 100000 }); };
  return { root, file, binding, calls, request, read, write, update, hook: value => { hook = value; } };
}

test('planner updates only changed markdown text, including nested collapsed progress', () => {
  const first = streamCard('检索了第一个来源。', false, presentation('开始检索'));
  const next = streamCard('检索了第一个来源。新增第二个来源。', false, presentation('开始检索，已找到两个来源'));
  const plan = planCardUpdate(first, next);
  assert.equal(plan.mode, 'elements'); assert.deepEqual(plan.updates.map(update => update.elementId), ['answer', 'progress_text_0']);
  assert.ok(!plan.updates.some(update => update.elementId === 'status'));
  assert.deepEqual(planCardUpdate(next, structuredClone(next)), { mode: 'none', updates: [] });
  assert.equal(first.body.elements[1].content, '检索了第一个来源。'); // planner does not mutate input.
});

test('planner preserves structural, phase, summary, disabled-stream and final transitions as full card', () => {
  const first = streamCard('正文', false, presentation('公开进度'));
  const variants = [
    streamCard('正文', false, { ...presentation('公开进度'), status: 'organizing' }),
    streamCard('正文 [官方](https://example.com/docs)', false, presentation('公开进度')),
    streamCard('正文', false, {}),
    { ...structuredClone(first), config: { ...first.config, summary: { content: 'changed' } } },
    { ...structuredClone(first), config: { ...first.config, streaming_mode: false } },
  ];
  for (const next of variants) assert.equal(planCardUpdate(first, next).mode, 'full');
  assert.equal(planCardUpdate(first, first, { final: true }).mode, 'full');
  assert.equal(planCardUpdate(null, first).mode, 'full');
  const empty = structuredClone(first); empty.body.elements[1].content = '';
  assert.equal(planCardUpdate(first, empty).mode, 'full');
  const duplicate = structuredClone(first); duplicate.body.elements.push({ tag: 'markdown', element_id: 'answer', content: 'duplicate' });
  assert.equal(planCardUpdate(duplicate, duplicate).mode, 'full');
});

test('same-layout presentation uses element endpoints; an unchanged snapshot acknowledges revision without network', async t => {
  const f = fixture(t);
  await f.update({ key: 'turn', revision: 1, text: 'one', presentation: presentation('one') });
  assert.equal(f.calls.filter(call => call[1] === 'POST').length, 2);
  assert.match(f.calls.at(-1)[2], /\/elements\/answer\/content$/);
  await f.update({ revision: 2, text: 'one two', presentation: presentation('one two') });
  const writes = f.calls.filter(call => call[1] === 'PUT');
  assert.deepEqual(writes.map(call => JSON.parse(call.at(-1)).sequence), [1, 2, 3]);
  assert.deepEqual(writes.slice(1).map(call => call[2].split('/').at(-2)), ['answer', 'progress_text_0']);
  assert.equal(f.read().sentRevision, 2); assert.deepEqual(f.read().lastAppliedCard, streamCard('one two', false, presentation('one two')));
  const count = f.calls.length; await f.update({ revision: 3 });
  assert.equal(f.calls.length, count); assert.equal(f.read().sentRevision, 3); assert.equal(f.read().cardSequence, 3);
});

test('partial batch does not acknowledge the whole revision and replays exact uncertain operation before newer snapshot', async t => {
  const f = fixture(t);
  await f.update({ key: 'turn', revision: 1, text: 'one', presentation: presentation('one') });
  let failed;
  f.hook(async args => { if (args[2].includes('/elements/progress_text_0/') && !failed) { failed = structuredClone(args); throw Error('accepted but acknowledgment lost'); } });
  await assert.rejects(f.update({ revision: 2, text: 'one two', presentation: presentation('one two') }), /acknowledgment/);
  const interrupted = f.read();
  assert.equal(interrupted.sentRevision, 1); assert.equal(interrupted.cardSequence, 2);
  assert.equal(interrupted.cardBatch.next, 1); assert.deepEqual(interrupted.cardPending.body, JSON.parse(failed.at(-1)));
  assert.equal(interrupted.lastAppliedCard.body.elements[1].content, 'one two');
  const offset = f.calls.length;
  await f.update({ revision: 3, text: 'one two three', presentation: presentation('one two three') });
  assert.deepEqual(f.calls[offset], failed);
  assert.deepEqual(f.calls.slice(offset).map(args => JSON.parse(args.at(-1)).sequence), [3, 4, 5]);
  assert.equal(f.read().sentRevision, 3); assert.equal(f.read().cardSequence, 5);
  assert.equal(f.read().cardPending, undefined); assert.equal(f.read().cardBatch, undefined);
  assert.deepEqual(f.read().lastAppliedCard, streamCard('one two three', false, presentation('one two three')));
});

test('final drains unfinished element batch then closes by full card; stale progress cannot reopen it', async t => {
  const f = fixture(t);
  await f.update({ key: 'turn', revision: 1, text: 'one', presentation: presentation('one') });
  let failed;
  f.hook(async args => { if (args[2].includes('/elements/progress_text_0/') && !failed) { failed = args; throw Error('uncertain'); } });
  await assert.rejects(f.update({ revision: 2, text: 'one two', presentation: presentation('one two') }));
  const offset = f.calls.length;
  await f.update({ revision: 3, text: '最终结论', final: true, presentation: { status: 'complete' } }, true);
  assert.deepEqual(f.calls[offset], failed);
  const last = JSON.parse(f.calls.at(-1).at(-1)); assert.equal(last.sequence, 4);
  assert.equal(JSON.parse(last.card.data).config.streaming_mode, false); assert.equal(f.read().cardClosed, true);
  const count = f.calls.length; await f.update({ revision: 4, text: 'late progress' });
  assert.equal(f.calls.length, count); assert.equal(f.read().sentRevision, 3);
});

test('old cardPending journals replay without inventing a known layout and then establish a full snapshot', async t => {
  const f = fixture(t);
  const pending = { sequence: 2, revision: 1, final: false, endpoint: '/open-apis/cardkit/v1/cards/card_fixture/elements/answer/content', body: { sequence: 2, uuid: 'legacy-fixed', content: 'old' } };
  f.write({ key: 'turn', cardId: 'card_fixture', messageId: 'om_fixture', cardSequence: 1, cardPending: pending, revision: 2, text: 'new', presentation: presentation('new') });
  await updateStreamCard({ file: f.file, s: f.read(), final: false, binding: f.binding, request: f.request, now: () => 100000 });
  assert.deepEqual(f.calls[0], ['api', 'PUT', pending.endpoint, '--data', JSON.stringify(pending.body)]);
  assert.equal(f.calls.length, 2); assert.equal(JSON.parse(f.calls[1].at(-1)).sequence, 3);
  assert.ok(JSON.parse(f.calls[1].at(-1)).card); assert.ok(f.read().lastAppliedCard);
});

test('phase transitions send full cards and final waits behind an in-flight content update', async t => {
  const f = fixture(t); let time = 100000;
  const out = new DurableOutbound(f.root, f.binding, f.request, { presentationEnabled: true, minIntervalMs: 2000, now: () => time });
  out.progress('[检索] 第一条', 'turn'); await out.flushCards();
  time += 2001; out.progress('[整理] 第二条', 'turn'); await out.flushCards();
  assert.equal(JSON.parse(JSON.parse(f.calls.at(-1).at(-1)).card.data).header.title.content, '正在整理');
  let started, release;
  const entered = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { release = resolve; });
  let held = false;
  f.hook(async args => { if (args[1] === 'PUT' && args[2].includes('/elements/') && !held) { held = true; started(); await wait; } });
  time += 2001; out.progress('[整理] 第二条，补充内容', 'turn'); const progress = out.flushCards(); await entered;
  const final = out.final('最终答复', 'reply', ['turn']); release(); await Promise.all([progress, final]);
  const closing = JSON.parse(f.calls.at(-1).at(-1)); assert.equal(JSON.parse(closing.card.data).config.streaming_mode, false);
  const state = out.read(out.file('card', 'turn')); assert.equal(state.finalDelivered, true); assert.equal(state.cardClosed, true);
  const count = f.calls.length; out.progress('[整理] 迟到内容', 'turn'); await out.flushCards(); assert.equal(f.calls.length, count);
});

test('unchanged answer does not resend while separate visible progress changes', async t => {
  const f = fixture(t);
  await f.update({ key: 'turn', revision: 1, text: 'fixed', presentation: presentation('one') });
  const offset = f.calls.length;
  await f.update({ revision: 2, presentation: presentation('two') });
  assert.equal(f.calls.length, offset + 1); assert.match(f.calls.at(-1)[2], /\/elements\/progress_text_0\/content$/);
});

for(const code of ['300309','200850'])test(`closed stream ${code} recovers the same card as a non-streaming snapshot`,async t=>{
  const f=fixture(t);await f.update({key:'turn',revision:1,text:'one',presentation:presentation('one')});
  f.hook(async args=>{if(args[2].includes('/elements/'))throw Object.assign(Error('stream closed'),{apiCode:code});});
  await f.update({revision:2,text:'two',presentation:presentation('two')});
  const recovered=f.read();assert.equal(recovered.sentRevision,2);assert.equal(recovered.cardStreamingFallback,true);
  assert.equal(recovered.cardStreamingFallbackCode,code);assert.equal(recovered.lastAppliedCard.config.streaming_mode,false);
  assert.equal(recovered.cardPending,undefined);assert.equal(recovered.cardBatch,undefined);
  const count=f.calls.length;await f.update({revision:3,text:'three',presentation:presentation('three')});
  assert.equal(f.calls.length,count+1);assert.ok(JSON.parse(f.calls.at(-1).at(-1)).card);
  await f.update({revision:4,text:'final',final:true,presentation:{status:'complete'}},true);
  assert.equal(f.read().cardClosed,true);assert.equal(f.calls.filter(a=>a[1]==='POST').length,2);
});

test('fallback journal survives an uncertain full update and replays exact UUID/sequence after restart',async t=>{
  const f=fixture(t);await f.update({key:'turn',revision:1,text:'one',presentation:presentation('one')});let uncertain;
  f.hook(async args=>{
    if(args[2].includes('/elements/'))throw Object.assign(Error('closed'),{apiCode:300309});
    if(args[1]==='PUT'&&!uncertain){uncertain=structuredClone(args);throw Error('ack lost');}
  });
  await assert.rejects(f.update({revision:2,text:'two',presentation:presentation('two')}),/ack lost/);
  assert.equal(f.read().sentRevision,1);assert.deepEqual(f.read().cardPending.body,JSON.parse(uncertain.at(-1)));
  const offset=f.calls.length;await f.update({revision:3,text:'three',presentation:presentation('three')});
  assert.deepEqual(f.calls[offset],uncertain);assert.equal(f.read().sentRevision,3);
  assert.equal(f.read().lastAppliedCard.body.elements[1].content,'three');
});

test('closed legacy element journal goes straight to latest final without draining obsolete progress',async t=>{
  const f=fixture(t);const pending={sequence:6,revision:4,final:false,endpoint:'/open-apis/cardkit/v1/cards/card_fixture/elements/answer/content',body:{sequence:6,uuid:'old',content:'old'}};
  f.write({key:'turn',cardId:'card_fixture',messageId:'om_fixture',cardSequence:5,cardPending:pending,cardBatch:{revision:4,operations:[pending,{...pending,sequence:7,body:{...pending.body,sequence:7,uuid:'old2'}}],next:0},revision:10,text:'最新最终答案',final:true,presentation:{status:'complete'}});
  f.hook(async args=>{if(args[2].includes('/elements/'))throw Object.assign(Error('closed'),{apiCode:300309});});
  await updateStreamCard({file:f.file,s:f.read(),final:true,binding:f.binding,request:f.request,now:()=>100000});
  assert.equal(f.calls.length,2);const last=JSON.parse(f.calls.at(-1).at(-1));assert.equal(last.sequence,8);
  assert.equal(JSON.parse(last.card.data).body.elements[1].content,'最新最终答案');assert.equal(f.read().sentRevision,10);assert.equal(f.read().cardClosed,true);
});

test('recovery uses newer queued progress and never reverts to the caller old snapshot',async t=>{
  const f=fixture(t);await f.update({key:'turn',revision:1,text:'one',presentation:presentation('one')});
  let changed=false;f.hook(async args=>{if(args[2].includes('/elements/')){
    if(!changed){changed=true;f.write({...f.read(),revision:8,text:'newest',presentation:presentation('newest')});}
    throw Object.assign(Error('closed'),{apiCode:300309});
  }});
  await f.update({revision:2,text:'old',presentation:presentation('old')});
  assert.equal(f.read().sentRevision,8);assert.equal(f.read().lastAppliedCard.body.elements[1].content,'newest');
});

test('permission and unknown transport errors retain pending operations without recovery writes',async t=>{
  const f=fixture(t);await f.update({key:'turn',revision:1,text:'one',presentation:presentation('one')});
  f.hook(async args=>{if(args[2].includes('/elements/'))throw Object.assign(Error('permission'),{apiCode:99991672});});
  const count=f.calls.length;await assert.rejects(f.update({revision:2,text:'two',presentation:presentation('two')}));
  assert.equal(f.calls.length,count+1);assert.equal(f.read().cardStreamingFallback,undefined);assert.ok(f.read().cardPending);
});

test('progress timestamps survive restart and replayed offsets cannot duplicate or regress history',async t=>{
  const f=fixture(t);const make=()=>new DurableOutbound(f.root,f.binding,f.request,{presentationEnabled:true,now:()=>Date.parse('2026-09-28T12:00:00Z')});
  let out=make();const at=Date.parse('2026-09-28T11:52:22Z');
  out.progress('事件一','turn',undefined,{at,observedAt:at+60000,position:100});
  out.progress('事件二','turn',undefined,{at:at+1000,position:200});out=make();
  out.progress('事件一','turn',undefined,{at,position:100});out.progress('事件二','turn',undefined,{at:at+1000,position:200});
  const state=out.read(out.file('card','turn'));assert.equal(state.presentation.publicProgress.length,2);assert.equal(state.revision,2);
  const card=streamCard(state.text,false,state.presentation);const encoded=JSON.stringify(card);
  assert.match(encoded,/09-28 19:52:22/);assert.match(encoded,/09-28 19:52:23/);assert.doesNotMatch(encoded,/20:00:00/);
  assert.match(encoded,/北京时间/);
  assert.match(JSON.stringify(streamCard('旧',false,presentation('旧记录'))),/时间未记录/);
});
