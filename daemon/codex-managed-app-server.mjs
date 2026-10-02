import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {connectManagedWebSocket} from './codex-managed-websocket.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const command=(exe,args)=>{try{return execFileSync(exe,args,{encoding:'utf8',maxBuffer:1024*1024,timeout:10000,stdio:['ignore','pipe','ignore']});}catch{fail('managed_identity_probe_failed');}};
export function activeCodexWriters(home,threadId) {
  if(!/^[a-f0-9-]{36}$/i.test(threadId??'') || !path.isAbsolute(home??''))fail('managed_binding_invalid');
  const lock=path.join(home,'thread-writer-locks',threadId+'.lock');
  if(!fs.existsSync(lock))return [];
  const probe=command('/usr/bin/python3',['-c',"import fcntl,sys\nf=open(sys.argv[1],'r+')\ntry:\n fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);print('free')\nexcept BlockingIOError: print('busy')",lock]).trim();
  if(probe==='free')return [];
  if(probe!=='busy')fail('managed_writer_probe_invalid');
  const writers=[];let pid;
  for(const line of command('/usr/sbin/lsof',['-Fpc',lock]).split('\n')){if(line.startsWith('p'))pid=Number(line.slice(1));if(line==='ccodex' && Number.isSafeInteger(pid))writers.push(pid);}
  if(!writers.length)fail('managed_writer_not_found');return [...new Set(writers)];
}
const nativeProbe=`import ctypes,json,os,struct,subprocess,sys
pid=int(sys.argv[1]);lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
lib.proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]
def info(flavor,size):
 b=ctypes.create_string_buffer(size)
 if lib.proc_pidinfo(pid,flavor,1,b,size)!=size:raise RuntimeError('identity_unavailable')
 return b.raw
u=info(17,56);bsd=info(3,136)
unique=struct.unpack_from('Q',u,16)[0]
if unique!=struct.unpack_from('Q',info(17,56),16)[0]:raise RuntimeError('identity_changed')
uid=struct.unpack_from('I',bsd,20)[0];status=struct.unpack_from('I',bsd,4)[0]
if uid!=os.getuid() or status==5:raise RuntimeError('identity_invalid')
buf=ctypes.create_string_buffer(4096)
if lib.proc_pidpath(pid,buf,4096)<=0:raise RuntimeError('executable_unavailable')
print(json.dumps({'processIdentity':{'bootId':subprocess.check_output(['/usr/sbin/sysctl','-n','kern.bootsessionuuid']).decode().strip(),'uniqueId':unique,'startSeconds':struct.unpack_from('Q',bsd,120)[0],'startMicroseconds':struct.unpack_from('Q',bsd,128)[0]},'executable':buf.value.decode(),'startTime':subprocess.check_output(['/bin/ps','-p',str(pid),'-o','lstart=']).decode().strip()}))`;
function owned(file,{socket=false,directory=false}={}) {
  const s=fs.lstatSync(file);
  if(s.isSymbolicLink() || s.uid!==process.getuid() || (s.mode&0o022) || (socket?!s.isSocket():directory?!s.isDirectory():!s.isFile()))fail('managed_path_untrusted');
  return s;
}
// This only discovers an already-live daemon that holds this exact writer lock.
// It never starts a server, executes its binary, changes config or adopts a fork.
export function resolveManagedDaemon(home,threadId,writers=activeCodexWriters(home,threadId)) {
  const root=fs.realpathSync(home),file=path.join(root,'app-server-daemon','daemon.pid');
  if(!fs.existsSync(file))return null;
  owned(root,{directory:true});owned(path.dirname(file),{directory:true});owned(file);
  const record=JSON.parse(fs.readFileSync(file,'utf8'));
  if(writers.length!==1 || record.pid!==writers[0])return null;
  if(!Number.isSafeInteger(record.pid) || record.pid<2 || !record.processIdentity || !Number.isSafeInteger(record.processIdentity.uniqueId) || typeof record.processStartTime!=='string')fail('managed_record_invalid');
  const live=JSON.parse(command('/usr/bin/python3',['-c',nativeProbe,String(record.pid)]));
  if(!same(record.processIdentity,live.processIdentity) || record.processStartTime!==live.startTime)fail('managed_identity_mismatch');
  const executable=fs.realpathSync(live.executable),releaseRoot=path.join(root,'packages','app-server-daemon','releases');
  const rel=path.relative(releaseRoot,executable);
  if(rel.startsWith('..') || path.isAbsolute(rel) || !/^[^/]+\/bin\/codex$/.test(rel))fail('managed_executable_mismatch');
  owned(executable);
  // The executable digest in daemon.pid uses BLAKE3. We do not execute the
  // binary: native PID/boot/start identity plus lock/socket ownership ties us
  // directly to the running writer, with the entire record rechecked at send.
  const alias=path.join(root,'app-server-control','app-server-control.sock');
  owned(path.dirname(alias),{directory:true});
  const expected=path.join(fs.realpathSync('/tmp'),`codex-daemon-${process.getuid()}`,createHash('sha256').update(alias).digest('hex'));
  if(fs.realpathSync(alias)!==expected)fail('managed_socket_scope_mismatch');
  owned(path.dirname(expected),{directory:true});const socket=owned(expected,{socket:true});
  if(socket.mode&0o077)fail('managed_socket_mode_invalid');
  const endpoints=command('/usr/sbin/lsof',['-a','-p',String(record.pid),'-U','-Fn']).split('\n').filter(l=>l.startsWith('n')).map(l=>l.slice(1));
  if(!endpoints.includes(expected))fail('managed_socket_owner_mismatch');
  const lock=owned(path.join(root,'thread-writer-locks',threadId+'.lock'));
  return {transport:'managed_app_server',home:root,threadId,writer_pid:record.pid,socketPath:expected,socketDev:socket.dev,socketIno:socket.ino,
    writerLock:{dev:lock.dev,ino:lock.ino,ctimeMs:lock.ctimeMs},record};
}
export function verifyManagedDescriptor(target,binding,resolve=resolveManagedDaemon) {
  if(target.threadId!==binding.codex_thread_id)fail('managed_thread_scope_mismatch');
  const live=resolve(target.home,target.threadId);
  if(!live || Object.keys(live).some(key=>!same(live[key],target[key])))fail('managed_target_changed');
}
export function managedTurnRequest(binding,thread,text) {
  if(thread?.id!==binding.codex_thread_id || thread.cwd!==binding.cwd || !Array.isArray(thread.turns))fail('managed_thread_scope_mismatch');
  const current=thread.turns.filter(turn=>turn.status==='inProgress');
  const params={threadId:binding.codex_thread_id,input:[{type:'text',text}]};
  if(thread.status?.type==='active') {
    if(current.length!==1 || typeof current[0].id!=='string' || !current[0].id.trim())fail('managed_active_turn_invalid');
    return {method:'turn/steer',params:{...params,expectedTurnId:current[0].id}};
  }
  if(thread.status?.type==='idle' && !current.length)return {method:'turn/start',params};
  fail('managed_thread_not_ready');
}
export async function withManagedThread(target,binding,action,{connect=connectManagedWebSocket,verify=verifyManagedDescriptor}={}) {
  verify(target,binding);const client=await connect(target.socketPath);
  try {
    verify(target,binding);
    await client.request('initialize',{clientInfo:{name:'feishu_codex_bridge',version:'1.0.0'}});
    client.notify('initialized',{});
    let cursor;const seen=new Set();let loaded=false;
    for(let i=0;i<100;i++){
      const page=await client.request('thread/loaded/list',{...(cursor?{cursor}:{})});
      if(!Array.isArray(page?.data))fail('managed_loaded_list_invalid');
      if(page.data.includes(binding.codex_thread_id)){loaded=true;break;}
      if(!page.nextCursor)break;
      if(typeof page.nextCursor!=='string' || seen.has(page.nextCursor))fail('managed_loaded_list_invalid');seen.add(page.nextCursor);cursor=page.nextCursor;
    }
    if(!loaded)fail('managed_thread_not_loaded');
    const result=await client.request('thread/read',{threadId:binding.codex_thread_id,includeTurns:true});
    managedTurnRequest(binding,result?.thread,''); // Validate exact root, cwd, and runtime state before submission.
    return await action(client,result.thread,()=>verify(target,binding));
  } finally {client.close();}
}
export async function inspectManagedThread(target,binding,options) {
  return withManagedThread(target,binding,async(_client,thread)=>({status:thread.status.type}),options);
}
export async function submitManagedTurn(target,binding,text,options) {
  return withManagedThread(target,binding,async(client,thread,reverify)=>{
    const request=managedTurnRequest(binding,thread,text);reverify();
    // Exactly one mutation attempt. Rejection, timeout or lost ACK never causes
    // a turn/start -> steer fallback or bypasses the durable rollout checkpoint.
    const result=await client.request(request.method,request.params);
    const id=request.method==='turn/steer'?result?.turnId:result?.turn?.id;
    if(typeof id!=='string' || !id.trim() || request.method==='turn/steer' && id!==request.params.expectedTurnId)fail('managed_submission_unconfirmed');
    return {transport:'managed_app_server',method:request.method};
  },options);
}

