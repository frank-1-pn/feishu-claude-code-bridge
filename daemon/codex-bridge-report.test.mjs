import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableInbox, digest } from './codex-bridge-inbox.mjs';
import { FileOutbox, enqueueFile, enqueueGeneratedReport, getReportDelivery } from './codex-bridge-files.mjs';
import { REPORT_POLICY, reportPolicy, renderReportHtml, prepareReplyReport } from './codex-bridge-report.mjs';
import { sanitizeFeishuReply } from './codex-bridge-sanitize.mjs';

function fixture(t, raw = '# 结论\n\n已验证的结果。😀\n\n' + '完整内容，保留原文与依据。\n'.repeat(230)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  const binding = { bot: 'fixture', chat_id: 'oc_fixture', allowed_sender_id: 'ou_fixture', profile: 'fixture-profile', cwd };
  const inboxRoot = path.join(root, 'inbox'), reportRoot = path.join(root, 'private-reports'), fileOutboxRoot = path.join(root, 'files');
  const inbox = new DurableInbox(inboxRoot, binding.bot, {}), jobId = 'om_report', replyKey = digest('final reply');
  const job = inbox.enqueue({ message_id: jobId, chat_id: binding.chat_id, sender_id: binding.allowed_sender_id, message_type: 'text', content: '请给报告' });
  Object.assign(job, { reply: raw, replyKey, status: 'reply_pending' }); inbox.save(job);
  const text = sanitizeFeishuReply(raw).trim();
  return { root, binding, inbox, job, options: { inboxRoot, reportRoot, fileOutboxRoot, binding, jobId, replyKey, text },
    reportDir: path.join(reportRoot, binding.bot, digest(replyKey)) };
}

test('policy avoids short answer/table uploads and has explicit complexity/size thresholds', () => {
  assert.equal(reportPolicy('短答复').generate, false);
  assert.equal(reportPolicy('| A | B |\n| --- | --- |\n| 1 | 2 |').generate, false);
  assert.equal(reportPolicy('x'.repeat(2400)).generate, true);
  assert.equal(reportPolicy('x'.repeat(1300)).generate, false);
  assert.equal(reportPolicy('```js\ncode\n```\n' + 'x'.repeat(1200)).reason, 'complex_answer');
  assert.equal(reportPolicy('短报告', { force: true }).generate, true);
  assert.equal(reportPolicy('x'.repeat(REPORT_POLICY.maxSourceBytes + 1), { force: true }).reason, 'size_limit');
});

test('HTML renders Chinese, table, fenced code, source numbers and safe balanced URLs', () => {
  const text = '# 测试报告 😀\n\n| 项目 | 结果 |\n| --- | --- |\n| 甲 | **通过** |\n| 乙 | `a|b` |\n\n```js\nconst x = "<script>";\n```\n\n[依据](https://example.com/a_(b)) 与 [同源](https://example.com/a_(b))。\n\n[参考][doc]\n\n[doc]: https://example.org/doc';
  const html = renderReportHtml(text);
  assert.match(html, /<table>/); assert.match(html, /<strong>通过<\/strong>/); assert.match(html, /<code>a\|b<\/code>/);
  assert.match(html, /const x = &quot;&lt;script&gt;&quot;/); assert.match(html, /href="https:\/\/example.com\/a_\(b\)"/);
  assert.equal((html.match(/aria-label="来源 1"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-label="来源 2"/g) ?? []).length, 1);
  assert.match(html, /原始 Markdown/); assert.match(html, /测试报告 😀/);
});

