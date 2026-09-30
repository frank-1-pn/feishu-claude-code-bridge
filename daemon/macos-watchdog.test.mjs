import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){const value=fn();if(value)return value;await sleep(100);}throw Error('watchdog_fixture_timeout');}
test('real supervisor adopts healthy identity, recovers exited worker and preserves queue bytes', {timeout:30000},async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'mac-watchdog-test-'));fs.mkdirSync(path.join(root,'state/events'),{recursive:true});const temp=path.join(root,'tmp');fs.mkdirSync(temp);
 for(const name of ['macos-watchdog.mjs','macos-health.mjs'])fs.copyFileSync(path.join(import.meta.dirname,name),path.join(root,name));
 fs.writeFileSync(path.join(root,'codex-bridge-worker.mjs'),`import fs from 'node:fs';import os from 'node:os';import path from 'node:path';const file=path.join(os.tmpdir(),'lark-codex-bridge.status.json');function publish(){fs.writeFileSync(file,JSON.stringify({pid:process.pid,heartbeat_at:new Date().toISOString()}));}publish();setInterval(publish,300);`);
 fs.writeFileSync(path.join(root,'macos-subscriber.mjs'),`import fs from 'node:fs';import path from 'node:path';fs.writeFileSync(path.join(import.meta.dirname,'state/events/test.subscriber.json'),JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`);
 const cli=path.join(root,'fake-cli');fs.writeFileSync(cli,`#!${process.execPath}\nconsole.log(JSON.stringify({apps:[{running:true,consumers:[{event_key:'im.message.receive_v1'},{event_key:'card.action.trigger'}]}]}));\n`,{mode:0o700});
 const config=path.join(root,'bindings.json');fs.writeFileSync(config,JSON.stringify({runtime:{lark_cli_exe:cli},bindings:{test:{profile:'fixture'}}}));
 const queue=path.join(root,'state/queue.json');fs.writeFileSync(queue,'private fixture durable record');
 const workerStatus=()=>{try{return JSON.parse(fs.readFileSync(path.join(temp,'lark-codex-bridge.status.json')));}catch{return null;}};
 const first=spawn(process.execPath,[path.join(root,'codex-bridge-worker.mjs')],{env:{...process.env,TMPDIR:temp},stdio:'ignore'});
 await until(()=>workerStatus()?.pid===first.pid);
 const supervisor=spawn(process.execPath,[path.join(root,'macos-watchdog.mjs'),config],{env:{...process.env,TMPDIR:temp},stdio:'ignore'});
 t.after(async()=>{supervisor.kill('SIGTERM');first.kill('SIGTERM');await sleep(600);const status=workerStatus();if(status?.pid!==first.pid)try{process.kill(status.pid,'SIGTERM');}catch{}fs.rmSync(root,{recursive:true,force:true});});
 await until(()=>fs.existsSync(path.join(root,'state/macos-watchdog.status.json')));assert.equal(workerStatus().pid,first.pid);
 first.kill('SIGTERM');const recovered=await until(()=>{const s=workerStatus();return s&&s.pid!==first.pid?s:null;});
 assert.notEqual(recovered.pid,first.pid);assert.equal(fs.readFileSync(queue,'utf8'),'private fixture durable record');
});
