import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('launcher refuses duplicate writers even with a fresh recorded heartbeat; failed stop retains identity', {skip:process.platform!=='win32'}, t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-launch-owner-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=fs.readFileSync(new URL('./start-codex-bridge.ps1',import.meta.url),'utf8');
  const script=path.join(dir,'start-codex-bridge.ps1');
  fs.writeFileSync(script,source.replace("'Global\\LarkCodexBridgeStart-ke'",`'Local\\LaunchOwner-${process.pid}'`));
  const worker=path.join(dir,'codex-bridge-worker.mjs'),bindings=path.join(dir,'codex-thread-bindings.json');
  fs.writeFileSync(worker,'process.exit(0)');fs.writeFileSync(bindings,'{}');
  const instance='11111111-1111-4111-8111-111111111111';
  const record={pid:42,instance,worker_path:worker,bindings_path:bindings};
  const pidFile=path.join(dir,'lark-codex-bridge.pid.json');
  const wrapper=path.join(dir,'fixture.ps1');
  const run=(duplicate,stale)=>{
    fs.writeFileSync(pidFile,JSON.stringify(record));
    fs.writeFileSync(path.join(dir,'lark-codex-bridge.status.json'),JSON.stringify({pid:42,instance,heartbeat_at:new Date(Date.now()-(stale?120000:0)).toISOString()}));
    const cmd=`node.exe ${worker} --bindings ${bindings} --instance ${instance}`;
    fs.writeFileSync(wrapper,`function Get-CimInstance { param($ClassName,$Filter) $one=[pscustomobject]@{Name='node.exe';ProcessId=42;CommandLine='${cmd}'}; if($Filter -like 'ProcessId=*'){return $one}; $one; ${duplicate?"[pscustomobject]@{Name='node.exe';ProcessId=43;CommandLine='"+cmd+"'}":''} }
function Stop-Process { [CmdletBinding()]param($Id,[switch]$Force) Write-Error 'fixture access denied' }
& '${script}'
`);
    return ()=>execFileSync('powershell.exe',['-NoProfile','-File',wrapper],{env:{...process.env,TEMP:dir},windowsHide:true,timeout:15000,stdio:'pipe'});
  };
  assert.throws(run(true,false),{status:1});
  assert.deepEqual(JSON.parse(fs.readFileSync(pidFile)),record);
  assert.throws(run(false,true),{status:1});
  assert.ok(fs.existsSync(pidFile),'failed process stop must never erase the live identity');
  assert.deepEqual(JSON.parse(fs.readFileSync(pidFile)),record);
});
