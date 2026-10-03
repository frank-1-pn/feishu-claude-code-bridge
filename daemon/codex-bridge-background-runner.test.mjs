import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {runBackgroundTask,runnerEnvironment,safeLoopbackProxy,safeNoProxy,codexArguments,probeRuntimeIdentity,MAX_PROMPT_BYTES,MAX_RESULT_BYTES,RESEARCH_PREFIX} from './codex-bridge-background-runner.mjs';

const nonce='nonce-fixture-0123456789';
function fixture(t,{taskPatch={},claimPatch={},identityFailure=false}={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'background-runner-test-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const taskDir=path.join(root,'task'),home=path.join(root,'home'),cli=path.join(root,'cli.mjs');
  fs.mkdirSync(taskDir,{mode:0o700});fs.mkdirSync(home,{mode:0o700});fs.writeFileSync(cli,'// fixture CLI, never executed\n',{mode:0o600});
  const task={schema:1,id:'task-fixture',title:'只读研究',prompt:'根据已提供资料起草方案',timeoutMs:60000,codexCliJs:cli,codexHome:home,...taskPatch};
  const write=(name,value)=>fs.writeFileSync(path.join(taskDir,name),JSON.stringify(value)+'\n',{mode:0o600});
  write('task.json',task);write('claim.json',{schema:1,taskId:task.id,nonce,...claimPatch});
  const clock={now:1000},timers=new Map(),spawns=[],signals=[];let nextTimer=0;
  const timer=(fn,ms,repeat=false)=>{const id=++nextTimer;timers.set(id,{fn,at:clock.now+ms,ms,repeat});return id;};
  const advance=ms=>{
    const target=clock.now+ms;
    for(;;){const next=[...timers].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;
      const [id,value]=next;clock.now=value.at;if(value.repeat)value.at+=value.ms;else timers.delete(id);value.fn();}
    clock.now=target;
  };
  const child=new EventEmitter();child.pid=42420;child.stdin=new EventEmitter();child.stdin.end=text=>{child.input=text;};
  child.kill=signal=>{signals.push({pid:child.pid,signal,direct:true});return true;};
  const identity=pid=>{if(identityFailure && pid===child.pid)throw Error('private identity stderr');return {bootId:'boot-fixture',uniqueId:pid+100,startSeconds:2,startMicroseconds:3};};
  const options={spawn:(exe,args,opts)=>{spawns.push({exe,args,opts});return child;},now:()=>clock.now,identity,groupAlive:()=>false,
    kill:(pid,signal)=>signals.push({pid,signal}),expectedCodexHome:home,
    env:{HOME:'/actual-user-home-fixture',PATH:'/usr/bin:/bin',LANG:'zh_CN.UTF-8',NODE_OPTIONS:'secret',OPENAI_API_KEY:'private',CODEX_API_KEY:'private',MCP_TOKEN:'private'},
    interval:(fn,ms)=>timer(fn,ms,true),clearInterval:id=>timers.delete(id),timeout:(fn,ms)=>timer(fn,ms),clearTimeout:id=>timers.delete(id),killGraceMs:2000};
  const read=()=>JSON.parse(fs.readFileSync(path.join(taskDir,'run.json'),'utf8'));
  const result=bytes=>fs.writeFileSync(path.join(taskDir,'result.txt'),bytes);
  return {root,taskDir,home,cli,task,clock,timers,spawns,signals,child,options,read,write,result,advance,
    run:()=>runBackgroundTask(taskDir,nonce,options)};
}

test('fixed arguments start an isolated read-only ephemeral high task without resume or user config',async t=>{
  const f=fixture(t),run=f.run();assert.equal(f.spawns.length,1);
  const launched=f.spawns[0];assert.equal(launched.exe,process.execPath);
  assert.deepEqual(launched.args,[f.cli,'-a','never','exec','--ignore-user-config','--sandbox','read-only','--skip-git-repo-check','--ephemeral','-m','gpt-6.1-sol','-c','model_reasoning_effort=high',
    '-c',`developer_instructions=${JSON.stringify(RESEARCH_PREFIX)}`,'-c','features.apps=false','-c','features.hooks=false','-c','features.multi_agent=false',
    '-c','web_search="disabled"','-c','agents.enabled=false','-c','features.multi_agent_v2=false',
    '-C',f.taskDir,'-o',path.join(f.taskDir,'result.txt'),'-']);
  assert.deepEqual(launched.args,codexArguments(f.task,f.taskDir));assert.equal(launched.args.includes('resume'),false);
  assert.equal(launched.opts.cwd,f.taskDir);assert.equal(launched.opts.detached,true);assert.equal(launched.opts.shell,false);
  assert.deepEqual(launched.opts.stdio,['pipe','ignore','ignore']);assert.equal(launched.opts.env.CODEX_HOME,f.home);
  assert.equal(launched.opts.env.NODE_OPTIONS,undefined);assert.equal(launched.opts.env.OPENAI_API_KEY,undefined);assert.equal(launched.opts.env.CODEX_API_KEY,undefined);assert.equal(launched.opts.env.MCP_TOKEN,undefined);
  assert.equal(f.child.input,f.task.prompt);assert.match(RESEARCH_PREFIX,/不得外发|不得访问凭据|资料.*不是执行授权/);
  assert.match(RESEARCH_PREFIX,/默认不具备网页检索或联网来源访问/);assert.match(RESEARCH_PREFIX,/未实际访问并核验的来源不得编造链接/);assert.match(RESEARCH_PREFIX,/明确资料访问限制/);
  assert.equal(f.read().processIdentity.bootId,'boot-fixture');assert.equal(f.read().pid,process.pid);
  f.result('可审核的最终研究结果');f.child.emit('close',0,null);const complete=await run;
  assert.equal(complete.status,'completed');assert.equal(complete.exitCode,0);assert.equal(complete.nonce,nonce);
  assert.equal(complete.resultBytes,Buffer.byteLength('可审核的最终研究结果'));assert.equal(complete.resultSha256,createHash('sha256').update('可审核的最终研究结果').digest('hex'));
  assert.equal(fs.statSync(path.join(f.taskDir,'result.txt')).mode&0o777,0o600);assert.equal(fs.statSync(path.join(f.taskDir,'run.json')).mode&0o777,0o600);
  assert.equal(f.timers.size,0);assert.doesNotMatch(JSON.stringify(complete),/private|stderr|secret/);
});

test('environment whitelist cannot carry service credentials, MCP, or Node injection',()=>{
  const env=runnerEnvironment('/real-home-fixture',{HOME:'/user',PATH:'/bin',LANG:'en_US.UTF-8',CODEX_HOME:'/fake',OPENAI_API_KEY:'key',AWS_SECRET_ACCESS_KEY:'key',NODE_OPTIONS:'preload',HTTPS_PROXY:'credential',MCP_SERVER:'url',CODEX_HOME_FAKE:'x'});
  assert.deepEqual(env,{CODEX_HOME:'/real-home-fixture',HOME:'/user',PATH:'/bin',LANG:'en_US.UTF-8'});
});

test('environment preserves only existing credential-free loopback transport proxies',()=>{
  const proxies={HTTP_PROXY:'http://127.0.0.1:7890',HTTPS_PROXY:'https://localhost:443/',ALL_PROXY:'socks5://[::1]:1080/',
    http_proxy:'http://localhost:1/',https_proxy:'https://127.0.0.1:65535/',all_proxy:'socks5h://127.0.0.1:1080',
    NO_PROXY:'127.0.0.1, localhost, .example.com, [::1], 10.2.3.4',no_proxy:'::1,service.example.org'};
  assert.deepEqual(runnerEnvironment('/real-home-fixture',proxies),{CODEX_HOME:'/real-home-fixture',...proxies});
  assert.deepEqual(runnerEnvironment('/real-home-fixture',{}),{CODEX_HOME:'/real-home-fixture'});
});

test('proxy authorities cannot carry secrets, public hosts, ambiguous addresses or non-root URLs',()=>{
  const rejected=['http://user:password@127.0.0.1:7890/','http://token@localhost:7890/',
    'http://proxy.example.org:7890/','http://192.168.1.2:7890/','http://0.0.0.0:7890/',
    'http://127.1:7890/','http://2130706433:7890/','http://localhost.:7890/','http://%6cocalhost:7890/',
    'http://127.0.0.1:7890/secret','http://127.0.0.1:7890/?token=secret','http://127.0.0.1:7890/#secret',
    'http://localhost/','http://localhost:0/','http://localhost:65536/','ftp://localhost:7890/',
    'http://localhost:7890/\n',' http://localhost:7890/','http://localhost:7890/ ',
    'http://localhost:7890\\@public.example.org/','secret-token'];
  for(const value of rejected) {
    assert.equal(safeLoopbackProxy(value),false,value);
    for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])
      assert.equal(runnerEnvironment('/real-home-fixture',{[key]:value})[key],undefined);
  }
});

