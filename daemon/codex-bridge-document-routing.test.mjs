import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {prepareDocumentSet,documentPolicy,safeDocumentName} from './codex-bridge-document-routing.mjs';
import {digest} from './codex-bridge-inbox.mjs';
import {prepareInbound} from './codex-bridge-media.mjs';

function fixture(t,destination='project'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'doc-routing-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const downloadRoot=path.join(root,'downloads');fs.mkdirSync(downloadRoot);
  const binding={bot:'fixture',profile:'fixture-profile',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',codex_thread_id:'thread_fixture',cwd:path.join(root,'workspace'),
    document_organization:{version:1,default_destination:destination,bare_file_action:'organize'}};
  fs.mkdirSync(binding.cwd);
  function file(messageId='om_fixture',content='文档原文\r\n42',name='中文资料.txt'){
    const dir=path.join(downloadRoot,binding.bot,digest(messageId));fs.mkdirSync(dir,{recursive:true});const saved_path=path.join(dir,'resource-0.txt');
    const bytes=Buffer.from(content);fs.writeFileSync(saved_path,bytes);
    return {event:{message_id:messageId,message_type:'file'},files:[{index:0,original_name:name,kind:'file',saved_path,size_bytes:bytes.length,sha256:digest(bytes)}]};
  }
  return {root,downloadRoot,binding,file,prepare:extra=>prepareDocumentSet({binding,downloadRoot,...extra})};
}

test('project originals are immutable and Git-ignored in the authorized workspace; retry preserves one source record',t=>{
  const f=fixture(t),input=f.file(),r=f.prepare(input),bytes=fs.readFileSync(input.files[0].saved_path);
  assert.equal(r.receipt.state,'project_originals_preserved');assert.deepEqual(fs.readdirSync(f.binding.cwd),['.feishu-attachments']);
  assert.equal(fs.readFileSync(path.join(f.binding.cwd,'.feishu-attachments','.gitignore'),'utf8'),'*\n');
  assert.deepEqual(fs.readFileSync(r.receipt.files[0].project_copy),bytes);
  assert.equal(path.basename(r.receipt.files[0].project_copy),'中文资料.txt');
  const again=f.prepare(input);assert.deepEqual(again,r);
  assert.equal(fs.readdirSync(path.join(r.receipt.projectRoot,'sources')).length,1);
  const second=f.prepare(f.file('om_second'));assert.equal(second.receipt.files[0].project_copy,r.receipt.files[0].project_copy);
  assert.equal(fs.readdirSync(path.join(r.receipt.projectRoot,'sources')).length,2);
  assert.match(r.prompt,/不代表已分类/);assert.match(r.prompt,/明确的分析/);assert.match(r.prompt,/document-organization\.md/);
});

test('vault destination only records intake; it never invents notes or writes a vault manifest',t=>{
  const f=fixture(t,'vault'),r=f.prepare(f.file());
  assert.equal(r.receipt.state,'received');assert.equal(r.receipt.projectRoot,undefined);assert.deepEqual(fs.readdirSync(f.binding.cwd),[]);
  assert.match(r.prompt,/本地知识库/);assert.equal(r.receipt.files[0].original_name,'中文资料.txt');
  assert(!fs.existsSync(path.join(f.binding.cwd,'.feishu-attachments')));
});

test('cloud destination does not upload or share automatically during intake',t=>{
  const f=fixture(t,'feishu'),r=f.prepare(f.file());
  assert.equal(r.receipt.state,'received');assert.equal(r.receipt.projectRoot,undefined);assert.match(r.prompt,/飞书云空间/);
});

test('bots, projects and threads never reuse a project attachment area',t=>{
  const f=fixture(t),first=f.prepare(f.file());
  for(const change of [{bot:'second'},{cwd:path.join(f.root,'other-project')},{codex_thread_id:'other-thread'}]){
    const binding={...f.binding,...change},source=f.file('om_'+Object.keys(change)[0]);
    fs.mkdirSync(binding.cwd,{recursive:true});
    if(change.bot){const dir=path.join(f.downloadRoot,binding.bot,digest(source.event.message_id));fs.mkdirSync(dir,{recursive:true});const p=path.join(dir,'file.txt');fs.copyFileSync(source.files[0].saved_path,p);source.files[0].saved_path=p;}
    const r=prepareDocumentSet({binding,downloadRoot:f.downloadRoot,...source});assert.notEqual(r.receipt.projectRoot,first.receipt.projectRoot);
  }
});

test('changed originals, changed snapshots, corrupt receipts and changed policies are detected without overwriting data',t=>{
  for(const variant of ['original','snapshot','receipt','policy']){
    const f=fixture(t),input=f.file(),r=f.prepare(input);
    if(variant==='original')fs.writeFileSync(input.files[0].saved_path,'tampered');
    if(variant==='snapshot')fs.writeFileSync(r.receipt.files[0].project_copy,'manual edit');
    if(variant==='receipt')fs.writeFileSync(r.receiptPath,'broken');
    if(variant==='policy')f.binding.document_organization.default_destination='vault';
    assert.throws(()=>f.prepare(input),/document_/);
    if(variant==='snapshot')assert.equal(fs.readFileSync(r.receipt.files[0].project_copy,'utf8'),'manual edit');
  }
});

