import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('socket probe detects unanswered pings, frozen loops, stale identity and bounded recovery', {skip:process.platform!=='win32'},t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ws-health-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const helper=path.resolve('daemon/subscriber-health.ps1').replaceAll("'","''");
 const script=path.join(dir,'check.ps1');
 fs.writeFileSync(script,`
$ErrorActionPreference='Stop'
. '${helper}'
$now=1000000L; $file=Join-Path $PSScriptRoot 'health.json'
$proc=@{ProcessId=42;CreationDate=[DateTimeOffset]::FromUnixTimeMilliseconds(100000).UtcDateTime}
$s=@{schema=1;pid=42;profile='fixture';started_at_ms=100500;updated_at_ms=$now;state='connected';generation=1;connected_at_ms=200000;recovering_since_ms=0;ping_interval_ms=120000;last_ping_at_ms=990000;last_pong_at_ms=990010;pending_ping_since_ms=0}
function Check($name,$signal,$verified,$restart){
 [IO.File]::WriteAllText($file,($s|ConvertTo-Json))
 $r=Get-LarkSocketHealth -Path $file -Process $proc -Profile fixture -NowMs $now
 if($r.signal -ne $signal -or $r.verified -ne $verified -or $r.needs_restart -ne $restart){throw "$name failed: $($r|ConvertTo-Json -Compress)"}
}
Check 'quiet healthy chat' connected $true $false
$s.pending_ping_since_ms=960000; $s.last_ping_at_ms=995000
Check 'new pings do not postpone timeout' pong_timeout $false $true
$s.pending_ping_since_ms=0; $s.last_pong_at_ms=720000
Check 'frozen ping loop' heartbeat_stale $false $true
$s.last_pong_at_ms=990010; $s.pid=43
Check 'PID mismatch' heartbeat_identity_invalid $false $true
$s.pid=42; $s.started_at_ms=200000
Check 'PID reuse' heartbeat_identity_invalid $false $true
$s.started_at_ms=100500; $s.profile='other'
Check 'wrong profile' heartbeat_identity_invalid $false $true
$s.profile='fixture'; $s.last_pong_at_ms=$now+2000
Check 'future timestamp' heartbeat_identity_invalid $false $true
$s.last_pong_at_ms=0; $s.state='awaiting_pong'; $s.connected_at_ms=990000
Check 'local ping not proof' awaiting_pong $false $false
$s.connected_at_ms=800000
Check 'no first pong' first_pong_timeout $false $true
$s.state='reconnecting'; $s.recovering_since_ms=990000
Check 'SDK reconnect grace' reconnecting $false $false
$s.recovering_since_ms=930000
Check 'SDK reconnect deadline' reconnecting $false $true
Remove-Item -LiteralPath $file
$r=Get-LarkSocketHealth -Path $file -Process $proc -Profile fixture -NowMs $now
if(-not $r.needs_restart -or $r.verified){throw 'missing heartbeat treated as healthy'}
[IO.File]::WriteAllText($file,'{broken')
$r=Get-LarkSocketHealth -Path $file -Process $proc -Profile fixture -NowMs $now
if(-not $r.needs_restart){throw 'corrupt heartbeat treated as healthy'}
Write-Output '13 health controls passed'
`);
 assert.match(execFileSync('powershell.exe',['-NoProfile','-File',script],{encoding:'utf8',windowsHide:true}),/13 health controls passed/);
});
