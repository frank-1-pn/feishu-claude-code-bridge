import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOUD_DOC_PRESENTATION_VERSION, presentCloudDoc } from './codex-bridge-cloud-presentation.mjs';
import { cloudDocBatches } from './codex-bridge-cloud-docs.mjs';

const text = (id, content, type = 2, extra = {}) => {
  const key = type >= 3 && type <= 11 ? `heading${type - 2}` : ({ 2: 'text', 12: 'bullet', 13: 'ordered', 14: 'code' })[type];
  return { block_id: id, block_type: type, [key]: { elements: [{ text_run: { content } }], ...extra } };
};
const conversion = (blocks, roots = blocks.map(block => block.block_id)) => ({ first_level_block_ids: roots, blocks });
const byId = converted => new Map(converted.blocks.map(block => [block.block_id, block]));
const part = block => block.text ?? block.code ?? block.bullet ?? block.ordered
  ?? Object.entries(block).find(([key]) => /^heading\d$/.test(key))?.[1];

function traversal(converted) {
  const map = byId(converted), ids = [];
  const visit = id => {
    const block = map.get(id);
    if (block.block_type !== 19 || !id.startsWith('presentation_conclusion_')) ids.push(id);
    for (const child of block.children ?? []) visit(child);
  };
  converted.first_level_block_ids.forEach(visit);
  return ids;
}

function tableFixture(rows = [['项目', '状态', '说明'], ['一号', '已核验', '这是需要更多横向空间的完整说明文字。']]) {
  const blocks = [], children = [];
  rows.forEach((row, r) => row.forEach((content, c) => {
    const cell = `cell_${r}_${c}`, paragraph = `paragraph_${r}_${c}`;
    children.push(cell);
    blocks.push({ block_id: cell, block_type: 32, table_cell: {}, children: [paragraph] }, text(paragraph, content));
  }));
  return conversion([{ block_id: 'table', block_type: 31, children,
    table: { cells: [...children], property: { row_size: rows.length, column_size: rows[0].length,
      column_width: rows[0].map(() => 244), header_row: false, header_column: false,
      merge_info: children.map(() => ({ row_span: 1, col_span: 1 })) } } }, ...blocks], ['table']);
}

test('an explicit conclusion becomes a short native callout without changing report reading order', () => {
  const source = conversion([text('title', '验收报告', 3), text('conclusion', '结论', 4),
    text('answer', '已通过核心验证。'), text('point1', '表格保留全部数值。', 12),
    text('point2', '来源可点击核验。', 12), text('details', '详细依据', 4), text('body', '详细过程与原始数值。')]);
  const before = structuredClone(source), styled = presentCloudDoc(source), map = byId(styled);
  assert.deepEqual(source, before);
  assert.deepEqual(traversal(styled), traversal(source));
  const callouts = styled.blocks.filter(block => block.block_type === 19);
  assert.equal(callouts.length, 1);
  assert.deepEqual(callouts[0].children, ['conclusion', 'answer', 'point1', 'point2']);
  assert.deepEqual(callouts[0].callout, { background_color: 5, border_color: 5 });
  assert.equal(styled.first_level_block_ids.length, 4);
  assert.equal(map.get('title').heading1.elements[0].text_run.text_element_style.text_color, 5);
  assert.equal(map.get('details').block_type, 4);
  assert.equal(map.get('body').text.elements[0].text_run.content, '详细过程与原始数值。');
  assert.match(CLOUD_DOC_PRESENTATION_VERSION, /^native-readable-v\d+$/);
});

test('plain explicit conclusion only groups adjacent points and never guesses a summary', () => {
  const source = conversion([text('a', '结论：本轮验收通过。'), text('b', '第一项证据', 12),
    text('c', '以下开始分析过程。'), text('d', '另一项', 12)]);
  const styled = presentCloudDoc(source);
  assert.deepEqual(styled.blocks.find(block => block.block_type === 19).children, ['a', 'b']);
  const ordinary = conversion([text('title', '报告', 3), text('a', '这里提到结论，但不是结论区。'),
    text('b', '结论仍然待确认', 4), text('c', '总结与计划', 4)]);
  const ordinaryStyled = presentCloudDoc(ordinary);
  assert.equal(ordinaryStyled.blocks.some(block => block.block_type === 19), false);
  assert.deepEqual(traversal(ordinaryStyled), traversal(ordinary));
});

