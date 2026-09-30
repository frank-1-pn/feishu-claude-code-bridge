import {randomUUID} from 'node:crypto';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));const command=process.argv[2]||'status';
const bindingPath=process.argv[3]||path.join(root,'codex-thread-bindings.json');
const config=fs.existsSync(bindingPath)?JSON.parse(fs.readFileSync(bindingPath,'utf8')):null;
const domain=`gui/${process.getuid()}`;const agents=path.join(os.homedir(),'Library/LaunchAgents');
const label=bot=>`com.frank.feishu.codex.${bot}`;
const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const labels=['watchdog','bridge',...Object.keys(config?.bindings||{})];
function servicePlist(name,args){
 const logs=path.join(root,'state/logs');fs.mkdirSync(logs,{recursive:true,mode:0o700});
 return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label(name))}</string><key>ProgramArguments</key><array>${args.map(v=>`<string>${xml(v)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path.dirname(process.execPath))}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin</string><key>TMPDIR</key><string>${xml(fs.realpathSync(os.tmpdir()))}</string><key>LARK_CLI_NO_PROXY</key><string>1</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(path.join(logs,name+'.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(logs,name+'.stderr'))}</string></dict></plist>`;
}
if(command==='check'||command==='start'||command==='harden'){
 if(!config)throw Error('bindings_not_configured');
 execFileSync(process.execPath,[path.join(root,'codex-bridge-worker.mjs'),'--bindings',bindingPath,'--check-config'],{stdio:'inherit'});
 if(command==='harden'){
  fs.mkdirSync(agents,{recursive:true});const file=path.join(agents,label('watchdog')+'.plist');
  fs.writeFileSync(file,servicePlist('watchdog',[process.execPath,path.join(root,'macos-watchdog.mjs'),bindingPath]),{mode:0o600});
  if(spawnSync('launchctl',['print',`${domain}/${label('watchdog')}`],{stdio:'ignore'}).status!==0)execFileSync('launchctl',['bootstrap',domain,file]);
 }
 if(command==='start'){
  fs.mkdirSync(agents,{recursive:true});
  const events=path.join(root,'state/events');fs.mkdirSync(events,{recursive:true,mode:0o700});
  for(const bot of Object.keys(config.bindings)){const file=path.join(events,`${bot}.ndjson`);fs.closeSync(fs.openSync(file,'a',0o600));const offset=path.join(fs.realpathSync(os.tmpdir()),`lark-${bot}-codex.offset`);if(!fs.existsSync(offset))fs.writeFileSync(offset,String(fs.statSync(file).size),{mode:0o600});}
  for(const name of labels.filter(n=>n!=='watchdog')){
   const target=`${domain}/${label(name)}`;if(spawnSync('launchctl',['print',target],{stdio:'ignore'}).status===0)continue;
   const args=name==='bridge'?[process.execPath,path.join(root,'codex-bridge-worker.mjs'),'--bindings',bindingPath,'--instance',randomUUID()]:[process.execPath,path.join(root,'macos-subscriber.mjs'),bindingPath,name];
   const file=path.join(agents,label(name)+'.plist');fs.writeFileSync(file,servicePlist(name,args),{mode:0o600});execFileSync('launchctl',['bootstrap',domain,file]);
  }
 }
}else if(command==='stop'){
 for(const name of labels){spawnSync('launchctl',['bootout',`${domain}/${label(name)}`],{stdio:'ignore'});fs.rmSync(path.join(agents,label(name)+'.plist'),{force:true});}
}else if(command==='status'){
 console.log(JSON.stringify({configured:!!config,services:labels.map(name=>({name,loaded:spawnSync('launchctl',['print',`${domain}/${label(name)}`],{stdio:'ignore'}).status===0})),transport_verified:false,note:'consumer readiness and process presence do not prove fresh SDK pong or end-to-end delivery'},null,2));
}else throw Error('expected check|start|stop|status');