test('NO_PROXY accepts bounded domain/IP lists and rejects credentials, controls and malformed entries',()=>{
  for(const value of ['localhost','127.0.0.1,::1','[::1],.example.com','service.example.org.,10.0.0.1'])assert.equal(safeNoProxy(value),true,value);
  for(const value of ['', '*','localhost,,example.com','user:secret@example.com','https://example.com',
    'localhost:7890','example.com?secret=key','example.com#secret','localhost\n,example.com','example.com\t',
    'secret-token','999.999.999.999','-bad.example.org','bad_.example.org','127.0.0.0/8',
    'example.com,'.repeat(129)+'localhost','x'.repeat(4097)]) {
    assert.equal(safeNoProxy(value),false,value);
    assert.equal(runnerEnvironment('/real-home-fixture',{NO_PROXY:value,no_proxy:value}).NO_PROXY,undefined);
    assert.equal(runnerEnvironment('/real-home-fixture',{NO_PROXY:value,no_proxy:value}).no_proxy,undefined);
  }
});

test('hard-link run claim allows one spawn across simultaneous runners and restart',async t=>{
  const f=fixture(t),first=f.run(),second=await f.run();
  assert.equal(second.status,'indeterminate');assert.equal(f.spawns.length,1);
  f.result('final');f.child.emit('close',0);await first;
  const before=fs.readFileSync(path.join(f.taskDir,'run.json'));const restarted=await f.run();
  assert.equal(restarted.status,'indeterminate');assert.equal(f.spawns.length,1);assert.deepEqual(fs.readFileSync(path.join(f.taskDir,'run.json')),before);
});

