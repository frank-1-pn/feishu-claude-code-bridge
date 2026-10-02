import fs from 'node:fs';
import path from 'node:path';
import {createHmac,randomBytes} from 'node:crypto';
import {digest,normalizeEvent} from './codex-bridge-inbox.mjs';
import {bindingSnapshot,isBoundJob} from './codex-bridge-ux.mjs';
import {isAuthorizedMessage} from './codex-bridge-authorization.mjs';
import {normalizeActionCallback} from './codex-bridge-actions.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';
import {stableJson,backgroundBudget,privateDirectory,privateRead,readBackgroundJson,publishBackgroundJson,readBackgroundTask,
  validateBackgroundTaskSource,cancelBackgroundTask} from './codex-bridge-background-store.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const messageId=id=>typeof id==='string' && /^om_[A-Za-z0-9_-]+$/.test(id);
const taskId=id=>typeof id==='string' && /^[a-f0-9]{64}$/.test(id);
const same=(a,b)=>stableJson(a)===stableJson(b);
const ended=new Set(['completed','failed','cancelled','timed_out']);
const labels={queued:'排队中',claimed:'已认领，启动待确认',running:'运行中',completed:'已完成，草稿待审查',failed:'失败',
  cancelled:'已停止',timed_out:'超时结束',indeterminate:'运行结果未知，仍保留容量',blocked:'暂停，等待维护'};
export const taskShortId=id=>{if(!taskId(id))fail('task_control_task_invalid');return `BG-${id.slice(0,12).toUpperCase()}`;};

