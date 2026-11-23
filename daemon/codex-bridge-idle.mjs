import fs from 'node:fs';
import {atomicWriteText} from './codex-bridge-storage.mjs';

// Only the receipt diagnostic may skip a redundant write. The authoritative
// intake cursor is read every time; queue commits and delivery are unaffected.
export function syncReceiptDiagnostic(binding,{readOffset,io=fs,write=atomicWriteText}) {
  const value=String(readOffset(binding)??0),file=binding.receiptOffsetPath;
  try {
    const before=io.lstatSync(file);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1
      ||process.platform!=='win32'&&(before.mode&0o777)!==0o600||typeof process.getuid==='function'&&before.uid!==process.getuid()) {
      throw Object.assign(Error('receipt_diagnostic_untrusted'),{code:'INVALID_DIAGNOSTIC'});
    }
    const fd=io.openSync(file,io.constants.O_RDONLY|(io.constants.O_NOFOLLOW??0));
    try {
      const current=io.fstatSync(fd),same=before.dev===current.dev&&before.ino===current.ino;
      if(!same||!current.isFile()||current.nlink!==1
        ||process.platform!=='win32'&&(current.mode&0o777)!==0o600
        ||typeof process.getuid==='function'&&current.uid!==process.getuid())
        throw Object.assign(Error('receipt_diagnostic_changed'),{code:'DIAGNOSTIC_CHANGED'});
      if(current.size===Buffer.byteLength(value)&&io.readFileSync(fd,'utf8')===value)return false;
    }finally{io.closeSync(fd);}
  }catch(error){if(error.code!=='ENOENT')throw error;}
  write(file,value);return true;
}
