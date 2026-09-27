import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('GUI watchdog launcher waits for work and propagates failure without a console entrypoint', {skip:process.platform!=='win32'}, t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'watchdog hidden '));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const launcher=path.join(dir,'run-watchdog-hidden.vbs');
  fs.copyFileSync(new URL('./run-watchdog-hidden.vbs',import.meta.url),launcher);
  fs.writeFileSync(path.join(dir,'feishu-watchdog.ps1'), "Start-Sleep -Milliseconds 150; [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'completed'),'done'); exit 7");
  const result=spawnSync(path.join(process.env.SystemRoot,'System32/wscript.exe'),['//B','//NoLogo',launcher],{windowsHide:true,timeout:10000});
  assert.equal(result.status,7);
  assert.equal(fs.readFileSync(path.join(dir,'completed'),'utf8'),'done');
  fs.unlinkSync(path.join(dir,'feishu-watchdog.ps1'));
  assert.equal(spawnSync('wscript.exe',['//B','//NoLogo',launcher],{windowsHide:true,timeout:10000}).status,2);
});