test('archive failure leaves valid downloaded input available to the original model request',async t=>{
  const f=fixture(t);f.binding.document_organization.version=999;
  const event={message_id:'om_failure',message_type:'file',content:JSON.stringify({file_key:'file_v3_fixture',file_name:'数据.txt'})};
  const prepared=await prepareInbound(f.binding,event,{downloadRoot:f.downloadRoot,writeText:(p,s)=>fs.writeFileSync(p,s),download:async(_,args,root)=>{
    const saved_path=path.join(root,'resource-0.txt');fs.writeFileSync(saved_path,'测试数据');return{saved_path};
  }});
  assert.match(prepared.content,/已下载文件/);assert.match(prepared.content,/document_policy_invalid/);
  assert.match(prepared.content,/不要声称已分类或入库/);
});

test('inbound file metadata and route survive download cache/restart without a second download',async t=>{
  const f=fixture(t,'vault');let downloads=0;
  const event={message_id:'om_chinese',message_type:'file',content:JSON.stringify({file_key:'file_v3_fixture',file_name:'原文件资料.pdf'})};
  const options={downloadRoot:f.downloadRoot,writeText:(p,s)=>fs.writeFileSync(p,s),download:async(_,args,root)=>{
    downloads++;const saved_path=path.join(root,'resource-0.pdf');fs.writeFileSync(saved_path,'%PDF fixture');return{saved_path};
  }};
  const first=await prepareInbound(f.binding,event,options),second=await prepareInbound(f.binding,event,options);
  assert.equal(first.content,second.content);assert.equal(downloads,1);
  const dir=path.join(f.downloadRoot,f.binding.bot,digest(event.message_id)),receipt=JSON.parse(fs.readFileSync(path.join(dir,'document-intake.json')));
  assert.equal(receipt.files[0].original_name,'原文件资料.pdf');assert.match(first.content,/本地知识库/);
});

test('disabled/unconfigured routes and voice messages retain the existing behavior',t=>{
  const f=fixture(t),input=f.file();
  assert.equal(documentPolicy({}),null);assert.equal(documentPolicy({document_organization:{enabled:false}}),null);
  assert.equal(prepareDocumentSet({...input,binding:{...f.binding,document_organization:undefined},downloadRoot:f.downloadRoot}),null);
  assert.equal(f.prepare({...input,event:{...input.event,message_type:'audio'}}),null);
  assert.throws(()=>documentPolicy({document_organization:{version:1,default_destination:'arbitrary-path',bare_file_action:'organize'}}),/document_policy_invalid/);
  assert(!fs.existsSync(path.join(f.binding.cwd,'.feishu-attachments')));
});

test('filenames cannot select a directory, retain unicode, and do not hit Windows reserved names',()=>{
  assert.equal(safeDocumentName('../../报告.txt'),'报告.txt');assert.equal(safeDocumentName('CON.txt'),'file_CON.txt');
  assert.equal(safeDocumentName('..\\恶意.exe'),'恶意.exe');assert.equal(safeDocumentName('name.  '),'name');
  assert.equal(safeDocumentName(''),'attachment.bin');assert(safeDocumentName('😀'.repeat(200)+'.pdf').endsWith('.pdf'));
});

test('an archive junction cannot create directories or files outside the managed root',t=>{
  const f=fixture(t),input=f.file(),outside=path.join(f.root,'outside');fs.mkdirSync(outside);
  fs.symlinkSync(outside,path.join(f.binding.cwd,'.feishu-attachments'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>f.prepare(input),/document_path_outside_root/);assert.deepEqual(fs.readdirSync(outside),[]);
});

test('a restart between the source checkpoint and final receipt reuses the originals and source timestamp',t=>{
  const f=fixture(t),input=f.file(),first=f.prepare(input);
  fs.unlinkSync(first.receiptPath);
  const resumed=prepareDocumentSet({binding:f.binding,downloadRoot:f.downloadRoot,...input,now:()=>first.receipt.receivedAt+60000});
  assert.deepEqual(resumed.receipt,first.receipt);assert.equal(fs.readdirSync(path.join(first.receipt.projectRoot,'sources')).length,1);
});

test('a conflicting project ignore policy is preserved and no private payload is written beneath it',t=>{
  const f=fixture(t),input=f.file(),archive=path.join(f.binding.cwd,'.feishu-attachments');fs.mkdirSync(archive);
  const ignore=path.join(archive,'.gitignore');fs.writeFileSync(ignore,'user-owned rule\n');
  assert.throws(()=>f.prepare(input),/document_snapshot_changed/);
  assert.equal(fs.readFileSync(ignore,'utf8'),'user-owned rule\n');assert.deepEqual(fs.readdirSync(archive),['.gitignore']);
});
