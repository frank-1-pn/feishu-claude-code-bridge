import { createHash } from 'node:crypto';

// Native Docx styles, verified against the official block/create-descendant
// schemas on 2026-09-27. These schemas expose no paragraph/line spacing fields.
// https://open.feishu.cn/document/docs/docs/data-structure/block
// https://open.feishu.cn/document/docs/docs/document-block/create-2
export const CLOUD_DOC_PRESENTATION_VERSION = 'native-readable-v1';

const MAX_BLOCKS = 5000;
const SUMMARY_BLOCKS = 64;
const SUMMARY_CHARACTERS = 1800;
const BLUE_BACKGROUND = 'LightBlueBackground';
const TEXT_KEYS = new Map([[2, 'text'], [12, 'bullet'], [13, 'ordered'],
  [14, 'code'], [15, 'quote'], [17, 'todo'],
  ...Array.from({ length: 9 }, (_, i) => [i + 3, `heading${i + 1}`])]);
const isHeading = block => block.block_type >= 3 && block.block_type <= 11;
const textPart = block => block?.[TEXT_KEYS.get(block.block_type)];
const invalid = () => Object.assign(Error('cloud_doc_invalid_presentation'),
  { code: 'cloud_doc_invalid_presentation', permanent: true });

function textContent(block) {
  return (textPart(block)?.elements ?? []).map(element =>
    typeof element?.text_run?.content === 'string' ? element.text_run.content : '').join('');
}

function styleText(part, { bold = false, blue = false, background } = {}) {
  if (!part) return;
  if (background) {
    part.style ??= {};
    part.style.background_color ??= background;
  }
  if (!bold && !blue) return;
  for (const element of part.elements ?? []) {
    // Preserve mentions, equations, links, inline code and unknown inline types.
    // In particular, do not reconstruct the text from plain textContent().
    if (!element.text_run) continue;
    const style = element.text_run.text_element_style ??= {};
    if (bold) style.bold = true;
    if (blue) style.text_color ??= 5;
  }
}

function graph(converted) {
  if (!converted || !Array.isArray(converted.blocks)
      || !Array.isArray(converted.first_level_block_ids)
      || converted.blocks.length > MAX_BLOCKS) throw invalid();
  const byId = new Map();
  for (const block of converted.blocks) {
    if (!block || typeof block.block_id !== 'string' || !block.block_id
        || byId.has(block.block_id)
        || (block.children !== undefined && !Array.isArray(block.children))) throw invalid();
    byId.set(block.block_id, block);
  }
  const seen = new Set();
  function visit(id, depth) {
    if (depth > 32 || seen.has(id) || !byId.has(id)) throw invalid();
    seen.add(id);
    for (const child of byId.get(id).children ?? []) visit(child, depth + 1);
  }
  for (const id of converted.first_level_block_ids) visit(id, 0);
  if (seen.size !== byId.size) throw invalid();
  return byId;
}

function subtree(id, byId) {
  const result = [];
  const pending = [id];
  while (pending.length) {
    const block = byId.get(pending.pop());
    result.push(block);
    pending.push(...(block.children ?? []).toReversed());
  }
  return result;
}

function subtreeDepth(id, byId) {
  const children = byId.get(id).children ?? [];
  return children.length ? 1 + Math.max(...children.map(child => subtreeDepth(child, byId))) : 0;
}

function readableWidth(text) {
  // This is a sizing estimate only; no character is transformed or truncated.
  let longest = 0;
  for (const line of text.split(/\r?\n/)) {
    let width = 0;
    for (const character of line) {
      if (/\p{Mark}/u.test(character) || character === '\u200d') continue;
      width += character.codePointAt(0) > 0xff ? 2 : 1;
    }
    longest = Math.max(longest, width);
  }
  return Math.min(320, Math.max(120, Math.ceil((longest * 7.5 + 32) / 8) * 8));
}

function styleTable(table, byId) {
  const property = table.table?.property;
  const columns = property?.column_size, rows = property?.row_size;
  const cellIds = table.children ?? table.table?.cells;
  if (!Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1
      || !Array.isArray(cellIds) || cellIds.length !== columns * rows
      || cellIds.some(id => byId.get(id)?.block_type !== 32)) return;
  // The Markdown converter produces unmerged tables. An unusual/merged native
  // table retains its original header semantics and widths instead of guessing.
  if ((property.merge_info ?? []).some(cell => cell.row_span > 1 || cell.col_span > 1)) return;

  const widths = Array(columns).fill(120);
  for (let index = 0; index < cellIds.length; index++) {
    const contents = subtree(cellIds[index], byId);
    widths[index % columns] = Math.max(widths[index % columns],
      ...contents.map(block => readableWidth(textContent(block))));
    if (index < columns) for (const block of contents) {
      // Code elements must remain byte-for-byte identical, including their styles.
      if (block.block_type !== 14) styleText(textPart(block), { bold: true, background: BLUE_BACKGROUND });
    }
  }
  // Narrow tables stay compact. Wide tables retain a readable minimum and use
  // the native horizontal scroll rather than squeezing text into tiny columns.
  const total = widths.reduce((sum, width) => sum + width, 0);
  const budget = Math.max(720, columns * 120);
  if (total > budget) {
    const flexible = total - columns * 120, available = budget - columns * 120;
    for (let i = 0; i < widths.length; i++) widths[i] = 120 + Math.floor((widths[i] - 120) * available / flexible);
  }
  property.column_width = widths;
  property.header_row = true;
}