test('crash after durable run claim but before spawn is never replayed',async t=>{
  const f=fixture(t);f.write('run-claim.json',{schema:1,taskId:f.task.id,nonce});
  const result=await f.run();assert.equal(result.errorCategory,'already_claimed');assert.equal(f.spawns.length,0);
  assert.equal(fs.existsSync(path.join(f.taskDir,'run.json')),false);
});

test('cancel before launch consumes the claim without spawning',async t=>{
  const f=fixture(t);f.write('cancel.json',{schema:1,taskId:f.task.id,nonce,requestedAt:1});
  const result=await f.run();assert.equal(result.status,'cancelled');assert.equal(f.spawns.length,0);
  assert.equal(fs.existsSync(path.join(f.taskDir,'run-claim.json')),true);
});

test('cancel polling requires matching nonce; TERM then KILL targets only its own verified process group',async t=>{
  const f=fixture(t),run=f.run();f.write('cancel.json',{schema:1,taskId:f.task.id,nonce:null,requestedAt:1});f.advance(1000);
  assert.equal(f.signals.length,0);assert.equal(f.read().heartbeatAt,2000);
  f.write('cancel.json',{schema:1,taskId:f.task.id,nonce,requestedAt:2});f.advance(1000);
  assert.deepEqual(f.signals,[{pid:-f.child.pid,signal:'SIGTERM'}]);assert.equal(f.read().status,'running');
  f.advance(2000);assert.deepEqual(f.signals.at(-1),{pid:-f.child.pid,signal:'SIGKILL'});
  f.child.emit('close',null,'SIGKILL');const result=await run;assert.equal(result.status,'cancelled');assert.equal(result.exitCode,null);
  assert.equal(fs.existsSync(path.join(f.taskDir,'result.txt')),false);assert.equal(f.timers.size,0);
});

test('timeout remains running until child close confirms its termination',async t=>{
  const f=fixture(t),run=f.run();f.advance(60000);
  assert.equal(f.read().status,'running');assert.equal(f.read().stopReason,'timed_out');assert.equal(f.signals[0].signal,'SIGTERM');
  f.child.emit('close',null,'SIGTERM');assert.equal((await run).status,'timed_out');assert.equal(f.timers.size,0);
});

test('unconfirmed termination stays indeterminate and never kills a reused PID',async t=>{
  const f=fixture(t);f.options.probe=()=>false;const run=f.run();f.advance(64000);
  const result=await run;assert.equal(result.status,'indeterminate');assert.equal(result.errorCategory,'termination_unconfirmed');assert.equal(f.signals.length,0);
  assert.equal(f.read().status,'indeterminate');assert.equal((await f.run()).status,'indeterminate');assert.equal(f.spawns.length,1);
});

