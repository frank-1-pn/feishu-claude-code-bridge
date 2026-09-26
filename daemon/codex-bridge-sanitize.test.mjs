import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeFeishuReply } from './codex-bridge-sanitize.mjs';

const citation = '<oai-mem-citation>\n'
  + '<citation_entries>\n'
  + 'MEMORY.md:10-12|note=[test]\n'
  + '</citation_entries>\n'
  + '<rollout_ids>\n'
  + '01a02f12-5b35-7571-ab8e-d410db3115c5\n'
  + '</rollout_ids>\n'
  + '</oai-mem-citation>';

test('leaves ordinary replies byte-for-byte unchanged', () => {
  const reply = '正常回复。\n保留原有换行。  ';
  assert.equal(sanitizeFeishuReply(reply), reply);
});

test('removes a complete memory citation suffix', () => {
  assert.equal(sanitizeFeishuReply('同步完成。\n\n' + citation + '\n'), '同步完成。');
});

test('removes a CRLF memory citation suffix', () => {
  const crlfCitation = citation.replaceAll('\n', '\r\n');
  assert.equal(sanitizeFeishuReply('修复完成。\r\n\r\n' + crlfCitation + '\r\n'), '修复完成。');
});

test('removes repeated citation suffixes', () => {
  assert.equal(sanitizeFeishuReply('正文\n' + citation + '\n' + citation), '正文');
});

test('fails closed for a truncated structured citation suffix', () => {
  const truncated = '<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2';
  assert.equal(sanitizeFeishuReply('正文\n' + truncated), '正文');
});

test('preserves an inline literal tag mention', () => {
  const reply = '请过滤 <oai-mem-citation>，但这句话本身应保留。';
  assert.equal(sanitizeFeishuReply(reply), reply);
});

test('returns an empty string when only internal metadata exists', () => {
  assert.equal(sanitizeFeishuReply(citation), '');
});
