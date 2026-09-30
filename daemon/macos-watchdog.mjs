import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import {spawn,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {workerHealth,busHealth,retryDelay,socketHealth} from './macos-health.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));const bindingPath=process.argv[2]||path.join(root,'codex-thread-bindings.json');let config=JSON.parse(fs.readFileSync(bindingPath,'utf8'));
const state=path.join(root,'state');fs.mkdirSync(state,{recursive:true,mode:0o700});const tmp=fs.realpathSync(os.tmpdir());const owned=new Set();const failures=new Map(),next=new Map();let stopping=false;
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
function identity(pid,script){if(!Number.isInteger(pid)||pid<2)return false;const p=spawnSync('/bin/ps',['-p',String(pid),'-o','args='],{encoding:'utf8'});return p.status===0&&p.stdout.includes(path.join(root,script));}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function emit(event,fields={}){process.stdout.write(JSON.stringify({at:new Date().toISOString(),event,...fields})+'\n');}
function restart(key,script,args,pid){
 if(Date.now()<(next.get(key)||0))return;
 if(pid&&identity(pid,script)){process.kill(pid,'SIGTERM');next.set(key,Date.now()+5000);emit('graceful_recovery_requested',{component:key});return;}
 const n=(failures.get(key)||0)+1;failures.set(key,n);next.set(key,Date.now()+retryDelay(n));
 const logs=path.join(state,'logs');fs.mkdirSync(logs,{recursive:true,mode:0o700});const out=fs.openSync(path.join(logs,key+'.log'),'a',0o600),err=fs.openSync(path.join(logs,key+'.stderr'),'a',0o600);
 const child=spawn(process.execPath,[path.join(root,script),...args],{cwd:root,stdio:['ignore',out,err],env:{...process.env,TMPDIR:tmp,LARK_CLI_NO_PROXY:'1'}});fs.closeSync(out);fs.closeSync(err);owned.add(child);child.once('error',()=>emit('component_spawn_failed',{component:key}));child.once('exit',()=>owned.delete(child));emit('component_started',{component:key,pid:child.pid});
}
let busLastCheck=0,buses={};const missingSince=new Map();const recovering=new Map();const busIdentities={};
function tick(){
 const now=Date.now();config=JSON.parse(fs.readFileSync(bindingPath,'utf8'));
 if(now-busLastCheck>30000){
  busLastCheck=now;buses={};
  for(const [bot,binding] of Object.entries(config.bindings)){
   const r=spawnSync(config.runtime.lark_cli_exe,[...(binding.profile?['--profile',binding.profile]:[]),'event','status','--current','--json'],{encoding:'utf8',timeout:10000,maxBuffer:1048576});
   try{const result=JSON.parse(r.stdout);const app=result.apps?.[0];busIdentities[bot]=app?.running?{pid:app.pid,startedAt:now-app.uptime_sec*1000}:null;buses[bot]=r.status===0?busHealth(result):{healthy:false,reason:'status_probe_failed'};}catch{buses[bot]={healthy:false,reason:'status_probe_failed'};}
  }
 }
 const subscriberStates={};
 for(const [bot] of Object.entries(config.bindings)){
  const s=read(path.join(state,'events',bot+'.subscriber.json'));const valid=identity(s?.pid,'macos-subscriber.mjs');
  const bus=busIdentities[bot];const socket=config.runtime.ws_health_required&&bus?socketHealth(read(path.join(state,'events',bot+'.ws-health.json')),{...bus,profile:config.bindings[bot].profile||'',now}):{verified:false,needs_restart:false,reason:'not_instrumented'};
  subscriberStates[bot]={process_healthy:valid,bus:buses[bot],socket};
  if(socket.needs_restart&&!recovering.has(bot)){recovering.set(bot,{pid:bus.pid});if(valid)process.kill(s.pid,'SIGTERM');emit('socket_recovery_requested',{component:bot,reason:socket.reason});}
  if(recovering.has(bot)){
   if(valid)continue;
   const b=spawnSync(config.runtime.lark_cli_exe,[...(config.bindings[bot].profile?['--profile',config.bindings[bot].profile]:[]),'event','stop','--json'],{encoding:'utf8',timeout:10000});
   if(b.status!==0)continue;recovering.delete(bot);next.delete('subscriber-'+bot);restart('subscriber-'+bot,'macos-subscriber.mjs',[bindingPath,bot],null);continue;
  }
  // A partial card permission failure must not restart working message intake.
  if(!valid)restart('subscriber-'+bot,'macos-subscriber.mjs',[bindingPath,bot],null);
  else if(buses[bot]?.healthy){failures.set('subscriber-'+bot,0);next.delete('subscriber-'+bot);missingSince.delete(bot);}
  else if(buses[bot]?.reason==='bus_missing'){missingSince.set(bot,missingSince.get(bot)||now);if(now-missingSince.get(bot)>60000)restart('subscriber-'+bot,'macos-subscriber.mjs',[bindingPath,bot],s.pid);}
 }
 const s=read(path.join(tmp,'lark-codex-bridge.status.json'));const valid=identity(s?.pid,'codex-bridge-worker.mjs');
 const health=workerHealth(s,{now,alive:alive(s?.pid),identity:valid});
 if(!health.healthy)restart('bridge','codex-bridge-worker.mjs',['--bindings',bindingPath,'--instance',randomUUID()],valid?s.pid:null);
 else{failures.set('bridge',0);next.delete('bridge');}
 const file=path.join(state,'macos-watchdog.status.json');fs.writeFileSync(file+'.tmp',JSON.stringify({checked_at:new Date().toISOString(),pid:process.pid,bridge:health,subscribers:subscriberStates,socket_verified:Object.values(subscriberStates).length>0&&Object.values(subscriberStates).every(s=>s.socket.verified)}),{mode:0o600});fs.renameSync(file+'.tmp',file);
}
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{stopping=true;for(const child of owned)child.kill('SIGTERM');});
while(!stopping){try{tick();}catch{emit('health_check_failed');}await new Promise(r=>setTimeout(r,5000));}
