import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough, Duplex } from 'node:stream';
import http from 'node:http';
import { createRequire } from 'node:module';
import { managedPaths, connectManaged, inspectManagedTarget, preflightManaged, submitManagedPrompt } from './codex-bridge-app-server.mjs';

const threadId = '10000000-0000-4000-8000-000000000001';
const turnId = '20000000-0000-4000-8000-000000000001';
const binding = { bot: 'test', codex_thread_id: threadId, cwd: path.join(os.tmpdir(), 'bound-workspace') };
const runtime = { codex_home: path.join(os.tmpdir(), 'codex-home'),
  orca_cli_exe: path.join(os.tmpdir(), 'orca/resources/bin/orca.exe') };
const target = { transport: 'codex_app_server',
  daemon_exe: path.join(runtime.codex_home, 'packages/app-server-daemon/releases/test/bin/codex.exe') };
function clientFixture(options = {}) {
  const calls = []; let closed = 0;
  const client = { close() { closed++; }, async call(method, params, mutating) {
    calls.push({ method, params, mutating });
    if (options.call) return options.call(method, params, mutating);
    if (method === 'thread/loaded/list') return { data: options.loaded ?? [threadId] };
    if (method === 'thread/read') return { thread: { id: threadId, cwd: binding.cwd,
      status: { type: options.state ?? 'idle' }, ...options.thread } };
    if (method === 'thread/turns/list') return { data: [{ id: turnId, status: 'inProgress', ...options.turn }] };
    if (method.startsWith('turn/')) {
      if (options.submitError) throw options.submitError;
      return options.result ?? (method === 'turn/steer' ? { turnId } : { turn: { id: turnId } });
    }
    throw Error('unexpected request');
  } };
  return { client, calls, connect: async () => client, get closed() { return closed; } };
}

test('managed executable must be contained in the original CODEX_HOME package', () => {
  assert.equal(managedPaths(runtime, target).executable, target.daemon_exe);
  for (const executable of ['codex.exe', path.join(os.tmpdir(), 'rogue/codex.exe'),
    path.join(runtime.codex_home, 'packages/app-server-daemon-rogue/codex.exe')])
    assert.throws(() => managedPaths(runtime, { ...target, daemon_exe: executable }), /invalid_executable/);
  assert.throws(() => managedPaths(runtime, { ...target, transport: 'pty' }), /invalid_target/);
});

test('idle target starts one turn without permissions, model or workspace overrides', async () => {
  const f = clientFixture();
  const result = await submitManagedPrompt(runtime, binding, target, '中文消息', 'om_test', f);
  assert.deepEqual(result, { mode: 'start', turnId });
  const writes = f.calls.filter(c => c.mutating);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'turn/start');
  assert.deepEqual(Object.keys(writes[0].params).sort(), ['clientUserMessageId', 'input', 'threadId']);
  assert.equal(writes[0].params.input[0].text, '中文消息');
  assert.equal(f.closed, 1);
});

