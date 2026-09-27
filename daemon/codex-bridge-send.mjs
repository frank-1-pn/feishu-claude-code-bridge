#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueueFile } from './codex-bridge-files.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const opts = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  if (!['--bot', '--job-id', '--file', '--mode', '--cover'].includes(name) || !process.argv[i + 1]) throw Error('invalid_arguments');
  opts[name.slice(2)] = process.argv[i + 1];
}
try {
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'codex-thread-bindings.json'), 'utf8').replace(/^\uFEFF/, ''));
  const binding = config.bindings[opts.bot];
  if (!binding || !/^[A-Za-z0-9_-]+$/.test(opts.bot)) throw Error('unknown_bot');
  const result = enqueueFile({ root: path.join(dir, 'state', 'file-outbox'), inboxRoot: path.join(dir, 'state', 'codex-inbox-v2'),
    binding: { ...binding, bot: opts.bot }, jobId: opts['job-id'], file: opts.file, mode: opts.mode, cover: opts.cover });
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
} catch (error) {
  // No paths, content or credentials in the runtime log.
  process.stderr.write(JSON.stringify({ ok: false, error: error.code ?? 'attachment_request_failed' }) + '\n'); process.exitCode = 1;
}
