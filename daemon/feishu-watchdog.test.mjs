import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const win = process.platform === 'win32';
test('supervisor recovers the probe/recovery race and does not restart healthy subscribers', { skip: !win }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-watchdog-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(new URL('./invoke-bounded-script.ps1', import.meta.url), path.join(dir, 'invoke-bounded-script.ps1'));
  fs.writeFileSync(path.join(dir, 'codex-thread-bindings.json'), JSON.stringify({ bindings: { fixture: { profile: '' } } }));
  fs.writeFileSync(path.join(dir, 'status-codex-bridge.ps1'), `
$counter=Join-Path $PSScriptRoot 'checks'; $n=0
if(Test-Path $counter){$n=[int][IO.File]::ReadAllText($counter)}
$n++; [IO.File]::WriteAllText($counter,[string]$n)
$ok=$n -ne 2
@{healthy=$ok;delivery_healthy=$ok;bridge=@{exact_identity=$ok;heartbeat_fresh=$ok};bots=@(@{bot='fixture';daemon_healthy=$true})}|ConvertTo-Json -Depth 4
if($ok){exit 0};exit 1
`);
  fs.writeFileSync(path.join(dir, 'start-codex-bridge.ps1'), "[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'starts'),'1');exit 0");
  fs.writeFileSync(path.join(dir, 'ensure-bot.ps1'), "throw 'healthy subscriber must not restart'");
  const script = new URL('./feishu-watchdog.ps1', import.meta.url);
  execFileSync('powershell.exe', ['-NoProfile', '-File', script.pathname.replace(/^\//, ''), '-RuntimeDir', dir, '-NoAlert'], { timeout: 20000 });
  assert.equal(fs.readFileSync(path.join(dir, 'starts'), 'utf8'), '1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state/watchdog.json'))).healthy, true);
  // A persistent failure sets a durable cooldown; next invocation only probes.
  fs.writeFileSync(path.join(dir, 'status-codex-bridge.ps1'), "@{healthy=$false;bridge=@{exact_identity=$false;heartbeat_fresh=$false};bots=@(@{bot='fixture';daemon_healthy=$true})}|ConvertTo-Json -Depth 4;exit 1");
  assert.throws(() => execFileSync('powershell.exe', ['-NoProfile', '-File', script.pathname.replace(/^\//, ''), '-RuntimeDir', dir, '-NoAlert'], { timeout: 30000 }), { status: 1 });
  const starts = fs.readFileSync(path.join(dir, 'starts'), 'utf8');
  assert.equal(starts, '1111');
  assert.throws(() => execFileSync('powershell.exe', ['-NoProfile', '-File', script.pathname.replace(/^\//, ''), '-RuntimeDir', dir, '-NoAlert'], { timeout: 10000 }), { status: 1 });
  assert.equal(fs.readFileSync(path.join(dir, 'starts'), 'utf8'), starts);
});