test('busy target steers the verified active turn; large Unicode text remains exact', async () => {
  const f = clientFixture({ state: 'active' });
  const prompt = '中文、换行\n'.repeat(15000);
  const result = await submitManagedPrompt(runtime, binding, target, prompt, 'om_test', f);
  assert.equal(result.mode, 'steer');
  const write = f.calls.find(c => c.mutating);
  assert.equal(write.params.expectedTurnId, turnId);
  assert.equal(write.params.input[0].text, prompt);
  assert.deepEqual(f.calls.find(c => c.method === 'thread/turns/list').params,
    { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
  assert.equal(f.closed, 1);
});

for (const [label, options, error] of [
  ['unloaded', { loaded: [] }, 'thread_not_loaded'],
  ['different thread', { thread: { id: turnId } }, 'binding_mismatch'],
  ['different workspace', { thread: { cwd: path.join(os.tmpdir(), 'other') } }, 'binding_mismatch'],
  ['unavailable', { state: 'systemError' }, 'thread_unavailable'],
  ['ended turn', { state: 'active', turn: { status: 'completed' } }, 'active_turn_changed'],
]) test(`${label} fails closed without creating a writer or task`, async () => {
  const f = clientFixture(options);
  await assert.rejects(submitManagedPrompt(runtime, binding, target, 'hello', 'om_test', f),
    e => e.message.endsWith(error) && e.notSubmitted === true);
  assert.equal(f.calls.some(c => c.mutating), false);
  assert.equal(f.closed, 1);
});

test('loaded-list pagination and malformed cursor are bounded', async () => {
  let n = 0;
  const f = clientFixture({ call(method) {
    if (method === 'thread/loaded/list') return ++n === 1 ? { data: [], nextCursor: 'next' } : { data: [threadId] };
    if (method === 'thread/read') return { thread: { id: threadId, cwd: binding.cwd, status: { type: 'idle' } } };
  } });
  assert.equal((await inspectManagedTarget(f.client, binding)).mode, 'start');
  assert.equal(n, 2);
  const repeated = clientFixture({ call: () => ({ data: [], nextCursor: 'repeat' }) });
  await assert.rejects(inspectManagedTarget(repeated.client, binding), /repeated_cursor/);
});

test('preflight is strictly read-only and always closes', async () => {
  const f = clientFixture({ state: 'active' });
  assert.equal((await preflightManaged(runtime, binding, target, f)).expectedTurnId, turnId);
  assert.equal(f.calls.some(c => c.mutating), false); assert.equal(f.closed, 1);
});

test('stable message correlation, but no retry after uncertain response', async () => {
  const a = clientFixture(), b = clientFixture();
  await submitManagedPrompt(runtime, binding, target, 'a', 'om_same', a);
  await submitManagedPrompt(runtime, binding, target, 'a', 'om_same', b);
  assert.equal(a.calls.at(-1).params.clientUserMessageId, b.calls.at(-1).params.clientUserMessageId);
  const f = clientFixture({ submitError: Object.assign(Error('timeout'), { notSubmitted: false }) });
  await assert.rejects(submitManagedPrompt(runtime, binding, target, 'a', 'om_same', f), e => e.notSubmitted === false);
  assert.equal(f.calls.filter(c => c.mutating).length, 1);
  assert.equal(f.closed, 1);
});

test('missing acceptance id is uncertain; failed connection is safely not submitted', async () => {
  const f = clientFixture({ result: {} });
  await assert.rejects(submitManagedPrompt(runtime, binding, target, 'a', 'om_test', f),
    e => e.message === 'app_server_acceptance_uncertain' && e.notSubmitted === false);
  await assert.rejects(submitManagedPrompt(runtime, binding, target, 'a', 'om_test', {
    connect: async () => { throw Error('private upstream failure'); },
  }), e => e.message === 'app_server_preconnect_failed' && e.notSubmitted === true);
});

const wsPath = process.env.BRIDGE_TEST_WS_MODULE || path.join(process.env.LOCALAPPDATA || '', 'Programs/orca/resources/node_modules/ws');
const wireAvailable = fs.existsSync(path.join(wsPath, 'index.js'));
function wireFixture(t, respond) {
  const WebSocket = createRequire(import.meta.url)(wsPath);
  const httpServer = http.createServer(); // no .listen(): pipes only, no port
  const wsServer = new WebSocket.WebSocketServer({ noServer: true, perMessageDeflate: false });
  httpServer.on('upgrade', (req, socket, head) => wsServer.handleUpgrade(req, socket, head,
    connection => wsServer.emit('connection', connection, req)));
  const writes = [], spawns = [], children = new Set();
  wsServer.on('connection', ws => ws.on('message', data => {
    const request = JSON.parse(data);
    writes.push(request);
    if (request.id == null) return;
    const result = request.method === 'initialize' ? { result: { userAgent: 'fixture' } } : respond(request, ws);
    if (result !== undefined) ws.send(JSON.stringify({ id: request.id, ...result }));
  }));
  const spawnProxy = (exe, args, opts) => {
    spawns.push({ exe, args, opts });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null;
    const peer = Duplex.from({ readable: child.stdin, writable: child.stdout });
    child.kill = () => { child.exitCode = 0; peer.destroy(); child.emit('exit', 0); };
    peer.on('error', () => {});
    httpServer.emit('connection', peer);
    return child;
  };
  t.after(() => { for (const ws of wsServer.clients) ws.terminate(); wsServer.close(); httpServer.close(); });
  return { options: { WebSocket, spawnProxy, children, timeoutMs: 100 }, writes, spawns, children };
}

test('real WebSocket HTTP Upgrade over proxy pipes; only proxy is spawned', { skip: !wireAvailable }, async t => {
  const f = wireFixture(t, request => ({ result: { echo: request.params.value } }));
  const client = await connectManaged(runtime, target, f.options);
  const value = '中文输入\n'.repeat(20000);
  assert.equal((await client.call('test/echo', { value })).echo, value);
  client.close();
  assert.deepEqual(f.spawns[0].args, ['app-server', 'proxy', '--sock', managedPaths(runtime, target).socket]);
  assert.equal(f.spawns[0].opts.windowsHide, true);
  assert.equal(f.spawns[0].opts.env.CODEX_HOME, runtime.codex_home);
  assert.equal(f.children.size, 0);
  assert.equal(f.writes[0].method, 'initialize');
});

test('wire timeout is safe only before mutating submission; errors stay redacted', { skip: !wireAvailable }, async t => {
  const f = wireFixture(t, request => request.method === 'test/reject'
    ? { error: { code: -32602, message: 'private body that must not escape' } }
    : request.method === 'test/internal' ? { error: { code: -32603, message: 'private internal error' } }
      : request.method === 'test/unknown' ? { error: { code: -99999, message: 'unknown outcome' } } : undefined);
  const client = await connectManaged(runtime, target, f.options);
  await assert.rejects(client.call('test/read', {}), e => e.notSubmitted === true);
  await assert.rejects(client.call('turn/start', {}, true), e => e.notSubmitted === false);
  await assert.rejects(client.call('test/reject', {}, true), e => e.notSubmitted === true
    && e.rpcCode === -32602 && e.message === 'app_server_rpc_rejected');
  await assert.rejects(client.call('test/internal', {}, true), e => e.notSubmitted === false);
  await assert.rejects(client.call('test/unknown', {}, true), e => e.notSubmitted === false);
  client.close(); assert.equal(f.children.size, 0);
});

test('worker routes managed owners before legacy terminal; resolver checks identity', () => {
  const worker = fs.readFileSync(new URL('./codex-bridge-worker.mjs', import.meta.url), 'utf8');
  const resolver = fs.readFileSync(new URL('./resolve-codex-pty.ps1', import.meta.url), 'utf8');
  assert.ok(worker.indexOf('await submitManagedPrompt') < worker.indexOf('const terminalHandle = await resolveOrcaTerminalHandle'));
  assert.match(worker, /await preflightManaged\(config.runtime, binding, resolved/);
  for (const token of ['processStartTime', 'ToFileTimeUtc()', '--managed-daemon', 'codex_app_server', '$writerPids.Count -eq 1'])
    assert.ok(resolver.includes(token));
});