test('numbered conclusion headings are supported and a second pass never wraps the later conclusion', () => {
  const source = conversion([text('title', '报告', 3), text('a', '一、结论', 4), text('b', '内容'),
    text('details', '依据', 4), text('second', '结论：另一个场景'), text('end', '结束')]);
  const first = presentCloudDoc(source);
  assert.equal(first.blocks.filter(block => block.block_type === 19).length, 1);
  assert.deepEqual(presentCloudDoc(first), first);
});

test('existing callout and original colors, links and semantic emphasis survive', () => {
  const source = conversion([{ block_id: 'existing', block_type: 19, callout: { background_color: 3, emoji_id: 'warning' }, children: ['label'] },
    text('label', '结论：存在待确认项。'), text('other', '结论：补充项'), text('title', '标题', 3)], ['existing', 'other', 'title']);
  source.blocks.at(-1).heading1.elements[0].text_run.text_element_style = {
    text_color: 1, italic: true, underline: true, link: { url: 'https%3A%2F%2Fexample.org%2F%E4%B8%AD%E6%96%87%3Fa%3D1' }
  };
  const result = presentCloudDoc(source);
  assert.equal(result.blocks.length, source.blocks.length);
  assert.deepEqual(result.blocks[0], source.blocks[0]);
  const original = source.blocks.at(-1).heading1.elements[0].text_run.text_element_style;
  assert.deepEqual(result.blocks.at(-1).heading1.elements[0].text_run.text_element_style, { ...original, bold: true });
});

test('native tables get a readable first row and compact unequal column widths without losing cells', () => {
  const source = tableFixture(), styled = presentCloudDoc(source), map = byId(styled);
  const originalHeader = source.blocks.find(block => block.block_id === 'paragraph_0_1');
  originalHeader.text.style = { align: 2, background_color: 'LightYellowBackground' };
  originalHeader.text.elements[0].text_run.text_element_style = { text_color: 1, underline: true, link: { url: 'https%3A%2F%2Fexample.org' } };
  const richResult = presentCloudDoc(source), richMap = byId(richResult);
  assert.equal(map.get('table').table.property.header_row, true);
  const widths = map.get('table').table.property.column_width;
  assert.equal(widths.length, 3);
  assert.ok(widths[2] > widths[0]);
  assert.ok(widths.every(width => Number.isInteger(width) && width >= 120 && width <= 320));
  assert.ok(widths.reduce((sum, value) => sum + value, 0) <= 720);
  assert.deepEqual(traversal(styled), traversal(source));
  assert.deepEqual(map.get('table').table.cells, source.blocks[0].table.cells);
  for (const id of source.blocks[0].children) assert.deepEqual(map.get(id), byId(source).get(id));
  assert.equal(map.get('paragraph_0_0').text.style.background_color, 'LightBlueBackground');
  assert.equal(map.get('paragraph_0_0').text.elements[0].text_run.text_element_style.bold, true);
  assert.deepEqual(map.get('paragraph_1_0'), byId(source).get('paragraph_1_0'));
  assert.deepEqual(richMap.get('paragraph_0_1').text.style, originalHeader.text.style);
  assert.deepEqual(richMap.get('paragraph_0_1').text.elements[0].text_run.text_element_style,
    { ...originalHeader.text.elements[0].text_run.text_element_style, bold: true });
  assert.deepEqual(presentCloudDoc(richResult), richResult);
});

test('table cell order comes from the graph, not the unordered convert block array', () => {
  const source = tableFixture(), expected = presentCloudDoc(source);
  source.blocks.reverse();
  const result = presentCloudDoc(source), a = byId(result), b = byId(expected);
  assert.deepEqual(result.blocks.map(block => block.block_id), source.blocks.map(block => block.block_id));
  for (const [id, block] of a) assert.deepEqual(block, b.get(id));
});

