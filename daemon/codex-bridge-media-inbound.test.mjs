import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareInbound } from './codex-bridge-media.mjs';
import { normalizeEvent, digest } from './codex-bridge-inbox.mjs';

function fixture(t, download) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-inbound-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binding = { bot: 'fixture', profile: 'fixture' };
  const options = { downloadRoot: root, download, writeText: fs.writeFileSync };
  return { root, binding, options, dir: id => path.join(root, binding.bot, digest(id)),
    prepare: event => prepareInbound(binding, event, options) };
}
const message = (id, nodes, type = 'post') => ({ message_id: `om_${id}`, message_type: type, content: JSON.stringify(nodes) });
const file = (key, name = '资料.xlsx') => ({ tag: 'file', file_key: `file_${key}`, file_name: name });
const save = (root, name, text = 'synthetic bytes') => { const saved_path = path.join(root, name); fs.writeFileSync(saved_path, text); return { saved_path }; };

test('mixed post preserves original text and every good attachment when another download fails, with restart reuse', async t => {
  const calls = [];
  const f = fixture(t, async (_, args, root) => {
    const key = args[args.indexOf('--file-key') + 1]; calls.push(key);
    if (key === 'file_bad') throw Error('private transport message must never enter prompt');
    return save(root, key === 'img_fixture' ? 'resource-0.png' : 'resource-2.xlsx');
  });
  const event = message('mixed', { content: [[{ tag: 'text', text: '分析资料正文' },
    { tag: 'img', image_key: 'img_fixture' }, file('bad', '失败.docx'), file('good')]] });
  const first = await f.prepare(event);
  assert.equal(first.attachmentPreparationError, 'attachment_partial_failure');
  assert.deepEqual(first.attachmentResults.map(x => x.status), ['success', 'failed', 'success']);
  assert.match(first.content, /分析资料正文/); assert.match(first.content, /resource-0.png/); assert.match(first.content, /resource-2.xlsx/);
  assert.ok(!first.content.includes('private transport'));
  const receipt = JSON.parse(fs.readFileSync(path.join(f.dir(event.message_id), 'attachment-results.json')));
  assert.deepEqual(receipt.results, first.attachmentResults);
  await f.prepare(event);
  assert.deepEqual(calls, ['img_fixture', 'file_bad', 'file_good', 'file_bad']);
  // A later authorized preparation may recover only the failed item.
  f.options.download = async (_, args, root) => { assert.equal(args[args.indexOf('--file-key') + 1], 'file_bad'); return save(root, 'resource-1.docx'); };
  const recovered = await f.prepare(event);
  assert.equal(recovered.attachmentPreparationError, undefined);
  assert.deepEqual(recovered.attachmentResults.map(x => x.status), ['success', 'success', 'success']);
});

test('Unicode original name, extension, source metadata, and bytes SHA survive a fresh preparation', async t => {
  let downloads = 0;
  const f = fixture(t, async (_, args, root) => {
    downloads++; assert.equal(args.at(-1), './resource-0.payload.XLSX');
    return save(root, 'resource-0.XLSX', '合成表格 bytes');
  });
  const event = message('metadata', { ...file('fixture', '../../中文报价.XLSX'), mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', file_size: 999, duration: 42 }, 'file');
  const first = await f.prepare(event), again = await f.prepare(event);
  assert.deepEqual(again.attachmentResults, first.attachmentResults); assert.equal(downloads, 1);
  const [item] = first.attachmentResults;
  assert.equal(item.original_name, '../../中文报价.XLSX'); assert.equal(item.extension, '.XLSX');
  assert.equal(item.sha256, digest('合成表格 bytes')); assert.equal(item.size_bytes, Buffer.byteLength('合成表格 bytes'));
  assert.equal(item.metadata.file_size, 999); assert.equal(item.metadata.duration, 42);
  assert.match(item.metadata.mime_type, /spreadsheetml/);
});

test('valid legacy cache is verified and upgraded; absent hashes or byte-size proof are never accepted', async t => {
  for (const variant of ['valid', 'hashless', 'sizeless']) {
    let downloads = 0;
    const f = fixture(t, async () => { downloads++; throw Error('must not redownload uncertain cache'); });
    const event = message(variant, file('fixture'), 'file'), root = f.dir(event.message_id);
    fs.mkdirSync(root, { recursive: true }); const { saved_path } = save(root, 'legacy.xlsx', 'fixture');
    const cached = { saved_path, sha256: digest('fixture'), size_bytes: 7, original_name: '资料.xlsx' };
    if (variant === 'hashless') delete cached.sha256;
    if (variant === 'sizeless') delete cached.size_bytes;
    fs.writeFileSync(path.join(root, 'resource-0.json'), JSON.stringify(cached));
    const result = await f.prepare(event);
    assert.equal(downloads, 0);
    if (variant === 'valid') {
      assert.equal(result.attachmentPreparationError, undefined);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'resource-0.json'))).schema, 2);
    } else assert.equal(result.attachmentPreparationError, 'attachment_cache_invalid');
  }
});

