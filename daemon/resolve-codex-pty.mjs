import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {activeCodexWriters,resolveManagedDaemon} from './codex-managed-app-server.mjs';
import {fileURLToPath} from 'node:url';
export function selectWriterPty(writers, processes, sessions) {
  const parents=new Map(processes.map(p=>[p.pid,p.ppid])); const matches=[];
  for(const writer of writers) {
    const ancestors=new Set();let cursor=writer;
    for(let depth=0;depth<64&&cursor>1&&!ancestors.has(cursor);depth++){ancestors.add(cursor);cursor=parents.get(cursor);}
    for(const session of sessions) if(session.isAlive&&ancestors.has(session.pid)) matches.push({writer_pid:writer,pty_pid:session.pid,pty_session_id:session.sessionId});
  }
  if(matches.length!==1)throw Error(matches.length?'writer_pty_ambiguous':'writer_pty_not_found');
  return matches[0];
}
export function resolve(args) {
  const thread=args['--thread-id'],home=args['--codex-home'];
  if(!/^[a-f0-9-]{36}$/i.test(thread||'')||!path.isAbsolute(home||''))throw Error('invalid_resolver_arguments');
  const writers=activeCodexWriters(home,thread);
  if(!writers.length)return {ok:true,active_writer:false};
  const managed=resolveManagedDaemon(home,thread,writers);
  if(managed)return {ok:true,active_writer:true,...managed};
  const processes=execFileSync('/bin/ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(s=>{const [pid,ppid]=s.trim().split(/\s+/).map(Number);return {pid,ppid};});
  const sessions=JSON.parse(execFileSync(process.execPath,[args['--rpc-script'],'--mode','list'],{encoding:'utf8'})).sessions;
  return {ok:true,active_writer:true,...selectWriterPty(writers,processes,sessions)};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try { const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i]]=process.argv[i+1];console.log(JSON.stringify(resolve(args))); }
  catch {console.log(JSON.stringify({ok:false,error:'writer_resolution_failed'}));process.exitCode=2;}
}
