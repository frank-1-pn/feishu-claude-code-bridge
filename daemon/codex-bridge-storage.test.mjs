import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomicWriteJson, createStatusPublisher } from './codex-bridge-storage.mjs';

const fixture = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-storage-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'status.json');
};
test('transient replacement failure retries without deleting the old checkpoint', t => {
  const file = fixture(t); atomicWriteJson(file, { old: true });
  let attempts = 0;
  const waits = [];
  const io = { ...fs, renameSync(a, b) {
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { old: true });
    if (++attempts < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    fs.renameSync(a, b);
  } };
  atomicWriteJson(file, { next: true }, { io, wait: ms => waits.push(ms) });
  assert.equal(attempts, 3); assert.deepEqual(waits, [10, 20]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { next: true });
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
});
test('persistent failure keeps old durable state and removes temporary files', t => {
  const file = fixture(t); atomicWriteJson(file, { old: true });
  const io = { ...fs, renameSync() { throw Object.assign(new Error('busy'), { code: 'EPERM' }); } };
  assert.throws(() => atomicWriteJson(file, {}, { io, wait() {} }), { code: 'EPERM' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { old: true });
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
});
test('status failures never escape, are throttled, and recover with diagnostic counters', () => {
  let clock = 10000, attempts = 0, result;
  const publish = createStatusPublisher('unused', { now: () => clock, onError() { throw new Error('log busy'); }, write(file, value) {
    attempts++; if (attempts === 1) throw Object.assign(new Error('busy'), { code: 'EPERM' }); result = value;
  } });
  assert.equal(publish({}), false);
  for (let i = 0; i < 100; i++) publish({});
  assert.equal(attempts, 1); clock += 5000;
  assert.equal(publish({ heartbeat_at: 'fresh' }), true);
  assert.equal(result.status_write_failures, 1);
  assert.equal(result.last_status_write_error.code, 'EPERM');
});
test('real Windows reader denying delete cannot crash heartbeat and recovery succeeds', { skip: process.platform !== 'win32' }, async t => {
  const file = fixture(t); atomicWriteJson(file, { old: true });
  const script = `$f=[IO.File]::Open('${file.replaceAll("'", "''")}','Open','Read',[IO.FileShare]::Read); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $f.Dispose()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(`locker exit ${code}`)); }); });
  let clock = 10000;
  const publish = createStatusPublisher(file, { now: () => clock });
  assert.equal(publish({ next: true }), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { old: true });
  const exited = new Promise(resolve => child.once('exit', resolve)); child.stdin.end('\n'); await exited;
  clock += 5000; assert.equal(publish({ next: true }), true);
  assert.equal(JSON.parse(fs.readFileSync(file)).next, true);
});