// Reuse transport/protocol initialization only. No PID/age cache grants trust:
// each operation verifies the complete live descriptor, reads the current
// thread, and every mutation verifies again immediately before sending once.
export class ManagedConnection {
  constructor({connect=connectManagedWebSocket,verify=verifyManagedDescriptor}={}) {
    this.connect=connect;this.verify=verify;this.tail=Promise.resolve();this.entry=null;this.stopped=false;
  }
  discard() {const entry=this.entry;this.entry=null;entry?.client.close();}
  close() {this.stopped=true;this.discard();}
  withThread(target,binding,action) {
    const operation=this.tail.then(async()=>{
      if(this.stopped)fail('managed_client_closed');
      try {
        this.verify(target,binding);
        const scope={target,binding:{bot:binding.bot,threadId:binding.codex_thread_id,cwd:binding.cwd}};
        if(this.entry && (!same(this.entry.scope,scope) || this.entry.client.closed))this.discard();
        if(!this.entry) {
          const client=await this.connect(target.socketPath);
          // close() can race a pending connect; it must never leave a socket or
          // permit queued work to initialize or mutate during shutdown.
          if(this.stopped){client.close();fail('managed_client_closed');}
          this.entry={scope:structuredClone(scope),client};
          this.verify(target,binding);
          await client.request('initialize',{clientInfo:{name:'feishu_codex_bridge',version:'1.0.0'}});
          client.notify('initialized',{});
        }
        const client=this.entry.client;
        // thread/read alone may return persisted history after unloading. Keep
        // current loaded membership authoritative instead of caching it.
        let cursor,loaded=false;const seen=new Set();
        for(let i=0;i<100;i++) {
          const page=await client.request('thread/loaded/list',{...(cursor?{cursor}:{})});
          if(!Array.isArray(page?.data))fail('managed_loaded_list_invalid');
          if(page.data.includes(binding.codex_thread_id)){loaded=true;break;}
          if(!page.nextCursor)break;
          if(typeof page.nextCursor!=='string' || seen.has(page.nextCursor))fail('managed_loaded_list_invalid');
          seen.add(page.nextCursor);cursor=page.nextCursor;
        }
        if(!loaded)fail('managed_thread_not_loaded');
        const result=await client.request('thread/read',{threadId:binding.codex_thread_id,includeTurns:true});
        managedTurnRequest(binding,result?.thread,'');
        if(this.stopped)fail('managed_client_closed');
        return await action(client,result.thread,()=>{if(this.stopped)fail('managed_client_closed');this.verify(target,binding);});
      } catch(error) {
        // A subsequent independently checkpointed job may reconnect, but this
        // operation never reconnects/retries an RPC (especially unknown ACKs).
        this.discard();throw error;
      }
    });
    this.tail=operation.catch(()=>{});return operation;
  }
  inspect(target,binding) {return this.withThread(target,binding,async(_client,thread)=>({status:thread.status.type}));}
  submit(target,binding,text) {
    return this.withThread(target,binding,async(client,thread,reverify)=>{
      const request=managedTurnRequest(binding,thread,text);reverify();
      const result=await client.request(request.method,request.params);
      const id=request.method==='turn/steer'?result?.turnId:result?.turn?.id;
      if(typeof id!=='string' || !id.trim() || request.method==='turn/steer' && id!==request.params.expectedTurnId)fail('managed_submission_unconfirmed');
      return {transport:'managed_app_server',method:request.method};
    });
  }
}
