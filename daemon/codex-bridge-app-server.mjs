// Client of the EXISTING managed daemon, never another app-server or writer.
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code, notSubmitted = true) => Object.assign(new Error(code), { notSubmitted });
const canonical = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();

export function managedPaths(runtime, target) {
  if (target?.transport !== 'codex_app_server' || !path.isAbsolute(runtime.codex_home))
    throw fail('app_server_invalid_target');
  const executable = target.daemon_exe;
  const packageRoot = canonical(path.join(runtime.codex_home, 'packages', 'app-server-daemon')) + '/';
  if (typeof executable !== 'string' || !path.isAbsolute(executable)
      || !canonical(executable).startsWith(packageRoot)
      || path.basename(executable).toLowerCase() !== 'codex.exe')
    throw fail('app_server_invalid_executable');
  return {
    executable,
    socket: path.join(runtime.codex_home, 'app-server-control', 'app-server-control.sock'),
    // This is an existing application dependency, not a new global install.
    wsModule: path.resolve(path.dirname(runtime.orca_cli_exe), '..', 'node_modules', 'ws'),
  };
}

export async function connectManaged(runtime, target, options = {}) {
  const paths = managedPaths(runtime, target);
  const WebSocket = options.WebSocket ?? require(paths.wsModule);
  const spawnProxy = options.spawnProxy ?? spawn;
  const timeoutMs = options.timeoutMs ?? 10000;
  // Windows AF_UNIX endpoints are reparse points: Node existsSync can return
  // false for a live socket. The official proxy validates/connects the endpoint.
  const child = spawnProxy(paths.executable, ['app-server', 'proxy', '--sock', paths.socket], {
    windowsHide: true, env: { ...process.env, CODEX_HOME: runtime.codex_home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  options.children?.add(child);
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  // The URL is used for the HTTP handshake only. createConnection always uses
  // the existing daemon's proxy pipes; no TCP connection/listener is created.
  const ws = new WebSocket('ws://localhost/', {
    createConnection: () => stream, handshakeTimeout: timeoutMs,
    maxPayload: 4 * 1024 * 1024, perMessageDeflate: false,
  });
  let nextId = 0, closed = false, opened = false;
  const pending = new Map();
  let openResolve, openReject;
  const ready = new Promise((resolve, reject) => { openResolve = resolve; openReject = reject; });
  const openTimer = setTimeout(() => stop('app_server_connect_timeout'), timeoutMs);
  function stop(code = 'app_server_closed') {
    if (closed) return;
    closed = true; clearTimeout(openTimer);
    if (!opened) openReject(fail(code));
    for (const p of pending.values()) {
      clearTimeout(p.timer); p.reject(fail(code, !p.mutating));
    }
    pending.clear();
    ws.terminate(); stream.destroy();
    if (child.exitCode == null) child.kill(); // only our short-lived proxy
    options.children?.delete(child);
  }
  child.stderr.on('data', () => {}); // never expose runtime stderr or credentials
  child.on('error', () => stop('app_server_proxy_error'));
  child.on('exit', () => stop('app_server_proxy_exit'));
  stream.on('error', () => stop('app_server_pipe_error'));
  ws.on('error', () => stop('app_server_socket_error'));
  ws.on('close', () => stop());
  ws.on('open', () => { opened = true; clearTimeout(openTimer); openResolve(); });
  ws.on('message', data => {
    let message;
    try { message = JSON.parse(data.toString()); }
    catch { stop('app_server_invalid_json'); return; }
    const p = pending.get(message.id);
    if (!p) return; // notifications/private output are consumed by rollout watcher
    pending.delete(message.id); clearTimeout(p.timer);
    if (message.error) {
      // Only protocol validation/precondition or documented overload rejections
      // prove a write was not accepted. Internal/unknown errors may have effects.
      const definitelyRejected = [-32600, -32601, -32602, -32001].includes(message.error.code);
      const error = fail('app_server_rpc_rejected', !p.mutating || definitelyRejected);
      error.rpcCode = message.error.code; p.reject(error);
    } else if ('result' in message) p.resolve(message.result);
    else p.reject(fail('app_server_invalid_response', !p.mutating));
  });
  async function call(method, params, mutating = false) {
    await ready;
    if (closed) throw fail('app_server_closed');
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id); reject(fail('app_server_request_timeout', !mutating));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, mutating });
      try { ws.send(JSON.stringify({ id, method, params })); }
      catch { pending.delete(id); clearTimeout(timer); reject(fail('app_server_write_uncertain', !mutating)); }
    });
  }
  try {
    await call('initialize', { clientInfo: { name: 'feishu_codex_bridge', version: '1.0.0' },
      capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized' }));
    return { call, close: () => stop() };
  } catch (error) { stop(); throw error; }
}

export async function inspectManagedTarget(client, binding) {
  if (!UUID.test(binding.codex_thread_id ?? '') || !path.isAbsolute(binding.cwd ?? ''))
    throw fail('app_server_invalid_binding');
  const threadId = binding.codex_thread_id;
  let cursor, found = false;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const loaded = await client.call('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(loaded.data)) throw fail('app_server_invalid_loaded_list');
    if (loaded.data.includes(threadId)) { found = true; break; }
    cursor = loaded.nextCursor;
    if (!cursor) break;
    if (seen.has(cursor)) throw fail('app_server_repeated_cursor');
    seen.add(cursor);
  }
  if (!found) throw fail('app_server_thread_not_loaded'); // never resume/claim it here
  const result = await client.call('thread/read', { threadId, includeTurns: false });
  const thread = result.thread;
  if (thread?.id !== threadId || typeof thread.cwd !== 'string'
      || canonical(thread.cwd) !== canonical(binding.cwd)) throw fail('app_server_binding_mismatch');
  if (!['active', 'idle'].includes(thread.status?.type)) throw fail('app_server_thread_unavailable');
  if (thread.status.type === 'idle') return { threadId, mode: 'start' };
  const turns = await client.call('thread/turns/list', {
    threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
  });
  const turn = turns.data?.[0];
  if (turn?.status !== 'inProgress' || !UUID.test(turn.id ?? ''))
    throw fail('app_server_active_turn_changed');
  return { threadId, mode: 'steer', expectedTurnId: turn.id };
}

export async function preflightManaged(runtime, binding, target, options = {}) {
  const client = await (options.connect ?? connectManaged)(runtime, target, options);
  try { return await inspectManagedTarget(client, binding); }
  finally { client.close(); }
}

export async function submitManagedPrompt(runtime, binding, target, prompt, messageId, options = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()
      || Buffer.byteLength(prompt) > 2 * 1024 * 1024
      || !/^om_[A-Za-z0-9_-]+$/.test(messageId ?? '')) throw fail('app_server_invalid_prompt');
  let client;
  try { client = await (options.connect ?? connectManaged)(runtime, target, options); }
  catch { throw fail('app_server_preconnect_failed'); }
  try {
    const state = await inspectManagedTarget(client, binding);
    // This stable identifier helps correlation; it is NOT assumed to make
    // turn/start idempotent. An uncertain response must never be reinjected.
    const clientUserMessageId = createHash('sha256').update(`${binding.bot}\0${messageId}`).digest('hex');
    const params = { threadId: state.threadId, input: [{ type: 'text', text: prompt }], clientUserMessageId };
    if (state.mode === 'steer') params.expectedTurnId = state.expectedTurnId;
    const result = await client.call(`turn/${state.mode}`, params, true);
    const turnId = state.mode === 'steer' ? result?.turnId : result?.turn?.id;
    if (!UUID.test(turnId ?? '')) throw fail('app_server_acceptance_uncertain', false);
    return { mode: state.mode, turnId };
  } finally { client.close(); }
}
