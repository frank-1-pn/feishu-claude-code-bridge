import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {normalizeCallback} from './macos-event-adapter.mjs';
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const bot=process.argv[3],binding=config.bindings[bot];
if(!binding||!/^[\w-]+$/.test(bot))throw Error('invalid_bot');
const root=path.dirname(process.argv[2]);const events=path.join(root,'state/events');fs.mkdirSync(events,{recursive:true,mode:0o700});
const log=path.join(events,`${bot}.ndjson`);fs.closeSync(fs.openSync(log,'a',0o600));const status=path.join(events,`${bot}.subscriber.json`);const children=new Set();let stopping=false;
const states={};
const heartbeat=setInterval(publish,15000);
function publish(){const tmp=status+'.tmp';fs.writeFileSync(tmp,JSON.stringify({pid:process.pid,checked_at:new Date().toISOString(),consumers:states}),{mode:0o600});fs.renameSync(tmp,status);}
async function consume(key){
 while(!stopping){
  const child=spawn(config.runtime.subscriber_cli_exe||config.runtime.lark_cli_exe,[...(binding.profile?['--profile',binding.profile]:[]),'event','consume',key,'--as','bot'],{stdio:['pipe','pipe','pipe'],env:{...process.env,LARK_CLI_NO_PROXY:'1',LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARK_BRIDGE_WS_HEALTH_FILE:path.join(events,`${bot}.ws-health.json`),LARK_BRIDGE_PROFILE:binding.profile||''}});children.add(child);states[key]={ready:false,pid:child.pid};publish();
  createInterface({input:child.stderr}).on('line',line=>{
   if(line.startsWith('[event] ready event_key=')){states[key].ready=true;publish();}
   else if(line.startsWith('{'))try{const e=JSON.parse(line).error;states[key].error={type:e?.type,subtype:e?.subtype};publish();}catch{}
  });
  createInterface({input:child.stdout}).on('line',line=>{try{const event=normalizeCallback(JSON.parse(line));fs.appendFileSync(log,JSON.stringify(event)+'\n',{mode:0o600});}catch{states[key].invalid_event_count=(states[key].invalid_event_count||0)+1;publish();}});
  await new Promise(resolve=>{child.once('error',()=>{states[key].error={type:'spawn_failed'};resolve();});child.once('close',resolve);});children.delete(child);states[key].ready=false;publish();
  if(!stopping)await new Promise(r=>setTimeout(r,5000));
 }
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;clearInterval(heartbeat);for(const child of children){child.stdin.end();setTimeout(()=>{if(child.exitCode===null)child.kill('SIGTERM');},5000).unref();}});
// Multiple consumers reuse one CLI bus; no extra WebSocket subscriber is created.
await Promise.all(['im.message.receive_v1','card.action.trigger'].map(consume));clearInterval(heartbeat);
