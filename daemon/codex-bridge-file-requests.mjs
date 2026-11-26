import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest} from './codex-bridge-inbox.mjs';
import {privateDirectory,privateRead,stableJson} from './codex-bridge-background-store.mjs';
import {safeAttachmentName,attachmentFileType,within} from './codex-bridge-files.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const limit=mode=>(mode==='image'?10:30)*1024*1024;
export function attachmentRequestPayload(value){
 if(!plain(value)||Object.keys(value).some(k=>!['schema','mode','name','bytes','sha256','cover'].includes(k))
   ||value.schema!==1||!['file','image','audio','video'].includes(value.mode))fail('agent_request_attachment_invalid');
 const artifact=(v,max)=>plain(v)&&Object.keys(v).sort().join(',')==='bytes,name,sha256'
   &&typeof v.name==='string'&&safeAttachmentName(v.name)===v.name&&hash(v.sha256)
   &&Number.isSafeInteger(v.bytes)&&v.bytes>0&&v.bytes<=max;
 if(!artifact({name:value.name,bytes:value.bytes,sha256:value.sha256},limit(value.mode))
   ||(value.mode==='video'?!artifact(value.cover,limit('image')):value.cover!==undefined))fail('agent_request_attachment_invalid');
 return {...value,...(value.cover?{cover:{...value.cover}}:{})};
}
function payloadRoot(ctx,{create=false}={}){
 const base=path.join(ctx.cwd,'.codex-bridge-file-payloads-v1');
 for(const dir of [base,path.join(base,ctx.binding.bot),path.join(base,ctx.binding.bot,ctx.scopeHash)])privateDirectory(dir,{create});
 if(create){
  const ignore=path.join(base,'.gitignore');
  try{fs.writeFileSync(ignore,'*\n',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  if(fs.lstatSync(ignore).nlink!==1||privateRead(ignore,{maxBytes:16,mode:0o600}).toString()!=='*\n')fail('agent_request_attachment_ignore_invalid');
 }
 return path.join(base,ctx.binding.bot,ctx.scopeHash);
}
const signature=s=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
function readFile(file,max,{privateFile=false}={}){
 let fd;
 try{
  const before=fs.lstatSync(file,{bigint:true});
  if(before.isSymbolicLink()||!before.isFile()||before.nlink!==1n)fail('agent_request_attachment_file_invalid');
  fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));const s=fs.fstatSync(fd,{bigint:true});
  if(before.isSymbolicLink()||!s.isFile()||s.nlink!==1n||s.size<1n||s.size>BigInt(max)
    ||process.getuid&&s.uid!==BigInt(process.getuid())||signature(before)!==signature(s)
    ||privateFile&&(s.mode&0o777n)!==0o600n)fail('agent_request_attachment_file_invalid');
  const bytes=Buffer.alloc(Number(s.size));let used=0;while(used<bytes.length){const n=fs.readSync(fd,bytes,used,bytes.length-used,used);if(!n)break;used+=n;}
  const extra=fs.readSync(fd,Buffer.alloc(1),0,1,used),after=fs.fstatSync(fd,{bigint:true}),current=fs.lstatSync(file,{bigint:true});
  if(extra||used!==Number(s.size)||bytes.length!==Number(s.size)||signature(s)!==signature(after)||signature(s)!==signature(current))fail('agent_request_attachment_changed');
  return bytes;
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}
function source(ctx,file,max){
 if(typeof file!=='string'||!path.isAbsolute(file))fail('agent_request_attachment_path_invalid');
 const real=fs.realpathSync(file),roots=[ctx.cwd,...(ctx.binding.outbound_roots??[])].map(p=>fs.realpathSync(p));
 if(!roots.some(r=>within(r,real)))fail('agent_request_attachment_outside_roots');
 const bytes=readFile(real,max);
 if(fs.realpathSync(file)!==real)fail('agent_request_attachment_changed');
 return {name:safeAttachmentName(path.basename(real)),bytes};
}
function publish(file,bytes){
 const tmp=file+'.'+randomUUID()+'.tmp';let fd;
 try{
  fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  try{fs.linkSync(tmp,file);}catch(e){if(e.code!=='EEXIST')throw e;}
 }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(tmp,{force:true});}
 if(digest(readFile(file,bytes.length,{privateFile:true}))!==digest(bytes))fail('agent_request_attachment_changed');
}
export function stageAttachmentRequest(ctx,{file,mode='file',cover}){
 if(!['file','image','audio','video'].includes(mode)||mode!=='video'&&cover!==undefined)fail('agent_request_attachment_invalid');
 const item=source(ctx,file,limit(mode)),preview=mode==='video'?source(ctx,cover,limit('image')):null;
 try{attachmentFileType(item.name,mode,item.bytes);}catch(error){if(/^attachment_[a-z_]+$/.test(error.code??''))fail('agent_request_'+error.code);throw error;}
 const describe=v=>({name:v.name,bytes:v.bytes.length,sha256:digest(v.bytes)});
 const value=attachmentRequestPayload({schema:1,mode,...describe(item),...(preview?{cover:describe(preview)}:{})});
 const root=payloadRoot(ctx,{create:true}),key=digest(stableJson(value)),dir=path.join(root,key);
 const lock=path.join(root,'.admission.lock');let fd,identity;
 try{
  // A leftover claim is an unknown admission, never an invitation to steal it.
  try{fd=fs.openSync(lock,'wx',0o600);identity=fs.fstatSync(fd);}catch(error){if(error.code==='EEXIST')fail('agent_request_attachment_admission_busy');throw error;}
  if(!fs.existsSync(dir)){
   const names=fs.readdirSync(root).filter(n=>n!=='.admission.lock');if(names.length>=256)fail('agent_request_attachment_storage_full');
   let bytes=0;
   for(const name of names){if(!hash(name))fail('agent_request_attachment_store_invalid');const d=path.join(root,name);privateDirectory(d);
    for(const n of fs.readdirSync(d)){if(!['file','cover'].includes(n))fail('agent_request_attachment_store_invalid');const st=fs.lstatSync(path.join(d,n));if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)fail('agent_request_attachment_store_invalid');bytes+=st.size;}}
   if(bytes+item.bytes.length+(preview?.bytes.length??0)>768*1024*1024)fail('agent_request_attachment_storage_full');
  }
  privateDirectory(dir,{create:true});publish(path.join(dir,'file'),item.bytes);if(preview)publish(path.join(dir,'cover'),preview.bytes);
 }finally{
  if(fd!==undefined){const current=fs.lstatSync(lock,{throwIfNoEntry:false});if(current&&current.dev===identity.dev&&current.ino===identity.ino&&current.nlink===1&&!current.isSymbolicLink())fs.unlinkSync(lock);fs.closeSync(fd);}
 }
 return value;
}
export function readAttachmentRequest(ctx,payload){
 const value=attachmentRequestPayload(payload),root=payloadRoot(ctx),dir=path.join(root,digest(stableJson(value)));privateDirectory(dir);
 const read=(name,descriptor)=>{const bytes=readFile(path.join(dir,name),descriptor.bytes,{privateFile:true});if(bytes.length!==descriptor.bytes||digest(bytes)!==descriptor.sha256)fail('agent_request_attachment_changed');return bytes;};
 return {name:value.name,mode:value.mode,bytes:read('file',value),...(value.cover?{preview:{name:value.cover.name,bytes:read('cover',value.cover)}}:{})};
}