test('hostile HTML and unsafe/local links cannot execute, fetch, or become live links', () => {
  const html = renderReportHtml('<script>globalThis.hacked=1</script>\n\n<img src=x onerror="alert(1)">\n\n[坏](javascript:alert(1)) [文件](file:///C:/secret) [数据](data:text/html,test) [认证](https://u:p@example.com)\n\n![远程图](https://example.com/image.png)\n\n[好](https://example.com/?a=1&b=2)');
  assert.doesNotMatch(html, /<script\b|<img\b|<iframe\b|<object\b|onerror="/i);
  assert.doesNotMatch(html, /href="(?:javascript:|file:|data:|https:\/\/u:p)/i);
  assert.match(html, /&lt;script&gt;globalThis.hacked=1&lt;\/script&gt;/);
  assert.match(html, /default-src 'none'/); assert.match(html, /https:\/\/example.com\/\?a=1&amp;b=2/);
  assert.match(html, /图片：远程图/);
});

test('links and reference-like text inside code stay literal, never create sources', () => {
  const html = renderReportHtml('`[private](https://example.com/code)`\n\n```text\n[x]: https://example.com/definition\n[link](https://example.com/fence)\n```\n\n[x]');
  assert.doesNotMatch(html, /class="sources"/); assert.doesNotMatch(html, /href=/);
});

test('report artifacts retain full sanitized answer and never read/move original attachments', t => {
  const f = fixture(t), original = path.join(f.binding.cwd, 'original.pdf'); fs.writeFileSync(original, 'original untouched');
  f.job.prepared = { resources: [{ local_path: original }] }; f.inbox.save(f.job);
  const result = prepareReplyReport(f.options);
  assert.equal(result.generated, true); assert.deepEqual(result.artifacts.map(a => a.name), ['report.html', 'answer.md']);
  assert.equal(fs.readFileSync(path.join(f.reportDir, 'answer.md'), 'utf8'), f.options.text);
  assert.equal(fs.readFileSync(original, 'utf8'), 'original untouched');
  assert.equal(fs.statSync(path.join(f.reportDir, 'report.html')).size < REPORT_POLICY.maxHtmlBytes, true);
  assert.deepEqual(f.binding.outbound_roots, undefined);
  assert.throws(() => enqueueFile({ root: f.options.fileOutboxRoot, ...f.options, file: path.join(f.reportDir, 'report.html') }), /outside_allowed_roots/);
});

test('restart deduplicates two artifacts, recovers uncertain sends with same keys, and retains state', async t => {
  const f = fixture(t); let now = 1000, fail = true; const sent = [];
  const result = prepareReplyReport(f.options), again = prepareReplyReport(f.options);
  assert.deepEqual(result.artifacts, again.artifacts);
  const request = async (binding, args, dir) => {
    assert.equal(binding.chat_id, f.binding.chat_id); assert.equal(binding.profile, f.binding.profile);
    sent.push(args.at(-1)); assert.equal(fs.existsSync(path.join(dir, args[args.indexOf('--file') + 1])), true);
    if (fail) { fail = false; throw Error('accepted then network lost'); } return {};
  };
  let outbox = new FileOutbox(f.options.fileOutboxRoot, f.binding, request, { now: () => now });
  await outbox.flush(); assert.equal(outbox.stats().file_pending_count, 1);
  const states = { root: f.options.fileOutboxRoot, binding: f.binding, artifacts: result.artifacts };
  assert.equal(getReportDelivery(states).status, 'pending');
  outbox = new FileOutbox(f.options.fileOutboxRoot, f.binding, request, { now: () => now });
  await outbox.flush(); assert.equal(sent.length, 2); now += 10000; await outbox.flush();
  assert.equal(sent.length, 3); assert.equal(sent[0], sent[2]); assert.equal(getReportDelivery(states).status, 'done');
  delete f.job.reply; f.job.status = 'done'; f.inbox.save(f.job);
  const reused = prepareReplyReport(f.options); assert.equal(reused.artifacts.every(a => a.status === 'done'), true);
  await outbox.flush(); assert.equal(sent.length, 3);
});

test('origin chat/sender/profile/reply mismatch fails before enqueue or network', async t => {
  const f = fixture(t);
  for (const binding of [{ ...f.binding, chat_id: 'oc_other' }, { ...f.binding, allowed_sender_id: 'ou_other' }]) {
    assert.throws(() => prepareReplyReport({ ...f.options, binding }), /binding_mismatch/);
  }
  assert.throws(() => prepareReplyReport({ ...f.options, replyKey: digest('other') }), /binding_mismatch/);
  const result = prepareReplyReport(f.options);
  assert.throws(() => prepareReplyReport({ ...f.options, binding: { ...f.binding, profile: 'other' } }), /binding_mismatch/);
  let calls = 0;
  const outbox = new FileOutbox(f.options.fileOutboxRoot, { ...f.binding, chat_id: 'oc_new' }, async () => calls++);
  await outbox.flush(); assert.equal(calls, 0); assert.equal(outbox.stats().file_failed_count, 2);
  assert.equal(getReportDelivery({ root: f.options.fileOutboxRoot, binding: f.binding, artifacts: result.artifacts }).status, 'blocked');
});

test('generated API accepts fixed names only and refuses changed report or payload bytes', async t => {
  const f = fixture(t), result = prepareReplyReport(f.options);
  assert.throws(() => enqueueGeneratedReport({ root: f.options.fileOutboxRoot, ...f.options, name: '../secret.txt' }), /invalid_report_artifact/);
  fs.appendFileSync(path.join(f.reportDir, 'answer.md'), 'tamper');
  assert.throws(() => prepareReplyReport(f.options), /snapshot_changed/);
  const target = path.join(f.options.fileOutboxRoot, f.binding.bot, result.artifacts[0].key, 'payload', 'report.html'); fs.appendFileSync(target, 'tamper');
  let calls = 0; const outbox = new FileOutbox(f.options.fileOutboxRoot, f.binding, async () => calls++);
  await outbox.flush(); assert.equal(calls, 1); assert.equal(outbox.stats().file_failed_count, 1);
});

test('report generation refuses arbitrary caller text, forged manifest and changed final', t => {
  const f = fixture(t);
  assert.throws(() => prepareReplyReport({ ...f.options, text: 'exfiltrate arbitrary bytes'.repeat(120) }), /not_authorized/);
  prepareReplyReport(f.options);
  assert.throws(() => prepareReplyReport({ ...f.options, text: f.options.text + 'changed' }), /final_changed/);
  const manifestFile = path.join(f.reportDir, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.origin.senderId = 'ou_other'; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => prepareReplyReport(f.options), /binding_mismatch/);
});

test('partial artifact snapshot before manifest can recover only unchanged bytes', t => {
  const f = fixture(t); const first = prepareReplyReport(f.options);
  fs.unlinkSync(path.join(f.reportDir, 'manifest.json'));
  assert.deepEqual(prepareReplyReport(f.options).artifacts, first.artifacts);
  fs.unlinkSync(path.join(f.reportDir, 'manifest.json')); fs.appendFileSync(path.join(f.reportDir, 'report.html'), 'changed');
  assert.throws(() => prepareReplyReport(f.options), /snapshot_changed/);
});

test('generated report rejects directory junction escaping its private root', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(f.options.reportRoot, { recursive: true });
  fs.symlinkSync(outside, path.join(f.options.reportRoot, f.binding.bot), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareReplyReport(f.options), /outside_allowed_root/);
  assert.equal(fs.existsSync(path.join(outside, digest(f.options.replyKey), 'answer.md')), false);
});

test('permission failure preserves report artifacts and produces one durable notice', async t => {
  const f = fixture(t), result = prepareReplyReport(f.options), notices = [];
  const outbox = new FileOutbox(f.options.fileOutboxRoot, f.binding, async () => { throw Object.assign(Error('permission'), { type: 'permission' }); },
    { notify: async (text, key) => notices.push({ text, key }) });
  await outbox.flush(); await outbox.flush(); await outbox.flush();
  assert.equal(notices.length, 1); assert.equal(new Set(notices.map(n => n.key)).size, 1);
  assert.equal(fs.readFileSync(path.join(f.reportDir, 'answer.md'), 'utf8'), f.options.text);
  assert.equal(getReportDelivery({ root: f.options.fileOutboxRoot, binding: f.binding, artifacts: result.artifacts }).status, 'blocked');
});

test('concurrent periodic/final flush shares one read-send-checkpoint operation', async t => {
  const f = fixture(t), result = prepareReplyReport(f.options); let release;
  const gate = new Promise(resolve => { release = resolve; }), sent = [];
  const outbox = new FileOutbox(f.options.fileOutboxRoot, f.binding, async (_, args) => { sent.push(args.at(-1)); await gate; });
  const first = outbox.flush(), second = outbox.flush();
  assert.equal(first, second); assert.equal(sent.length, 1);
  release(); await Promise.all([first, second]);
  assert.equal(sent.length, 2); assert.equal(new Set(sent).size, 2);
  await outbox.flush(); assert.equal(sent.length, 2);
  assert.equal(getReportDelivery({ root: f.options.fileOutboxRoot, binding: f.binding, artifacts: result.artifacts }).status, 'done');
});
