import fs from 'node:fs';
import path from 'node:path';
import { digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { sanitizeFeishuReply } from './codex-bridge-sanitize.mjs';
import { authorizedFileJob, enqueueGeneratedReport, within } from './codex-bridge-files.mjs';

export const REPORT_POLICY = Object.freeze({ minCharacters: 2400, complexMinCharacters: 1200,
  maxSourceBytes: 4 * 1024 * 1024, maxHtmlBytes: 12 * 1024 * 1024 });
const fail = code => Object.assign(new Error(code), { code, permanent: true });
export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function reportPolicy(text, { force = false } = {}) {
  if (typeof text !== 'string' || !text.trim()) return { generate: false, reason: 'empty' };
  if (Buffer.byteLength(text) > REPORT_POLICY.maxSourceBytes) return { generate: false, reason: 'size_limit' };
  const complex = /^(?: {0,3}```| {0,3}~~~)/m.test(text) || /^\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}/m.test(text)
    || (text.match(/^#{1,6}\s+\S/gm) ?? []).length >= 3;
  return { generate: Boolean(force || text.length >= REPORT_POLICY.minCharacters || (complex && text.length >= REPORT_POLICY.complexMinCharacters)),
    reason: force ? 'requested' : text.length >= REPORT_POLICY.minCharacters ? 'long_answer' : complex && text.length >= REPORT_POLICY.complexMinCharacters ? 'complex_answer' : 'short_answer' };
}

// Remote links are navigations only. Reports never fetch images, styles, scripts,
// local files, or data URLs. Escaped raw HTML remains visible as ordinary text.
function safeUrl(value) {
  if (!/^https?:\/\//i.test(value) || /[\x00-\x20\x7f<>]/.test(value)) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

function destination(text, start) {
  if (text[start] !== '(') return null;
  let depth = 1, i = start + 1;
  for (; i < text.length && i - start <= 4096; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) break;
  }
  if (depth !== 0) return null;
  let url = text.slice(start + 1, i).trim();
  if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1);
  return { url, end: i + 1 };
}

function inline(text, context, depth = 0) {
  let out = '', i = 0;
  const sourceLink = (label, rawUrl) => {
    const url = safeUrl(rawUrl);
    if (!url) return `${escapeHtml(label)} <span class="unlinked">(${escapeHtml(rawUrl)})</span>`;
    let index = context.sources.findIndex(s => s.url === url);
    if (index < 0) { index = context.sources.length; context.sources.push({ url, label }); }
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a><sup><a href="${escapeHtml(url)}" aria-label="来源 ${index + 1}" target="_blank" rel="noopener noreferrer">[${index + 1}]</a></sup>`;
  };
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|>]/.test(text[i + 1])) { out += escapeHtml(text[i + 1]); i += 2; continue; }
    if (text[i] === '`') {
      let n = 1; while (text[i + n] === '`') n++;
      const delimiter = '`'.repeat(n), end = text.indexOf(delimiter, i + n);
      if (end >= 0) { out += `<code>${escapeHtml(text.slice(i + n, end))}</code>`; i = end + n; continue; }
    }
    const image = text[i] === '!' && text[i + 1] === '[', start = image ? i + 1 : i;
    if (text[start] === '[') {
      const labelEnd = text.indexOf(']', start + 1);
      if (labelEnd > start) {
        const label = text.slice(start + 1, labelEnd), link = destination(text, labelEnd + 1);
        if (link) { out += sourceLink(image ? `图片：${label}` : label, link.url); i = link.end; continue; }
        const reference = text.slice(labelEnd + 1).match(/^\[([^\]]*)\]/);
        const refKey = (reference ? reference[1] || label : label).trim().toLowerCase();
        if (context.references.has(refKey)) { out += sourceLink(label, context.references.get(refKey)); i = labelEnd + 1 + (reference?.[0].length ?? 0); continue; }
      }
    }
    if (depth < 3 && text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) { out += `<strong>${inline(text.slice(i + 2, end), context, depth + 1)}</strong>`; i = end + 2; continue; }
    }
    out += text[i] === '\n' ? '<br>\n' : escapeHtml(text[i]); i++;
  }
  return out;
}

function tableCells(line) {
  let value = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const cells = []; let current = '', code = false;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && i + 1 < value.length) { current += value[i] + value[++i]; continue; }
    if (value[i] === '`') code = !code;
    if (value[i] === '|' && !code) { cells.push(current.trim()); current = ''; } else current += value[i];
  }
  cells.push(current.trim()); return cells;
}
const separator = line => Boolean(line && line.includes('|') && tableCells(line).every(c => /^:?-{3,}:?$/.test(c)));
const fence = line => line?.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);