// Titles are the only user supplied task data shown in shared controls. Never
// render prompts, result previews, internal identifiers, routes or error text.
export function safeTaskTitle(value) {
  return Array.from(String(value??'后台任务')
    .replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,' ')
    .replace(/(?:https?:\/\/|file:\/\/)[^\s]+|(?:[A-Za-z]:[\\/]|\/)[^\s，。；]+/g,'[路径已省略]')
    .replace(/\b(?:om|oc|ou|omt)_[A-Za-z0-9_-]+\b|\b[a-f0-9]{64}\b/gi,'[内部标识已省略]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]{20,})\b/g,'[敏感值已省略]')
    .replace(/(?:token|secret|password|密钥|令牌)\s*[:=：]\s*[^\s，。；]+/gi,'[敏感值已省略]')
    .replace(/[<>*`[\]#~]/g,'').replace(/\s+/g,' ').trim()).slice(0,80).join('')||'后台任务';
}
const escapeMd=value=>String(value).replace(/[&<>*~[\]()#:_]/g,c=>`&#${c.charCodeAt(0)};`);
export function stripExternalTaskControlFields(event) {
  const clean={...event};
  for(const key of Object.keys(clean))if(/^(?:task_control(?:_|$)|control_handled$|taskControlReceipt$)/.test(key))delete clean[key];
  return clean;
}
export const publicTask=task=>({shortId:taskShortId(task.id),title:safeTaskTitle(task.title),
  state:labels[task.status]??'状态待核验',cancelRequested:task.cancelRequested===true && !ended.has(task.status),delivery:task.notification==='notified'?'原任务回包已送达':'原任务回包尚未验收'});

// Entire-text matching intentionally leaves calendar/order/meeting requests,
// multi-action messages, quoted instructions and bulk cancellation to the model.
export function parseTaskControl(event) {
  if(event?.message_type!=='text' || event.attachments?.length)return null;
  const text=normalizeEvent(event).text.trim().replace(/[？?！!。]+$/u,'');
  if(!text || text.length>160 || /[\r\n]/.test(text))return null;
  const source=event.parent_id||event.reply_to||event.root_id;
  if(source && !messageId(source))return null;
  const ref=source?{sourceJobId:source}:{};
  if(/^(?:现在|目前)?(?:有哪些|有什么|有啥)(?:后台)?任务(?:在(?:运行|跑|进行))?$/u.test(text)
      || /^(?:查询|查看|列出)(?:全部|当前)?后台任务$/u.test(text))return {action:'list'};
  if(/^(?:查(?:一下)?|看(?:一下)?|查询|查看)(?:任务|后台任务)?(?:进度|状态)$/u.test(text))return {action:source?'status':'list',...ref};
  if(/^(?:这个|这项|这条)(?:分析|研究|后台任务|任务)(?:的)?(?:进度|状态)(?:怎么样|如何)?$/u.test(text))return {action:'status',...ref};
  if(/^(?:(?:取消|停止)(?:这个|这项|这条)?(?:分析|研究|后台任务)|(?:这个|这项|这条)(?:分析|研究|后台任务)(?:取消|停止))$/u.test(text))return {action:'cancel',...ref};
  if(source && /^(?:取消|停止)(?:这个任务)?$|^这个任务(?:取消|停止)$/u.test(text))return {action:'cancel',...ref};
  const short='(BG-[a-fA-F0-9]{12})';
  let m=new RegExp(`^(?:查(?:一下)?|查询|查看)?(?:后台任务|任务)?\\s*${short}(?:的)?(?:进度|状态)$`,'u').exec(text);
  if(m)return {action:'status',shortId:m[1].toUpperCase(),...ref};
  m=new RegExp(`^(?:取消|停止)(?:后台任务|任务)?\\s*${short}$`,'u').exec(text);
  if(!m)m=new RegExp(`^(?:后台任务|任务)?\\s*${short}(?:取消|停止)$`,'u').exec(text);
  if(m)return {action:'cancel',shortId:m[1].toUpperCase(),...ref};
  // taskKey is meaningful only while replying to its exact originating job.
  m=/^(查询|查看|取消|停止)(?:后台)?任务\s+([A-Za-z0-9][A-Za-z0-9_.-]{0,79})(?:的)?(进度|状态)?$/u.exec(text);
  if(m && source && (!['取消','停止'].includes(m[1]) || !m[3]))return {action:['取消','停止'].includes(m[1])?'cancel':'status',taskKey:m[2],...ref};
  return null;
}

export function resolveTaskControl(command,tasks,{binding,senderId}) {
  const list=tasks.filter(t=>taskId(t.id) && t.bot===binding.bot && t.chatId===binding.chat_id && t.codexThreadId===binding.codex_thread_id)
    .sort((a,b)=>Number(ended.has(a.status))-Number(ended.has(b.status)) || (b.createdAt??0)-(a.createdAt??0) || a.id.localeCompare(b.id));
  if(command.action==='list')return {kind:'list',tasks:list};
  let candidates=list;
  if(command.taskId)candidates=candidates.filter(t=>t.id===command.taskId);
  if(command.shortId)candidates=candidates.filter(t=>taskShortId(t.id)===command.shortId);
  if(command.sourceJobId)candidates=candidates.filter(t=>t.sourceJobId===command.sourceJobId);
  if(command.taskKey)candidates=candidates.filter(t=>t.taskKey===command.taskKey);
  const explicit=command.taskId||command.shortId||command.sourceJobId;
  if(!explicit)return {kind:'ambiguous',tasks:candidates.filter(t=>!ended.has(t.status))};
  if(!candidates.length)return {kind:'not_found',tasks:[]};
  if(candidates.length!==1)return {kind:'ambiguous',tasks:candidates};
  const task=candidates[0];
  if(command.action==='cancel' && senderId!==task.sourceSenderId && senderId!==binding.allowed_sender_id)return {kind:'forbidden',tasks:[]};
  return {kind:'task',task};
}

// Default adapter reads the authoritative private task/source/run records. IO
// can inject equivalent read/cancel helpers; those helpers remain trusted code.
export function backgroundControlApi({root,inboxRoot,binding,completionRoot}) {
  const options={root,inboxRoot,binding,completionRoot};
  const readTask=({taskId:id})=>{
    const task=readBackgroundTask(root,binding,id),source=validateBackgroundTaskSource(task,options),dir=path.join(root,binding.bot,id);
    const schedule=readBackgroundJson(path.join(dir,'schedule.json'),{optional:true,maxBytes:8*1024*1024});
    if(schedule && (schedule.schema!==1 || schedule.taskId!==id || schedule.requestHash!==task.requestHash))fail('task_control_state_invalid');
    const claim=readBackgroundJson(path.join(dir,'claim.json'),{optional:true}),run=readBackgroundJson(path.join(dir,'run.json'),{optional:true});
    let status=schedule?.status??'queued',nonce=schedule?.nonce??null,resultSha256=schedule?.resultSha256??null;
    const validClaim=claim?.schema===1 && claim.taskId===id && typeof claim.nonce==='string' && /^[a-f0-9-]{36}$/.test(claim.nonce);
    if(run && validClaim && run.schema===1 && run.taskId===id && run.nonce===claim.nonce
        && run.taskSha256===digest(privateRead(path.join(dir,'task.json'),{maxBytes:128*1024})) && ended.has(run.status)) {
      status=run.status;nonce=run.nonce;resultSha256=status==='completed'?run.resultSha256:null;
      if(status==='completed') {
        const bytes=privateRead(path.join(dir,'result.txt'),{maxBytes:backgroundBudget(task).maxOutputBytes});
        if(run.exitCode!==0 || bytes.length<1 || bytes.length!==run.resultBytes || digest(bytes)!==run.resultSha256
            || !bytes.equals(Buffer.from(bytes.toString('utf8'))))fail('task_control_result_invalid');
      }
    }
    else if(claim && (!validClaim || !['claimed','running',...ended].includes(status))) {
      status='indeterminate';nonce=validClaim?claim.nonce:null;resultSha256=null;
    }
    const cancel=readBackgroundJson(path.join(dir,'cancel.json'),{optional:true});
    const notification=schedule?.notification,known=(schedule?.notifications??[]).find(n=>n.outcomeKey===notification?.outcomeKey);
    const currentNotification=notification?.status==='notified' && known?.status==='notified'
      && notification.outcome?.status===status && notification.outcome?.nonce===nonce && notification.outcome?.resultSha256===resultSha256
      && notification.outcomeKey===digest(stableJson({nonce:notification.outcome.nonce??null,status:notification.outcome.status,
        resultSha256:notification.outcome.resultSha256??null,errorCategory:notification.outcome.errorCategory??null}))
      && stableJson(known.outcome)===stableJson(notification.outcome);
    return {id,bot:task.bot,chatId:task.binding.chat_id,codexThreadId:task.binding.codex_thread_id,sourceJobId:task.sourceJobId,
      sourceSenderId:source.event.sender_id,taskKey:task.taskKey,title:task.title,createdAt:task.createdAt,status,
      notification:currentNotification?'notified':'pending',cancelRequested:cancel?.schema===1 && cancel.taskId===id && cancel.nonce===(claim?.nonce??null)};
  };
  return {readTask,listTasks:()=>{
    if(!fs.existsSync(path.join(root,binding.bot)))return [];
    privateDirectory(root);privateDirectory(path.join(root,binding.bot));
    const ids=fs.readdirSync(path.join(root,binding.bot)).filter(taskId),tasks=[];
    for(const id of ids)tasks.push(readTask({taskId:id})); // Partial/corrupt lists fail closed, never say the queue is empty.
    return tasks;
  },cancelTask:task=>cancelBackgroundTask({...options,jobId:task.sourceJobId,taskKey:task.taskKey})};
}

const eventIdentity=event=>Object.fromEntries(['type','message_id','message_type','content','chat_id','chat_type','sender_id','sender_type',
  'parent_id','root_id','reply_to','thread_id','create_time','timestamp','synthetic_callback','bridge_binding','codex_thread_id',
  'action_source_job_id','action_source_message_id'].filter(k=>event[k]!==undefined).map(k=>[k,event[k]]));
const eventHash=event=>digest(stableJson(eventIdentity(event)));
const listText=tasks=>tasks.slice(0,10).map(t=>{const p=publicTask(t);return `${p.shortId}｜${p.title}：${p.state}${p.cancelRequested?'（已请求取消，尚待停止确认）':''}`;}).join('\n');
const taskText=task=>{const p=publicTask(task);return `${p.shortId}｜${p.title}：${p.state}${p.cancelRequested?'；已请求取消，尚待停止确认':''}。${p.delivery}。`;};
const resolvedText=resolution=>{
  if(resolution.kind==='list')return resolution.tasks.length?`当前后台任务：\n${listText(resolution.tasks)}${resolution.tasks.length>10?'\n仅展示前10项；可用短标识查询单项。':''}`:'目前没有可查询的后台任务。';
  if(resolution.kind==='not_found')return '未找到对应后台任务。请回复原任务消息或使用列表中的 BG 短标识。';
  if(resolution.kind==='forbidden')return '只有原提交者或维护负责人可以取消该后台任务。';
  if(resolution.kind==='ambiguous')return `请用 BG 短标识指定一个后台任务，或回复原任务消息；本次没有取消任务。${resolution.tasks.length?`\n${listText(resolution.tasks)}`:''}`;
  return taskText(resolution.task);
};

export class TaskControl {
  constructor({root,binding,api,backgroundRoot,inboxRoot,completionRoot,now=Date.now,maxSendAttempts=3,cardTtlMs=24*60*60*1000}) {
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(binding?.bot??'') || !Number.isSafeInteger(maxSendAttempts) || maxSendAttempts<1 || maxSendAttempts>3
        || !Number.isSafeInteger(cardTtlMs) || cardTtlMs<1 || cardTtlMs>7*24*60*60*1000)fail('task_control_options_invalid');
    Object.assign(this,{binding,now,maxSendAttempts,cardTtlMs});this.scope=bindingSnapshot(binding);
    this.dir=path.join(path.resolve(root),binding.bot);this.receipts=path.join(this.dir,'receipts');this.cards=path.join(this.dir,'cards');
    for(const dir of [path.resolve(root),this.dir,this.receipts,this.cards])privateDirectory(dir,{create:true});
    const secretFile=path.join(this.dir,'secret.json');publishBackgroundJson(secretFile,{secret:randomBytes(32).toString('hex')});
    this.secret=readBackgroundJson(secretFile,{mode:0o600}).secret;if(!/^[a-f0-9]{64}$/.test(this.secret??''))fail('task_control_secret_invalid');
    this.api=api??backgroundControlApi({root:backgroundRoot,inboxRoot,binding,completionRoot});this.processing=new Set();this.sending=new Set();
  }
  file(id){if(!messageId(id))fail('task_control_id_invalid');privateDirectory(this.receipts);return path.join(this.receipts,`${digest(id)}.json`);}
  records(){privateDirectory(this.receipts);return fs.readdirSync(this.receipts).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).map(n=>{
    try {return readBackgroundJson(path.join(this.receipts,n),{maxBytes:1024*1024,mode:0o600});}catch{return {schema:0};}
  });}
  save(record){atomicWriteJson(this.file(record.id),record);}
  valid(record){return record?.schema===1 && same(record.binding,this.scope) && messageId(record.id) && record.auditHash===eventHash(record.auditEvent);}
  receipt(event){
    try {const r=readBackgroundJson(this.file(event.message_id??event.id),{optional:true,maxBytes:1024*1024,mode:0o600});
      return this.valid(r) && r.auditHash===eventHash(event)?r:null;}catch{return null;}
  }
  protocol(event){const r=this.receipt(event);return r?{handled:true,receiptId:r.id,visible:r.visible===true,
    instruction:'这条任务控制已由持久运行时受理、执行或对账并负责回包。原消息仅在会话中保留可见审计；不要重新查询、取消、执行业务、调用feedback/silent工具或发送final/commentary。不要把取消请求说成已停止。'}:null;}
  confirmVisible(job){
    if(job?.markerSeen!==true)return false;
    const record=this.receipt(job.event);if(!record || job.id!==record.id)return false;
    if(!record.visible){record.visible=true;record.visibleAt=this.now();this.save(record);}return true;
  }
  acceptRecord(event,command,extra={}) {
    const id=event.message_id??event.id,file=this.file(id),old=readBackgroundJson(file,{optional:true,maxBytes:1024*1024,mode:0o600});
    if(old){if(!this.valid(old) || old.auditHash!==eventHash(event) || !same(old.command,command))fail('task_control_replay_mismatch');return old;}
    const record={schema:1,id,binding:this.scope,auditEvent:structuredClone(eventIdentity(event)),auditHash:eventHash(event),command,
      senderId:event.sender_id,acceptedAt:this.now(),phase:'accepted',visible:false,delivery:{state:'pending',attempts:0,key:`task-control:${digest(`${this.binding.bot}\0${id}`)}`},...extra};
    publishBackgroundJson(file,record);const current=readBackgroundJson(file,{mode:0o600,maxBytes:1024*1024});
    if(current.auditHash!==record.auditHash || !same(current.command,command))fail('task_control_replay_mismatch');return current;
  }
  async accept(event) {
    if(!event || event.sender_type!=='user' || event.chat_type!=='group' || event.synthetic_callback || !messageId(event.message_id)
        || !isAuthorizedMessage(this.binding,event) || !isBoundJob(this.binding,{id:event.message_id,event}))return {accepted:false,reason:'unauthorized'};
    const command=parseTaskControl(event);if(!command)return {accepted:false,reason:'not_control'};
    const record=this.acceptRecord(event,command);await this.process(record);
    return {accepted:true,id:record.id,auditEvent:structuredClone(record.auditEvent),protocol:this.protocol(event)};
  }
  async process(record) {
    if(!this.valid(record) || record.phase==='ready' || this.processing.has(record.id))return;
    this.processing.add(record.id);
    try {
      const tasks=await this.api.listTasks(),resolution=resolveTaskControl(record.command,tasks,{binding:this.binding,senderId:record.senderId});
      if(record.phase==='executing') {
        // A durable claim may outlive a cancellation call. Only read back; the
        // request is never automatically replayed across an unknown boundary.
        const task=tasks.find(t=>t.id===record.target?.id);
        record.text=task?`${taskText(task)}${!task.cancelRequested && !ended.has(task.status)?' 上次取消是否生效尚未确认；本次不会重复执行。':''}`:'上次取消结果尚未确认；本次不会重复执行，请维护负责人核验。';
        record.operation='unknown';
      } else if(record.command.action==='cancel' && resolution.kind==='task') {
        const target=await this.api.readTask({taskId:resolution.task.id});
        const checked=resolveTaskControl({...record.command,taskId:target.id},[target],{binding:this.binding,senderId:record.senderId});
        if(checked.kind!=='task'){record.text=resolvedText(checked);}
        else if(ended.has(target.status) || target.cancelRequested){record.text=taskText(target);}
        else {
          record.target={id:target.id,sourceJobId:target.sourceJobId,taskKey:target.taskKey};record.phase='executing';
          const ownClaim=publishBackgroundJson(`${this.file(record.id)}.execution`,{schema:1,id:record.id,target:record.target,claimedAt:this.now()});
          this.save(record);
          if(!ownClaim){
            record.operation='unknown';record.text='上次取消是否生效尚未确认；本次不会重复执行，请维护负责人核验。';
            record.phase='ready';this.save(record);return;
          }
          try {
            const result=await this.api.cancelTask(record.target);
            record.operation=result?.cancelRequested===true?'requested':result?.alreadyFinished===true?'already_finished':'unknown';
            record.text=result?.cancelRequested===true?`${taskShortId(target.id)}｜${safeTaskTitle(target.title)}：已请求取消，尚未确认停止。运行结果未知时仍保留容量，不会重跑。`
              :result?.alreadyFinished===true?`${taskShortId(target.id)}｜${safeTaskTitle(target.title)}：任务已结束，未再次执行取消；草稿回包仍需单独验收。`:'取消结果尚未确认；已保存请求记录，不会自动重试取消。';
          }catch {record.operation='unknown';record.text='取消结果尚未确认；已保存请求记录，不会自动重试取消。';}
        }
      } else record.text=resolvedText(resolution);
      if(resolution.kind==='task') {
        record.sourceTask={id:resolution.task.id,sourceJobId:resolution.task.sourceJobId,taskKey:resolution.task.taskKey};
        try {const snapshot=await this.createTaskCard({taskId:resolution.task.id,key:`control:${record.id}`,controlResult:record.operation});record.card=snapshot.card;record.contextId=snapshot.contextId;}catch{}
      }
      record.phase='ready';record.readyAt=this.now();this.save(record);
    } catch {
      // A failed read is not an empty task list. Never leak raw runtime errors.
      record.text='后台任务状态暂时无法核验；本次没有发起新的取消，请维护负责人检查。';
      if(record.phase==='executing')record.text='取消结果尚未确认；已保存请求记录，不会自动重试取消。';
      record.phase='ready';this.save(record);
    } finally {this.processing.delete(record.id);}
  }
  async drain(send,{limit=20}={}) {
    for(const record of this.records().filter(r=>r.phase!=='ready'||r.delivery?.state==='pending').slice(0,limit)) {
      if(!this.valid(record))continue;await this.process(record);
      if(record.phase!=='ready' || record.delivery.state!=='pending' || this.sending.has(record.id) || (record.delivery.retryAt??0)>this.now())continue;
      this.sending.add(record.id);
      try {
        // Persist before network. A crash or timeout is unknown, not permission
        // to send another message. The caller may explicitly reconcile by key.
        record.delivery.state='sending';record.delivery.attempts++;this.save(record);
        let result;
        try {result=await send(record.text,record.delivery.key,{receiptId:record.id,jobId:record.id,event:structuredClone(record.auditEvent),
          routeMessageId:record.routeMessageId,card:record.card,contextId:record.contextId,sourceTask:record.sourceTask});}
        catch(error){result={definitelyFailed:error?.definitelyFailed===true};}
        if(result?.delivered===true && messageId(result.messageId)) {
          if(record.contextId)this.bindCard(record.contextId,result.messageId);
          record.delivery.state='delivered';record.delivery.messageId=result.messageId;record.delivery.deliveredAt=this.now();
        } else if(result?.definitelyFailed===true && record.delivery.attempts<this.maxSendAttempts) {
          record.delivery.state='pending';record.delivery.retryAt=this.now()+1000*2**(record.delivery.attempts-1);
        } else record.delivery.state=result?.definitelyFailed===true?'failed':'unknown';
        this.save(record);
      } finally {this.sending.delete(record.id);}
    }
    return this.stats();
  }
  reconcileDelivery(event,result) {
    const record=typeof event==='string'?readBackgroundJson(this.file(event),{optional:true,maxBytes:1024*1024,mode:0o600}):this.receipt(event);
    if(!this.valid(record) || !['sending','unknown'].includes(record.delivery.state) || (result?.key!==undefined && result.key!==record.delivery.key))return false;
    if(result.verified===true && messageId(result.messageId)){
      if(record.contextId)this.bindCard(record.contextId,result.messageId);
      record.delivery.state='delivered';record.delivery.messageId=result.messageId;record.delivery.deliveredAt=this.now();
    }
    else if(result.definitelyFailed===true){record.delivery.state=record.delivery.attempts<this.maxSendAttempts?'pending':'failed';record.delivery.retryAt=this.now()+1000;}
    else return false;
    this.save(record);return true;
  }
  stats(){const all=this.records(),valid=all.filter(r=>this.valid(r));return {
    task_control_pending_count:all.length-valid.length+valid.filter(r=>r.delivery.state!=='delivered'||!r.visible).length,
    task_control_outbox_pending_count:valid.filter(r=>r.delivery.state!=='delivered').length,
    task_control_audit_pending_count:valid.filter(r=>!r.visible).length,
    task_control_blocked_count:all.length-valid.length+valid.filter(r=>['sending','unknown','failed'].includes(r.delivery.state)).length};}

  cardFile(id){if(!/^[a-f0-9]{64}$/.test(id??''))fail('task_control_context_invalid');privateDirectory(this.cards);return path.join(this.cards,`${id}.json`);}
  contextSignature(context){return createHmac('sha256',this.secret).update(stableJson(context)).digest('hex');}
  async createTaskCard({taskId:id,key,controlResult}) {
    if(!taskId(id)||typeof key!=='string'||!key||key.length>300)fail('task_control_card_invalid');
    const task=await this.api.readTask({taskId:id});
    if(resolveTaskControl({action:'status',taskId:id},[task],{binding:this.binding,senderId:this.binding.allowed_sender_id}).kind!=='task')fail('task_control_card_invalid');
    const identity={schema:1,binding:this.scope,taskId:id,sourceJobId:task.sourceJobId,taskKey:task.taskKey,keyHash:digest(key)};
    const contextId=this.contextSignature(identity),file=this.cardFile(contextId);
    publishBackgroundJson(file,{...identity,contextId,messageId:null,createdAt:this.now(),expiresAt:this.now()+this.cardTtlMs});
    const context=readBackgroundJson(file,{mode:0o600});if(!same(identity,Object.fromEntries(Object.keys(identity).map(k=>[k,context[k]]))))fail('task_control_context_conflict');
    const p=publicTask(task),button=(action,label,type)=>({tag:'button',text:{tag:'plain_text',content:label},type,width:'fill',
      behaviors:[{type:'callback',value:{task_control:'v1',context_id:contextId,action}}]});
    const controlNotice={requested:'已请求取消，尚未确认停止。',unknown:'本次取消结果尚未确认；不会自动重试。',already_finished:'任务已结束，未再次执行取消。'}[controlResult];
    const cancel=button('cancel','取消后台任务','danger');cancel.disabled=ended.has(task.status)||task.cancelRequested===true||controlResult==='unknown';
    cancel.confirm={title:{tag:'plain_text',content:'取消这个后台任务？'},text:{tag:'plain_text',content:'仅原提交者或维护负责人可操作；请求取消不等于已停止。'}};
    const card={schema:'2.0',config:{update_multi:true,width_mode:'default',enable_forward:false},
      header:{title:{tag:'plain_text',content:`后台任务 · ${p.shortId}`},template:'blue',icon:{tag:'standard_icon',token:'todo_colorful'}},
      body:{direction:'vertical',padding:'12px 12px 20px 12px',vertical_spacing:'8px',elements:[
        {tag:'markdown',content:`**${escapeMd(p.title)}**`,text_size:'heading-3'},
        {tag:'column_set',flex_mode:'none',columns:[{tag:'column',width:'weighted',weight:1,background_style:'grey-50',padding:'12px',vertical_spacing:'4px',elements:[
          {tag:'markdown',content:`当前状态：${escapeMd(p.state)}${p.cancelRequested?'；已请求取消，尚待停止确认':''}${controlNotice?`\n${controlNotice}`:''}`},
          {tag:'markdown',content:`<font color='grey'>${escapeMd(p.delivery)}</font>`,text_size:'notation'}]}]},
        {tag:'column_set',flex_mode:'none',horizontal_spacing:'8px',columns:[{tag:'column',width:'weighted',weight:1,elements:[button('status','查询进度','primary_filled')]},
          {tag:'column',width:'weighted',weight:1,elements:[cancel]}]}]}};
    return {card,contextId};
  }
  bindCard(contextId,message) {
    if(!messageId(message))fail('task_control_card_invalid');const file=this.cardFile(contextId),context=readBackgroundJson(file,{mode:0o600});
    if(!same(context.binding,this.scope) || (context.messageId && context.messageId!==message))fail('task_control_context_conflict');
    context.messageId=message;atomicWriteJson(file,context);return true;
  }
  async acceptCallback(envelope,{authenticatedBot,appId,allowMissingHost=false}={}) {
    try {
      const callback=normalizeActionCallback(envelope),value=callback.action?.value;
      if(authenticatedBot!==this.binding.bot || (appId!==undefined && callback.appId!==appId)
          || (callback.host!=='im_message' && !(allowMissingHost===true && callback.host===undefined))
          || callback.action?.tag!=='button' || !value || Object.keys(value).sort().join(',')!=='action,context_id,task_control'
          || value.task_control!=='v1' || !['status','cancel'].includes(value.action) || callback.action.form_value && Object.keys(callback.action.form_value).length)fail('task_control_callback_invalid');
      const context=readBackgroundJson(this.cardFile(value.context_id),{mode:0o600});
      const identity=Object.fromEntries(['schema','binding','taskId','sourceJobId','taskKey','keyHash'].map(k=>[k,context[k]]));
      if(this.contextSignature(identity)!==value.context_id || !same(context.binding,this.scope) || this.now()>=context.expiresAt
          || !context.messageId || callback.context?.open_message_id!==context.messageId || callback.context?.open_chat_id!==this.binding.chat_id)fail('task_control_callback_unauthorized');
      if(typeof callback.eventId!=='string'||!callback.eventId||callback.eventId.length>256)fail('task_control_callback_invalid');
      const sender=callback.operator?.open_id;
      const authEvent={type:'im.message.receive_v1',chat_id:this.binding.chat_id,chat_type:'group',sender_type:'user',sender_id:sender,
        mentions:[{id:this.binding.bot_open_id}]};
      if(!isAuthorizedMessage(this.binding,authEvent))fail('task_control_callback_unauthorized');
      const task=await this.api.readTask({taskId:context.taskId});
      const command={action:value.action,taskId:context.taskId,sourceJobId:context.sourceJobId,taskKey:context.taskKey};
      const resolved=resolveTaskControl(command,[task],{binding:this.binding,senderId:sender});
      if(resolved.kind!=='task')fail('task_control_callback_unauthorized');
      const id=`om_tc_${digest(`${this.binding.bot}\0${callback.eventId}`)}`;
      const auditEvent={...authEvent,message_type:'text',message_id:id,parent_id:context.sourceJobId,
        content:JSON.stringify({text:`后台任务按钮：${value.action==='cancel'?'取消':'查询'} ${taskShortId(context.taskId)}`}),synthetic_callback:true,
        bridge_binding:bindingSnapshot(this.binding),codex_thread_id:this.binding.codex_thread_id,
        action_source_job_id:context.sourceJobId,action_source_message_id:context.messageId};
      const record=this.acceptRecord(auditEvent,command,{callbackContext:value.context_id,routeMessageId:context.messageId});
      await this.process(record);return {accepted:true,id,auditEvent:structuredClone(record.auditEvent),protocol:this.protocol(record.auditEvent)};
    } catch(error){return {accepted:false,reason:error.code?.startsWith('task_control_')?error.code:'task_control_callback_rejected'};}
  }
}
