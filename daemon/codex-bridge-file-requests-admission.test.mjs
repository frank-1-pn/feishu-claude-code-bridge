import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {stageAttachmentRequest} from './codex-bridge-file-requests.mjs';

function fixture(t) {
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'file-admission-')));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const ctx={cwd,binding:{bot:'fixture'},scopeHash:'a'.repeat(64)},root=path.join(cwd,'.codex-bridge-file-payloads-v1','fixture',ctx.scopeHash);
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const source=name=>{const file=path.join(cwd,name);fs.writeFileSync(file,`fixture ${name}`,{mode:0o600});return file;};
  const count=()=>fs.readdirSync(root).filter(n=>/^[a-f0-9]{64}$/.test(n)).length;
  const seed=(i,size)=>{const dir=path.join(root,i.toString(16).padStart(64,'0'));fs.mkdirSync(dir,{mode:0o700});if(size){const file=path.join(dir,'file');fs.writeFileSync(file,'',{mode:0o600});fs.truncateSync(file,size);}};
  return {cwd,ctx,root,source,count,seed};
}

test('real concurrent processes cannot exceed 256 snapshots while one owns admission',async t=>{
  const f=fixture(t);for(let i=0;i<255;i++)f.seed(i);
  const first=f.source('first.txt'),second=f.source('second.txt'),held=path.join(f.cwd,'held'),release=path.join(f.cwd,'release');
  const moduleUrl=new URL('./codex-bridge-file-requests.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs';import path from 'node:path';import {stageAttachmentRequest} from ${JSON.stringify(moduleUrl)};
    const open=fs.openSync;const timeout=new Int32Array(new SharedArrayBuffer(4));
    fs.openSync=function(file,...args){const fd=open.call(fs,file,...args);if(path.basename(String(file))==='.admission.lock'){
      fs.writeFileSync(${JSON.stringify(held)},'held');const end=Date.now()+5000;
      while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>end)throw Error('fixture timeout');Atomics.wait(timeout,0,0,10);}}
      return fd;};
    stageAttachmentRequest(${JSON.stringify(f.ctx)},{file:${JSON.stringify(first)}});
  `],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const completion=new Promise(resolve=>child.once('close',code=>resolve(code)));
  const deadline=Date.now()+4000;while(!fs.existsSync(held)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(fs.existsSync(held),'first publisher acquired the real filesystem lock');
  const contender=spawnSync(process.execPath,['--input-type=module','-e',`
    import {stageAttachmentRequest} from ${JSON.stringify(moduleUrl)};
    try{stageAttachmentRequest(${JSON.stringify(f.ctx)},{file:${JSON.stringify(second)}});process.stdout.write('unexpected-success');}
    catch(error){process.stdout.write(error.code??'unknown');}
  `],{encoding:'utf8',timeout:3000});
  assert.equal(contender.status,0);assert.equal(contender.stdout,'agent_request_attachment_admission_busy');assert.equal(f.count(),255);
  fs.writeFileSync(release,'release');assert.equal(await completion,0,stderr);assert.equal(f.count(),256);
  assert.throws(()=>stageAttachmentRequest(f.ctx,{file:second}),{code:'agent_request_attachment_storage_full'});
  assert.equal(f.count(),256);assert.ok(!fs.existsSync(path.join(f.root,'.admission.lock')));
});

test('logical byte budget rejects additional data and releases only its own claim',t=>{
  const f=fixture(t);for(let i=0;i<25;i++)f.seed(i,30*1024*1024);f.seed(25,18*1024*1024);
  assert.throws(()=>stageAttachmentRequest(f.ctx,{file:f.source('next.txt')}),{code:'agent_request_attachment_storage_full'});
  assert.equal(f.count(),26);assert.ok(!fs.existsSync(path.join(f.root,'.admission.lock')));
});

test('unknown existing admission is retained, including hardlinked claims',t=>{
  const f=fixture(t),file=f.source('next.txt'),lock=path.join(f.root,'.admission.lock');fs.writeFileSync(lock,'unknown claim',{mode:0o600});
  const before=fs.lstatSync(lock);assert.throws(()=>stageAttachmentRequest(f.ctx,{file}),{code:'agent_request_attachment_admission_busy'});
  assert.equal(fs.readFileSync(lock,'utf8'),'unknown claim');assert.equal(fs.lstatSync(lock).ino,before.ino);assert.equal(f.count(),0);
  fs.linkSync(lock,path.join(f.cwd,'linked-claim'));assert.throws(()=>stageAttachmentRequest(f.ctx,{file}),{code:'agent_request_attachment_admission_busy'});assert.equal(fs.lstatSync(lock).nlink,2);
});

test('completed immutable duplicate is accepted at capacity without allocating another slot',t=>{
  const f=fixture(t),file=f.source('same.txt'),first=stageAttachmentRequest(f.ctx,{file});for(let i=0;i<255;i++)f.seed(i);
  const duplicate=stageAttachmentRequest(f.ctx,{file});assert.deepEqual(duplicate,first);assert.equal(f.count(),256);
});
