const COMPLETE_MEMORY_CITATION_SUFFIX_RE =
  /(?:^|\r?\n)<oai-mem-citation>\s*<citation_entries>[\s\S]*?<\/citation_entries>\s*<rollout_ids>[\s\S]*?<\/rollout_ids>\s*<\/oai-mem-citation>[ \t]*(?:\r?\n)?$/u;

const INCOMPLETE_MEMORY_CITATION_SUFFIX_RE =
  /(?:^|\r?\n)<oai-mem-citation>\s*<citation_entries>[\s\S]*$/u;

/**
 * Remove Codex runtime provenance metadata from text sent to Feishu.
 *
 * The Codex/Orca UI may consume this block as structured metadata, while
 * Feishu receives plain text. Only a structured block at the end of the
 * answer is removed; ordinary inline discussion of the tag is preserved.
 * A truncated structured suffix is removed as a fail-closed privacy guard.
 */
export function sanitizeFeishuReply(value) {
  const source = typeof value === 'string' ? value : String(value ?? '');
  let sanitized = source;

  // Normally there is exactly one block. Loop defensively in case a retry or
  // upstream renderer appended the same metadata more than once.
  for (;;) {
    const next = sanitized.replace(COMPLETE_MEMORY_CITATION_SUFFIX_RE, '');
    if (next === sanitized) break;
    sanitized = next;
  }
  sanitized = sanitized.replace(INCOMPLETE_MEMORY_CITATION_SUFFIX_RE, '');

  return sanitized === source ? source : sanitized.trimEnd();
}
