#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const result = { mode: '', sessionId: '', scrollbackRows: 2000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') result.mode = argv[++index] ?? '';
    else if (arg === '--session-id') result.sessionId = argv[++index] ?? '';
    else if (arg === '--scrollback-rows') result.scrollbackRows = Number(argv[++index] ?? '2000');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['list', 'write', 'snapshot', 'inspect', 'cwd'].includes(result.mode)) {
    throw new Error('Expected --mode list|write|snapshot|inspect|cwd');
  }
  if (result.mode !== 'list' && !result.sessionId) throw new Error('--session-id is required');
  return result;
}

function findDaemonEndpoint() {
  const runtimeDir = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'orca', 'daemon') : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'orca', 'daemon');
  const candidates = fs.readdirSync(runtimeDir)
    .map((name) => /^daemon-v(\d+)\.pid$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter(Number.isSafeInteger)
    .sort((a, b) => b - a);
  if (candidates.length === 0) throw new Error('Orca terminal daemon PID record not found');
  const version = candidates[0];
  const tokenPath = path.join(runtimeDir, `daemon-v${version}.token`);
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  if (!token) throw new Error('Orca terminal daemon token is empty');
  const suffix = crypto.createHash('sha256').update(runtimeDir).digest('hex').slice(0, 12);
  return {
    version,
    token,
    socketPath: process.platform === 'darwin' ? path.join(runtimeDir, `daemon-v${version}.sock`) : `\\\\?\\pipe\\orca-terminal-host-v${version}-${suffix}`,
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function requestFor(args, stdinText) {
  const id = crypto.randomUUID();
  if (args.mode === 'list') return { id, type: 'listSessions', payload: {} };
  if (args.mode === 'write') return { id, type: 'write', payload: { sessionId: args.sessionId, data: stdinText } };
  if (args.mode === 'snapshot') {
    return {
      id,
      type: 'getSnapshot',
      payload: { sessionId: args.sessionId, scrollbackRows: args.scrollbackRows },
    };
  }
  if (args.mode === 'inspect') return { id, type: 'inspectProcess', payload: { sessionId: args.sessionId } };
  return { id, type: 'getCwd', payload: { sessionId: args.sessionId } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = findDaemonEndpoint();
  const stdinText = args.mode === 'write' ? await readStdin() : '';
  const request = requestFor(args, stdinText);
  const clientId = `lark-codex-bridge-${crypto.randomUUID()}`;
  const socket = net.createConnection(endpoint.socketPath);
  socket.setEncoding('utf8');

  let buffer = '';
  let helloAccepted = false;
  let completed = false;
  const timeout = setTimeout(() => {
    socket.destroy(new Error('Orca terminal daemon RPC timeout'));
  }, 5000);

  const finish = (error, payload) => {
    if (completed) return;
    completed = true;
    clearTimeout(timeout);
    socket.destroy();
    if (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    }
  };

  socket.on('connect', () => {
    socket.write(`${JSON.stringify({
      type: 'hello',
      version: endpoint.version,
      token: endpoint.token,
      role: 'control',
      clientId,
    })}\n`);
  });

  socket.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (!helloAccepted) {
        if (message.type !== 'hello' || message.ok !== true) {
          finish(new Error(message.error || 'Orca terminal daemon rejected hello'));
          return;
        }
        helloAccepted = true;
        socket.write(`${JSON.stringify(request)}\n`);
        continue;
      }
      if (message.id !== request.id) continue;
      if (message.ok !== true) finish(new Error(message.error || 'Orca terminal daemon request failed'));
      else finish(null, message.payload ?? {});
      return;
    }
  });
  socket.on('error', (error) => {
    if (completed) return;
    completed = true;
    clearTimeout(timeout);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