test('merged/native unusual tables retain their pre-existing header meaning and geometry', () => {
  const source = tableFixture();
  source.blocks[0].table.property.merge_info[0] = { row_span: 1, col_span: 2 };
  source.blocks[0].table.property.header_row = false;
  assert.deepEqual(presentCloudDoc(source), source);
});

test('wide tables keep readable minimum widths instead of squeezing or deleting columns', () => {
  const source = tableFixture([Array(10).fill('长列标题'), Array(10).fill('很长的内容'.repeat(40))]);
  const result = presentCloudDoc(source);
  assert.deepEqual(result.blocks[0].table.property.column_width, Array(10).fill(120));
  assert.deepEqual(traversal(result), traversal(source));
});

test('code wraps but every element and language remain byte-identical, including inside a table header', () => {
  const source = tableFixture([['代码']]);
  const code = text('code', 'const 中文 = "😀";\r\n  // 原始缩进\nconsole.log(中文);\n', 14,
    { style: { language: 30, wrap: false, background_color: 'LightYellowBackground' } });
  code.code.elements[0].text_run.text_element_style = { bold: false, text_color: 1, link: { url: 'https%3A%2F%2Fexample.org' } };
  source.blocks[1].children = ['code']; source.blocks[2] = code;
  const originalBytes = JSON.stringify(code.code.elements), result = presentCloudDoc(source), actual = byId(result).get('code');
  assert.equal(JSON.stringify(actual.code.elements), originalBytes);
  assert.deepEqual(actual.code.style, { language: 30, wrap: true, background_color: 'LightYellowBackground' });
});

test('code never gains background_color, which real descendant creation rejects with API 4000501', () => {
  const source = conversion([text('code', 'const result = "原始代码";\n', 14, { style: { language: 30, wrap: false } }),
    text('plain', '没有语言标记的代码\n', 14)]);
  const result = presentCloudDoc(source);
  for (let i = 0; i < source.blocks.length; i++) {
    assert.equal(Object.hasOwn(result.blocks[i].code.style, 'background_color'), false);
    assert.equal(result.blocks[i].code.style.wrap, true);
    assert.equal(JSON.stringify(result.blocks[i].code.elements), JSON.stringify(source.blocks[i].code.elements));
  }
  assert.equal(result.blocks[0].code.style.language, 30);
  assert.deepEqual(presentCloudDoc(result), result);
});

test('all special blocks, inline payloads and image mappings pass through without rewriting', () => {
  const source = conversion([text('title', '完整内容', 3),
    { block_id: 'media', block_type: 27, image: { token: '', width: 500, height: 300 } },
    { block_id: 'special', block_type: 999, unknown: { arbitrary: ['原始', 123, { url: 'https://example.org/source?q=x' }] } },
    { block_id: 'board', block_type: 43, board: { token: 'fixture', width: 400 } },
    { block_id: 'paragraph', block_type: 2, text: { elements: [{ equation: { content: '\\alpha + 1' } },
      { mention_doc: { token: 'fixture-doc', title: '原始链接' } }, { future_inline: { preserved: true } },
      { text_run: { content: '不可遗漏 👩‍🔬 é', text_element_style: { link: { url: 'https%3A%2F%2Fexample.org' }, inline_code: true } } }] } }]);
  source.block_id_to_image_urls = [{ block_id: 'media', image_url: 'https://example.org/图.png' }];
  source.future_metadata = { retained: ['完整', 1] };
  const result = presentCloudDoc(source);
  assert.deepEqual(result.blocks.slice(1), source.blocks.slice(1));
  assert.deepEqual(result.block_id_to_image_urls, source.block_id_to_image_urls);
  assert.deepEqual(result.future_metadata, source.future_metadata);
});

test('conclusion grouping stops at code and special blocks, retaining their original root positions', () => {
  const source = conversion([text('title', '报告', 3), text('summary', '结论', 4), text('answer', '已确认。'),
    text('code', 'const result = true;', 14), text('later', '后续内容'), { block_id: 'special', block_type: 999, unknown: {} }]);
  const result = presentCloudDoc(source);
  assert.deepEqual(result.blocks.find(block => block.block_type === 19).children, ['summary', 'answer']);
  assert.deepEqual(result.first_level_block_ids.slice(2), ['code', 'later', 'special']);
  assert.deepEqual(traversal(result), traversal(source));
});

