import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareInbound } from './codex-bridge-media.mjs';

function fixture(t,download) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-media-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {downloadRoot:root,download,writeText:(p,s)=>fs.writeFileSync(p,s)};
}
test('downloads real bytes into per-message directory; caches without downloading twice',async t=>{
  let calls=0;
  const opts=fixture(t,async(binding,args,root)=>{
    calls++;assert.equal(binding.profile,'test');assert.ok(args.includes('image'));
    const p=path.join(root,'resource-0.png');fs.writeFileSync(p,Buffer.from([137,80,78,71,13,10,26,10]));
    return {saved_path:p};
  });
  const e={message_id:'om_image',message_type:'image',content:'[Image: img_v3_abc]'};
  const p=await prepareInbound({bot:'test',profile:'test'},e,opts);
  assert.match(p.content,/view_image/);assert.match(p.content,/resource-0.png/);
  await prepareInbound({bot:'test'},e,opts);assert.equal(calls,1);
});
test('file name cannot choose the output path; UTF-8 filename and content retained',async t=>{
  const opts=fixture(t,async(_,args,root)=>{
    assert.equal(args.at(-1),'./resource-0');const p=path.join(root,'resource-0.txt');fs.writeFileSync(p,'中文文件内容');return{saved_path:p};
  });
  const e={message_id:'om_file',message_type:'file',content:JSON.stringify({file_key:'file_v3_abc',file_name:'../../文件.txt'})};
  const p=await prepareInbound({bot:'test'},e,opts);assert.match(p.content,/resource-0.txt/);
});
test('rejects downloader escape, missing keys and oversized attachment',async t=>{
  const opts=fixture(t,async()=>({saved_path:import.meta.filename}));
  const e={message_id:'om_x',message_type:'image',content:'[Image: img_v3_abc]'};
  await assert.rejects(prepareInbound({bot:'test'},e,opts),/outside_download_root/);
  await assert.rejects(prepareInbound({bot:'test'},{...e,content:'no key'},opts),/key_missing/);
  opts.download=async(_,a,root)=>{const p=path.join(root,'large.bin');fs.writeFileSync(p,'');fs.truncateSync(p,51*1024*1024);return {saved_path:p};};
  await assert.rejects(prepareInbound({bot:'test'},e,opts),/size_invalid/);
});
test('long multiline input uses a UTF-8 file without losing content or hitting argv limit',async t=>{
  const opts=fixture(t,async()=>{throw Error('not needed');});const content='中文长消息\n'.repeat(2000);
  const p=await prepareInbound({bot:'test'},{message_id:'om_long',message_type:'text',content},opts);
  assert.ok(p.content.length<1000);const dir=fs.readdirSync(path.join(opts.downloadRoot,'test'))[0];
  assert.equal(fs.readFileSync(path.join(opts.downloadRoot,'test',dir,'message.txt'),'utf8'),content);
});