test('tampered bytes and changed source identity cannot be silently reused or redownloaded', async t => {
  for (const variant of ['bytes', 'key', 'profile', 'corrupt']) {
    let downloads = 0;
    const f = fixture(t, async (_, args, root) => { downloads++; return save(root, 'resource-0.xlsx', 'original'); });
    let event = message('tamper', file('fixture'), 'file');
    const first = await f.prepare(event);
    if (variant === 'bytes') fs.writeFileSync(first.attachmentResults[0].saved_path, 'modified');
    if (variant === 'key') event = message('tamper', file('different'), 'file');
    if (variant === 'profile') f.binding.profile = 'different';
    if (variant === 'corrupt') fs.writeFileSync(path.join(f.dir(event.message_id), 'resource-0.json'), '{');
    const second = await f.prepare(event);
    assert.equal(downloads, 1); assert.equal(second.attachmentResults[0].status, 'failed');
    assert.match(second.attachmentPreparationError, /^attachment_cache_/);
    assert.equal(second.attachmentResults[0].saved_path, undefined);
  }
});

test('empty and oversized files are individually classified, while a following valid file remains available', async t => {
  const f = fixture(t, async (_, args, root) => {
    const key = args[args.indexOf('--file-key') + 1];
    const result = save(root, key + '.bin', key === 'file_empty' ? '' : 'fixture');
    if (key === 'file_large') fs.truncateSync(result.saved_path, 50 * 1024 * 1024 + 1);
    return result;
  });
  const result = await f.prepare(message('limits', [file('empty'), file('large'), file('valid')]));
  assert.deepEqual(result.attachmentResults.map(x => x.code ?? x.status), ['attachment_empty', 'attachment_too_large', 'success']);
  assert.match(result.content, /附件为空/); assert.match(result.content, /50 MiB/);
});

test('symlinked bot/message directories are rejected before any downloader mutation', async t => {
  for (const level of ['bot', 'message']) {
    let downloads = 0;
    const f = fixture(t, async () => { downloads++; });
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    const event = message('link', file('fixture'), 'file');
    if (level === 'message') fs.mkdirSync(path.join(f.root, f.binding.bot));
    fs.symlinkSync(outside, level === 'bot' ? path.join(f.root, f.binding.bot) : f.dir(event.message_id), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.prepare(event), { code: 'attachment_outside_download_root' });
    assert.equal(downloads, 0); assert.deepEqual(fs.readdirSync(outside), []);
  }
});

test('returned symlink, internal alias and hardlink files never expose bytes or rejected paths', async t => {
  for (const variant of ['outside', 'inside', 'hardlink']) {
    const f = fixture(t, async (_, args, root) => {
      const target = variant === 'inside' ? path.join(root, 'original.txt') : path.join(f.root, 'outside-private.txt');
      fs.writeFileSync(target, 'not-for-prompt'); const alias = path.join(root, 'alias.txt');
      if (variant === 'hardlink') fs.linkSync(target, alias); else fs.symlinkSync(target, alias);
      return { saved_path: alias };
    });
    const result = await f.prepare(message('alias', file('fixture'), 'file'));
    assert.equal(result.attachmentResults[0].status, 'failed'); assert.equal(result.attachmentResults[0].saved_path, undefined);
    assert.ok(!result.content.includes('outside-private')); assert.ok(!result.content.includes('not-for-prompt')); assert.ok(!result.content.includes('alias.txt'));
  }
});

test('corrupt and symlinked cache records do not trigger downloads or read outside files', async t => {
  for (const variant of ['corrupt', 'symlink']) {
    let calls = 0;
    const f = fixture(t, async () => { calls++; }); const event = message('cache', file('fixture'), 'file');
    const root = f.dir(event.message_id); fs.mkdirSync(root, { recursive: true });
    const cache = path.join(root, 'resource-0.json');
    if (variant === 'corrupt') fs.writeFileSync(cache, '{ invalid');
    else { const outside = path.join(f.root, 'private.json'); fs.writeFileSync(outside, 'private'); fs.symlinkSync(outside, cache); }
    const result = await f.prepare(event); assert.equal(calls, 0); assert.equal(result.attachmentResults[0].status, 'failed');
    assert.ok(!result.content.includes('private.json'));
  }
});

test('missing post resource keys, malformed keys and unknown types explicitly retain the original message', async t => {
  const f = fixture(t, async (_, args, root) => save(root, 'good.xlsx'));
  const event = message('missing', { content: [[{ tag: 'text', text: '仍需处理的正文' }, { tag: 'file', file_name: '缺失.pdf' }, file('good')]] });
  const prepared = await f.prepare(event);
  assert.equal(prepared.attachmentPreparationError, 'attachment_partial_failure'); assert.match(prepared.content, /仍需处理的正文/);
  assert.deepEqual(prepared.attachmentResults.map(x => x.status), ['success', 'failed']);
  const invalid = await f.prepare(message('invalid', { file_key: '../../private', file_name: '名字' }, 'file'));
  assert.equal(invalid.attachmentPreparationError, 'attachment_resource_key_invalid');
  const unknown = await f.prepare(message('unknown', { detail: 'unknown original' }, 'new_type'));
  assert.equal(unknown.attachmentPreparationError, 'attachment_type_unsupported'); assert.match(unknown.content, /unknown original/);
});