test('failed child birth probe waits for owned child close; no input or premature terminal capacity release',async t=>{
  const f=fixture(t,{identityFailure:true}),run=f.run();
  assert.equal(f.read().status,'indeterminate');assert.equal(f.child.input,undefined);assert.deepEqual(f.signals,[{pid:f.child.pid,signal:'SIGTERM',direct:true}]);
  f.child.emit('close',null,'SIGTERM');const result=await run;assert.equal(result.status,'failed');assert.equal(result.errorCategory,'identity_probe_failed');
  assert.equal(fs.existsSync(path.join(f.taskDir,'result.txt')),false);
});

for(const [name,bytes,error] of [['empty','  \n','result_empty'],['too large',Buffer.alloc(MAX_RESULT_BYTES+1),'result_too_large'],['invalid UTF-8',Buffer.from([0xff]),'invalid_result']])
  test(`exit zero with ${name} output fails safely and removes unusable result`,async t=>{
    const f=fixture(t),run=f.run();f.result(bytes);f.child.emit('close',0);const result=await run;
    assert.equal(result.status,'failed');assert.equal(result.errorCategory,error);assert.equal(fs.existsSync(path.join(f.taskDir,'result.txt')),false);
  });

test('result may fill exactly its bound, and nonzero exit never promotes a partial final',async t=>{
  const f=fixture(t),run=f.run();f.result(Buffer.alloc(MAX_RESULT_BYTES,0x61));f.child.emit('close',0);assert.equal((await run).resultBytes,MAX_RESULT_BYTES);
  const failed=fixture(t),failedRun=failed.run();failed.result('partial');failed.child.emit('close',7);const result=await failedRun;
  assert.equal(result.status,'failed');assert.equal(result.errorCategory,'child_failed');assert.equal(result.exitCode,7);assert.equal(fs.existsSync(path.join(failed.taskDir,'result.txt')),false);
});

test('live oversized output is stopped before it can be accepted',async t=>{
  const f=fixture(t),run=f.run();f.result(Buffer.alloc(MAX_RESULT_BYTES+1));f.advance(1000);
  assert.equal(f.signals.at(-1).signal,'SIGTERM');f.child.emit('close',null,'SIGTERM');const result=await run;
  assert.equal(result.status,'failed');assert.equal(result.errorCategory,'result_too_large');
});

test('spawn errors persist only a safe category and never raw stderr',async t=>{
  const f=fixture(t);f.options.spawn=()=>{throw Error('credential raw stderr secret');};const result=await f.run();
  assert.equal(result.status,'failed');assert.equal(result.errorCategory,'spawn_failed');assert.doesNotMatch(JSON.stringify(f.read()),/credential|stderr|secret/);
  const asyncFailure=fixture(t),run=asyncFailure.run();asyncFailure.child.emit('error',Error('private token'));
  assert.equal(asyncFailure.read().status,'running');asyncFailure.child.emit('close',1);const asyncResult=await run;
  assert.equal(asyncResult.errorCategory,'child_process_error');assert.doesNotMatch(JSON.stringify(asyncFailure.read()),/private|token/);
});

test('child close cannot release capacity while its tool process group survives or is unknown',async t=>{
  for(const groupAlive of [()=>true,()=>{throw Error('private group probe');}]) {
    const f=fixture(t);f.options.groupAlive=groupAlive;const run=f.run();f.result('unconfirmed final');
    f.write('cancel.json',{schema:1,taskId:f.task.id,nonce});f.advance(1000);f.child.emit('close',0);
    const result=await run;assert.equal(result.status,'indeterminate');assert.ok(['child_group_alive','group_probe_failed'].includes(result.errorCategory));
    assert.equal(f.read().status,'indeterminate');assert.equal(f.spawns.length,1);assert.equal(fs.existsSync(path.join(f.taskDir,'result.txt')),false);
    assert.equal((await f.run()).status,'indeterminate');assert.equal(f.spawns.length,1);
  }
});

test('matching cancellation published during result reading wins before completed checkpoint',async t=>{
  const f=fixture(t),run=f.run();f.result('finished result');
  const resultInode=fs.statSync(path.join(f.taskDir,'result.txt')).ino,original=fs.readFileSync;
  fs.readFileSync=(file,...args)=>{
    const bytes=original(file,...args);
    if(typeof file==='number' && fs.fstatSync(file).ino===resultInode)
      f.write('cancel.json',{schema:1,taskId:f.task.id,nonce,requestedAt:f.clock.now});
    return bytes;
  };
  try {f.child.emit('close',0);}finally{fs.readFileSync=original;}
  const result=await run;assert.equal(result.status,'cancelled');assert.equal(result.resultSha256,undefined);
  assert.equal(fs.existsSync(path.join(f.taskDir,'result.txt')),false);assert.equal(f.read().completedAt,f.clock.now);
});

