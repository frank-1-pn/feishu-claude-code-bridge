import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPresentation, decorateSources, markdownBlocks, markdownElements, safeHttpUrl } from './codex-bridge-presentation.mjs';
import { streamCard, updateStreamCard } from './codex-bridge-cardkit.mjs';

const find = (card, id) => {
  const scan = elements => { for (const e of elements) { if (e.element_id === id) return e; const inner = e.elements && scan(e.elements); if (inner) return inner; } };
  return scan(card.body.elements);
};

test('long answer extracts original conclusion and five items; complete details remain lossless', () => {
  const source = '已完成三项修改；实际客户端显示仍待验收。\n\n' + Array.from({length:8}, (_, i) => `- 原文要点 ${i + 1}：${'保留事实。'.repeat(40)}`).join('\n') + '\n\n这是最后一段。';
  const view = buildPresentation(source, {final:true});
  assert.equal(view.fullText, source);
  assert.equal(view.detailText, source);
  assert.match(view.answer, /^已完成三项修改；实际客户端显示仍待验收。/);
  assert.equal((view.answer.match(/^- 原文要点/gm) ?? []).length, 5);
  assert.ok(!view.answer.includes('原文要点 6'));
  assert.ok(view.detailText.endsWith('这是最后一段。'));
});

test('more than five short points fold without rewriting or dropping their original labels', () => {
  const source = '结论：保留原文。\n\n- 已验证：A\n- 推断：B\n- 待确认：C\n- D\n- E\n- F';
  const view = buildPresentation(source, {final:true,summary:'所有事项已验证'});
  assert.equal(view.detailText, source);
  assert.ok(!view.answer.includes('所有事项已验证'));
  assert.ok(view.answer.includes('- 待确认：C'));
  assert.ok(!view.answer.includes('- F'));
  assert.equal(buildPresentation(source, {final:true,summary:'结论：保留原文。'}).answer, '结论：保留原文。');
});

test('fences, indented code, inline code and table bytes survive decoration', () => {
  const source = '前言\r\n\r\n```js\r\nconst x = "[source](https://private.invalid)";\r\n```\r\n\r\n    [code](https://code.invalid)\r\n\r\n| 项目 | 值 |\r\n| --- | --- |\r\n| 甲 | `a|b` |\r\n\r\n行内 `[code](https://inline.invalid)` 和 [官方](https://example.com/a_(b))。';
  assert.equal(markdownBlocks(source).map(b => b.text).join(''), source);
  const result = decorateSources(source);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, 'https://example.com/a_(b)');
  for (const block of markdownBlocks(source).filter(b => ['table','code'].includes(b.kind))) assert.ok(result.text.includes(block.text));
  assert.ok(result.text.includes('`[code](https://inline.invalid)`'));
});

test('numbered citations dedupe URLs and escape attributes; unsafe/local links are not clickable', () => {
  const text = "[原文](https://example.com/?q='value'&a=1) [再次](https://example.com/?q='value'&a=1) [本地](C:/secret.md) [坏链接](javascript:alert(1)) [图片](https://other.example/a)";
  const result = decorateSources(text);
  assert.equal(result.sources.length, 2);
  assert.equal((result.text.match(/>1<\/number_tag>/g) ?? []).length, 2);
  assert.match(result.text, /&amp;a=1/);
  assert.ok(!result.text.includes('[本地]('));
  assert.ok(!result.text.includes('[坏链接]('));
  for (const value of ['javascript:alert(1)','file:///C:/x','https://user:password@example.com','https://example.com\n/x','https:\\example.com','not-a-url']) assert.equal(safeHttpUrl(value),null);
  assert.equal(decorateSources('![alt](https://image.example/x)').sources.length, 0);
});

test('unclosed fences and backticks never turn code examples into clickable citations', () => {
  const source = '```js\n[private](https://code.invalid)';
  assert.equal(decorateSources(source).text, source);
  assert.equal(decorateSources(source).sources.length, 0);
  assert.equal(decorateSources('`[code](https://example.com)').sources.length, 0);
});

test('tables split at four per Markdown element while original text stays identical', () => {
  const source = Array.from({length:9}, (_, i) => `| 字段 | 值 |\n| --- | --- |\n| 表 ${i} | 内容😀 |\n\n`).join('');
  const elements = markdownElements(source);
  assert.equal(elements.length, 3);
  assert.equal(elements.map(e => e.content).join(''), source);
  assert.ok(elements.every(e => markdownBlocks(e.content).filter(b => b.kind === 'table').length <= 4));
  const card = streamCard(source, true);
  assert.equal(find(card,'answer').element_id, 'answer');
});