test('normalization handles locale posts, deduplicates resource references and keeps enriched metadata', () => {
  const normalized = normalizeEvent(message('locale', { zh_cn: { title: '标题', content: [[
    { tag: 'img', image_key: 'img_fixture' }, { tag: 'file', file_key: 'file_fixture' },
    { ...file('fixture', '后续名字.pdf'), mime_type: 'application/pdf' },
    { tag: 'a', href: 'https://example.test/untrusted' }]] } }));
  assert.equal(normalized.resources.length, 2); assert.equal(normalized.resources[1].name, '后续名字.pdf');
  assert.equal(normalized.resources[1].metadata.mime_type, 'application/pdf'); assert.deepEqual(normalized.resourceErrors, []);
  assert.equal(normalizeEvent(message('textkey', { text: 'file_fixture' }, 'text')).resources.length, 0);
});

test('normalization bounds hostile attachment trees and counts without dropping already found resources', () => {
  let deep = file('deep'); for (let i = 0; i < 100; i++) deep = { nested: deep };
  const depth = normalizeEvent(message('depth', [file('good'), deep]));
  assert.equal(depth.resources.length, 1); assert.ok(depth.resourceErrors.includes('attachment_structure_limit'));
  const count = normalizeEvent(message('count', Array.from({ length: 150 }, (_, i) => file(String(i)))));
  assert.equal(count.resources.length, 20); assert.ok(count.resourceErrors.includes('attachment_resource_limit'));
});

test('JSON originals use a payload filename distinct from their cache; reserved downloader outputs are rejected', async t => {
  const f = fixture(t, async (_, args, root) => {
    assert.equal(args.at(-1), './resource-0.payload.json');
    return save(root, args.at(-1), '{"synthetic":true}');
  });
  const event = message('json', file('fixture', '资料.json'), 'file');
  const first = await f.prepare(event), second = await f.prepare(event);
  assert.equal(first.attachmentPreparationError, undefined); assert.deepEqual(first.attachmentResults, second.attachmentResults);
  assert.equal(fs.readFileSync(first.attachmentResults[0].saved_path, 'utf8'), '{"synthetic":true}');
  const g = fixture(t, async (_, args, root) => save(root, 'resource-0.json', 'original must not be overwritten by receipt'));
  const rejected = await g.prepare(event);
  assert.equal(rejected.attachmentPreparationError, 'attachment_path_reserved');
  assert.equal(fs.readFileSync(path.join(g.dir(event.message_id), 'resource-0.json'), 'utf8'), 'original must not be overwritten by receipt');
});

test('declared overlimit sizes are rejected before download; at most 20 distinct resources are attempted', async t => {
  let calls = 0;
  const f = fixture(t, async (_, args, root) => { calls++; return save(root, 'fixture.bin'); });
  const tooLarge = await f.prepare(message('declared', [
    { ...file('large'), file_size: 50 * 1024 * 1024 + 1 },
    { ...file('huge'), size: '999999999999999999999999999999' }, file('good') ]));
  assert.equal(calls, 1);
  assert.deepEqual(tooLarge.attachmentResults.map(x => x.code ?? x.status), ['attachment_too_large', 'attachment_too_large', 'success']);
  calls = 0;
  const count = await f.prepare(message('countbudget', Array.from({ length: 30 }, (_, i) => file(String(i)))));
  assert.equal(calls, 20); assert.equal(count.attachmentPreparationError, 'attachment_partial_failure');
  assert.match(fs.readFileSync(path.join(f.dir('om_countbudget'), 'message.txt'), 'utf8'), /20 项安全上限/);
});

test('a message has a 250 MiB total byte budget and stops downloading after it is used, including after restart', async t => {
  let calls = 0;
  const f = fixture(t, async (_, args, root) => {
    calls++;
    const saved_path = path.join(root, 'synthetic-large.bin');
    if (!fs.existsSync(saved_path)) { fs.writeFileSync(saved_path, ''); fs.truncateSync(saved_path, 50 * 1024 * 1024); }
    return { saved_path };
  });
  const event = message('totalbudget', Array.from({ length: 7 }, (_, i) => ({ ...file(String(i)), file_size: 50 * 1024 * 1024 })));
  const result = await f.prepare(event);
  assert.equal(calls, 5); assert.equal(result.attachmentResults.filter(x => x.status === 'success').length, 5);
  assert.deepEqual(result.attachmentResults.slice(5).map(x => x.code), ['attachment_total_too_large', 'attachment_total_too_large']);
  assert.match(result.content, /250 MiB/);
  await f.prepare(event); assert.equal(calls, 5);
});
