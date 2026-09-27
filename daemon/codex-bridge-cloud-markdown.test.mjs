import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCloudMarkdown} from './codex-bridge-cloud-markdown.mjs';

test('repairs blank paragraphs inside a complete table, leaving surrounding paragraphs and all cells intact',()=>{
  const raw='正文\r\n\r\n| 名称 | 值 |\r\n\r\n| :--- | ---: |\r\n\r\n| 中文 | 42 |\r\n\r\n| 链接 | [依据](https://example.org) |\r\n\r\n后文\r\n';
  const normalized=normalizeCloudMarkdown(raw);
  assert.equal(normalized,'正文\r\n\r\n| 名称 | 值 |\r\n| :--- | ---: |\r\n| 中文 | 42 |\r\n| 链接 | [依据](https://example.org) |\r\n\r\n后文\r\n');
  assert.deepEqual(normalized.split(/\r?\n/).filter(Boolean),raw.split(/\r?\n/).filter(Boolean));
  assert.equal(normalizeCloudMarkdown(normalized),normalized);
});

test('literal code, quoted examples, escaped/inline-code pipes and incomplete tables retain their bytes',()=>{
  const table='| A | B |\n\n| --- | --- |\n\n| C | D |';
  for(const raw of ['```markdown\n'+table+'\n```','~~~~md\n'+table+'\n~~~\n'+table+'\n~~~~',
    table.split('\n').map(x=>'    '+x).join('\n'),table.split('\n').map(x=>'> '+x).join('\n'),
    '| A | B |\n\n正文\n\n| C | D |','| A | B |\n\n| --- | --- |',
    table.replace('A','`a|b`'),table.replace('A','a\\|b'),table.replace('| C | D |','| C | D | E |')]) {
    assert.equal(normalizeCloudMarkdown(raw),raw);
  }
});