test('very large Unicode answers remain available unless full report delivery is confirmed', () => {
  const source = '需要核验的结果。\n\n' + '汉字😀'.repeat(40000);
  const pending = buildPresentation(source, {final:true,report:{fileName:'报告.html',delivered:false}});
  assert.equal(pending.fullText, source); assert.equal(pending.detailText, source);
  assert.ok(!/\uFFFD/u.test(pending.answer));
  const done = buildPresentation(source, {final:true,report:{fileName:'报告.html',delivered:true,url:'C:/fake.html'}});
  assert.equal(done.fullText, source); assert.equal(done.detailText, ''); assert.equal(done.report.url,null);
  const card = streamCard(source,true,{report:{fileName:'报告.html',delivered:true}});
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 3000);
  assert.match(find(card,'report').content,/已作为附件发送/);
});

test('only explicit public commentary enters collapsed progress; unrelated reasoning stays absent', () => {
  const card = streamCard('最终结果',true,{publicProgress:[
    {channel:'analysis',text:'PRIVATE REASONING'}, {channel:'reasoning',text:'SECRET'},
    {text:'UNTAGGED'}, {channel:'commentary',text:'正在检索公开文档'},
    {channel:'commentary',text:'正在检索公开文档'}, {channel:'commentary',text:'已整理来源'},
  ],reasoning:'ALSO PRIVATE'});
  const serialized=JSON.stringify(card);
  assert.ok(!/PRIVATE|SECRET|UNTAGGED/.test(serialized));
  assert.equal(find(card,'progress').expanded,false);
  assert.equal((serialized.match(/正在检索公开文档/g) ?? []).length,1);
  assert.equal(find(card,'answer').content,'最终结果');
});

test('status is separate; waiting closes streaming and completion preview contains the actual result', () => {
  assert.equal(find(streamCard('  ',true),'answer').content,'本次没有可发送的正文。');
  const waiting = streamCard('请补充用途和格式。',true,{status:'waiting',interactions:[{tag:'form',element_id:'form_fixture',name:'fixture',elements:[]}]});
  assert.equal(waiting.config.streaming_mode,false);
  assert.equal(waiting.header.title.content,'等待补充');
  assert.equal(waiting.config.summary.content,'等待补充');
  assert.equal(waiting.body.elements.at(-1).tag,'form');
  const done = streamCard('已修复重连，客户端验收待完成。',true);
  assert.equal(done.config.summary.content,'已修复重连，客户端验收待完成。');
  assert.equal(find(done,'status').content,'**处理完成**');
  assert.equal(streamCard('正在读取来源',false,{status:'searching'}).header.title.content,'正在检索');
  assert.ok(!JSON.stringify(streamCard('working',false,{interactions:[{tag:'form'}]})).includes('"tag":"form"'));
});

test('presentation updates retry exact sequence/UUID and bind message before controls are published', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'card-presentation-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const file = path.join(root,'card.json');
  let state = {key:'turn',revision:1,text:'first',presentation:{status:'searching'}};
  fs.writeFileSync(file,JSON.stringify(state));
  let bound=false,fail=true; const calls=[];
  const request=async (_,args) => {
    calls.push(args);
    if(args[1]==='POST')return args[2].includes('cardkit')?{card_id:'123'}:{message_id:'om_fixture'};
    assert.equal(bound,true);
    if(fail){fail=false;throw Error('uncertain');}
    return{};
  };
  const run = final => updateStreamCard({file,s:state,final,binding:{chat_id:'oc_fixture'},request,now:()=>1000,onMessage:async id => {assert.equal(id,'om_fixture');bound=true;}});
  await assert.rejects(run(false),/uncertain/);
  const failed=calls.at(-1); state={...JSON.parse(fs.readFileSync(file)),revision:2,text:'last',presentation:{status:'waiting'}};
  fs.writeFileSync(file,JSON.stringify(state));
  await run(true);
  assert.deepEqual(calls.at(-2),failed);
  const final=JSON.parse(calls.at(-1).at(-1));
  assert.equal(final.sequence,2);assert.equal(JSON.parse(final.card.data).config.summary.content,'等待补充');
  assert.ok(JSON.parse(fs.readFileSync(file)).cardClosed);
  state={...JSON.parse(fs.readFileSync(file)),revision:3,text:'late'};
  const before=calls.length;await run(false);assert.equal(calls.length,before);
});
