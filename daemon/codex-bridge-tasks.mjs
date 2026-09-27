import fs from 'node:fs';
import path from 'node:path';
import {digest} from './codex-bridge-inbox.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {classifyFailure,recordFailure} from './codex-bridge-retry.mjs';

const invalid=code=>{throw Object.assign(Error(code),{permanent:true,code});};
const plain=value=>typeof value==='string'&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const taskLink=(value,guid)=>{
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port
    &&['applink.feishu.cn','applink.larkoffice.com'].includes(u.hostname)&&u.pathname.startsWith('/client/todo/')
    &&u.searchParams.get('guid')?.toLowerCase()===guid?.toLowerCase();}catch{return false;}
};
const sourceLink=value=>{
  try{if(typeof value!=='string'||value.length>2048)return null;const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port
    &&(u.hostname==='feishu.cn'||u.hostname.endsWith('.feishu.cn'))?u.href:null;}catch{return null;}
};
const safeCode=value=>/^[A-Za-z0-9_]{1,80}$/.test(String(value))?String(value):'task_create_failed';
function validateBinding(binding){
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(binding?.bot??'')||!/^oc_[A-Za-z0-9_-]+$/.test(binding.chat_id??'')
    ||!/^ou_[A-Za-z0-9_-]+$/.test(binding.allowed_sender_id??'')||typeof binding.codex_thread_id!=='string'||!binding.codex_thread_id
    ||(binding.profile!==undefined&&typeof binding.profile!=='string'))invalid('invalid_task_binding');
}

// Form times have one explicit timezone: Asia/Shanghai. Never let the process
// timezone or Date.parse's locale-dependent rules reinterpret user input.
export function taskDue(value='') {
  if(!plain(value))invalid('invalid_task_due');
  if(!value.trim())return undefined;
  const m=/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(value.trim());
  if(!m)invalid('invalid_task_due');
  const [,y,mo,d,h='00',mi='00']=m;
  const utc=Date.UTC(+y,+mo-1,+d,+h,+mi);const test=new Date(utc);
  if(+y<2000||+y>2100||test.getUTCFullYear()!==+y||test.getUTCMonth()!==+mo-1||test.getUTCDate()!==+d||+h>23||+mi>59)invalid('invalid_task_due');
  // All-day dates use UTC-day precision in Task v2; applying the local offset
  // would make the server truncate them to the preceding calendar date.
  return {timestamp:String(m[4] ? utc-8*3600000 : utc),is_all_day:!m[4]};
}

export function taskPayload(binding,values,key,{answer='',sourceUrl}={}) {
  validateBinding(binding);
  if(!object(values)||Object.keys(values).some(k=>!['summary','due','reminder'].includes(k)))invalid('invalid_task_fields');
  if(typeof key!=='string'||!key||!plain(answer)||answer.length>4*1024*1024)invalid('invalid_task_fields');
  const summary=typeof values.summary==='string'?values.summary.trim():undefined;
  if(!plain(summary)||!summary||Array.from(summary).length>200)invalid('invalid_task_summary');
  if(!plain(values.due??'')||!plain(values.reminder??'none'))invalid('invalid_task_fields');
  const due=taskDue(values.due??'');const reminder=values.reminder||'none';
  if(!['none','0','15','30','60'].includes(reminder)||(!due&&reminder!=='none'))invalid('invalid_task_reminder');
  const source=typeof sourceUrl==='string'?sourceLink(sourceUrl):null;
  const prefix='来自飞书 AI 答复，经本人确认创建。\n\n',suffix=source?'\n\n来源：'+source:'';
  const budget=2900-Array.from(prefix+suffix).length,chars=Array.from(answer);
  const excerpt=chars.length>budget?chars.slice(0,Math.max(0,budget-1)).join('')+'…':answer;
  const description=prefix+excerpt+suffix;
  return {summary,description,members:[{id:binding.allowed_sender_id,type:'user',role:'assignee'}],
    ...(due?{due}:{}),...(reminder==='none'?{}:{reminders:[{relative_fire_minute:Number(reminder)}]}),
    client_token:digest(key),extra:JSON.stringify({bridge_task:digest(key)})};
}

