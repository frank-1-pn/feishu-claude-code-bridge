import fs from 'node:fs';
import path from 'node:path';
import {digest} from './codex-bridge-inbox.mjs';
import {opsScope} from './codex-bridge-ops-policy.mjs';
import {readBackgroundSource,backgroundSourceActionable,privateDirectory,privateRead,publishBackgroundJson,stableJson} from './codex-bridge-background-store.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const hash=/^[a-f0-9]{64}$/;
const key=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const jobId=/^om_[A-Za-z0-9_-]{1,180}$/;
const MAX_TASKS=128,MAX_OPERATIONS=512,MAX_CHAIN=32,MAX_SOURCES=256,MAX_BYTES=2*1024*1024;
const same=(a,b)=>stableJson(a)===stableJson(b);
const text=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v);
const eventFields=['type','message_id','message_type','content','chat_id','chat_type','sender_id','sender_type','create_time','timestamp',
  'parent_id','root_id','thread_id','reply_to','attachments','mentions','codex_thread_id','bridge_binding','synthetic_callback','action_source_job_id','action_source_message_id'];
const identity=e=>Object.fromEntries(eventFields.filter(k=>e?.[k]!==undefined).map(k=>[k,e[k]]));
const sourceIdentity=job=>({id:job.id,acceptedAt:job.acceptedAt,sequence:job.sequence,event:identity(job.event)});
const sourceHash=job=>digest(stableJson(sourceIdentity(job)));
const safeTitle=v=>String(v).replace(/(?:[A-Za-z]:)?[\\/][^\s]+|(?:om_|ou_|oc_)[\w-]+|(?:token|secret|password)\s*[:=]\s*\S+|sk-[\w-]+/gi,'[已隐藏]').replace(/[<>\r\n]/g,' ').slice(0,100);
export const collaborationShortId=id=>`CT-${id.slice(0,12).toUpperCase()}`;
export const collaborationTaskId=(scope,sourceId,taskKey)=>digest(`${scope}\0${sourceId}\0${taskKey}`);
function json(file,{optional=false,maxBytes=MAX_BYTES}={}) {
  const bytes=privateRead(file,{optional,maxBytes,mode:0o600});if(bytes===null)return null;
  if(fs.lstatSync(file).nlink!==1)fail('collaboration_private_file_invalid');
  return JSON.parse(bytes.toString('utf8'));
}
export function readCollaborationPolicy({root,binding,codexHome}) {
  try {
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(binding.bot??''))fail('collaboration_bot_invalid');
    const file=path.join(root,binding.bot,'policy.json');if(!fs.existsSync(file))return {enabled:false,reason:null};
    privateDirectory(root);privateDirectory(path.dirname(file));
    const p=json(file,{maxBytes:16384});
    if(!plain(p)||p.schema!==1||Object.keys(p).some(k=>!['schema','scope','enabled'].includes(k))||typeof p.enabled!=='boolean'
        ||!same(p.scope,opsScope(binding,codexHome))||binding.group_access!=='all_group_humans')fail('collaboration_policy_invalid');
    return {...p,reason:null};
  }catch{return {enabled:false,reason:'collaboration_policy_invalid'};}
}
export function stripExternalCollaborationFields(event) {
  return Object.fromEntries(Object.entries(event).filter(([k])=>!/^collaboration_|^collab_|^task_context|^business_task|^cooperation_/i.test(k)));
}
function waitingFields(value) {
  if(!Array.isArray(value)||value.length>16||value.some(v=>!text(v,64)))fail('collaboration_fields_invalid');
  const normalized=value.map(v=>v.trim());if(new Set(normalized).size!==normalized.length)fail('collaboration_fields_invalid');return normalized;
}
function validVersion(v){if(!Number.isSafeInteger(v)||v<0)fail('collaboration_version_invalid');return v;}
function eventText(event) {
  if(event.message_type!=='text')return '';
  let c=event.content;if(plain(c))c=c.text;
  else if(typeof c==='string'){try {const p=JSON.parse(c);if(plain(p))c=p.text;}catch{}}
  return typeof c==='string'&&c.length<=4096?c:'';
}