export function renderReportHtml(text) {
  const context = { sources: [], references: new Map() }, lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let inFence = null;
  for (const line of lines) {
    const f = fence(line);
    if (f) { if (!inFence) inFence = f[1]; else if (f[1][0] === inFence[0] && f[1].length >= inFence.length) inFence = null; continue; }
    if (inFence) continue;
    const ref = line.match(/^ {0,3}\[([^\]]+)\]:\s*(\S+)\s*$/);
    if (ref) context.references.set(ref[1].trim().toLowerCase(), ref[2]);
  }
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const f = fence(line);
    if (f) {
      const content = []; i++;
      while (i < lines.length) { const end = fence(lines[i]); if (end && end[1][0] === f[1][0] && end[1].length >= f[1].length && !end[2].trim()) break; content.push(lines[i++]); }
      if (i < lines.length) i++;
      blocks.push(`<figure class="code-block">${f[2].trim() ? `<figcaption>${escapeHtml(f[2].trim())}</figcaption>` : ''}<pre><code>${escapeHtml(content.join('\n'))}</code></pre></figure>`); continue;
    }
    if (/^ {0,3}\[([^\]]+)\]:\s*\S+\s*$/.test(line)) { i++; continue; }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) { const level = Math.min(heading[1].length + 1, 6); blocks.push(`<h${level}>${inline(heading[2], context)}</h${level}>`); i++; continue; }
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.includes('|') && separator(lines[i + 1])) {
      const headings = tableCells(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !fence(lines[i])) rows.push(tableCells(lines[i++]));
      blocks.push(`<div class="table-scroll" role="region" aria-label="数据表格" tabindex="0"><table><thead><tr>${headings.map(h => `<th scope="col">${inline(h, context)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(c => `<td>${inline(c, context)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = []; while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*> ?/, ''));
      blocks.push(`<blockquote>${inline(quote.join('\n'), context)}</blockquote>`); continue;
    }
    const list = line.match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
    if (list) {
      const ordered = Boolean(list[2]), tag = ordered ? 'ol' : 'ul', items = [];
      while (i < lines.length) {
        const item = lines[i].match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
        if (!item || Boolean(item[2]) !== ordered) break;
        items.push(`<li${ordered ? ` value="${Number(item[2])}"` : ''}>${inline(item[3], context)}</li>`); i++;
      }
      blocks.push(`<${tag}>${items.join('')}</${tag}>`); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !fence(lines[i]) && !/^\s*(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s)/.test(lines[i])
      && !separator(lines[i + 1]) && !/^ {0,3}\[([^\]]+)\]:\s*\S+\s*$/.test(lines[i])) paragraph.push(lines[i++]);
    blocks.push(`<p>${inline(paragraph.join('\n'), context)}</p>`);
  }
  const sources = context.sources.length ? `<section class="sources"><h2>来源链接</h2><ol>${context.sources.map(s => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.label)}</a><span class="source-url">${escapeHtml(s.url)}</span></li>`).join('')}</ol></section>` : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>完整答复报告</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#18243b;font:16px/1.8 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere}main{max-width:900px;margin:32px auto;padding:36px 48px;background:white;border:1px solid #e0e6ef;border-radius:18px}header{border-bottom:1px solid #e0e6ef;padding-bottom:20px;margin-bottom:28px}header p{margin:4px 0;color:#546580;font-size:14px}.eyebrow{color:#236b63;font-size:12px;letter-spacing:.12em}h1{font-size:29px;margin:4px 0}h2{font-size:23px;margin:32px 0 12px}h3,h4,h5,h6{margin:24px 0 10px;line-height:1.5}p{margin:12px 0}a{color:#125fad;text-decoration-thickness:1px;text-underline-offset:3px}sup{font-size:11px;margin-left:3px;white-space:nowrap}ul,ol{padding-left:25px}li{padding:3px 0}code{font:14px/1.7 Consolas,"SFMono-Regular",monospace;background:#eff3f8;border-radius:4px;padding:2px 5px;overflow-wrap:anywhere}figure{margin:20px 0}figcaption{font-size:12px;background:#e9eff6;padding:5px 14px;color:#44566b;border-radius:9px 9px 0 0}pre{max-width:100%;overflow:auto;background:#f2f5f9;border:1px solid #e0e6ef;border-radius:9px;padding:16px;font:13px/1.8 Consolas,"SFMono-Regular",monospace;tab-size:2}pre code{padding:0;background:none;white-space:pre;overflow-wrap:normal}blockquote{margin:18px 0;padding:10px 18px;border-left:3px solid #6c9dc7;background:#f5f8fc;color:#44546b}.table-scroll{max-width:100%;overflow-x:auto;margin:20px 0;border:1px solid #dce4ee;border-radius:9px}table{border-collapse:collapse;width:100%;min-width:350px;font-size:14px}th,td{padding:11px 14px;border-bottom:1px solid #e1e7ef;text-align:left;vertical-align:top;min-width:90px}th{background:#edf3f8;font-weight:650}tr:last-child td{border-bottom:0}.sources{border-top:1px solid #e0e6ef;margin-top:32px}.source-url{display:block;font-size:12px;color:#66758a}.unlinked{color:#596980}details{border-top:1px solid #e0e6ef;margin-top:28px;padding-top:16px}summary{cursor:pointer;font-size:14px;color:#4c617a}details pre{white-space:pre-wrap;overflow-wrap:anywhere}footer{color:#63738a;font-size:12px;margin-top:28px}hr{border:0;border-top:1px solid #e0e6ef;margin:24px 0}@media(max-width:600px){body{background:#fff}main{margin:0;padding:24px 20px;border:0;border-radius:0}h1{font-size:25px}h2{font-size:21px}pre{padding:12px}th,td{padding:9px 11px}}@media print{body{background:#fff;font-size:11pt}main{max-width:none;margin:0;padding:0;border:0}a{color:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere}pre code{white-space:pre-wrap}table{min-width:0}.table-scroll{overflow:visible}h2,h3{break-after:avoid}details,footer{display:none}header{padding-bottom:10px;margin-bottom:16px}}</style></head>
<body><main><header><span class="eyebrow">完整答复 · 可离线阅读</span><h1>完整答复报告</h1><p>正文保留本轮答复；原文同时以 Markdown 文件提供。</p></header><article>${blocks.join('\n')}</article>${sources}<details><summary>查看原始 Markdown</summary><pre id="raw-answer">${escapeHtml(text)}</pre></details><footer>来源链接由答复原文提取；链接存在不代表内容已额外核验。</footer></main></body></html>`;
}

// Caller must pass the final public text only, after the normal sanitizer. A
// report never reads, copies or mutates inbound files or explicit attachments.
export function prepareReplyReport({ reportRoot, fileOutboxRoot, inboxRoot, binding, jobId, replyKey, text, force = false }) {
  const job = authorizedFileJob(inboxRoot, binding, jobId, replyKey);
  const policy = reportPolicy(text, { force });
  if (!policy.generate) return { generated: false, reason: policy.reason, artifacts: [] };
  const reportId = digest(replyKey), botRoot = path.join(reportRoot, binding.bot), dir = path.join(botRoot, reportId);
  fs.mkdirSync(botRoot, { recursive: true });
  if (!within(fs.realpathSync(reportRoot), fs.realpathSync(botRoot))) throw fail('report_outside_allowed_root');
  fs.mkdirSync(dir, { recursive: true });
  if (!within(fs.realpathSync(botRoot), fs.realpathSync(dir))) throw fail('report_outside_allowed_root');
  const manifestPath = path.join(dir, 'manifest.json');
  let manifest;
  if (fs.existsSync(manifestPath)) {
    if (!within(fs.realpathSync(dir), fs.realpathSync(manifestPath))) throw fail('report_outside_allowed_root');
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.answerHash !== digest(text)) throw fail('report_final_changed');
  } else {
    if (typeof job.reply !== 'string' || sanitizeFeishuReply(job.reply).trim() !== text) throw fail('report_final_not_authorized');
    const html = renderReportHtml(text);
    if (Buffer.byteLength(html) > REPORT_POLICY.maxHtmlBytes) return { generated: false, reason: 'html_size_limit', artifacts: [] };
    const artifacts = [{ name: 'report.html', data: html }, { name: 'answer.md', data: text }];
    // Artifact bytes are immutable. On a crash before manifest, finish only if
    // the existing bytes exactly match this deterministic rendering.
    for (const { name, data } of artifacts) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) {
        if (!within(fs.realpathSync(dir), fs.realpathSync(file)) || digest(fs.readFileSync(file)) !== digest(data)) throw fail('report_snapshot_changed');
      } else fs.writeFileSync(file, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
    manifest = { kind: 'codex-generated-report-v1', reportId, jobId, replyKey,
      origin: { bot: binding.bot, chatId: binding.chat_id, senderId: binding.allowed_sender_id, profile: binding.profile ?? '' },
      sourceHash: digest(job.reply), answerHash: digest(text), reason: policy.reason, createdAt: Date.now(),
      artifacts: artifacts.map(({ name, data }) => ({ name, hash: digest(data), bytes: Buffer.byteLength(data) })) };
    atomicWriteJson(manifestPath, manifest);
  }
  const artifacts = ['report.html', 'answer.md'].map(name => enqueueGeneratedReport({ root: fileOutboxRoot, inboxRoot, reportRoot, binding, jobId, replyKey, name }));
  return { generated: true, reason: manifest.reason, reportId, artifacts,
    notice: '完整 HTML 报告与 Markdown 原文已加入附件发送队列；送达后可在聊天中打开。' };
}