function explicitConclusion(block) {
  if (!isHeading(block) && block.block_type !== 2) return false;
  const text = textContent(block).trim();
  if (/^(?:核心|主要)?结论\s*[:：]\s*\S/u.test(text)) return true;
  return isHeading(block) && /^(?:(?:[一二三四五六七八九十]+|\d+)[、.．)]\s*)?(?:核心|主要)?结论\s*[:：]?$/u.test(text);
}

function styleConclusion(converted, byId) {
  const roots = converted.first_level_block_ids;
  let index = -1;
  for (let i = 0; i < roots.length; i++) {
    const block = byId.get(roots[i]);
    // A pre-existing conclusion callout already supplies emphasis. This also
    // makes repeated presentation passes stable when a second conclusion exists.
    if (block.block_type === 19 && subtree(block.block_id, byId).some(explicitConclusion)) return;
    if (explicitConclusion(block)) { index = i; break; }
  }
  if (index < 0) return;
  const first = byId.get(roots[index]);
  const group = [];
  let count = 1, characters = 0;
  for (let i = index; i < roots.length && group.length < 7; i++) {
    const block = byId.get(roots[i]);
    if (i !== index && !(isHeading(first)
      ? [2, 12, 13].includes(block.block_type) : [12, 13].includes(block.block_type))) break;
    const members = subtree(block.block_id, byId);
    // Do not pull code/tables/media/special blocks under a summary container.
    if (members.some(member => member !== first && ![2, 12, 13].includes(member.block_type))) break;
    // Adding a wrapper increases every descendant's depth by one. Keep the
    // existing planner's depth-32 guarantee even for a short but deep list.
    if (subtreeDepth(block.block_id, byId) >= 32) break;
    const length = members.reduce((sum, member) => sum + textContent(member).length, 0);
    if (count + members.length > SUMMARY_BLOCKS || characters + length > SUMMARY_CHARACTERS) break;
    group.push(block.block_id); count += members.length; characters += length;
  }
  if (!group.length || group.length === roots.length || converted.blocks.length >= MAX_BLOCKS) {
    // Never turn a whole report into one subtree, nor push 5000 blocks over the
    // existing batch planner's ceiling. Emphasize the explicit label in place.
    styleText(textPart(first), { background: BLUE_BACKGROUND });
    return;
  }
  const hash = createHash('sha256').update(JSON.stringify([CLOUD_DOC_PRESENTATION_VERSION, group])).digest('hex').slice(0, 24);
  const base = `presentation_conclusion_${hash}`;
  let id = base, suffix = 0;
  while (byId.has(id)) id = `${base}_${++suffix}`;
  const wrapper = { block_id: id, block_type: 19, callout: { background_color: 5, border_color: 5 }, children: group };
  if (Object.hasOwn(first, 'parent_id')) wrapper.parent_id = first.parent_id;
  for (const child of group) {
    const block = byId.get(child);
    if (Object.hasOwn(block, 'parent_id')) block.parent_id = id;
  }
  roots.splice(index, group.length, id);
  // Keep original block-array order as well as document traversal order.
  converted.blocks.splice(converted.blocks.indexOf(first), 0, wrapper);
}

/**
 * Style an official Docx Markdown-convert result without rendering Markdown,
 * adding prose, removing unsupported blocks or mutating the caller's object.
 * Unknown block/inline payloads and conversion metadata pass through unchanged.
 * API validation, read-only-field removal and batching remain with the caller.
 */
export function presentCloudDoc(converted) {
  const result = structuredClone(converted);
  const byId = graph(result);
  for (const block of result.blocks) {
    if (isHeading(block)) styleText(textPart(block), { bold: true, blue: block.block_type <= 4 });
    if (block.block_type === 14 && block.code) {
      block.code.style ??= {};
      block.code.style.wrap = true;
      // Live acceptance on 2026-09-27: adding background_color to Code caused
      // API 4000501 (operation/block mismatch). The same request succeeded
      // with only that added field removed. The generic TextStyle schema is
      // not proof that each field works for Code. Preserve source styles, but
      // never synthesize a code background here; wrap is independently verified.
    }
    if (block.block_type === 31) styleTable(block, byId);
  }
  styleConclusion(result, byId);
  return result;
}