// Local context transactions only. Never invokes a calendar/order/send API.
// One immutable catalog commit atomically owns both task and resource versions.
export class CollaborationContext {
  constructor({root,inboxRoot,completionRoot,binding,codexHome,now=Date.now,afterClaim}) {
    if(!path.isAbsolute(root??'')||!path.isAbsolute(inboxRoot??'')||!path.isAbsolute(codexHome??'')||!path.isAbsolute(binding?.cwd??''))fail('collaboration_runtime_invalid');
    Object.assign(this,{root:path.resolve(root),inboxRoot:path.resolve(inboxRoot),completionRoot,binding,codexHome,now,afterClaim});
    this.scope=opsScope(binding,codexHome);this.scopeHash=digest(stableJson(this.scope));
    this.dir=path.join(this.root,binding.bot,this.scopeHash);this.catalogDir=path.join(this.dir,'catalog');this.claimDir=path.join(this.dir,'claims');this.resultDir=path.join(this.dir,'results');
  }
  policy(){return readCollaborationPolicy(this);}
  enabled(){if(!this.policy().enabled)fail('collaboration_disabled');}
  source(id,{active=false,event}={}) {
    if(!jobId.test(id??''))fail('collaboration_source_invalid');
    const job=readBackgroundSource({...this,jobId:id,active});
    if(event&&!same(identity(event),identity(job.event)))fail('collaboration_event_mismatch');
    return job;
  }
  init(){for(const d of [this.root,path.join(this.root,this.binding.bot),this.dir,this.catalogDir,this.claimDir,this.resultDir])privateDirectory(d,{create:true});}
  empty(){return {schema:1,scopeHash:this.scopeHash,version:0,previous:null,tasks:{},resources:{},proposals:{},operations:{}};}
  state() {
    if(!fs.existsSync(this.dir))return this.empty();
    for(const d of [this.root,path.join(this.root,this.binding.bot),this.dir,this.catalogDir,this.claimDir,this.resultDir])privateDirectory(d);
    const files=fs.readdirSync(this.catalogDir).sort();if(files.length>MAX_OPERATIONS||files.some(f=>!/^v-\d{6}\.json$/.test(f)))fail('collaboration_catalog_invalid');
    if(files.some((f,i)=>f!==`v-${String(i+1).padStart(6,'0')}.json`))fail('collaboration_catalog_invalid');
    let previous=files.length>1?json(path.join(this.catalogDir,files.at(-2))):this.empty();
    for(const [i,file] of files.entries()) {
      if(i!==files.length-1)continue;
      const s=json(path.join(this.catalogDir,file));
      if(s?.schema!==1||s.scopeHash!==this.scopeHash||s.version!==i+1||file!==`v-${String(i+1).padStart(6,'0')}.json`
          ||s.previous!==digest(stableJson(previous))||!plain(s.tasks)||!plain(s.resources)||!plain(s.proposals)||!plain(s.operations)
          ||Object.keys(s.tasks).length>MAX_TASKS||Object.keys(s.operations).length>MAX_OPERATIONS)fail('collaboration_catalog_invalid');
      for(const [id,task] of Object.entries(s.tasks))if(!hash.test(id)||task.id!==id||task.id!==collaborationTaskId(this.scopeHash,task.sourceJobId,task.taskKey)
          ||!key.test(task.taskKey)||!hash.test(task.sourceHash)||!text(task.title,200)||!/^ou_[A-Za-z0-9_-]{1,180}$/.test(task.responsibleSenderId??'')
          ||!Number.isSafeInteger(task.version)||task.version<1||!['active','closed'].includes(task.state)||!Array.isArray(task.linkedSources)
          ||task.linkedSources.length>32||task.linkedSources.some(v=>!jobId.test(v.id??'')||!hash.test(v.hash??'')))fail('collaboration_task_invalid');
      previous=s;
    }
    return previous;
  }
  verifiedTasks(state=this.state()) {
    const sources=new Map(),read=id=>{
      if(!sources.has(id)){if(sources.size>=MAX_SOURCES)fail('collaboration_source_limit');sources.set(id,this.source(id));}return sources.get(id);
    };
    return Object.values(state.tasks).map(task=>{
      const source=read(task.sourceJobId);
      if(!backgroundSourceActionable({...this,job:source})
          ||sourceHash(source)!==task.sourceHash)fail('collaboration_task_source_changed');
      for(const ref of task.linkedSources)if(sourceHash(read(ref.id))!==ref.hash)fail('collaboration_task_source_changed');
      waitingFields(task.waitingFields);return task;
    });
  }
  summary(task,state=this.state()) {
    return {taskId:collaborationShortId(task.id),title:safeTitle(task.title),version:task.version,state:task.state,
      responsibleSenderId:task.responsibleSenderId,waitingFields:[...task.waitingFields],resourceVersion:task.resourceId?(state.resources[task.resourceId]?.version??0):null};
  }
  resolve({jobId:id,taskId,event}={}) {
    if(!this.policy().enabled)return {kind:'disabled',candidates:[]};
    const source=this.source(id,{event}),state=this.state(),tasks=this.verifiedTasks(state).filter(t=>t.state==='active');
    const raw=eventText(source.event),explicit=taskId===undefined?[...raw.matchAll(/\bCT-([a-f0-9]{12})\b/gi)].map(m=>`CT-${m[1].toUpperCase()}`):[taskId];
    if(taskId===undefined&&/\bCT-/i.test(raw)&&explicit.length!==[...raw.matchAll(/\bCT-/gi)].length)
      return {kind:'unknown',reason:'invalid_identifier',candidates:[]};
    if(explicit.length) {
      if(explicit.some(v=>!/^CT-[A-F0-9]{12}$/.test(v))||new Set(explicit).size!==1)return {kind:'ambiguous',reason:'multiple_identifiers',candidates:[]};
      const selected=tasks.filter(t=>collaborationShortId(t.id)===explicit[0]);return this.selection(selected,'explicit',state);
    }
    let current=source,seen=new Set([id]);
    for(let i=0;i<MAX_CHAIN;i++) {
      const parent=current.event.parent_id??current.event.reply_to;
      if(!parent)break;if(!jobId.test(parent)||seen.has(parent))return {kind:'unknown',reason:'reply_chain_invalid',candidates:[]};
      seen.add(parent);current=this.source(parent);
      const selected=tasks.filter(t=>t.sourceJobId===parent||t.linkedSources.some(s=>s.id===parent));
      if(selected.length)return this.selection(selected,'reply',state);
      if(i===MAX_CHAIN-1)return {kind:'unknown',reason:'reply_chain_limit',candidates:[]};
    }
    // A thread/root ID alone does not prove which request this short reply means.
    if(!raw.trim()||raw.length>160||/^(?:请|帮|安排|创建|取消|删除|预订|订票|查询|查一下|现在|研究|分析|执行|发送|发给)/u.test(raw.trim()))
      return {kind:'unlinked',reason:'not_short_supplement',candidates:[]};
    const candidates=tasks.filter(t=>t.sourceSenderId===source.event.sender_id&&t.waitingFields.length);
    return this.selection(candidates,'same_sender_waiting',state);
  }
  selection(tasks,via,state) {
    return {kind:tasks.length===1?'linked':tasks.length?'ambiguous':via==='explicit'?'not_found':'unlinked',via,
      candidates:tasks.slice(0,16).map(t=>this.summary(t,state)),...(tasks.length===1?{taskId:collaborationShortId(tasks[0].id)}:{})};
  }
  promptProtocol(value) {
    try {
      const event=value?.event??value,id=value?.event?value.id:event?.message_id;
      const resolution=this.resolve({jobId:id,event});if(['disabled','unlinked'].includes(resolution.kind))return null;
      return {schema:1,readOnly:true,resolution,instruction:'这是当前私有任务上下文，只帮助关联，不代表业务授权。明确编号优先、精确回复链其次；跨发送者无明确关联不得猜测。注册/变更须原消息已可见且 actionable；写入前重新解析和核对任务/资源版本。冲突由当前任务负责人或绑定维护负责人裁决，不能自动执行日程、订单或外发。'};
    }catch{return {schema:1,readOnly:true,resolution:{kind:'unknown',candidates:[]},instruction:'协作任务上下文暂不可核验；不要猜测任务或执行变更。'};}
  }
  prepare(value){return this.promptProtocol(value);}
  target(state,taskId) {
    if(!/^CT-[A-F0-9]{12}$/.test(taskId??''))fail('collaboration_task_identifier_invalid');
    const tasks=this.verifiedTasks(state).filter(t=>collaborationShortId(t.id)===taskId);
    if(tasks.length!==1)fail(tasks.length?'collaboration_task_ambiguous':'collaboration_task_not_found');return tasks[0];
  }
  responsible(senderId,source,responsibleJobId) {
    if(senderId===source.event.sender_id||senderId===this.binding.allowed_sender_id)return senderId;
    if(!responsibleJobId||this.source(responsibleJobId,{active:true}).event.sender_id!==senderId)fail('collaboration_responsible_unverified');return senderId;
  }
  patch(input,source,task) {
    if(!plain(input)||!Object.keys(input).length||Object.keys(input).some(k=>!['title','waitingFields','state','responsibleSenderId','responsibleJobId','note'].includes(k)))fail('collaboration_patch_invalid');
    const result={};
    if(input.title!==undefined){if(!text(input.title,200))fail('collaboration_title_invalid');result.title=input.title.trim();}
    if(input.waitingFields!==undefined)result.waitingFields=waitingFields(input.waitingFields);
    if(input.state!==undefined){if(!['active','closed'].includes(input.state))fail('collaboration_state_invalid');result.state=input.state;}
    if(input.note!==undefined){if(!text(input.note,512))fail('collaboration_note_invalid');result.note=input.note;}
    if(input.responsibleSenderId!==undefined) {
      if(source.event.sender_id!==this.binding.allowed_sender_id)fail('collaboration_reassignment_forbidden');
      result.responsibleSenderId=this.responsible(input.responsibleSenderId,source,input.responsibleJobId);
    }
    if(input.responsibleJobId!==undefined&&input.responsibleSenderId===undefined)fail('collaboration_patch_invalid');
    return result;
  }
  transaction(action,input,mutate) {
    this.enabled();if(!plain(input)||!key.test(input.operationKey??''))fail('collaboration_operation_key_invalid');
    const source=this.source(input.jobId,{active:true}),operationId=digest(`${this.scopeHash}\0${source.id}\0${input.operationKey}`);
    const request={schema:1,operationId,action,input,sourceHash:sourceHash(source)},requestHash=digest(stableJson(request));
    this.init();let state=this.state();
    if(fs.readdirSync(this.claimDir).length>MAX_OPERATIONS)fail('collaboration_claim_limit');
    const prior=state.operations[operationId],claimFile=path.join(this.claimDir,`${operationId}.json`),resultFile=path.join(this.resultDir,`${operationId}.json`);
    const priorClaim=json(claimFile,{optional:true});
    if(priorClaim&&(!same(priorClaim.request,request)||priorClaim.requestHash!==requestHash))fail('collaboration_operation_conflict');
    if(prior){if(prior.requestHash!==requestHash)fail('collaboration_operation_conflict');return {...prior.result,duplicate:true};}
    const priorResult=json(resultFile,{optional:true});
    if(priorResult){if(priorResult.requestHash!==requestHash)fail('collaboration_operation_conflict');return {...priorResult.result,duplicate:true};}
    if(priorClaim)return {status:'unknown',operationId,businessExecuted:false,replayed:false};
    if(state.version>=MAX_OPERATIONS||fs.readdirSync(this.claimDir).length>=MAX_OPERATIONS)fail('collaboration_catalog_full');
    // Validation before claim; claimed work never silently retries after a crash.
    const next=structuredClone(state),result=mutate(next,source,operationId);
    next.operations[operationId]={requestHash,result};next.version=state.version+1;next.previous=digest(stableJson(state));
    if(Buffer.byteLength(stableJson(next))>MAX_BYTES)fail('collaboration_catalog_full');
    if(!publishBackgroundJson(claimFile,{request,requestHash,createdAt:this.now()}))return this.transaction(action,input,mutate);
    this.afterClaim?.({operationId,action});
    // Revalidate classification after the durable claim, immediately before commit.
    this.enabled();
    if(sourceHash(this.source(input.jobId,{active:true}))!==request.sourceHash)fail('collaboration_source_changed');
    const file=path.join(this.catalogDir,`v-${String(next.version).padStart(6,'0')}.json`);
    if(!publishBackgroundJson(file,next)) {
      const conflict={status:'conflict',reason:'catalog_cas',businessExecuted:false,operationId};
      publishBackgroundJson(resultFile,{requestHash,result:conflict});return conflict;
    }
    return result;
  }
  register(input) {
    return this.transaction('register',input,(s,source)=>{
      if(Object.keys(input).some(k=>!['jobId','operationKey','taskKey','title','responsibleSenderId','responsibleJobId','waitingFields','resourceKey'].includes(k))
          ||!key.test(input.taskKey??'')||!text(input.title,200)||Object.keys(s.tasks).length>=MAX_TASKS)fail('collaboration_register_invalid');
      const id=collaborationTaskId(this.scopeHash,source.id,input.taskKey);if(s.tasks[id])fail('collaboration_task_exists');
      const responsibleSenderId=this.responsible(input.responsibleSenderId??this.binding.allowed_sender_id,source,input.responsibleJobId);
      if(!/^ou_[A-Za-z0-9_-]{1,180}$/.test(responsibleSenderId??''))fail('collaboration_responsible_invalid');
      if(input.resourceKey!==undefined&&!text(input.resourceKey,128))fail('collaboration_resource_invalid');
      const resourceId=input.resourceKey===undefined?null:digest(`${this.scopeHash}\0${input.resourceKey}`);
      if(resourceId&&!s.resources[resourceId])s.resources[resourceId]={version:0};
      const task={id,taskKey:input.taskKey,title:input.title.trim(),sourceJobId:source.id,sourceSenderId:source.event.sender_id,sourceHash:sourceHash(source),
        responsibleSenderId,waitingFields:waitingFields(input.waitingFields??[]),version:1,state:'active',resourceId,linkedSources:[],createdAt:this.now()};
      s.tasks[id]=task;return {status:'registered',task:this.summary(task,s),businessExecuted:false};
    });
  }
  change(action,input) {
    return this.transaction(action,input,(s,source,operationId)=>{
      if(Object.keys(input).some(k=>!['jobId','operationKey','taskId','expectedVersion','expectedResourceVersion','patch'].includes(k)))fail('collaboration_change_invalid');
      const task=this.target(s,input.taskId),patch=this.patch(input.patch,source,task),base=validVersion(input.expectedVersion);
      const resolution=this.resolve({jobId:source.id});
      if(resolution.kind!=='linked'||resolution.taskId!==input.taskId)fail('collaboration_change_association_required');
      if(task.state==='closed')fail('collaboration_task_closed');
      const resourceVersion=task.resourceId?s.resources[task.resourceId]?.version:null;
      if(task.resourceId)validVersion(input.expectedResourceVersion);
      else if(input.expectedResourceVersion!==undefined)fail('collaboration_resource_invalid');
      const authorized=[task.responsibleSenderId,this.binding.allowed_sender_id].includes(source.event.sender_id);
      const conflict=base!==task.version||(task.resourceId&&input.expectedResourceVersion!==resourceVersion);
      if(action==='record'&&authorized&&!conflict)return this.apply(s,task,patch,source);
      const proposalId=digest(`${operationId}\0proposal`);
      s.proposals[proposalId]={id:proposalId,taskId:task.id,sourceJobId:source.id,sourceHash:sourceHash(source),proposerSenderId:source.event.sender_id,
        baseVersion:base,baseResourceVersion:input.expectedResourceVersion??null,patch,status:'pending',conflict,createdAt:this.now()};
      return {status:conflict?'conflict':'decision_required',proposalId,task:this.summary(task,s),businessExecuted:false,requiresResponsibleDecision:true};
    });
  }
  proposeChange(input){return this.change('propose',input);}
  recordChange(input){return this.change('record',input);}
  linkSource(task,source) {
    if(!task.linkedSources.some(s=>s.id===source.id)&&source.id!==task.sourceJobId) {
      if(task.linkedSources.length>=32)fail('collaboration_source_limit');task.linkedSources.push({id:source.id,hash:sourceHash(source)});
    }
  }
  apply(state,task,patch,source) {
    Object.assign(task,patch);task.version++;task.updatedAt=this.now();
    this.linkSource(task,source);
    if(task.resourceId)state.resources[task.resourceId].version++;
    return {status:'context_recorded',task:this.summary(task,state),businessExecuted:false};
  }
  decideChange(input) {
    return this.transaction('decide',input,(s,source)=>{
      if(Object.keys(input).some(k=>!['jobId','operationKey','proposalId','decision','expectedVersion','expectedResourceVersion'].includes(k))
          ||!hash.test(input.proposalId??'')||!['accept','reject'].includes(input.decision))fail('collaboration_decision_invalid');
      const proposal=s.proposals[input.proposalId];if(!proposal||proposal.status!=='pending')fail('collaboration_proposal_not_pending');
      const task=s.tasks[proposal.taskId];this.target(s,collaborationShortId(task.id));
      if(![task.responsibleSenderId,this.binding.allowed_sender_id].includes(source.event.sender_id))fail('collaboration_decision_forbidden');
      if(sourceHash(this.source(proposal.sourceJobId))!==proposal.sourceHash)fail('collaboration_proposal_source_changed');
      if(validVersion(input.expectedVersion)!==task.version||task.resourceId&&validVersion(input.expectedResourceVersion)!==s.resources[task.resourceId].version)
        fail('collaboration_decision_version_conflict');
      proposal.status=input.decision==='accept'?'accepted':'rejected';proposal.decidedBy=source.event.sender_id;proposal.decidedAt=this.now();
      if(input.decision==='reject')return {status:'proposal_rejected',proposalId:proposal.id,businessExecuted:false};
      if(task.state==='closed')fail('collaboration_task_closed');
      this.linkSource(task,this.source(proposal.sourceJobId));
      return {...this.apply(s,task,proposal.patch,source),proposalId:proposal.id};
    });
  }
  stats() {
    let operationPending=0,blocked=0,waiting=0,decisions=0;const policy=this.policy();
    try {
      const s=this.state();this.verifiedTasks(s);waiting=Object.values(s.tasks).filter(t=>t.state==='active'&&t.waitingFields.length).length;
      decisions=Object.values(s.proposals).filter(p=>p.status==='pending').length;
      const claims=fs.existsSync(this.claimDir)?fs.readdirSync(this.claimDir):[];
      if(claims.length>MAX_OPERATIONS)fail('collaboration_claim_limit');
      for(const file of claims) {
        if(!/^[a-f0-9]{64}\.json$/.test(file))fail('collaboration_claim_invalid');const c=json(path.join(this.claimDir,file));
        if(!hash.test(c.requestHash??'')||c.request?.operationId!==file.slice(0,-5)||digest(stableJson(c.request))!==c.requestHash)fail('collaboration_claim_invalid');
        if(!s.operations[c.request.operationId]&&!json(path.join(this.resultDir,file),{optional:true})){operationPending++;blocked++;}
      }
    }catch{operationPending=Math.max(1,operationPending);blocked=Math.max(1,blocked);}
    return {collaboration_operation_pending_count:operationPending,collaboration_operation_blocked_count:blocked,
      collaboration_decision_waiting_count:decisions,collaboration_waiting_task_count:waiting,collaboration_policy_blocked_count:policy.reason?1:0};
  }
}
