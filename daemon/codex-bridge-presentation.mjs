// Pure presentation of PUBLIC assistant output. The caller must select only
// final/commentary events; arbitrary rollout/reasoning objects are never read.
const STATUS = Object.freeze({
  queued: '已排队', working: '正在处理', searching: '正在检索',
  organizing: '正在整理', waiting: '等待补充', complete: '处理完成', error: '处理遇到问题',
});

export function safeHttpUrl(value) {
  if (typeof value !== 'string' || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const attr = value => String(value).replaceAll('&', '&amp;').replaceAll("'", '&#39;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plain = value => String(value).replace(/<[^>]*>/g, '').replace(/!?\[([^\]]+)\]\([^\n]*?\)/g, '$1').replace(/[*_`#~]/g, '').replace(/\s+/g, ' ').trim();
const shorten = (value, limit) => Array.from(value).slice(0, limit).join('') + (Array.from(value).length > limit ? '…' : '');

/** Lossless blocks, keeping fenced/indented code and tables as atomic units. */
export function markdownBlocks(value) {
  const lines = String(value).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const blocks = []; let current = [], kind = '', fence = null;
  const flush = () => { if (current.length) blocks.push({ kind, text: current.join('') }); current = []; kind = ''; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], clean = line.replace(/\r?\n$/, '');
    if (fence) {
      current.push(line);
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`).test(clean)) { fence = null; flush(); }
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(clean);
    if (opening) { flush(); fence = { char: opening[1][0], length: opening[1].length }; kind = 'code'; current.push(line); continue; }
    if (!clean.trim()) { current.push(line); flush(); continue; }
    const tableStart = clean.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*\|/.test(lines[i + 1] ?? '');
    const nextKind = /^\s{4}|^\t/.test(clean) ? (kind === 'list' ? 'list' : 'code')
      : tableStart || (kind === 'table' && clean.includes('|')) ? 'table'
        : /^ {0,3}(?:[-+*]|\d+[.)])\s/.test(clean) ? 'list'
          : /^ {0,3}#{1,6}\s/.test(clean) ? 'heading' : 'prose';
    if (current.length && (nextKind !== kind || nextKind === 'heading')) flush();
    kind = nextKind; current.push(line);
  }
  flush(); return blocks;
}

// Parse link destinations with balanced parentheses, without matching images.
function linkAt(text, start) {
  if (text[start] !== '[' || text[start - 1] === '!' || text[start - 1] === '\\') return null;
  let end = start + 1, bracketDepth = 1;
  for (; end < text.length && bracketDepth; end++) {
    if (text[end] === '\\') { end++; continue; }
    if (text[end] === '[') bracketDepth++;
    else if (text[end] === ']') bracketDepth--;
    if (text[end] === '\n') return null;
  }
  if (bracketDepth || text[end] !== '(') return null;
  const targetStart = ++end; let depth = 1;
  for (; end < text.length && depth; end++) {
    if (text[end] === '\\') { end++; continue; }
    if (text[end] === '(') depth++;
    else if (text[end] === ')') depth--;
    if (text[end] === '\n' || depth > 32) return null;
  }
  if (depth) return null;
  const target = text.slice(targetStart, end - 1).trim();
  const match = /^(?:<([^<>]+)>|(\S+?))(?:\s+["'][^\n]*["'])?$/.exec(target);
  if (!match) return null;
  return { label: text.slice(start + 1, targetStart - 2), url: match[1] ?? match[2], end };
}

export function decorateSources(value, sourceList = []) {
  const sources = sourceList.map(s => ({ ...s })), known = new Map(sources.map(s => [s.url, s.number]));
  const transformed = markdownBlocks(value).map(block => {
    if (block.kind === 'code') return block.text;
    const text = block.text; let result = '';
    for (let i = 0; i < text.length;) {
      if (text[i] === '`') {
        const ticks = /^`+/.exec(text.slice(i))[0], stop = text.indexOf(ticks, i + ticks.length);
        // An unmatched inline fence is not transformed either.
        const end = stop < 0 ? text.length : stop + ticks.length;
        result += text.slice(i, end); i = end; continue;
      }
      const link = text[i] === '[' ? linkAt(text, i) : null;
      if (!link) { result += text[i++]; continue; }
      const url = safeHttpUrl(link.url);
      if (!url) { result += `${link.label}（${link.url}）`; i = link.end; continue; }
      let number = known.get(url);
      if (!number && sources.length < 99) {
        number = sources.length + 1; known.set(url, number); sources.push({ number, label: plain(link.label) || url, url });
      }
      result += text.slice(i, link.end);
      if (number) result += `<number_tag url='${attr(url)}'>${number}</number_tag>`;
      i = link.end;
    }
    return result;
  }).join('');
  return { text: transformed, sources };
}

function extractPreview(text, suppliedSummary) {
  const explicit = typeof suppliedSummary === 'string' ? suppliedSummary.trim() : '';
  if (explicit && text.includes(explicit) && Array.from(explicit).length <= 1400) return explicit;
  const blocks = markdownBlocks(text), selected = [];
  const itemCount = blocks.filter(b => b.kind === 'list').reduce((n, b) => n + (b.text.match(/^ {0,3}(?:[-+*]|\d+[.)])\s/gm)?.length ?? 0), 0);
  if (Array.from(text).length <= 1400 && itemCount <= 5) return text;
  const firstProse = blocks.find(b => b.kind === 'prose' && b.text.trim());
  const lead = firstProse && Array.from(firstProse.text).length <= 600 ? firstProse : null;
  if (lead) selected.push(lead.text.trim());
  let count = 0, length = selected.join('').length;
  for (const block of blocks.filter(b => b.kind === 'list')) {
    // Keep each original item and its continuation intact. Nested items are
    // part of their parent, not promoted into independent claims.
    const items = block.text.split(/(?=^ {0,3}(?:[-+*]|\d+[.)])\s)/m).filter(s => s.trim());
    for (const item of items) {
      if (count === 5) break;
      if (length + item.length > 1400) break;
      selected.push(item.trimEnd()); length += item.length; count++;
    }
    if (count === 5) break;
  }
  return selected.join('\n\n') || '正文包含较长内容，请展开查看完整答复。';
}

/**
 * No summary generation or factual classification takes place here. Existing
 * verification/inference labels remain the author's own words. Progress must
 * be explicitly tagged commentary; a reasoning/analysis item is rejected.
 */
export function progressTimeLabel(item) {
  const source=Number.isFinite(item.at)?item.at:null;
  const value=source??(Number.isFinite(item.observedAt)?item.observedAt:null);
  if(value===null || value<0 || !Number.isFinite(new Date(value).getTime()))return '时间未记录';
  const parts=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));
  const part=type=>parts.find(p=>p.type===type).value;
  return `${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}${source===null?'（接收时间）':''}`;
}

export function buildPresentation(value, options = {}) {
  const fullText = String(value ?? '');
  const final = Boolean(options.final);
  const state = STATUS[options.status] ? options.status : final ? 'complete' : 'working';
  const status = STATUS[state];
  const decorated = decorateSources(fullText);
  const preview = final ? extractPreview(fullText, options.summary) : fullText;
  const decoratedPreview = decorateSources(preview, decorated.sources).text;
  let answer = decoratedPreview.trim() ? decoratedPreview : (final ? '本次没有可发送的正文。' : '正在处理…');
  const publicProgress = (Array.isArray(options.publicProgress) ? options.publicProgress : [])
    .filter(item => item && item.channel === 'commentary' && typeof item.text === 'string' && item.text.trim())
    .map(item => `**${progressTimeLabel(item)}**\n\n${item.text.trim()}`)
    .filter((text, index, items) => index === 0 || text !== items[index - 1]).slice(-12);
  const report = options.report && typeof options.report.fileName === 'string' ? {
    fileName: options.report.fileName.replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 160),
    delivered: options.report.delivered === true,
    url: safeHttpUrl(options.report.url),
  } : null;
  if(report?.delivered && answer==='正文包含较长内容，请展开查看完整答复。') answer='完整内容见随附报告。';
  const detailText = final && preview !== fullText && !report?.delivered ? decorated.text : '';
  const summary = final && state === 'complete' ? shorten(plain(preview), 100) || status : status;
  return { fullText, answer, detailText, sources: decorated.sources, publicProgress, report, state, status, summary };
}

// Feishu permits at most four Markdown tables per rich-text component. Split
// on block boundaries while leaving every table and code fence intact.
export function markdownElements(text, prefix = 'detail') {
  const elements = []; let chunk = '', tableCount = 0;
  const emit = () => { if (chunk) elements.push({ tag: 'markdown', element_id: `${prefix}_${elements.length}`, content: chunk }); chunk = ''; tableCount = 0; };
  for (const block of markdownBlocks(text)) {
    if (block.kind === 'table' && tableCount === 4) emit();
    if (chunk && Buffer.byteLength(chunk) + Buffer.byteLength(block.text) > 12000) emit();
    chunk += block.text; if (block.kind === 'table') tableCount++;
  }
  emit(); return elements;
}

export function sourceMarkdown(sources) {
  return sources.map(source => `<number_tag url='${attr(source.url)}'>${source.number}</number_tag> ${attr(source.label)}`).join('\n\n');
}
