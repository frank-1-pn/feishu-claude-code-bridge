import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {normalizeEvent} from './codex-bridge-inbox.mjs';
import {isBoundJob} from './codex-bridge-ux.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const ZONE = 'Australia/Brisbane';
const errors = new Set(['timeout','unavailable','cli_failed','invalid_json','upstream_failed','invalid_response','incomplete_pagination','page_limit','missing_event_id','invalid_arguments']);
const invalid = () => { throw new Error('invalid_response'); };
const keys = (o, allowed) => o && typeof o==='object' && !Array.isArray(o) && Object.keys(o).every(k=>allowed.includes(k));
const dateValid = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d+'T00:00:00Z')) && new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
const stamp = e => Number(e.create_time ?? e.timestamp);
const localDay = (ms,zone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

// This is a read optimization, never an intake filter or classifier. Any
// ambiguity (including a reply/attachment) is left to the original session.
export function parseSingleDayQuery(event, timezone=ZONE) {
  if(timezone!==ZONE || event.message_type!=='text' || event.synthetic_callback || event.parent_id || event.root_id
      || event.attachments?.length || event.attachmentPreparationError || event.nativeContext || event.bridge_native_context)return null;
  if(!Number.isFinite(stamp(event)) || stamp(event)<100000000000 || !Number.isFinite(new Date(stamp(event)).getTime()))return null;
  if(typeof event.content==='object' && !keys(event.content,['text']))return null;
  if(typeof event.content==='string' && event.content.trim().startsWith('{')) {
    try { if(!keys(JSON.parse(event.content),['text']))return null; } catch { return null; }
  }
  const text=normalizeEvent(event).text.trim();
  const match=/^(?:请\s*)?(?:帮我\s*)?(?:查一下|查询|查看|查)\s*(今天|明天|后天|\d{4}-\d{2}-\d{2}|(?:\d{4}年)?\d{1,2}月\d{1,2}[日号])\s*的?\s*(?:安排|日程|行程)\s*[？?。]?$/u.exec(text);
  if(!match)return null;
  const original=localDay(stamp(event),timezone), token=match[1];
  let day;
  if(['今天','明天','后天'].includes(token)) {
    day=new Date(Date.parse(original+'T00:00:00Z')+['今天','明天','后天'].indexOf(token)*86400000).toISOString().slice(0,10);
  } else if(token.includes('-'))day=token;
  else {
    const m=/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]$/u.exec(token);
    day=`${m[1]??original.slice(0,4)}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  }
  return dateValid(day)?{operation:'agenda',date:day,timezone}:null;
}

export function validateReadonlyConfig(binding) {
  const c=binding.readonly_prefetch;
  if(c===undefined)return null;
  if(!keys(c,['version','enabled','helper_path','helper_sha256','timezone','timeout_ms','max_age_ms']) || c.version!==1 || typeof c.enabled!=='boolean')throw new Error('invalid_readonly_prefetch_config');
  if(!c.enabled)return null;
  if(binding.group_access!=='all_group_humans' || c.timezone!==ZONE || typeof binding.profile!=='string' || !binding.profile || binding.profile.startsWith('-')
      || !path.isAbsolute(c.helper_path??'') || !/^[a-f0-9]{64}$/.test(c.helper_sha256??'')
      || !Number.isInteger(c.timeout_ms??5000) || (c.timeout_ms??5000)<500 || (c.timeout_ms??5000)>10000
      || !Number.isInteger(c.max_age_ms??30000) || (c.max_age_ms??30000)<1000 || (c.max_age_ms??30000)>60000)throw new Error('invalid_readonly_prefetch_config');
  return {...c,timeout_ms:c.timeout_ms??5000,max_age_ms:c.max_age_ms??30000};
}

export function readonlyEligible(binding,event) {
  try { return !!validateReadonlyConfig(binding) && !!event.bridge_binding && isBoundJob(binding,{event})
    && /^om_[A-Za-z0-9_-]+$/.test(event.message_id??event.id??'') && !!parseSingleDayQuery(event); }
  catch { return false; }
}

export function readonlyScope(binding,event) {
  return hash(JSON.stringify([binding.bot,binding.profile,binding.chat_id,binding.codex_thread_id,binding.cwd,
    binding.allowed_sender_id,binding.group_access,binding.bot_open_id,binding.readonly_prefetch,
    event.message_id??event.id,event.sender_id,event.chat_id,stamp(event),event.parent_id??'',event.root_id??'',normalizeEvent(event).text]));
}

function helperFile(binding,c) {
  const root=fs.realpathSync(binding.cwd), real=fs.realpathSync(c.helper_path), rel=path.relative(root,real);
  if(rel==='..' || rel.startsWith('..'+path.sep) || path.isAbsolute(rel) || !fs.lstatSync(c.helper_path).isFile()
      || !fs.statSync(real).isFile() || fs.statSync(real).size>1024*1024)throw new Error('helper_invalid');
  if(hash(fs.readFileSync(real))!==c.helper_sha256)throw new Error('helper_invalid');
  return real;
}

export function readonlyArgv(binding,c,query,helper) {
  return [helper,'--profile',binding.profile,'--timezone',query.timezone,'--timeout',String(c.timeout_ms/1000),
    '--workers','4','agenda','--date',query.date,'--calendar-id','primary','--attendees'];
}

// Child output and stderr are never logged. On POSIX, terminate the entire
// process group so Python's CLI children cannot linger beyond this read budget.
export function runReadonlyHelper(file,args,{cwd,timeoutMs,children=new Set()}={}) {
  return new Promise(resolve=>{
    let child,chunks=[],bytes=0,settled=false,timer;
    const stop=()=>{try { if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL'); } catch {} };
    const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);children.delete(child);resolve(result);};
    try {child=spawn(file,args,{cwd,env:{...process.env,LARK_CLI_NO_PROXY:'1'},stdio:['ignore','pipe','ignore'],windowsHide:true,detached:process.platform!=='win32'});} catch {finish({error:'unavailable'});return;}
    children.add(child);
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144){stop();finish({error:'invalid_response'});}else chunks.push(chunk);});
    child.once('error',()=>finish({error:'unavailable'}));
    child.once('close',code=>finish({code,stdout:Buffer.concat(chunks).toString('utf8')}));
    timer=setTimeout(()=>{stop();finish({error:'timeout'});},timeoutMs);
  });
}

export function projectReadonlyResult(value,query) {
  if(!keys(value,['operation','date','timezone','status','events','error']) || value.operation!=='agenda' || value.date!==query.date
      || value.timezone!==query.timezone || !['complete','partial','failed'].includes(value.status) || !Array.isArray(value.events) || value.events.length>200)invalid();
  if(value.status!=='complete')throw new Error(value.status==='partial'?'partial':errors.has(value.error)?value.error:'invalid_response');
  if('error' in value)invalid();
  const times=t=>typeof t==='string' && (dateValid(t) || dateValid(t.slice(0,10))
    && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?\+10:00$/.test(t) && Number.isFinite(Date.parse(t)));
  const safeTitle=t=>typeof t==='string' && t.length<=240 && !/[\x00-\x1f\x7f]/.test(t)
    && !/(?:https?:\/\/|\b(?:ou_|oc_|om_|cli_)[A-Za-z0-9_-]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b[A-Za-z0-9_-]{32,}\b)/u.test(t);
  const events=value.events.map(e=>{
    if(!keys(e,['title','status','start','end','participants_complete','participants']) || !safeTitle(e.title) || !['confirmed','tentative','cancelled','unknown'].includes(e.status)
        || !times(e.start) || !times(e.end) || Date.parse(e.end)<Date.parse(e.start) || e.participants_complete!==true || !Array.isArray(e.participants) || e.participants.length>1000)invalid();
    const participants=e.participants.map((p,i)=>{
      if(!keys(p,['participant','type','rsvp']) || p.participant!==i+1 || !['user','resource','chat','third_party','unknown'].includes(p.type)
          || !['accept','decline','tentative','needs_action','unknown'].includes(p.rsvp))invalid();
      return {participant:p.participant,type:p.type,rsvp:p.rsvp};
    });
    return {title:e.title,status:e.status,start:e.start,end:e.end,participants_complete:true,participants};
  });
  return {...query,status:'complete',events};
}

export async function prefetchReadonly(binding,event,{now=Date.now,run=runReadonlyHelper,children}={}) {
  if(!readonlyEligible(binding,event))return null;
  const c=validateReadonlyConfig(binding), query=parseSingleDayQuery(event), startedAt=now();
  const base={version:1,scope:readonlyScope(binding,event),startedAt};
  try {
    const helper=helperFile(binding,c);
    const raw=await run('python3',readonlyArgv(binding,c,query,helper),{cwd:binding.cwd,timeoutMs:c.timeout_ms,children});
    if(raw.error)throw new Error(errors.has(raw.error)?raw.error:'unavailable');
    let value;try {value=JSON.parse(raw.stdout);}catch {throw new Error('invalid_json');}
    const result=projectReadonlyResult(value,query);
    if(raw.code!==0)throw new Error('cli_failed');
    const fetchedAt=now();
    if(fetchedAt-startedAt>c.timeout_ms)throw new Error('timeout');
    return {...base,fetchedAt,status:'complete',result};
  } catch(error) {
    return {...base,fetchedAt:now(),status:'fallback',error:['helper_invalid','partial',...errors].includes(error.message)?error.message:'unavailable'};
  }
}

export async function prepareReadonlyInput(binding,event,prepare,options={}) {
  const [prepared,read]=await Promise.all([prepare(event),prefetchReadonly(binding,event,options)]);
  const result={...prepared};
  // Never forward an inbound claim of trusted runtime data, even if its fields
  // happen to match this source. Only this invocation may attach a new result.
  delete result.bridgeReadonly;
  if(read)result.bridgeReadonly=read;
  return result;
}

export function verifiedReadonly(binding,event,now=Date.now()) {
  const r=event.bridgeReadonly;
  if(!r)return null;
  if(!readonlyEligible(binding,event) || r.version!==1 || r.scope!==readonlyScope(binding,event))return {error:'scope_mismatch'};
  const c=validateReadonlyConfig(binding);
  if(!Number.isFinite(r.fetchedAt) || !Number.isFinite(r.startedAt) || r.fetchedAt<r.startedAt || now<r.fetchedAt || now-r.fetchedAt>c.max_age_ms)return {error:'stale'};
  if(r.status!=='complete')return {error:['helper_invalid','partial',...errors].includes(r.error)?r.error:'unavailable'};
  try {return {result:projectReadonlyResult(r.result,parseSingleDayQuery(event)),fetchedAt:r.fetchedAt};}
  catch {return {error:'invalid_response'};}
}
