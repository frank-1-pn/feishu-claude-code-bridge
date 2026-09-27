// Explicitly invoked live test: one idle bot, bounded faults, existing daemon only.
// Private evidence stays in runtime/state; no message content or keys are printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify,parseArgs} from 'node:util';
import {createFaultRelay} from './feishu-network-probe.mjs';
import {atomicWriteJson} from '../daemon/codex-bridge-storage.mjs';
const {values}=parseArgs({options:{'runtime-dir':{type:'string'},bot:{type:'string'}}});
if(process.platform!=='win32' || !values['runtime-dir'] || !/^[a-zA-Z0-9_-]+$/.test(values.bot||''))throw new Error('Usage: node scripts/verify-feishu-network.mjs --runtime-dir <installed-daemon> --bot <idle-bot>');
const exec=promisify(execFile),runtime=path.resolve(values['runtime-dir']),bot=values.bot;
const bindings=JSON.parse(fs.readFileSync(path.join(runtime,'codex-thread-bindings.json'),'utf8'));
if(!bindings.bindings?.[bot])throw new Error('Unknown bot');
const profile=String(bindings.bindings[bot].profile||'');
const runId=new Date().toISOString().replaceAll(':','-');
const config=path.join(runtime,`state/network-probe-${bot}.json`);
const evidence=path.join(runtime,`state/network-acceptance-${runId}.json`);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const quote=s=>"'"+s.replaceAll("'","''")+"'";
async function ps(command){return (await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:30000,maxBuffer:2*1024*1024})).stdout;}
async function status(){try{return JSON.parse(await ps(`& ${quote(path.join(runtime,'status-codex-bridge.ps1'))}`));}catch(error){if(error.code===1 && error.stdout)return JSON.parse(error.stdout);throw error;}}
async function restart(){await ps(`$ErrorActionPreference='Stop'; . ${quote(path.join(runtime,'subscriber-health.ps1'))}; $n=[int][IO.File]::ReadAllText((Join-Path $env:TEMP 'lark-${bot}.pid')); $p=Get-CimInstance Win32_Process -Filter "ProcessId=$n"; if($p){if(-not (Test-LarkSubscriber $p ${quote(profile)})){throw 'Identity mismatch'}; & taskkill.exe /PID $n /T /F | Out-Null; if($LASTEXITCODE -ne 0){throw 'Stop failed'}}; & ${quote(path.join(runtime,'ensure-bot.ps1'))} -Bot ${quote(bot)} -Profile ${quote(profile)} -SkipSessionBinding`);}
function safeBot(s){const b=s.bots.find(b=>b.bot===bot);return {pid:b.daemon_pid,signal:b.socket_signal,verified:b.socket_verified,needs_restart:b.socket_needs_restart,pong_age_seconds:b.pong_age_seconds,interval:b.ping_interval_seconds};}
const record={started_at:new Date().toISOString(),events:[],passed:false,scope:`${bot} TLS network only; no machine-wide network change`};
function note(event,extra={}){const item={at:new Date().toISOString(),event,...extra};record.events.push(item);fs.writeFileSync(evidence,JSON.stringify(record,null,2));process.stdout.write(JSON.stringify(item)+'\n');}
async function waitFor(fn,ms){const end=Date.now()+ms;while(Date.now()<end){const s=await status();if(fn(s))return s;await pause(1500);}throw new Error('Acceptance stage timed out');}
const initial=await status();
if(!initial.transport_healthy || initial.bots.some(b=>b.queued_count || b.awaiting_delivery_count || b.awaiting_reply_count || b.reply_pending_count || b.failed_count))throw new Error('Requires healthy idle bots');
if(fs.existsSync(config))throw new Error('Existing diagnostic route must be inspected');
const otherPids=new Map(initial.bots.filter(b=>b.bot!==bot).map(b=>[b.bot,b.daemon_pid]));
const initialBridge=initial.bridge.pid;
const log=path.join(os.tmpdir(),`lark-${bot}-events.ndjson`);const prefix=fs.readFileSync(log);
const prefixHash=crypto.createHash('sha256').update(prefix).digest('hex');
const relay=await createFaultRelay({maxFaultMs:240000});let changed=false,leaseTimer;
const lease=()=>atomicWriteJson(config,{proxy:relay.url,expires_at_ms:Date.now()+45000});
try{
 const fd=fs.openSync(config,'wx');fs.closeSync(fd);changed=true;lease();
 leaseTimer=setInterval(()=>{try{lease();}catch{clearInterval(leaseTimer);}},10000);leaseTimer.unref();
 await restart();
 const positive=await waitFor(s=>safeBot(s).verified,30000);
 if(relay.stats.connections<1 || relay.stats.forwarded_bytes<1)throw new Error('Positive control bypassed relay');
 const old=safeBot(positive).pid;record.initial_subscriber_pid=old;
 note('positive_real_pong',{...safeBot(positive),relay_connections:relay.stats.connections});
 relay.blackhole(240000);const faultAt=Date.now();note('network_blackhole_enabled');
 let sawUnhealthy=false,sawDroppedAlive=false,lastLog=0,restarted;
 while(Date.now()-faultAt<230000){
  const s=await status(), b=safeBot(s);
  if(s.bridge.pid!==initialBridge || s.bots.some(b=>otherPids.has(b.bot)&&otherPids.get(b.bot)!==b.daemon_pid))throw new Error('Unrelated process changed during fault');
  if(relay.stats.dropped_bytes>0 && b.pid===old && !sawDroppedAlive){sawDroppedAlive=true;note('encrypted_bytes_dropped_process_still_alive',{...b,dropped_bytes:relay.stats.dropped_bytes});}
  if(b.needs_restart && !b.verified && !sawUnhealthy){sawUnhealthy=true;note('expired_heartbeat_detected',{...b,elapsed_seconds:Math.round((Date.now()-faultAt)/1000)});}
  if(b.pid!==old){restarted=s;note('scheduled_watchdog_replaced_subscriber',{...b,elapsed_seconds:Math.round((Date.now()-faultAt)/1000)});break;}
  if(Date.now()-lastLog>25000){lastLog=Date.now();note('fault_observation',{...b,dropped_bytes:relay.stats.dropped_bytes});}
  await pause(1500);
 }
 if(!restarted || !sawUnhealthy || !sawDroppedAlive)throw new Error('Missing silent-failure recovery evidence');
 relay.restore();note('network_restored');
 const recovered=await waitFor(s=>safeBot(s).verified && s.transport_healthy,160000);
 note('real_pong_after_automatic_recovery',{...safeBot(recovered),elapsed_seconds:Math.round((Date.now()-faultAt)/1000)});
 const after=fs.readFileSync(log);
 if(after.length<prefix.length || crypto.createHash('sha256').update(after.subarray(0,prefix.length)).digest('hex')!==prefixHash)throw new Error('Existing NDJSON prefix changed');
 record.passed=true;record.unrelated_bot_unchanged=true;record.bridge_unchanged=true;record.existing_event_bytes_preserved=true;
 record.relay_stats={...relay.stats};note('transport_acceptance_passed');
}catch(error){record.error='Network acceptance stage failed; inspect local private logs';note('acceptance_failed',{reason:record.error});process.exitCode=1;}
finally{
 clearInterval(leaseTimer);relay.restore();if(changed){fs.rmSync(config,{force:true});await restart();}
 await relay.close();
 const final=await waitFor(s=>s.transport_healthy,30000);
 note('cleanup_direct_connection_verified',{...safeBot(final),probe_config_removed:!fs.existsSync(config),transport_healthy:final.transport_healthy,delivery_healthy:final.delivery_healthy});
}
