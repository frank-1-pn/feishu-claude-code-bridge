import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {syncReceiptDiagnostic} from './codex-bridge-idle.mjs';

function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'receipt-idle-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {receiptOffsetPath:path.join(dir,'receipt.offset')};}
test('idle receipts retain the inode and bytes; changed intake and externally changed diagnostics are read afresh',t=>{
  const b=fixture(t);let cursor=10,reads=0;const options={readOffset:()=>{reads++;return cursor;}};
  assert.equal(syncReceiptDiagnostic(b,options),true);const first=fs.statSync(b.receiptOffsetPath);
  for(let i=0;i<20;i++)assert.equal(syncReceiptDiagnostic(b,options),false);
  assert.equal(reads,21);assert.equal(fs.statSync(b.receiptOffsetPath).ino,first.ino);assert.equal(fs.readFileSync(b.receiptOffsetPath,'utf8'),'10');
  cursor=11;assert.equal(syncReceiptDiagnostic(b,options),true);assert.equal(fs.readFileSync(b.receiptOffsetPath,'utf8'),'11');
  fs.writeFileSync(b.receiptOffsetPath,'5');assert.equal(syncReceiptDiagnostic(b,options),true);assert.equal(fs.readFileSync(b.receiptOffsetPath,'utf8'),'11');
});
test('receipt diagnostic failures never write or advance an authoritative cursor',t=>{
  const b=fixture(t);let writes=0;const options={readOffset:()=>10,write:()=>{writes++;throw Error('disk failed');}};
  assert.throws(()=>syncReceiptDiagnostic(b,options),/disk failed/);assert.equal(writes,1);
  fs.writeFileSync(b.receiptOffsetPath,'10',{mode:0o600});fs.chmodSync(b.receiptOffsetPath,0o644);
  if(process.platform!=='win32')assert.throws(()=>syncReceiptDiagnostic(b,options),/untrusted/);assert.equal(writes,1);
  fs.chmodSync(b.receiptOffsetPath,0o600);const other=b.receiptOffsetPath+'.other';fs.renameSync(b.receiptOffsetPath,other);fs.symlinkSync(other,b.receiptOffsetPath);
  assert.throws(()=>syncReceiptDiagnostic(b,options),/untrusted/);assert.equal(writes,1);
});
