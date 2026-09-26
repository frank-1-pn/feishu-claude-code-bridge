// Run only while the bridge worker is stopped. Does not touch subscribe daemons.
// Reconciles recent authorized messages with the old seen journal and rollout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableInbox, digest } from './codex-bridge-inbox.mjs';
const configPath=process.argv[2];
if(!configPath)throw Error('Usage: node migrate-codex-inbox.mjs <bindings.json> [--apply]');
const apply=process.argv.includes('--apply');
const config=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));
const root=path.join(path.dirname(configPath),'state','codex-inbox-v2');
const state=path.join(os.tmpdir(),'lark-codex-bridge');
const load=(file)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}};
const seen=load(path.join(state,'seen-events.json'));
const receipts=load(path.join(state,'receipt-events.json'));
function findRollout(root,thread){
  const dirs=[root];const found=[];
  while(dirs.length){const d=dirs.pop();for(const e of fs.readdirSync(d,{withFileTypes:true})){
    const p=path.join(d,e.name);if(e.isDirectory())dirs.push(p);else if(e.name.endsWith(`-${thread}.jsonl`))found.push(p);
  }}
  if(found.length!==1)throw Error('Expected exactly one rollout per bound thread');return found[0];
}
for(const [bot,binding] of Object.entries(config.bindings)){
  const log=path.join(os.tmpdir(),`lark-${bot}-events.ndjson`);
  if(!fs.existsSync(log))continue;
  const events=[];
  for(const line of fs.readFileSync(log,'utf8').split('\n')){
    let e;try{e=JSON.parse(line);}catch{continue;}
    if(e.type!=='im.message.receive_v1'||e.chat_id!==binding.chat_id||e.sender_id!==binding.allowed_sender_id)continue;
    if(Date.now()-Number(e.create_time)>config.runtime.max_event_age_ms||seen.includes(e.message_id??e.id))continue;
    events.push(e);
  }
  const rollout=findRollout(path.join(config.runtime.codex_home,'sessions'),binding.codex_thread_id);
  const markers=new Map();const markerCounts=new Map();let offset=0;
  let pending=Buffer.alloc(0);
  for await(const chunk of fs.createReadStream(rollout)){
    pending=Buffer.concat([pending,chunk]);
    for(;;){
      const end=pending.indexOf(10);if(end<0)break;
      const bytes=pending.subarray(0,end+1);const line=bytes.toString('utf8');
      if(line.includes('\u98de\u4e66\u6d88\u606f')){
        let item;try{item=JSON.parse(line);}catch{}
        if(item?.type==='response_item'&&item.payload?.role==='user'){
          for(const e of events){const id=e.message_id??e.id;if(JSON.stringify(item.payload.content).includes(`[\u98de\u4e66\u6d88\u606f\uff5c${bot}\uff5c${id}]`)){
            if(!markers.has(id))markers.set(id,offset);
            markerCounts.set(id,(markerCounts.get(id)??0)+1);
          }}
        }
      }
      offset+=bytes.length;pending=pending.subarray(end+1);
    }
  }
  const inbox=apply?new DurableInbox(root,bot,{}):null;
  const report=[];
  for(const e of events){
    const id=e.message_id??e.id;
    const outbox=path.join(state,`outbox-${bot}-${id}.txt`);
    const status=fs.existsSync(outbox)?'reply_pending':markers.has(id)?'submitted':'queued';
    report.push({messageId:id,type:e.message_type,status,markerCount:markerCounts.get(id)??0});
    if(!apply)continue;
    if(inbox.jobs.has(id)){
      const existing=inbox.jobs.get(id);
      if(process.argv.includes('--reconcile') && markers.has(id) && ['queued','submitted'].includes(existing.status)){
        existing.status='submitted';existing.rollout=rollout;existing.cursor=markers.get(id);existing.submittedAt=Number(e.create_time)||Date.now();inbox.save(existing);
      }
      continue;
    }
    const j=inbox.enqueue(e);j.receipted=receipts.includes(id);
    if(status==='reply_pending'){
      j.status=status;j.reply=fs.readFileSync(outbox,'utf8');j.replyKey=digest(`legacy:${bot}:${id}`);
    }else if(status==='submitted'){
      j.status=status;j.rollout=rollout;j.cursor=markers.get(id);j.submittedAt=Number(e.create_time)||Date.now();
    }
    inbox.save(j);
  }
  console.log(JSON.stringify({bot,apply,messages:report}));
}
