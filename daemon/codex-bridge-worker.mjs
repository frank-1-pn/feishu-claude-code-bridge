#!/usr/bin/env node

/**
 * Thin Feishu -> Codex bridge.
 *
 * It deliberately does NOT open another lark event subscription. It consumes
 * the NDJSON files maintained by the existing lark-cli daemons, with its own
 * byte offsets, uses Orca's public agent-prompt API for an already-open Codex
 * terminal when one owns the target thread (falling back to `codex exec resume`
 * otherwise), and sends the final answer through the existing
 * lark-send.ps1 helper/profile.
 *
 * Runtime logs and status contain metadata only; message and response bodies
 * are never written to them. A response body may exist briefly in the private
 * outbox so a transient send failure does not rerun the Codex turn. V2 keeps
 * private input and delivery state under daemon/state, outside Git.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  formatProgressReply,
  progressFingerprint,
  progressGate,
  rolloutAssistantMessage,
  rolloutTaskCompletion,
} from './codex-bridge-progress.mjs';
import { sanitizeFeishuReply } from './codex-bridge-sanitize.mjs';
import { DurableInbox, digest } from './codex-bridge-inbox.mjs';
import { prepareInbound } from './codex-bridge-media.mjs';
import { atomicWriteJson, atomicWriteText, createStatusPublisher } from './codex-bridge-storage.mjs';
import { createLarkTransport } from './codex-bridge-lark.mjs';
import { DurableOutbound } from './codex-bridge-outbound.mjs';
import { FileOutbox } from './codex-bridge-files.mjs';
import { recordFailure } from './codex-bridge-retry.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DAEMON_DIR = path.dirname(SCRIPT_PATH);
const TEMP_DIR = os.tmpdir();
const STATE_DIR = path.join(TEMP_DIR, 'lark-codex-bridge');
const LOCK_PATH = path.join(TEMP_DIR, 'lark-codex-bridge.lock');
const PID_PATH = path.join(TEMP_DIR, 'lark-codex-bridge.pid.json');
const STATUS_PATH = path.join(TEMP_DIR, 'lark-codex-bridge.status.json');
const SEEN_PATH = path.join(STATE_DIR, 'seen-events.json');
const RECEIPTS_PATH = path.join(STATE_DIR, 'receipt-events.json');
const PROGRESS_PATH = path.join(STATE_DIR, 'progress-events.json');
const RECEIPT_TEXT = '✅ 已收到，正在交给当前 Codex 会话处理；关键阶段会自动同步进度。若会话正忙，消息会保留并自动继续。';
const EMPTY_REPLY_TEXT = 'Codex 本次只返回了内部引用元数据，没有可发送的正文，请重试。';
const PROGRESS_MIN_INTERVAL_MS = 10000;
const PROGRESS_MAX_MESSAGES = 8;
const PROGRESS_MAX_CHARACTERS = 1800;
const ORCA_PTY_RPC_PATH = path.join(DAEMON_DIR, 'orca-pty-rpc.mjs');
const RESOLVE_CODEX_PTY_PATH = path.join(DAEMON_DIR, 'resolve-codex-pty.ps1');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const result = {
    bindings: path.join(DAEMON_DIR, 'codex-thread-bindings.json'),
    instance: '',
    checkConfig: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--bindings') result.bindings = path.resolve(argv[++index] ?? '');
    else if (arg === '--instance') result.instance = argv[++index] ?? '';
    else if (arg === '--check-config') result.checkConfig = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function assertFile(filePath, field) {
  if (!path.isAbsolute(filePath) || !fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${field} is not an existing absolute file`);
  }
}

function assertDirectory(dirPath, field) {
  if (!path.isAbsolute(dirPath) || !fs.statSync(dirPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${field} is not an existing absolute directory`);
  }
}

function loadAndValidateConfig(bindingsPath) {
  assertFile(bindingsPath, 'bindings file');
  const config = readJson(bindingsPath);
  if (config.version !== 1 || !config.runtime || !config.bindings) {
    throw new Error('bindings file must have version=1, runtime, and bindings');
  }
  assertDirectory(config.runtime.codex_home, 'runtime.codex_home');
  assertFile(config.runtime.codex_cli_js, 'runtime.codex_cli_js');
  assertFile(config.runtime.orca_cli_exe, 'runtime.orca_cli_exe');
  assertFile(config.runtime.lark_send_script, 'runtime.lark_send_script');
  assertFile(ORCA_PTY_RPC_PATH, 'Orca PTY RPC helper');
  assertFile(RESOLVE_CODEX_PTY_PATH, 'Codex PTY resolver');
  if (!Number.isInteger(config.runtime.poll_interval_ms) || config.runtime.poll_interval_ms < 250) {
    throw new Error('runtime.poll_interval_ms must be an integer >= 250');
  }
  if (!Number.isInteger(config.runtime.heartbeat_interval_ms) || config.runtime.heartbeat_interval_ms < 1000) {
    throw new Error('runtime.heartbeat_interval_ms must be an integer >= 1000');
  }
  if (!Number.isInteger(config.runtime.pty_turn_timeout_ms) || config.runtime.pty_turn_timeout_ms < 60000) {
    throw new Error('runtime.pty_turn_timeout_ms must be an integer >= 60000');
  }
  if (!Number.isInteger(config.runtime.max_inbound_bytes) || config.runtime.max_inbound_bytes < 1024) {
    throw new Error('runtime.max_inbound_bytes must be an integer >= 1024');
  }
  if (!Number.isInteger(config.runtime.max_event_age_ms) || config.runtime.max_event_age_ms < 60000) {
    throw new Error('runtime.max_event_age_ms must be an integer >= 60000');
  }

  const entries = Object.entries(config.bindings);
  if (entries.length === 0) throw new Error('at least one binding is required');
  const threads = new Set();
  const profiles = new Set();
  for (const [bot, binding] of entries) {
    if (!/^[A-Za-z0-9_-]+$/.test(bot)) throw new Error(`invalid bot name: ${bot}`);
    if (!UUID_RE.test(binding.codex_thread_id ?? '')) throw new Error(`${bot}: invalid codex_thread_id`);
    if (threads.has(binding.codex_thread_id)) throw new Error(`${bot}: duplicate codex_thread_id`);
    threads.add(binding.codex_thread_id);
    assertDirectory(binding.cwd, `${bot}.cwd`);
    if (!/^oc_[A-Za-z0-9]+$/.test(binding.chat_id ?? '')) throw new Error(`${bot}: invalid chat_id`);
    if (!/^ou_[A-Za-z0-9]+$/.test(binding.allowed_sender_id ?? '')) {
      throw new Error(`${bot}: invalid allowed_sender_id`);
    }
    if (typeof binding.profile !== 'string') throw new Error(`${bot}: profile must be a string`);
    if (profiles.has(binding.profile)) throw new Error(`${bot}: one runtime binding per Lark profile is required`);
    profiles.add(binding.profile);
    binding.bot = bot;
    binding.logPath = path.join(TEMP_DIR, `lark-${bot}-events.ndjson`);
    binding.offsetPath = path.join(TEMP_DIR, `lark-${bot}-codex.offset`);
    binding.receiptOffsetPath = path.join(TEMP_DIR, `lark-${bot}-codex-receipt.offset`);
  }
  return config;
}

function log(event, fields = {}) {
  // Callers may pass identifiers/counters only. Never pass prompt/reply text.
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(instance) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, instance })}\n`, 'utf8');
      return fd;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner;
      try { owner = readJson(LOCK_PATH); } catch { owner = null; }
      if (owner && processExists(Number(owner.pid))) {
        throw new Error(`another bridge instance is alive (pid=${owner.pid})`);
      }
      fs.rmSync(LOCK_PATH, { force: true });
    }
  }
  throw new Error('could not acquire bridge lock');
}

function readOffset(binding) {
  const stat = fs.statSync(binding.logPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  if (!fs.existsSync(binding.offsetPath)) {
    // Same safety rule as the original monitor: never replay history on the
    // first bridge run. Future runs resume from this independently stored byte.
    atomicWriteText(binding.offsetPath, String(stat.size));
    log('offset_initialized_at_eof', { bot: binding.bot, offset: stat.size });
    return stat.size;
  }
  const raw = fs.readFileSync(binding.offsetPath, 'ascii').trim();
  const offset = Number(raw);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    atomicWriteText(binding.offsetPath, String(stat.size));
    log('offset_invalid_reset_to_eof', { bot: binding.bot, offset: stat.size });
    return stat.size;
  }
  if (offset > stat.size) {
    atomicWriteText(binding.offsetPath, '0');
    log('log_rotation_detected', { bot: binding.bot, previousOffset: offset, size: stat.size });
    return 0;
  }
  return offset;
}

function writeOffset(binding, expectedOffset, nextOffset, originalBytes) {
  // start-bot/ensure-bot may reset this offset during a log rotation. Do not
  // overwrite such an external reset after a long Codex turn completes.
  let currentRaw;
  try {
    currentRaw = fs.readFileSync(binding.offsetPath, 'ascii').trim();
  } catch {
    log('offset_commit_skipped_external_removal', { bot: binding.bot, expectedOffset });
    return false;
  }
  const current = Number(currentRaw);
  if (current !== expectedOffset) {
    log('offset_commit_skipped_external_change', {
      bot: binding.bot,
      expectedOffset,
      currentOffset: Number.isSafeInteger(current) ? current : null,
    });
    return false;
  }

  const stat = fs.statSync(binding.logPath, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size < nextOffset) {
    log('offset_commit_skipped_log_changed', { bot: binding.bot, expectedOffset });
    return false;
  }
  const fd = fs.openSync(binding.logPath, 'r');
  try {
    const check = Buffer.allocUnsafe(originalBytes.length);
    const bytesRead = fs.readSync(fd, check, 0, check.length, expectedOffset);
    if (bytesRead !== originalBytes.length || !check.equals(originalBytes)) {
      log('offset_commit_skipped_log_replaced', { bot: binding.bot, expectedOffset });
      return false;
    }
  } finally {
    fs.closeSync(fd);
  }
  atomicWriteText(binding.offsetPath, String(nextOffset));
  return true;
}

function readNextLine(binding) {
  const offset = readOffset(binding);
  if (offset === null) return null;
  const stat = fs.statSync(binding.logPath, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size <= offset) return null;

  const bytesAvailable = Math.min(stat.size - offset, 1024 * 1024);
  const fd = fs.openSync(binding.logPath, 'r');
  let chunk;
  try {
    chunk = Buffer.allocUnsafe(bytesAvailable);
    const bytesRead = fs.readSync(fd, chunk, 0, bytesAvailable, offset);
    chunk = chunk.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  const newlineIndex = chunk.indexOf(0x0a);
  if (newlineIndex < 0) return null; // Wait for a complete NDJSON record.
  const originalBytes = chunk.subarray(0, newlineIndex + 1);
  const lineBytes = chunk.subarray(0, newlineIndex > 0 && chunk[newlineIndex - 1] === 0x0d
    ? newlineIndex - 1
    : newlineIndex);
  return {
    offset,
    nextOffset: offset + originalBytes.length,
    originalBytes,
    lineBytes,
  };
}

function loadIdJournal(filePath) {
  try {
    const seen = readJson(filePath);
    return Array.isArray(seen) ? seen.filter((item) => typeof item === 'string').slice(-1024) : [];
  } catch {
    return [];
  }
}

function rememberSeen(messageId) {
  if (!messageId) return;
  const next = [...seenIds.filter((item) => item !== messageId), messageId].slice(-1024);
  seenIds = next;
  atomicWriteJson(SEEN_PATH, next);
}

function rememberReceipt(messageId) {
  if (!messageId) return;
  const next = [...receiptIds.filter((item) => item !== messageId), messageId].slice(-1024);
  receiptIds = next;
  atomicWriteJson(RECEIPTS_PATH, next);
}

function rememberProgress(progressId) {
  if (!progressId) return;
  const next = [...progressIds.filter((item) => item !== progressId), progressId].slice(-4096);
  progressIds = next;
  atomicWriteJson(PROGRESS_PATH, next);
}

function outboxPath(binding, messageId) {
  const safeId = String(messageId || randomUUID()).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(STATE_DIR, `outbox-${binding.bot}-${safeId}.txt`);
}

function pruneInterruptedCodexOutputs() {
  let names;
  try { names = fs.readdirSync(STATE_DIR); } catch { return; }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.codex-output.tmp')) continue;
    fs.rmSync(path.join(STATE_DIR, name), { force: true });
    removed += 1;
  }
  if (removed > 0) log('interrupted_codex_outputs_pruned', { count: removed });
}

function buildPrompt(binding, event) {
  const content = typeof event.content === 'string'
    ? event.content
    : JSON.stringify(event.content ?? '');
  const prefix = `[飞书消息｜${binding.bot}｜${event.message_id ?? event.id ?? 'unknown'}] `
    + '已通过用户白名单。请在当前线程直接处理；阶段性工作进度可用 commentary 输出，bridge 会同步飞书，'
    + '同一 message_id 的重复投递只视作同一请求，不重复执行已完成的操作。'
    + '不要输出隐藏思考过程；最终答复只包含最终结果并由 bridge 回传。'
    + `需要交付用户要求的本地文件时，用 node "${path.join(DAEMON_DIR, 'codex-bridge-send.mjs')}" --bot ${binding.bot} --job-id ${event.message_id ?? event.id} --file "绝对路径" 排入发送队列；只能提交用户要求的交付物，不能仅因链接提到了本地文件就上传。默认 --mode file；图片可用 image，音频 audio，视频 video 需 --cover 封面路径。文件限30MiB，图片10MiB，默认只允许当前工作目录。排队不等于送达。`
    + '若末尾为 ...(truncated)，先按 message_id 用现有 messages-mget 流程取全文。正文：';
  return content.includes('\n') || content.includes('\r')
    ? `${prefix}\n${content}`
    : `${prefix}${content}`;
}

function runChild(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const captureStderr = options.captureStderr === true;
    let stderr = '';
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: options.stdinText === undefined
        ? ['ignore', 'ignore', captureStderr ? 'pipe' : 'ignore']
        : ['pipe', 'ignore', captureStderr ? 'pipe' : 'ignore'],
      cwd: options.cwd,
      env: options.env,
    });
    activeChildren.add(child);
    if (captureStderr) {
      child.stderr?.on('data', (chunk) => {
        if (stderr.length < 16384) stderr += chunk.toString('utf8').slice(0, 16384 - stderr.length);
      });
    }
    child.once('error', (error) => {
      activeChildren.delete(child);
      error.stderr = stderr;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      activeChildren.delete(child);
      if (code === 0) resolve();
      else {
        const error = new Error(`child exited code=${code ?? 'null'} signal=${signal ?? 'none'}`);
        error.stderr = stderr;
        reject(error);
      }
    });
    if (options.stdinText !== undefined) child.stdin.end(options.stdinText, 'utf8');
  });
}

function runChildCapture(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    let stdout = '';
    let stderr = '';
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: options.stdinText === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd,
      env: options.env,
    });
    activeChildren.add(child);
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error('child_capture_timeout');
      error.stdout = stdout; error.stderr = stderr;
      reject(error);
    }, options.timeoutMs ?? 30000);
    timer.unref();
    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxOutputBytes) stdout += chunk.toString('utf8').slice(0, maxOutputBytes - stdout.length);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxOutputBytes) stderr += chunk.toString('utf8').slice(0, maxOutputBytes - stderr.length);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(`child exited code=${code ?? 'null'} signal=${signal ?? 'none'}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
    if (options.stdinText !== undefined) child.stdin.end(options.stdinText, 'utf8');
  });
}

function findRolloutPath(threadId) {
  const sessionsRoot = path.join(config.runtime.codex_home, 'sessions');
  const suffix = `-${threadId}.jsonl`.toLowerCase();
  const stack = [sessionsRoot];
  const matches = [];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
        const stat = fs.statSync(entryPath);
        matches.push({ path: entryPath, mtimeMs: stat.mtimeMs });
      }
    }
  }
  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (matches.length === 0) throw new Error(`rollout_not_found:${threadId}`);
  return matches[0].path;
}

async function waitForRolloutFinal(rolloutPath, startOffset, messageId, onCommentary, signal) {
  const deadline = Date.now() + config.runtime.pty_turn_timeout_ms;
  let cursor = startOffset;
  let pending = '';
  let markerSeen = false;
  const decoder = new TextDecoder('utf-8');

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('rollout_watch_aborted');
    const stat = fs.statSync(rolloutPath, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error('rollout_disappeared');
    if (stat.size < cursor) throw new Error('rollout_truncated');
    if (stat.size > cursor) {
      const fd = fs.openSync(rolloutPath, 'r');
      try {
        while (cursor < stat.size) {
          const length = Math.min(1024 * 1024, stat.size - cursor);
          const chunk = Buffer.allocUnsafe(length);
          const bytesRead = fs.readSync(fd, chunk, 0, length, cursor);
          if (bytesRead <= 0) break;
          cursor += bytesRead;
          pending += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
        }
      } finally {
        fs.closeSync(fd);
      }

      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line) continue;
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        const payload = item?.payload;
        if (!markerSeen
            && item?.type === 'response_item'
            && payload?.type === 'message'
            && payload?.role === 'user'
            && JSON.stringify(payload.content ?? []).includes(messageId)) {
          markerSeen = true;
          continue;
        }
        if (markerSeen) {
          const assistantMessage = rolloutAssistantMessage(item);
          if (assistantMessage?.phase === 'commentary') {
            await onCommentary?.(assistantMessage.text);
            continue;
          }
          if (assistantMessage?.phase === 'final_answer') return assistantMessage.text;
        }
        if (markerSeen) {
          const completion = rolloutTaskCompletion(item);
          if (completion?.kind === 'final') return completion.text;
          if (completion?.error) throw new Error(completion.error);
        }
      }
    }
    await sleep(250);
  }
  throw new Error('rollout_turn_timeout');
}

async function resolveActivePty(binding) {
  const result = await runChildCapture('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', RESOLVE_CODEX_PTY_PATH,
    '-ThreadId', binding.codex_thread_id,
    '-CodexHome', config.runtime.codex_home,
    '-RpcScript', ORCA_PTY_RPC_PATH,
  ], { cwd: DAEMON_DIR });
  const resolved = JSON.parse(result.stdout.trim());
  if (resolved.ok !== true) throw new Error(`pty_resolve_failed:${resolved.error ?? 'unknown'}`);
  return resolved.active_writer === true ? resolved : null;
}

async function resolveOrcaTerminalHandle(pty) {
  const result = await runChildCapture(config.runtime.orca_cli_exe, [
    'terminal', 'list', '--json',
  ], { cwd: DAEMON_DIR });
  const response = JSON.parse(result.stdout.trim());
  if (response.ok !== true || !Array.isArray(response.result?.terminals)) {
    throw new Error('pty_orca_terminal_list_failed');
  }
  const matches = response.result.terminals.filter((terminal) =>
    terminal?.ptyId === pty.pty_session_id
    && terminal?.connected === true
    && terminal?.writable === true
    && typeof terminal?.handle === 'string');
  if (matches.length !== 1) {
    throw new Error(`pty_orca_terminal_handle_count:${matches.length}`);
  }
  return matches[0].handle;
}

async function runPtyTurn(binding, event, prompt, replyPath, pty, onCommentary, submitOnly = false) {
  const rolloutPath = findRolloutPath(binding.codex_thread_id);
  const startOffset = fs.statSync(rolloutPath).size;
  const safePrompt = prompt.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const terminalHandle = await resolveOrcaTerminalHandle(pty);
  if (safePrompt.length <= 16000) {
    // This is Orca's supported agent-prompt path. It performs bracketed paste,
    // applies the Windows ConPTY settle delay, and submits from the terminal
    // daemon. It does not depend on desktop focus or a simulated key press.
    try {
      const result = await runChildCapture(config.runtime.orca_cli_exe, [
        'terminal', 'send',
        '--terminal', terminalHandle,
        '--text', safePrompt,
        '--enter',
        '--json',
      ], { cwd: DAEMON_DIR });
      const response = JSON.parse(result.stdout.trim());
      if (response.ok !== true) throw new Error('pty_orca_agent_prompt_rejected');
    } catch (error) {
      // Orca CLI can time out while the runtime has already accepted and queued
      // the agent prompt (observed with a busy Codex turn). The rollout marker
      // is the authority for delivery, so keep waiting instead of sending a
      // false failure back to Feishu.
      log('orca_agent_prompt_cli_uncertain', {
        bot: binding.bot,
        messageId: event.message_id ?? event.id ?? null,
        error: error.message,
      });
    }
  } else {
    // Windows command lines cannot safely carry arbitrarily long Feishu text.
    // Stream the paste through the daemon, then use Orca's semantic Enter path
    // after the same settle interval as its packaged agent-prompt injector.
    const pastedInput = `\u001b[200~${safePrompt}\u001b[201~`;
    await runChildCapture(process.execPath, [
      ORCA_PTY_RPC_PATH,
      '--mode', 'write',
      '--session-id', pty.pty_session_id,
    ], {
      cwd: DAEMON_DIR,
      stdinText: pastedInput,
    });
    await sleep(1500);
    const result = await runChildCapture(config.runtime.orca_cli_exe, [
      'terminal', 'send',
      '--terminal', terminalHandle,
      '--enter',
      '--json',
    ], { cwd: DAEMON_DIR });
    const response = JSON.parse(result.stdout.trim());
    if (response.ok !== true) throw new Error('pty_orca_enter_rejected');
  }
  if (submitOnly) return;
  const reply = await waitForRolloutFinal(
    rolloutPath,
    startOffset,
    event.message_id ?? event.id ?? '',
    onCommentary,
  );
  atomicWriteText(replyPath, reply);
}

async function runCodex(binding, event, replyPath) {
  const prompt = buildPrompt(binding, event);
  const messageId = event.message_id ?? event.id ?? '';
  const progressState = { sentCount: 0, lastSentAt: 0 };
  const onCommentary = (text) => forwardCommentary(binding, messageId, text, progressState);
  const pty = await resolveActivePty(binding);
  if (pty) {
    try {
      await runPtyTurn(binding, event, prompt, replyPath, pty, onCommentary);
      return 'orca_terminal_agent_prompt';
    } catch (error) {
      if (error.message !== 'rollout_task_bad_request') throw error;
      log('codex_bad_request_retry', { bot: binding.bot, messageId: messageId || null, attempt: 2 });
      const recoveryPrompt = [
        '[bridge automatic recovery]',
        'The previous turn ended with an upstream Bad Request before a final answer.',
        'Do not repeat completed writes. Inspect current state, continue from the interruption, and provide the final answer.',
        '',
        prompt,
      ].join('\n');
      await sleep(1000);
      await runPtyTurn(binding, event, recoveryPrompt, replyPath, pty, onCommentary);
      return 'orca_terminal_agent_prompt_retry';
    }
  }
  const rolloutPath = findRolloutPath(binding.codex_thread_id);
  const startOffset = fs.statSync(rolloutPath).size;
  const args = [
    config.runtime.codex_cli_js,
    '-a', 'on-request',
    'exec',
    '--sandbox', 'workspace-write',
    '--cd', binding.cwd,
    '--output-last-message', replyPath,
    'resume', binding.codex_thread_id,
    '-',
  ];
  const controller = new AbortController();
  try {
    const childPromise = runChild(process.execPath, args, {
      cwd: binding.cwd,
      env: { ...process.env, CODEX_HOME: config.runtime.codex_home },
      stdinText: prompt,
      captureStderr: true,
    });
    const rolloutPromise = waitForRolloutFinal(
      rolloutPath,
      startOffset,
      messageId,
      onCommentary,
      controller.signal,
    );
    const [, reply] = await Promise.all([childPromise, rolloutPromise]);
    atomicWriteText(replyPath, reply);
  } finally {
    controller.abort();
  }
  return 'codex_cli';
}

async function sendReply(binding, replyPath) {
  // Outboxes survive transient send failures and may predate the current
  // worker process. Sanitize again at the final egress boundary so neither an
  // orphan retry nor a future producer can leak Codex-only metadata to Feishu.
  const rawReply = fs.readFileSync(replyPath, 'utf8');
  const sanitizedReply = sanitizeFeishuReply(rawReply);
  if (sanitizedReply !== rawReply) {
    atomicWriteText(replyPath, sanitizedReply.trim() || EMPTY_REPLY_TEXT);
    log('outbound_internal_metadata_stripped', {
      bot: binding.bot,
      beforeBytes: Buffer.byteLength(rawReply, 'utf8'),
      afterBytes: Buffer.byteLength(sanitizedReply, 'utf8'),
    });
  }
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', config.runtime.lark_send_script,
    '-TextFile', replyPath,
    '-ChatId', binding.chat_id,
  ];
  if (binding.profile) args.push('-Profile', binding.profile);
  await runChild('powershell.exe', args, {
    cwd: DAEMON_DIR,
    env: { ...process.env, LARK_CLI_NO_PROXY: '1' },
  });
}

function progressMessagePath(binding, messageId, progressId) {
  const safeId = String(messageId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(STATE_DIR, `progress-${binding.bot}-${safeId}-${progressId.slice(0, 16)}.txt`);
}

async function forwardCommentary(binding, messageId, text, progressState) {
  const sanitized = sanitizeFeishuReply(text).trim();
  if (!sanitized) return;
  const progressId = progressFingerprint(binding.bot, messageId, sanitized);
  if (progressIds.includes(progressId)) {
    log('progress_duplicate_ignored', { bot: binding.bot, messageId: messageId || null });
    return;
  }
  const now = Date.now();
  const gate = progressGate(
    progressState,
    now,
    PROGRESS_MIN_INTERVAL_MS,
    PROGRESS_MAX_MESSAGES,
  );
  if (!gate.ok) {
    log('progress_throttled', { bot: binding.bot, messageId: messageId || null, reason: gate.reason });
    return;
  }
  const reply = formatProgressReply(sanitized, PROGRESS_MAX_CHARACTERS);
  if (!reply) return;
  const replyPath = progressMessagePath(binding, messageId, progressId);
  atomicWriteText(replyPath, reply);
  try {
    await sendReply(binding, replyPath);
    rememberProgress(progressId);
    progressState.sentCount += 1;
    progressState.lastSentAt = Date.now();
    updateBotStatus(binding.bot, {
      progress_sent_count: progressState.sentCount,
      last_progress_at: new Date(progressState.lastSentAt).toISOString(),
    });
    log('progress_sent', {
      bot: binding.bot,
      messageId: messageId || null,
      progressCount: progressState.sentCount,
      bytes: Buffer.byteLength(reply, 'utf8'),
    });
  } catch (error) {
    log('progress_send_failed', { bot: binding.bot, messageId: messageId || null, error: error.message });
  } finally {
    fs.rmSync(replyPath, { force: true });
  }
}

function receiptPath(binding, messageId) {
  const safeId = String(messageId || randomUUID()).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(STATE_DIR, `receipt-${binding.bot}-${safeId}.txt`);
}

async function ensureReceipt(binding, messageId) {
  if (!messageId || receiptIds.includes(messageId)) return;
  if (receiptPromises.has(messageId)) {
    await receiptPromises.get(messageId);
    return;
  }
  const promise = (async () => {
    const textPath = receiptPath(binding, messageId);
    atomicWriteText(textPath, RECEIPT_TEXT);
    try {
      await sendReply(binding, textPath);
      rememberReceipt(messageId);
      log('receipt_sent', { bot: binding.bot, messageId });
    } finally {
      fs.rmSync(textPath, { force: true });
    }
  })();
  receiptPromises.set(messageId, promise);
  try {
    await promise;
  } finally {
    receiptPromises.delete(messageId);
  }
}

function isAuthorizedEvent(binding, event) {
  return event
    && event.type === 'im.message.receive_v1'
    && event.chat_id === binding.chat_id
    && event.sender_id === binding.allowed_sender_id;
}

function isFreshEvent(event) {
  const rawTimestamp = event.timestamp ?? event.create_time;
  const timestamp = Number(rawTimestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  const age = Date.now() - timestamp;
  return age >= -300000 && age <= config.runtime.max_event_age_ms;
}

async function handleLine(binding, record) {
  if (record.lineBytes.length > config.runtime.max_inbound_bytes) {
    log('record_too_large_ignored', { bot: binding.bot, bytes: record.lineBytes.length });
    writeOffset(binding, record.offset, record.nextOffset, record.originalBytes);
    return;
  }

  let event;
  try {
    event = JSON.parse(record.lineBytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    log('invalid_ndjson_ignored', { bot: binding.bot, offset: record.offset });
    writeOffset(binding, record.offset, record.nextOffset, record.originalBytes);
    return;
  }

  const messageId = event.message_id ?? event.id ?? '';
  if (!isAuthorizedEvent(binding, event)) {
    log('event_ignored_by_whitelist', { bot: binding.bot, messageId: messageId || null });
    writeOffset(binding, record.offset, record.nextOffset, record.originalBytes);
    return;
  }
  if (event.message_type !== 'text' || typeof event.content !== 'string') {
    log('unsupported_message_type_ignored', {
      bot: binding.bot,
      messageId: messageId || null,
      messageType: typeof event.message_type === 'string' ? event.message_type : null,
    });
    writeOffset(binding, record.offset, record.nextOffset, record.originalBytes);
    return;
  }
  if (!isFreshEvent(event)) {
    log('stale_event_ignored', { bot: binding.bot, messageId: messageId || null });
    writeOffset(binding, record.offset, record.nextOffset, record.originalBytes);
    return;
  }
  if (messageId && seenIds.includes(messageId)) {
    log('duplicate_event_ignored', { bot: binding.bot, messageId });
    writeOffset(binding, record.offset, record.nextOffset, record.originalBytes);
    return;
  }

  try {
    await ensureReceipt(binding, messageId);
  } catch (error) {
    // Receipt delivery has its own offset/pump and will retry independently.
    // Do not hold the actual Codex request behind a transient acknowledgement.
    log('receipt_send_failed', { bot: binding.bot, messageId: messageId || null, error: error.message });
  }

  const replyPath = outboxPath(binding, messageId);
  updateBotStatus(binding.bot, {
    state: 'processing',
    current_message_id: messageId || null,
    progress_sent_count: 0,
    last_progress_at: null,
  });
  if (!fs.existsSync(replyPath)) {
    const codexOutputPath = `${replyPath}.${randomUUID()}.codex-output.tmp`;
    log('codex_resume_started', { bot: binding.bot, messageId: messageId || null });
    try {
      const transport = await runCodex(binding, event, codexOutputPath);
      const rawReply = fs.readFileSync(codexOutputPath, 'utf8');
      const sanitizedReply = sanitizeFeishuReply(rawReply);
      if (sanitizedReply !== rawReply) {
        log('codex_internal_metadata_stripped', {
          bot: binding.bot,
          messageId: messageId || null,
          beforeBytes: Buffer.byteLength(rawReply, 'utf8'),
          afterBytes: Buffer.byteLength(sanitizedReply, 'utf8'),
        });
      }
      atomicWriteText(
        replyPath,
        sanitizedReply.trim()
          || (rawReply.trim() ? EMPTY_REPLY_TEXT : 'Codex 本次没有返回可发送的文本，请重试。'),
      );
      log('codex_resume_completed', { bot: binding.bot, messageId: messageId || null, transport });
    } catch (error) {
      const activeWriter = /thread-store conflict|already has an active writer/i.test(String(error.stderr ?? ''));
      const ptyFailure = /^(pty_|rollout_)/i.test(error.message);
      atomicWriteText(
        replyPath,
        activeWriter
          ? '⚠️ 当前 Codex 线程正被桌面端会话占用，飞书 bridge 不能同时写入。' +
            '请先在电脑端切换到其他会话或关闭 Codex/Orca，等待几秒后再从飞书重发；无需放宽沙箱或处理审批。'
          : ptyFailure
            ? `⚠️ 飞书消息已到达，但当前 Codex 会话注入失败（${new Date().toLocaleString('zh-CN')}）。` +
              'bridge 保留了安全边界；请在电脑端查看 bridge 状态。'
            : `⚠️ Codex 没有完成这条请求（${new Date().toLocaleString('zh-CN')}）。` +
            '桥接层没有绕过审批或放宽沙箱；请稍后重发，或回到电脑查看是否需要人工审批。',
      );
      log('codex_resume_failed', {
        bot: binding.bot,
        messageId: messageId || null,
        error: error.message,
        reason: activeWriter ? 'thread_active_writer' : ptyFailure ? 'pty_injection_error' : 'child_error',
      });
    } finally {
      fs.rmSync(codexOutputPath, { force: true });
    }
  } else {
    log('outbox_retry', { bot: binding.bot, messageId: messageId || null });
  }

  let remoteSendSucceeded = false;
  try {
    await sendReply(binding, replyPath);
    remoteSendSucceeded = true;
  } catch (error) {
    const retryKey = `${binding.bot}:${messageId}`;
    const attempts = (retryCounts.get(retryKey) ?? 0) + 1;
    retryCounts.set(retryKey, attempts);
    const delayMs = Math.min(60000, 1000 * (2 ** Math.min(attempts, 6)));
    lastError = {
      at: new Date().toISOString(),
      stage: 'send_reply',
      bot: binding.bot,
      message_id: messageId || null,
      error: error.message,
    };
    log('reply_send_failed', { bot: binding.bot, messageId: messageId || null, attempts, delayMs });
    await sleep(delayMs);
  }
  if (remoteSendSucceeded) {
    // Never classify a post-send local bookkeeping error as a send failure:
    // retrying the outbox after Feishu already accepted it would duplicate the
    // reply. Keep both a recent-id journal and the byte offset as independent
    // dedupe barriers.
    const localErrors = [];
    try { rememberSeen(messageId); } catch { localErrors.push('seen_journal'); }
    try {
      if (!writeOffset(binding, record.offset, record.nextOffset, record.originalBytes)) {
        localErrors.push('offset');
      }
    } catch {
      localErrors.push('offset');
    }
    try { fs.rmSync(replyPath, { force: true }); } catch { localErrors.push('outbox_cleanup'); }
    lastSuccessAt = new Date().toISOString();
    retryCounts.delete(`${binding.bot}:${messageId}`);
    log('reply_sent', {
      bot: binding.bot,
      messageId: messageId || null,
      localBookkeepingOk: localErrors.length === 0,
      localErrors,
    });
  }
  updateBotStatus(binding.bot, { state: 'idle', current_message_id: null });
}

async function drainOutboxes(binding) {
  let names;
  try { names = fs.readdirSync(STATE_DIR); } catch { return false; }
  let found = false;
  const prefix = `outbox-${binding.bot}-`;
  for (const name of names.filter((item) => item.startsWith(prefix) && item.endsWith('.txt')).sort()) {
    found = true;
    const replyPath = path.join(STATE_DIR, name);
    const messageId = name.slice(prefix.length, -4);
    if (messageId && seenIds.includes(messageId)) {
      try { fs.rmSync(replyPath, { force: true }); } catch {}
      log('seen_outbox_not_resent', { bot: binding.bot, messageId });
      continue;
    }
    updateBotStatus(binding.bot, { state: 'sending_outbox', current_message_id: messageId || null });
    let remoteSendSucceeded = false;
    try {
      await sendReply(binding, replyPath);
      remoteSendSucceeded = true;
    } catch (error) {
      lastError = {
        at: new Date().toISOString(),
        stage: 'send_orphan_outbox',
        bot: binding.bot,
        message_id: messageId || null,
        error: error.message,
      };
      log('orphan_outbox_send_failed', { bot: binding.bot, messageId: messageId || null });
      await sleep(5000);
    }
    if (remoteSendSucceeded) {
      const localErrors = [];
      try { rememberSeen(messageId); } catch { localErrors.push('seen_journal'); }
      try { fs.rmSync(replyPath, { force: true }); } catch { localErrors.push('outbox_cleanup'); }
      lastSuccessAt = new Date().toISOString();
      log('orphan_outbox_sent', {
        bot: binding.bot,
        messageId: messageId || null,
        localBookkeepingOk: localErrors.length === 0,
        localErrors,
      });
    }
    updateBotStatus(binding.bot, { state: 'idle', current_message_id: null });
  }
  return found;
}

function updateStatus(extra = {}) {
  const offsets = {};
  if (config) {
    for (const [bot, binding] of Object.entries(config.bindings)) {
      let offset = null;
      try {
        const value = Number(fs.readFileSync(binding.offsetPath, 'ascii').trim());
        if (Number.isSafeInteger(value) && value >= 0) offset = value;
      } catch {}
      offsets[bot] = offset;
    }
  }
  const activeBots = Object.entries(botStates)
    .filter(([, value]) => value.state !== 'idle')
    .map(([bot]) => bot);
  status = {
    ...status,
    ...extra,
    pid: process.pid,
    instance,
    worker_path: SCRIPT_PATH,
    bindings_path: bindingsPath,
    heartbeat_at: new Date().toISOString(),
    last_success_at: lastSuccessAt,
    last_error: lastError,
    offsets,
    state: activeBots.length === 0 ? 'idle' : activeBots.length === 1 ? botStates[activeBots[0]].state : 'processing_multiple',
    current_bot: activeBots.length === 1 ? activeBots[0] : null,
    current_bots: activeBots,
    current_message_id: activeBots.length === 1 ? botStates[activeBots[0]].current_message_id : null,
    bot_states: botStates,
  };
  publishStatus(status);
}

function updateBotStatus(bot, extra) {
  botStates[bot] = { ...(botStates[bot] ?? { state: 'idle', current_message_id: null }), ...extra };
  updateStatus();
}

function initializeReceiptOffset(binding) {
  if (fs.existsSync(binding.receiptOffsetPath)) return;
  let initialOffset = null;
  try {
    const candidate = Number(fs.readFileSync(binding.offsetPath, 'ascii').trim());
    const size = fs.statSync(binding.logPath).size;
    if (Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= size) initialOffset = candidate;
  } catch {}
  if (initialOffset === null) {
    const stat = fs.statSync(binding.logPath, { throwIfNoEntry: false });
    initialOffset = stat?.isFile() ? stat.size : 0;
  }
  atomicWriteText(binding.receiptOffsetPath, String(initialOffset));
  log('receipt_offset_initialized', { bot: binding.bot, offset: initialOffset });
}

async function handleReceiptLine(binding, record) {
  const receiptBinding = { ...binding, offsetPath: binding.receiptOffsetPath };
  if (record.lineBytes.length > config.runtime.max_inbound_bytes) {
    writeOffset(receiptBinding, record.offset, record.nextOffset, record.originalBytes);
    return;
  }
  let event;
  try {
    event = JSON.parse(record.lineBytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    writeOffset(receiptBinding, record.offset, record.nextOffset, record.originalBytes);
    return;
  }
  const messageId = event.message_id ?? event.id ?? '';
  const shouldReceipt = isAuthorizedEvent(binding, event)
    && event.message_type === 'text'
    && typeof event.content === 'string'
    && isFreshEvent(event)
    && !(messageId && seenIds.includes(messageId));
  if (shouldReceipt) {
    try {
      await ensureReceipt(binding, messageId);
    } catch (error) {
      log('receipt_send_failed', { bot: binding.bot, messageId: messageId || null, error: error.message });
      await sleep(1000);
      return;
    }
  }
  writeOffset(receiptBinding, record.offset, record.nextOffset, record.originalBytes);
}

async function receiptLoop(binding) {
  initializeReceiptOffset(binding);
  const receiptBinding = { ...binding, offsetPath: binding.receiptOffsetPath };
  while (!stopping) {
    const record = readNextLine(receiptBinding);
    if (record) await handleReceiptLine(binding, record);
    else await sleep(config.runtime.poll_interval_ms);
  }
}

async function processingLoop(binding) {
  while (!stopping) {
    let foundWork = await drainOutboxes(binding);
    const record = readNextLine(binding);
    if (record) {
      foundWork = true;
      await handleLine(binding, record);
    }
    if (!foundWork) await sleep(config.runtime.poll_interval_ms);
  }
}

async function mainLoop() {
  for (const bot of Object.keys(config.bindings)) {
    botStates[bot] = { state: 'idle', current_message_id: null };
  }
  updateStatus({ started_at: new Date().toISOString() });
  heartbeatTimer = setInterval(() => updateStatus(), config.runtime.heartbeat_interval_ms);
  heartbeatTimer.unref();

  const bindings = Object.values(config.bindings);
  await Promise.all(bindings.map((binding) => durableBotLoops(binding)));
}

const LARK_ENTRY = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@larksuite', 'cli', 'bin', process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli');
const INBOX_ROOT = path.join(DAEMON_DIR, 'state', 'codex-inbox-v2');

async function lark(binding, args, cwd = DAEMON_DIR) {
  const result=await createLarkTransport(LARK_ENTRY, { children: activeChildren, cwd: DAEMON_DIR })(binding, args, cwd);
  lastSuccessAt=new Date().toISOString();return result;
}

async function sendDurableText(binding, text, key) {
  const clean = sanitizeFeishuReply(text).trim() || EMPTY_REPLY_TEXT;
  const chars = Array.from(clean);
  for (let i=0; i<chars.length; i+=4000) {
    await lark(binding, ['im', '+messages-send', '--chat-id', binding.chat_id,
      '--text', chars.slice(i,i+4000).join(''), '--idempotency-key', digest(`${key}:${i}`).slice(0,32)]);
  }
  lastSuccessAt = new Date().toISOString();
}


async function durableBotLoops(binding) {
  const outbound = new DurableOutbound(path.join(DAEMON_DIR, 'state', 'outbound-v3'), binding, lark);
  const files = new FileOutbox(path.join(DAEMON_DIR, 'state', 'file-outbox'), binding,
    (...args) => outbound.serial(() => lark(...args)), {notify:(text,key)=>outbound.text(text,key)});
  const inbox = new DurableInbox(INBOX_ROOT, binding.bot, {
    prepare: event => prepareInbound(binding,event,{ download:lark, downloadRoot:path.join(os.homedir(),'lark-downloads','codex-inbox'), writeText:atomicWriteText }),
    target: async () => {
      const pty = await resolveActivePty(binding);
      return { pty, rollout: findRolloutPath(binding.codex_thread_id) };
    },
    inject: async (job,target) => {
      if (target.pty) {
        await runPtyTurn(binding,job.event,buildPrompt(binding,job.prepared),'',target.pty,null,true);
      } else {
        // Without a live terminal, keep one resume writer at a time. Intake,
        // receipt and reply scanning still run independently and survive restart.
        const output = path.join(STATE_DIR,`headless-${digest(job.id)}.tmp`);
        try { await runCodex(binding,job.prepared,output); }
        finally { fs.rmSync(output,{force:true}); }
      }
    },
    send: (text,key) => outbound.text(text,key),
    final: (text,key,streams) => outbound.final(text,key,streams),
    progress: (text,key) => outbound.progress(text,key),
    log,
  }, { timeoutMs: config.runtime.pty_turn_timeout_ms });
  const loop = async (name,fn,delay=500) => {
    while (!stopping) {
      try { await fn(); }
      catch {
        lastError={at:new Date().toISOString(),bot:binding.bot,stage:name,error:'operation_failed'};
        log('inbox_loop_error',{bot:binding.bot,stage:name});
      }
      await sleep(delay);
    }
  };
  const intake = async () => {
    for(let i=0;i<100;i++) {
      const record=readNextLine(binding); if(!record) break;
      let event;
      try { event=JSON.parse(record.lineBytes.toString('utf8').replace(/^\uFEFF/,'')); } catch {}
      if (event && record.lineBytes.length<=config.runtime.max_inbound_bytes && isAuthorizedEvent(binding,event) && isFreshEvent(event)) {
        const id=event.message_id??event.id;
        if(!seenIds.includes(id)) inbox.enqueue(event);
      }
      if(!writeOffset(binding,record.offset,record.nextOffset,record.originalBytes)) break;
    }
  };
  const receipts = async () => {
    for(const j of inbox.jobs.values()) {
      if(j.receipted) continue;
      j.receiptRetry ??= {};
      if (j.receiptRetry.blocked || (j.receiptRetry.retryAt ?? 0) > Date.now()) continue;
      try {
        if(!receiptIds.includes(j.id)) await outbound.text('已保存，正在投递到当前 Codex 会话；图片和文件会下载后交给会话读取。',`receipt:${j.id}`);
        j.receipted=true;
      } catch (error) { recordFailure(j.receiptRetry,error); }
      inbox.save(j);
    }
    // This is an intake/receipt diagnostic cursor, not proof of model delivery.
    atomicWriteText(binding.receiptOffsetPath,String(readOffset(binding)??0));
  };
  const watch = async () => {
    await inbox.watch();
    const stats=inbox.stats();
    const busy=stats.queued_count+stats.awaiting_delivery_count+stats.awaiting_reply_count+stats.reply_pending_count;
    const fileStats=files.stats();
    updateBotStatus(binding.bot,{...stats,...fileStats,state:stats.failed_count||stats.watch_error_count||stats.outbound_blocked_count||fileStats.file_failed_count?'degraded':busy?'processing':'idle',
      current_message_id:[...inbox.jobs.values()].find(j=>!['done','failed'].includes(j.status))?.id??null,
      delivery_stalled:(stats.awaiting_delivery_count>0 && stats.oldest_undelivered_seconds>120) || stats.oldest_queued_seconds>120});
  };
  await Promise.all([loop('intake',intake),loop('dispatch',()=>inbox.dispatchOne()),
    loop('watch',watch),loop('replies',()=>inbox.deliverReplies()),loop('receipts',receipts,1000),
    loop('cards',()=>outbound.flushCards(),1000),loop('files',()=>files.flush(),1000)]);
}

let args;
let bindingsPath;
let instance;
let config;
let lockFd = null;
let heartbeatTimer = null;
let stopping = false;
let status = {};
const publishStatus = createStatusPublisher(STATUS_PATH, {
  onError: error => log('status_write_failed', error),
});
let seenIds = [];
let receiptIds = [];
let progressIds = [];
let lastSuccessAt = null;
let lastError = null;
const activeChildren = new Set();
const receiptPromises = new Map();
const botStates = {};
const retryCounts = new Map();

function cleanup() {
  stopping = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const child of activeChildren) {
    if (!child.killed) child.kill();
  }
  try {
    const pidRecord = readJson(PID_PATH);
    if (pidRecord.pid === process.pid && pidRecord.instance === instance) fs.rmSync(PID_PATH, { force: true });
  } catch {}
  try {
    const lockRecord = readJson(LOCK_PATH);
    if (lockRecord.pid === process.pid && lockRecord.instance === instance) fs.rmSync(LOCK_PATH, { force: true });
  } catch {}
  if (lockFd !== null) {
    try { fs.closeSync(lockFd); } catch {}
  }
}

try {
  args = parseArgs(process.argv.slice(2));
  bindingsPath = args.bindings;
  config = loadAndValidateConfig(bindingsPath);
  if (args.checkConfig) {
    process.stdout.write(`${JSON.stringify({ ok: true, bindings: Object.keys(config.bindings) })}\n`);
    process.exit(0);
  }
  if (!UUID_RE.test(args.instance)) throw new Error('--instance UUID is required');
  instance = args.instance;
  lockFd = acquireLock(instance);
  atomicWriteJson(PID_PATH, {
    pid: process.pid,
    instance,
    started_at: new Date().toISOString(),
    worker_path: SCRIPT_PATH,
    bindings_path: bindingsPath,
  });
  pruneInterruptedCodexOutputs();
  seenIds = loadIdJournal(SEEN_PATH);
  receiptIds = loadIdJournal(RECEIPTS_PATH);
  progressIds = loadIdJournal(PROGRESS_PATH);
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });
  process.once('exit', cleanup);
  log('bridge_started', { pid: process.pid, instance, bots: Object.keys(config.bindings) });
  await mainLoop();
  cleanup();
} catch (error) {
  // Error messages are generated by this program and never include message bodies.
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event: 'fatal', error: error.message })}\n`);
  cleanup();
  process.exitCode = 1;
}