// Task client_token lasts only five minutes. Preserve the first attempt and
// exact payload; stop before expiry rather than silently creating another task.
export class NativeTasks {
  constructor({root,binding,request,now=Date.now}) {
    validateBinding(binding);if(typeof root!=='string'||!root||typeof request!=='function')invalid('invalid_task_store');
    Object.assign(this,{binding,request,now});this.scope=digest(JSON.stringify(bindingSnapshot(binding)));
    this.root=path.join(root,binding.bot,this.scope);fs.mkdirSync(this.root,{recursive:true});this.inflight=new Map();
  }
  create(args) {
    const key=args?.key;
    if(typeof key!=='string'||!key||key.length>300)return Promise.reject(Object.assign(Error('invalid_task_key'),{permanent:true,code:'invalid_task_key'}));
    // Serialize instead of sharing the old Promise: a concurrent caller changing
    // the payload must still pass the persisted-intention comparison.
    const promise=(this.inflight.get(key)??Promise.resolve()).catch(()=>{}).then(()=>this.perform(args));
    this.inflight.set(key,promise);
    return promise.finally(()=>{if(this.inflight.get(key)===promise)this.inflight.delete(key);});
  }
  async perform({key,values,answer,sourceUrl}) {
    if(typeof key!=='string'||!key||key.length>300)invalid('invalid_task_key');
    if(digest(JSON.stringify(bindingSnapshot(this.binding)))!==this.scope)invalid('task_binding_changed');
    const payload=taskPayload(this.binding,values,this.scope+'\0'+key,{answer,sourceUrl});
    const inputHash=digest(JSON.stringify({values,answer:answer??'',sourceUrl:sourceUrl??null}));
    const file=path.join(this.root,digest(key)+'.json');
    let state;
    if(fs.existsSync(file)){
      try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{invalid('task_state_corrupt');}
      if(!object(state)||state.schema!==1||state.scope!==this.scope||state.keyHash!==digest(key)
        ||!['pending','done','blocked','uncertain'].includes(state.status)||!Number.isFinite(state.createdAt)
        ||state.createdAt<0||state.createdAt>this.now()
        ||(state.firstAttemptAt!==undefined&&(!Number.isFinite(state.firstAttemptAt)||state.firstAttemptAt<state.createdAt||state.firstAttemptAt>this.now()))
        ||(['pending','done','blocked','uncertain'].includes(state.status)&&state.firstAttemptAt===undefined)
        ||(state.retryAt!==undefined&&state.retryAt!==null&&!Number.isFinite(state.retryAt))
        ||(state.status==='done'&&(!uuid(state.guid)||!taskLink(state.url,state.guid))))invalid('task_state_invalid');
    }else state={schema:1,scope:this.scope,keyHash:digest(key),inputHash,status:'queued',payload,createdAt:this.now()};
    if(state.inputHash!==inputHash||JSON.stringify(state.payload)!==JSON.stringify(payload))invalid('task_payload_changed');
    if(['done','blocked','uncertain'].includes(state.status))return state;
    if(state.firstAttemptAt!==undefined&&this.now()-state.firstAttemptAt>=240000){
      state.status='uncertain';state.error='task_result_needs_verification';atomicWriteJson(file,state);return state;
    }
    if((state.retryAt??0)>this.now())return state;
    state.firstAttemptAt??=this.now();state.status='pending';atomicWriteJson(file,state);
    try {
      const result=await this.request(this.binding,['task','tasks','create','--params',JSON.stringify({user_id_type:'open_id'}),'--data',JSON.stringify(state.payload)]);
      const task=result.task;
      if(!uuid(task?.guid)||!taskLink(task?.url,task.guid))throw Object.assign(Error('task_response_invalid'),{code:'INVALID_TASK_RESPONSE'});
      state.status='done';state.guid=task.guid;state.url=task.url;state.completedAt=this.now();delete state.error;delete state.retryAt;
    } catch(error) {
      const code=safeCode(error.apiCode??error.code??'transport_error');
      recordFailure(state,Object.assign(Error('task_create_failed'),{apiCode:code,permanent:classifyFailure(error).kind==='permanent'||['1470400','1470403','1470404'].includes(code)}),this.now());
      state.status=state.blocked?'blocked':'pending';
    }
    atomicWriteJson(file,state);return state;
  }
}

export const TASK_FORM_FIELDS=[
  {name:'summary',label:'待办事项（负责人：你自己）',type:'text',required:true,maxLength:200},
  {name:'due',label:'截止时间（北京时间，YYYY-MM-DD HH:mm；可留空）',type:'text',required:false,maxLength:16},
  {name:'reminder',label:'提前提醒（设置提醒时必须填写截止时间）',type:'select',required:false,options:[
    {value:'none',label:'不提醒'},{value:'0',label:'到期时'},{value:'15',label:'提前 15 分钟'},{value:'30',label:'提前 30 分钟'},{value:'60',label:'提前 1 小时'}]},
];