test('nonce, task bounds, fake home, symlinks and public input files fail before spawning',async t=>{
  for(const taskPatch of [{prompt:'x'.repeat(MAX_PROMPT_BYTES+1)},{timeoutMs:59999},{timeoutMs:1800001},{title:''}]) {
    const f=fixture(t,{taskPatch});await assert.rejects(f.run());assert.equal(f.spawns.length,0);
  }
  const mismatch=fixture(t,{claimPatch:{nonce:'nonce-foreign-0123456789'}});await assert.rejects(mismatch.run(),/claim_mismatch/);
  const home=fixture(t);home.options.expectedCodexHome=home.root;await assert.rejects(home.run(),/codex_home_mismatch/);
  const link=fixture(t);fs.renameSync(path.join(link.taskDir,'task.json'),path.join(link.root,'outside.json'));fs.symlinkSync(path.join(link.root,'outside.json'),path.join(link.taskDir,'task.json'));
  await assert.rejects(link.run(),/unsafe_path/);
  const publicTask=fixture(t);fs.chmodSync(path.join(publicTask.taskDir,'task.json'),0o644);await assert.rejects(publicTask.run(),/unsafe_path/);
  const preexisting=fixture(t);fs.symlinkSync('/nonexistent-fixture',path.join(preexisting.taskDir,'result.txt'));assert.equal((await preexisting.run()).status,'indeterminate');assert.equal(preexisting.spawns.length,0);
});

test('a substituted result symlink is never read and cannot leak its target',async t=>{
  const f=fixture(t),run=f.run(),outside=path.join(f.root,'outside');fs.writeFileSync(outside,'private target',{mode:0o600});
  fs.unlinkSync(path.join(f.taskDir,'result.txt'));fs.symlinkSync(outside,path.join(f.taskDir,'result.txt'));f.child.emit('close',0);
  const result=await run;assert.equal(result.status,'failed');assert.equal(result.errorCategory,'invalid_result');assert.equal(fs.readFileSync(outside,'utf8'),'private target');
  assert.equal(fs.existsSync(path.join(f.taskDir,'result.txt')),false);assert.doesNotMatch(JSON.stringify(result),/private target/);
});

test('birth identity probes reject boot or start changes, missing processes, and malformed identity',()=>{
  const birth={bootId:'one-boot',uniqueId:7,startSeconds:8,startMicroseconds:9};
  assert.equal(probeRuntimeIdentity(4,birth,()=>({...birth})),true);
  for(const patch of [{bootId:'second-boot'},{uniqueId:8},{startSeconds:9},{startMicroseconds:10}])assert.equal(probeRuntimeIdentity(4,birth,()=>({...birth,...patch})),false);
  assert.equal(probeRuntimeIdentity(4,birth,()=>{throw Error('no process');}),false);
  assert.equal(probeRuntimeIdentity(4,{},()=>({})),false);
});


test('per-task output and deadline are hard limits while research steps are clearly a prompt budget',async t=>{
  const budget={version:1,timeoutMs:60000,maxOutputBytes:1024,researchStepLimit:2};
  const f=fixture(t,{taskPatch:{budget}}),run=f.run();
  assert.match(f.spawns[0].args.join(' '),/2个研究步骤.*计划提示预算.*不是工具调用次数硬限/);
  f.result('x'.repeat(1025));f.advance(1000);assert.equal(f.read().phase,'stopping');f.child.emit('close',0,null);
  assert.equal((await run).errorCategory,'result_too_large');assert.equal(f.timers.size,0);
  const exact=fixture(t,{taskPatch:{budget}}),done=exact.run();exact.result('x'.repeat(1024));exact.child.emit('close',0,null);
  assert.equal((await done).status,'completed');assert.equal(exact.read().resultBytes,1024);
});

test('malformed budget cannot spawn even when the top-level task is otherwise valid',async t=>{
  for(const budget of [{version:1,timeoutMs:60001,maxOutputBytes:1024,researchStepLimit:2},
    {version:1,timeoutMs:60000,maxOutputBytes:262145,researchStepLimit:2},{version:1,timeoutMs:60000,maxOutputBytes:1024,researchStepLimit:25}]) {
    const f=fixture(t,{taskPatch:{budget}});await assert.rejects(f.run(),/budget_invalid/);assert.equal(f.spawns.length,0);
  }
});
