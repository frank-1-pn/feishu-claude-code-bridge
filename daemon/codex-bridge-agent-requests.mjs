import fs from 'node:fs';
import path from 'node:path';
import {digest} from './codex-bridge-inbox.mjs';
import {bindingSnapshot,isBoundJob} from './codex-bridge-ux.mjs';
import {isAuthorizedMessage} from './codex-bridge-authorization.mjs';
import {privateDirectory,privateRead,publishBackgroundJson,stableJson} from './codex-bridge-background-store.mjs';
import {enqueueActionable,enqueueSilentCompletion,readDisposition} from './codex-bridge-completion.mjs';
import {verifyBackgroundCompletion} from './codex-bridge-background.mjs';
import {TaskResultStore} from './codex-bridge-task-results.mjs';
import {rolloutAssistantMessage,rolloutTaskCompletion} from './codex-bridge-progress.mjs';

export const AGENT_REQUEST_LIMITS=Object.freeze({maxBytes:96*1024,maxPending:128,maxFiles:8192});
const fail=code=>{throw Object.assign(Error(code),{code});};
const same=(a,b)=>stableJson(a)===stableJson(b);
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const idValid=v=>typeof v==='string'&&/^om_[A-Za-z0-9_-]{1,180}$/.test(v);
const keyValid=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(v);
const hashValid=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const publicationWait=new Int32Array(new SharedArrayBuffer(4));
function json(file,{optional=false,maxBytes=AGENT_REQUEST_LIMITS.maxBytes}={}) {
 for(let i=0;i<=250;i++){
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});if(!stat&&optional)return null;if(!stat||stat.nlink===1)break;
  if(stat.nlink!==2)fail('agent_request_private_file_invalid');const dir=path.dirname(file);privateDirectory(dir);
  const prefix=path.basename(file)+'.';let matching=0;
  for(const n of fs.readdirSync(dir).filter(n=>n.startsWith(prefix)&&/\.[a-f0-9-]{36}\.tmp$/.test(n))){
   const tmp=fs.lstatSync(path.join(dir,n),{throwIfNoEntry:false});
   if(tmp&&tmp.dev===stat.dev&&tmp.ino===stat.ino&&tmp.nlink===2&&tmp.isFile()&&!tmp.isSymbolicLink()
    &&(tmp.mode&0o777)===0o600&&(!process.getuid||tmp.uid===process.getuid()))matching++;
  }
  if(fs.lstatSync(file,{throwIfNoEntry:false})?.nlink===1)continue;
  if(matching!==1)fail('agent_request_private_file_invalid');if(i===250)fail('agent_request_publication_pending');Atomics.wait(publicationWait,0,0,2);
 }
 const bytes=privateRead(file,{optional,maxBytes,mode:0o600});if(bytes===null)return null;
 if(fs.lstatSync(file).nlink!==1)fail('agent_request_private_file_invalid');return JSON.parse(bytes.toString('utf8'));
}
function context({stateRoot,configFile=path.join(path.dirname(stateRoot??''),'codex-thread-bindings.json'),binding,codexHome}) {
 if(!path.isAbsolute(stateRoot??'')||stateRoot!==path.resolve(stateRoot)||!path.isAbsolute(configFile??'')
   ||configFile!==path.resolve(configFile)||!binding||!keyValid(binding.bot))fail('agent_request_runtime_invalid');
 const config=json(configFile,{maxBytes:256*1024}),selected=config.bindings?.[binding.bot];
 if(!plain(config.bindings)||Object.values(config.bindings).filter(v=>v?.codex_thread_id===binding.codex_thread_id).length!==1)fail('agent_request_scope_ambiguous');
 const cleanBinding=Object.fromEntries(Object.entries(binding).filter(([k])=>!['logPath','offsetPath','receiptOffsetPath'].includes(k)));
 if(!selected||!same({...selected,bot:binding.bot},cleanBinding)||config.runtime?.codex_home!==codexHome
   ||binding.group_access!=='all_group_humans'||!path.isAbsolute(codexHome??'')||codexHome!==path.resolve(codexHome)
   ||!path.isAbsolute(binding.cwd??'')||fs.realpathSync(binding.cwd)!==binding.cwd)fail('agent_request_scope_changed');
 const scope={schema:1,binding:bindingSnapshot(binding),configurationHash:digest(stableJson({...selected,codexHome})),cwd:binding.cwd,codexHome,stateRoot,configFile};
 const scopeHash=digest(stableJson(scope));
 return {...scope,binding,scope,scopeHash,dir:path.join(binding.cwd,'.codex-bridge-requests-v1',binding.bot,scopeHash),
  receiptDir:path.join(stateRoot,'agent-requests-v1',binding.bot,scopeHash)};
}
function source(ctx,jobId,{currentAction=false}={}) {
 if(!idValid(jobId))fail('agent_request_source_invalid');
 const j=json(path.join(ctx.stateRoot,'codex-inbox-v2',ctx.binding.bot,`job-${digest(jobId)}.json`),{maxBytes:8*1024*1024});
 if(j.id!==jobId||j.event?.message_id!==jobId||!isBoundJob(ctx.binding,j))fail('agent_request_source_changed');
 if(j.event.synthetic_callback) {
  if(j.event.background_completion){
   if(!same(j.event.bridge_binding,bindingSnapshot(ctx.binding))||!verifyBackgroundCompletion(ctx.binding,j.event,path.join(ctx.stateRoot,'background-v1')))fail('agent_request_background_unverified');
  }else new TaskResultStore({root:path.join(ctx.stateRoot,'task-results-v1'),inboxRoot:path.join(ctx.stateRoot,'codex-inbox-v2'),
   completionRoot:path.join(ctx.stateRoot,'completions-v1'),backgroundRoot:path.join(ctx.stateRoot,'background-v1'),binding:ctx.binding,codexHome:ctx.codexHome}).verifyActionEvent(j.event,{current:currentAction});
 }else if(!same(j.event.bridge_binding,bindingSnapshot(ctx.binding))||j.event.sender_type!=='user'||!isAuthorizedMessage(ctx.binding,j.event))fail('agent_request_source_unauthorized');
 return j;
}
function sourceHash(job) {
 return digest(stableJson({id:job.id,acceptedAt:job.acceptedAt,sequence:job.sequence,event:job.event,
  taskResultProtocolVersion:job.taskResultProtocolVersion,taskResultProtocolScope:job.taskResultProtocolScope}));
}
function payload(kind,request) {
 if(['actionable','silent'].includes(kind)){if(request!==undefined)fail('agent_request_payload_invalid');return null;}
 if(kind==='link'){
  if(!plain(request)||Object.keys(request).length!==1||!idValid(request.targetJobId))fail('agent_request_payload_invalid');return {...request};
 }
 if(kind!=='result'||!plain(request)||Object.keys(request).some(k=>!['resultKey','title','text','status'].includes(k))
   ||!keyValid(request.resultKey)||!['complete','waiting','failed','background'].includes(request.status)
   ||typeof request.text!=='string'||!request.text.trim()||Buffer.byteLength(request.text)>64*1024
   ||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(request.text)
   ||request.title!==undefined&&(typeof request.title!=='string'||!request.title.trim()||request.title.length>200||/[\r\n\u0000-\u001f\u007f]/u.test(request.title)))fail('agent_request_payload_invalid');
 return {...request};
}
function key(ctx,jobId,kind,value) {
 return digest(`${ctx.scopeHash}\0${jobId}\0${['actionable','silent'].includes(kind)?'disposition':kind}${kind==='result'?'\0'+value.resultKey:''}`);
}
function validateJob(ctx,job,kind,{active=true}={}) {
 const disposition=readDisposition({root:path.join(ctx.stateRoot,'completions-v1'),binding:ctx.binding,job});
 if(job.event.synthetic_callback&&['actionable','silent','link'].includes(kind))fail('agent_request_source_unauthorized');
 if((kind!=='silent'&&(disposition==='silent'||job.completionDisposition==='silent'||job.feedbackDisposition==='silent'))
   ||kind==='silent'&&(disposition==='actionable'||job.feedbackDisposition==='actionable'))fail('agent_request_disposition_conflict');
 if(['result','link'].includes(kind)&&(job.taskResultProtocolVersion!==1||!same(job.taskResultProtocolScope,{cwd:ctx.cwd,codexHome:ctx.codexHome})))fail('agent_request_protocol_mismatch');
 if(active && (!['submitted','delivered'].includes(job.status)||kind!=='silent'&&(job.unclassifiedTurnEnded||job.taskResultProtocolBlocked))
   && !(kind==='silent'&&job.status==='done'&&job.completionDisposition==='silent'))fail('agent_request_source_not_active');
}
function assertTurnOpen(ctx,job,request){
 if(!job.rollout||!path.isAbsolute(job.rollout)||fs.realpathSync(job.rollout)!==job.rollout)fail('agent_request_turn_proof_unavailable');
 const before=fs.lstatSync(job.rollout);let fd;
 try{
  fd=fs.openSync(job.rollout,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));const stat=fs.fstatSync(fd);
  if(!stat.isFile()||before.isSymbolicLink()||stat.dev!==before.dev||stat.ino!==before.ino||stat.nlink!==1||stat.mode&0o022
   ||process.getuid&&stat.uid!==process.getuid())fail('agent_request_turn_proof_unavailable');
  const known=Number.isSafeInteger(job.markerPosition)&&job.markerPosition>=0,start=known?job.markerPosition:(job.cursor??0);
  if(!Number.isSafeInteger(start)||start<0||stat.size<start||stat.size-start>64*1024*1024)fail('agent_request_turn_proof_unavailable');
  const buffer=Buffer.alloc(stat.size-start);let used=0;while(used<buffer.length){const n=fs.readSync(fd,buffer,used,buffer.length-used,start+used);if(!n)break;used+=n;}
  let seen=known&&job.markerSeen,owner=job.markerTurnId??(seen?job.turnId:undefined),observed=owner??job.turnId,proof=false;
  const marker=`[飞书消息｜${ctx.binding.bot}｜${job.id}]`;
  for(const line of buffer.subarray(0,used).toString('utf8').split('\n').slice(0,-1)){
   let item;try{item=JSON.parse(line);}catch{continue;}const p=item.payload;
   if((item.type==='turn_context'||item.type==='event_msg'&&p?.type==='task_started')&&p?.turn_id)observed=p.turn_id;
   if(item.type==='response_item'&&p?.role==='user'&&JSON.stringify(p.content??[]).includes(marker)){seen=true;owner??=observed;}
   if(request&&seen&&observed===owner&&item.type==='response_item'&&['custom_tool_call_output','function_call_output'].includes(p?.type)){
    const output=typeof p.output==='string'?p.output:JSON.stringify(p.output??'');
    if(output.includes(request.requestKey)&&output.includes(request.requestHash))proof=true;
   }
   if(seen&&observed===owner&&(rolloutAssistantMessage(item)?.phase==='final_answer'||rolloutTaskCompletion(item))){
    if(proof)return;fail('agent_request_source_turn_ended');
   }
  }
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}
function directories(ctx,{create=false,receipts=false}={}) {
 const base=path.join(ctx.cwd,'.codex-bridge-requests-v1');
 for(const dir of [base,path.join(base,ctx.binding.bot),ctx.dir])privateDirectory(dir,{create});
 if(create){
  const ignore=path.join(base,'.gitignore');
  if(fs.existsSync(ignore)){const bytes=privateRead(ignore,{mode:0o600,maxBytes:16});if(fs.lstatSync(ignore).nlink!==1||bytes.toString()!=='*\n')fail('agent_request_ignore_invalid');}
  else {
   try{fs.writeFileSync(ignore,'*\n',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
   const bytes=privateRead(ignore,{mode:0o600,maxBytes:16});if(fs.lstatSync(ignore).nlink!==1||bytes.toString()!=='*\n')fail('agent_request_ignore_invalid');
  }
 }
 if(receipts)for(const dir of [path.join(ctx.stateRoot,'agent-requests-v1'),path.join(ctx.stateRoot,'agent-requests-v1',ctx.binding.bot),ctx.receiptDir])privateDirectory(dir,{create:true});
}
function files(ctx) {
 if(!fs.existsSync(ctx.dir))return [];
 directories(ctx);const names=fs.readdirSync(ctx.dir);
 if(names.length>AGENT_REQUEST_LIMITS.maxFiles)fail('agent_request_scan_limit');
 if(names.some(n=>!/^request-[a-f0-9]{64}\.json$/.test(n)&&!/^request-[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/.test(n)))fail('agent_request_unexpected_file');
 return names.filter(n=>/^request-[a-f0-9]{64}\.json$/.test(n)).sort();
}
function receipt(ctx,requestKey) {
 const r=json(path.join(ctx.receiptDir,`receipt-${requestKey}.json`),{optional:true,maxBytes:8192});
 if(r&&(r.schema!==1||r.scopeHash!==ctx.scopeHash||r.requestKey!==requestKey||!['applied','rejected'].includes(r.status)||!hashValid(r.requestHash)))fail('agent_request_receipt_invalid');return r;
}
function validateRecord(ctx,name,r) {
 if(!plain(r)||!same(Object.keys(r).sort(),['schema','scopeHash','jobId','sourceHash','kind','payload','queuedAt','requestKey','requestHash'].sort())
   ||r.schema!==1||r.scopeHash!==ctx.scopeHash||!hashValid(r.sourceHash)||!Number.isSafeInteger(r.queuedAt)||r.queuedAt<0
   ||!hashValid(r.requestKey)||name!==`request-${r.requestKey}.json`)fail('agent_request_record_invalid');
 const value=payload(r.kind,r.payload===null?undefined:r.payload);
 if(r.requestKey!==key(ctx,r.jobId,r.kind,value)||r.requestHash!==digest(stableJson({...r,requestHash:undefined})))fail('agent_request_record_changed');return r;
}

// Producer authority is read-only. The sole mutation is in the selected cwd;
// queued is durable transport intake, never runtime application or delivery.
export function enqueueAgentRequest(options) {
 const ctx=context(options),job=source(ctx,options.jobId),value=payload(options.kind,options.request);
 const requestKey=key(ctx,job.id,options.kind,value),name=`request-${requestKey}.json`,file=path.join(ctx.dir,name);
 const semantic={schema:1,scopeHash:ctx.scopeHash,jobId:job.id,sourceHash:sourceHash(job),kind:options.kind,payload:value};
 if(fs.existsSync(file)){
  directories(ctx);const prior=validateRecord(ctx,name,json(file));validateJob(ctx,job,options.kind,{active:false});
  if(!same(semantic,Object.fromEntries(Object.keys(semantic).map(k=>[k,prior[k]]))))fail('agent_request_conflict');
  return {queued:true,duplicate:true,applied:false,delivered:false,requestKey,requestHash:prior.requestHash};
 }
 validateJob(ctx,job,options.kind);
 if(options.kind!=='silent')assertTurnOpen(ctx,job);
 if(job.event.synthetic_callback&&!job.event.background_completion)source(ctx,job.id,{currentAction:true});
 if(['result','link'].includes(options.kind)){
  const decisionFile=path.join(ctx.dir,`request-${key(ctx,job.id,'actionable',null)}.json`);
  if(fs.existsSync(decisionFile)&&json(decisionFile).kind==='silent')fail('agent_request_disposition_conflict');
 }
 directories(ctx,{create:true});
 let pending=0;for(const n of files(ctx)){const requestKey=n.slice(8,-5);if(!receipt(ctx,requestKey))pending++;}
 if(pending>=AGENT_REQUEST_LIMITS.maxPending)fail('agent_request_queue_full');
 const queuedAt=(options.now??Date.now)();if(!Number.isSafeInteger(queuedAt)||queuedAt<0)fail('agent_request_time_invalid');
 const r={...semantic,queuedAt,requestKey};r.requestHash=digest(stableJson(r));
 if(Buffer.byteLength(stableJson(r))>AGENT_REQUEST_LIMITS.maxBytes)fail('agent_request_payload_invalid');
 // Re-read the authoritative scope/source before publishing immutable bytes.
 const latest=context(options),current=source(latest,job.id,{currentAction:!!job.event.synthetic_callback&&!job.event.background_completion});validateJob(latest,current,options.kind);if(options.kind!=='silent')assertTurnOpen(latest,current);
 if(sourceHash(current)!==r.sourceHash)fail('agent_request_source_changed');
 const created=publishBackgroundJson(file,r),prior=validateRecord(ctx,name,json(file));
 if(!same(semantic,Object.fromEntries(Object.keys(semantic).map(k=>[k,prior[k]]))))fail('agent_request_conflict');
 return {queued:true,duplicate:!created,applied:false,delivered:false,requestKey,requestHash:prior.requestHash};
}

export class AgentRequestDispatcher {
 constructor(options){this.options=options;this.ctx=context(options);this.dir=this.ctx.dir;this.receiptDir=this.ctx.receiptDir;this.scopeHash=this.ctx.scopeHash;this.scanBlocked=0;}
 requests(){const ctx=context(this.options);if(ctx.scopeHash!==this.scopeHash)fail('agent_request_scope_changed');return files(ctx).map(name=>({name,file:path.join(ctx.dir,name)}));}
 hasPending(jobId){try{return this.requests().some(({name,file})=>{const r=validateRecord(this.ctx,name,json(file));return r.jobId===jobId&&!receipt(this.ctx,r.requestKey);});}catch{return true;}}
 drain(){
  if(this.draining)return;this.draining=true;this.scanBlocked=0;
  try{
   const ctx=context(this.options);if(ctx.scopeHash!==this.scopeHash)fail('agent_request_scope_changed');
   const list=[];
   for(const item of this.requests()){
    try{const r=validateRecord(ctx,item.name,json(item.file)),done=receipt(ctx,r.requestKey);
     if(done){if(done.requestHash!==r.requestHash)fail('agent_request_receipt_invalid');continue;}list.push(r);
    }catch(error){if(error.code!=='agent_request_publication_pending')this.scanBlocked++;}
   }
   list.sort((a,b)=>(['actionable','silent'].includes(a.kind)?0:a.kind==='link'?1:2)-(['actionable','silent'].includes(b.kind)?0:b.kind==='link'?1:2)||a.queuedAt-b.queuedAt||a.requestKey.localeCompare(b.requestKey));
   for(const r of list){
    try{
     const latest=context(this.options);if(latest.scopeHash!==ctx.scopeHash)fail('agent_request_scope_changed');
     const job=source(latest,r.jobId);if(sourceHash(job)!==r.sourceHash)fail('agent_request_source_changed');validateJob(latest,job,r.kind,{active:false});
     if(!job.markerSeen)continue;
     // Workspace bytes and their timestamps are untrusted. After the owning
     // turn ends, only its immutable real tool output proves this exact payload
     // existed before final. Later-turn output cannot authorize a new request.
     assertTurnOpen(latest,job,r);
     if(['result','link'].includes(r.kind)&&!job.event.synthetic_callback&&job.feedbackDisposition!=='actionable')continue;
     directories(ctx,{receipts:true});
     let result;
     if(r.kind==='actionable'||r.kind==='silent'){
      const prior=readDisposition({root:path.join(ctx.stateRoot,'completions-v1'),binding:ctx.binding,job});
      result=prior===r.kind?{queued:true,duplicate:true}:(r.kind==='actionable'?enqueueActionable:enqueueSilentCompletion)({root:path.join(ctx.stateRoot,'completions-v1'),inboxRoot:path.join(ctx.stateRoot,'codex-inbox-v2'),binding:ctx.binding,jobId:r.jobId});
     }
     else if(r.kind==='link')result=this.options.taskResults.link(r.jobId,r.payload.targetJobId);
     else result=this.options.taskResults.submit(r.jobId,r.payload);
     const done={schema:1,scopeHash:ctx.scopeHash,requestKey:r.requestKey,requestHash:r.requestHash,status:'applied',at:(this.options.now??Date.now)(),
      ...(result?.replyKey?{replyKey:result.replyKey}:{})};
     const target=path.join(ctx.receiptDir,`receipt-${r.requestKey}.json`);publishBackgroundJson(target,done);
     const proof=receipt(ctx,r.requestKey);if(!proof||proof.requestHash!==r.requestHash||proof.status!=='applied')fail('agent_request_receipt_invalid');
     if(['actionable','silent'].includes(r.kind))this.options.onClassification?.(r.jobId);
    }catch(error){
     // Unknown filesystem/callback outcomes remain pending. Store operations are
     // idempotent immutable publications, never a business/API replay.
     const code=error.code??'';
     if(['task_result_prior_outstanding','task_result_publication_pending','agent_request_publication_pending'].includes(code)
      ||!/^agent_request_|^task_result_|^completion_|^unknown_completion_|^invalid_completion_/.test(code))continue;
     directories(ctx,{receipts:true});publishBackgroundJson(path.join(ctx.receiptDir,`receipt-${r.requestKey}.json`),
      {schema:1,scopeHash:ctx.scopeHash,requestKey:r.requestKey,requestHash:r.requestHash,status:'rejected',at:(this.options.now??Date.now)(),error:code});
    }
   }
  }catch{this.scanBlocked++;}finally{this.draining=false;}
 }
 stats(){
  let pending=0,blocked=0,rejected=0;
  try{for(const {name,file} of this.requests()){try{const r=validateRecord(this.ctx,name,json(file)),done=receipt(this.ctx,r.requestKey);
    if(done&&done.requestHash!==r.requestHash)fail('agent_request_receipt_invalid');if(!done)pending++;else if(done.status==='rejected'){
     rejected++;try{if(source(this.ctx,r.jobId).status!=='done')blocked++;}catch{blocked++;}
    }
   }catch(error){if(error.code==='agent_request_publication_pending')pending++;else blocked++;}}}catch{blocked++;}
  // Changed configurations leave prior scopes inert. Unresolved requests stay
  // visible, while authoritative terminal sources retire historical blockers.
  try{
   const botDir=path.dirname(this.dir);
   if(fs.existsSync(botDir)){
    privateDirectory(botDir);const scopes=fs.readdirSync(botDir);if(scopes.length>256)fail('agent_request_scan_limit');
    for(const name of scopes){
     if(name===this.scopeHash)continue;if(!hashValid(name))fail('agent_request_record_invalid');
     const oldDir=path.join(botDir,name);privateDirectory(oldDir);const names=fs.readdirSync(oldDir);if(names.length>AGENT_REQUEST_LIMITS.maxFiles)fail('agent_request_scan_limit');
     for(const file of names.filter(n=>/^request-[a-f0-9]{64}\.json$/.test(n))){
      const oldCtx={...this.ctx,scopeHash:name,receiptDir:path.join(this.options.stateRoot,'agent-requests-v1',this.options.binding.bot,name)},
       r=validateRecord(oldCtx,file,json(path.join(oldDir,file))),done=receipt(oldCtx,r.requestKey);
      if(done&&done.requestHash!==r.requestHash)fail('agent_request_receipt_invalid');
      if(!done||done.status!=='applied'){
       try{if(source(this.ctx,r.jobId).status!=='done')blocked++;}catch{blocked++;}
      }
     }
    }
   }
  }catch{blocked++;}
  return {agent_request_pending_count:pending,agent_request_blocked_count:Math.max(blocked,this.scanBlocked),agent_request_rejected_count:rejected};
 }
}