test('5000-block reports preserve independent roots and remain compatible with existing batch sizing', () => {
  const source = conversion(Array.from({ length: 5000 }, (_, i) => text(`p${i}`, i === 0 ? '结论：全部保留。' : `第 ${i} 行`)));
  const result = presentCloudDoc(source);
  assert.equal(result.blocks.length, 5000);
  assert.equal(result.first_level_block_ids.length, 5000);
  assert.equal(result.blocks[0].text.style.background_color, 'LightBlueBackground');
  const plan = cloudDocBatches(result);
  assert.equal(plan.batches.length, 5);
  assert.ok(plan.batches.every(batch => batch.descendants.length <= 1000));
  assert.deepEqual(plan.batches.flatMap(batch => batch.children_id), source.first_level_block_ids);
});

test('a 4999-block report can add one bounded conclusion without nesting the report', () => {
  const source = conversion(Array.from({ length: 4999 }, (_, i) => text(`p${i}`, i === 0 ? '结论：全部保留。' : `第 ${i} 行`)));
  const result = presentCloudDoc(source), callout = result.blocks.find(block => block.block_type === 19);
  assert.equal(result.blocks.length, 5000);
  assert.equal(result.first_level_block_ids.length, 4999);
  assert.deepEqual(callout.children, ['p0']);
  assert.deepEqual(traversal(result), traversal(source));
  assert.deepEqual(presentCloudDoc(result), result);
});

test('large nested summaries are emphasized in place and never exceed a batch with a new wrapper', () => {
  const source = conversion([text('summary', '结论：大量明细'),
    ...Array.from({ length: 1000 }, (_, i) => text(`p${i}`, `明细 ${i}`, 12)), text('end', '附注')], ['summary', 'end']);
  source.blocks[0].children = source.blocks.slice(1, -1).map(block => block.block_id);
  const result = presentCloudDoc(source);
  assert.equal(result.blocks.length, source.blocks.length);
  assert.deepEqual(traversal(result), traversal(source));
});

test('a whole short report is not replaced by a single callout subtree', () => {
  const source = conversion([text('summary', '结论', 4), text('answer', '只有这段结论。')]);
  const result = presentCloudDoc(source);
  assert.equal(result.blocks.length, source.blocks.length);
  assert.deepEqual(result.first_level_block_ids, source.first_level_block_ids);
  assert.equal(result.blocks[0].heading2.style.background_color, 'LightBlueBackground');
});

test('a valid depth-32 conclusion retains its depth and stays writable without a wrapper', () => {
  const blocks = [text('summary', '结论：深层明细。')];
  for (let i = 1; i <= 32; i++) {
    blocks.at(-1).children = [`nested${i}`];
    blocks.push(text(`nested${i}`, `明细 ${i}`, 12));
  }
  blocks.push(text('end', '附注'));
  const source = conversion(blocks, ['summary', 'end']);
  const result = presentCloudDoc(source);
  assert.equal(result.blocks.length, source.blocks.length);
  assert.equal(result.blocks[0].text.style.background_color, 'LightBlueBackground');
  assert.deepEqual(traversal(result), traversal(source));
  assert.equal(cloudDocBatches(result).batches[0].descendants.length, source.blocks.length);
});

test('malformed graphs fail with a fixed non-sensitive diagnostic and never mutate input', () => {
  for (const source of [conversion([text('secret-id', 'private')], ['missing-secret']),
    conversion([text('a', 'private'), text('a', 'private')]),
    conversion([{ ...text('a', 'private'), children: ['a'] }]),
    conversion([text('a', 'private'), text('orphan', 'secret')], ['a']),
    conversion(Array.from({ length: 5001 }, (_, i) => text(`p${i}`, 'private')))]) {
    const before = structuredClone(source);
    assert.throws(() => presentCloudDoc(source), { code: 'cloud_doc_invalid_presentation', message: 'cloud_doc_invalid_presentation' });
    assert.deepEqual(source, before);
  }
  assert.deepEqual(presentCloudDoc(conversion([])), conversion([]));
});
