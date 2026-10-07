import fs from 'node:fs';
import path from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';
import {digest} from './codex-bridge-inbox.mjs';
import {bindingSnapshot,isBoundJob,parseReplyUx} from './codex-bridge-ux.mjs';
import {normalizeForm} from './codex-bridge-actions.mjs';
import {isAuthorizedMessage} from './codex-bridge-authorization.mjs';
import {readDisposition} from './codex-bridge-completion.mjs';
import {privateDirectory,privateRead,stableJson} from './codex-bridge-background-store.mjs';
import {verifyBackgroundCompletion} from './codex-bridge-background.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const same=(a,b)=>stableJson(a)===stableJson(b);
const jobPattern=/^om_[A-Za-z0-9_-]{1,180}$/;
const keyPattern=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const MAX_REVISIONS=64,MAX_BYTES=96*1024;
const publicationWait=new Int32Array(new SharedArrayBuffer(4));
const eventFields=['type','message_id','message_type','content','chat_id','chat_type','sender_id','sender_type','create_time','timestamp',
  'parent_id','root_id','thread_id','reply_to','attachments','mentions','codex_thread_id','bridge_binding','synthetic_callback',
  'action_source_job_id','action_source_message_id','background_completion','background_task_id','background_nonce','background_result_sha256','background_outcome_key'];
eventFields.push('action_context_id','action_type');
const identity=job=>({id:job.id,acceptedAt:job.acceptedAt,sequence:job.sequence,taskResultProtocolVersion:job.taskResultProtocolVersion,
  taskResultProtocolScope:job.taskResultProtocolScope,
  event:Object.fromEntries(eventFields.filter(k=>job.event?.[k]!==undefined).map(k=>[k,job.event[k]]))});
const sourceHash=job=>digest(stableJson(identity(job)));
export const taskResultSourceHash=sourceHash;
export const taskResultRequestHash=request=>digest(stableJson(requestValue(request)));
function json(file,{optional=false,maxBytes=MAX_BYTES}={}) {
  const bytes=privateRead(file,{optional,maxBytes,mode:0o600});if(bytes===null)return null;
  if(fs.lstatSync(file).nlink!==1)fail('task_result_private_file_invalid');
  return JSON.parse(bytes.toString('utf8'));
}
function requestValue(request) {
  if(!plain(request)||Object.keys(request).some(k=>!['resultKey','title','text','status'].includes(k))
      ||!keyPattern.test(request.resultKey??'')||!['complete','waiting','failed','background'].includes(request.status)
      ||typeof request.text!=='string'||!request.text.trim()||Buffer.byteLength(request.text)>64*1024
      ||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(request.text)
      ||request.title!==undefined&&(typeof request.title!=='string'||!request.title.trim()||request.title.length>200||/[\r\n\u0000-\u001f\u007f]/u.test(request.title)))fail('task_result_request_invalid');
  if(parseReplyUx(request.text).form&&request.status!=='waiting')fail('task_result_form_status_mismatch');
  return {resultKey:request.resultKey,...(request.title!==undefined?{title:request.title}:{}),text:request.text,status:request.status};
}

// Frozen, source-scoped reply bytes. This store performs no platform operations.
// Exclusive publication is the CAS: no mutable latest pointer, turn-derived key,
// or message-provided protocol/association field can select an answer.
export class TaskResultStore {
  constructor({root,inboxRoot,completionRoot,binding,codexHome,backgroundRoot=path.join(path.dirname(root??''),'background-v1'),
    actionRoot=path.join(path.dirname(root??''),'actions-v1'),outboundRoot=path.join(path.dirname(root??''),'outbound-v3'),
    recoveryRoot=path.join(path.dirname(root??''),'task-result-recovery-v1'),now=Date.now}) {
    if([root,inboxRoot,completionRoot,codexHome,binding?.cwd,backgroundRoot,actionRoot,outboundRoot,recoveryRoot].some(v=>!path.isAbsolute(v??'')||v!==path.resolve(v))
        ||!keyPattern.test(binding?.bot??'')||binding.group_access!=='all_group_humans'||!binding.codex_thread_id)fail('task_result_runtime_invalid');
    const cwd=fs.realpathSync(binding.cwd);if(cwd!==binding.cwd)fail('task_result_runtime_invalid');
    if(fs.existsSync(codexHome)&&fs.realpathSync(codexHome)!==codexHome)fail('task_result_runtime_invalid');
    Object.assign(this,{root,inboxRoot,completionRoot,binding,codexHome,backgroundRoot,actionRoot,outboundRoot,recoveryRoot,now});
    this.scope={binding:bindingSnapshot(binding),cwd,codexHome,root,inboxRoot,completionRoot,backgroundRoot,actionRoot,outboundRoot};
    this.scopeHash=digest(stableJson(this.scope));this.dir=path.join(root,binding.bot,this.scopeHash);
  }
  init(){for(const d of [this.root,path.join(this.root,this.binding.bot),this.dir])privateDirectory(d,{create:true});}
  publish(file,value) {
    // Staging never appears in the commit catalog. The exclusive hard link is
    // still the immutable CAS; an abandoned staging file is never promoted.
    const staging=path.join(this.dir,'staging');privateDirectory(staging,{create:true});
    const tmp=path.join(staging,`${digest(file)}.${randomUUID()}.tmp`);let fd;
    try {
      fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,stableJson(value)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      try {fs.linkSync(tmp,file);}catch(error){if(error.code==='EEXIST')return false;throw error;}
      // Minimize the owned two-link publication interval before any reader
      // validates the committed file's permanent single-link shape.
      fs.unlinkSync(tmp);return true;
    }finally {if(fd!==undefined)fs.closeSync(fd);fs.rmSync(tmp,{force:true});}
  }
  committed(file,{optional=false}={}) {
    // A concurrent publisher can be between link and unlink. Wait only when
    // the second link is an exact, private staging inode for this destination;
    // arbitrary hard links and abandoned/unknown state still fail closed.
    for(let attempt=0;attempt<=250;attempt++) {
      const stat=fs.lstatSync(file,{throwIfNoEntry:false});if(!stat&&optional)return null;
      if(!stat||stat.nlink===1)return json(file,{optional});
      const staging=path.join(this.dir,'staging');if(stat.nlink!==2||!fs.existsSync(staging))fail('task_result_private_file_invalid');
      privateDirectory(staging);const prefix=digest(file)+'.';let matching=0;
      for(const name of fs.readdirSync(staging).filter(v=>v.startsWith(prefix)&&/^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(v))) {
        const candidate=fs.lstatSync(path.join(staging,name),{throwIfNoEntry:false});
        if(candidate?.dev===stat.dev&&candidate?.ino===stat.ino&&candidate.isFile()&&!candidate.isSymbolicLink()
            &&candidate.nlink===2&&(candidate.mode&0o777)===0o600&&(!process.getuid||candidate.uid===process.getuid()))matching++;
      }
      // Unlink may have completed while inspecting staging; recheck rather
      // than misclassifying that normal publication as an unexplained link.
      if(fs.lstatSync(file,{throwIfNoEntry:false})?.nlink===1)continue;
      if(matching!==1)fail('task_result_private_file_invalid');
      if(attempt===250)fail('task_result_publication_pending');
      Atomics.wait(publicationWait,0,0,2);
    }
  }
  source(id,{active=false}={}) {
    if(!jobPattern.test(id??''))fail('task_result_source_invalid');
    const job=json(path.join(this.inboxRoot,this.binding.bot,`job-${digest(id)}.json`),{maxBytes:8*1024*1024});
    if(job.id!==id||job.event?.message_id!==id||job.taskResultProtocolVersion!==1||!job.markerSeen
        ||!same(job.taskResultProtocolScope,{cwd:this.binding.cwd,codexHome:this.codexHome})
        ||!isBoundJob(this.binding,job))fail('task_result_source_mismatch');
    if(job.event.synthetic_callback) {
      if(job.event.background_completion) {
        if(!same(job.event.bridge_binding,bindingSnapshot(this.binding))||!verifyBackgroundCompletion(this.binding,job.event,this.backgroundRoot))fail('task_result_background_unverified');
      }else this.actionProof(job);
    } else {
      if(!same(job.event.bridge_binding,bindingSnapshot(this.binding))||job.event.sender_type!=='user'||!isAuthorizedMessage(this.binding,job.event)||job.unclassifiedTurnEnded
          ||job.completionDisposition==='silent'||job.feedbackDisposition==='silent')fail('task_result_source_unclassified');
      const decision=readDisposition({root:this.completionRoot,binding:this.binding,job});
      if(decision==='silent'||decision!=='actionable'&&job.feedbackDisposition!=='actionable')fail('task_result_source_unclassified');
    }
    if(active&&!['submitted','delivered','reply_pending','done','waiting_input','task_waiting','task_background'].includes(job.status))fail('task_result_source_not_active');
    return job;
  }
  outboundCard(messageId,expectedOwner) {
    if(!jobPattern.test(messageId??''))fail('task_result_card_identity_invalid');
    const dir=path.join(this.outboundRoot,this.binding.bot);if(!fs.existsSync(dir))fail('task_result_card_unknown');
    const files=fs.readdirSync(dir).filter(v=>/^card-[a-f0-9]{64}\.json$/.test(v));if(files.length>10000)fail('task_result_card_limit');
    const matches=[];
    for(const file of files) {
      const card=json(path.join(dir,file),{maxBytes:8*1024*1024});if(card.messageId!==messageId)continue;
      const owner=this.source(card.jobId);
      if(owner.event.synthetic_callback||expectedOwner&&owner.id!==expectedOwner||typeof card.key!=='string'
          ||file!==`card-${digest(card.key)}.json`||owner.streamKey!==card.key||card.jobId!==owner.id)fail('task_result_card_scope_changed');
      matches.push({owner,card});
    }
    if(matches.length!==1)fail(matches.length?'task_result_card_ambiguous':'task_result_card_unknown');return matches[0];
  }
  actionProof(job,{current=false}={}) {
    const event=job.event,id=job.id,contextId=event?.action_context_id;
    if(!/^om_cb_[a-f0-9]{64}$/.test(id??'')||!/^([a-f0-9]{64})$/.test(contextId??'')||event?.synthetic_callback!==true
        ||event.background_completion||!['conditions','shorter','sources','table'].includes(event.action_type))fail('task_result_action_unverified');
    const dir=path.join(this.actionRoot,this.binding.bot),context=json(path.join(dir,'contexts',contextId,'context.json'),{maxBytes:8*1024*1024}),
      operation=json(path.join(dir,'contexts',contextId,'operations',`${id}.json`),{maxBytes:256*1024});
    const secret=privateRead(path.join(dir,'context-secret'),{mode:0o600,maxBytes:128}).toString('utf8');
    if(fs.lstatSync(path.join(dir,'context-secret')).nlink!==1||!/^([a-f0-9]{64})$/.test(secret))fail('task_result_action_unverified');
    const owner=this.source(context.sourceJobId),binding={bot:this.binding.bot,chat_id:this.binding.chat_id,
      allowed_sender_id:this.binding.allowed_sender_id,codex_thread_id:this.binding.codex_thread_id};
    const identity={keyHash:context.keyHash,sourceJobId:context.sourceJobId,codexThreadId:context.codexThreadId,chatId:context.chatId,
      allowedSenderId:context.allowedSenderId,answerHash:digest(context.answer),version:context.version,form:normalizeForm(context.form),mode:context.mode};
    // Older acceptors took a second clock sample when building the event. Only
    // the exact private accepted operation may carry this bounded legacy skew.
    const eventMillis=typeof event.timestamp==='string'?Date.parse(event.timestamp):NaN;
    const canonicalTimestamp=Number.isFinite(eventMillis)&&new Date(eventMillis).toISOString()===event.timestamp;
    if(owner.event.synthetic_callback||context.bot!==this.binding.bot||context.contextId!==contextId
        ||context.keyHash!==digest(`${this.binding.bot}\0task:${owner.id}`)||!same(context.identity,identity)
        ||context.answerHash!==identity.answerHash||!same(context.form,identity.form)
        ||contextId!==createHmac('sha256',secret).update(`${context.keyHash}\0${context.version}`).digest('hex')
        ||context.chatId!==binding.chat_id||context.allowedSenderId!==binding.allowed_sender_id||context.codexThreadId!==binding.codex_thread_id
        ||!Number.isSafeInteger(context.version)||context.version<1||!['waiting','complete'].includes(context.mode)
        ||!Number.isFinite(context.createdAt)||!Number.isFinite(context.expiresAt)||context.expiresAt<=context.createdAt
        ||operation.id!==id||operation.contextId!==contextId||operation.action!==event.action_type||!same(operation.event,event)
        ||!same(operation.binding,binding)||!Number.isSafeInteger(operation.sequence)||operation.sequence<1
        ||!Number.isFinite(operation.acceptedAt)||operation.acceptedAt<context.createdAt||operation.acceptedAt>=context.expiresAt
        ||!canonicalTimestamp||eventMillis<operation.acceptedAt||eventMillis>operation.acceptedAt+1000||eventMillis>=context.expiresAt
        ||event.action_source_job_id!==owner.id
        ||event.action_source_message_id!==context.messageId||event.sender_id!==binding.allowed_sender_id
        ||event.codex_thread_id!==binding.codex_thread_id||event.chat_id!==binding.chat_id
        ||context.mode==='waiting'&&event.action_type!=='conditions')fail('task_result_action_unverified');
    const {card}=this.outboundCard(context.messageId,owner.id);
    if(current) {
      const latest=json(path.join(dir,`latest-${context.keyHash}.json`),{maxBytes:4096});
      if(latest.contextId!==contextId||latest.version!==context.version||card.presentation?.actionContext!==contextId)fail('task_result_action_stale');
    }
    const proofHash=digest(stableJson({operation,context:{identity,contextId,messageId:context.messageId,createdAt:context.createdAt,expiresAt:context.expiresAt},
      card:{key:card.key,jobId:card.jobId,messageId:card.messageId}}));
    return {ownerJobId:owner.id,action:event.action_type,version:context.version,answerHash:context.answerHash,mode:context.mode,proofHash};
  }
  verifyActionEvent(event,{current=true}={}) {
    const actual=json(path.join(this.inboxRoot,this.binding.bot,`job-${digest(event?.message_id??'')}.json`),{maxBytes:8*1024*1024});
    if(actual.taskResultProtocolVersion!==1||!same(actual.taskResultProtocolScope,{cwd:this.binding.cwd,codexHome:this.codexHome})
        ||actual.id!==event.message_id||!same(actual.event,event))fail('task_result_action_unverified');
    const proof=this.actionProof(actual,{current});return {ownerJobId:proof.ownerJobId,action:proof.action};
  }
  roleFile(id){return path.join(this.dir,`role-${digest(id)}.json`);}
  role(source) {
    if(!fs.existsSync(this.dir))return null;
    for(const d of [this.root,path.join(this.root,this.binding.bot),this.dir])privateDirectory(d);
    const role=this.committed(this.roleFile(source.id),{optional:true});if(!role)return null;
    if(role.schema!==1||role.scopeHash!==this.scopeHash||role.sourceJobId!==source.id||role.sourceHash!==sourceHash(source)
        ||!jobPattern.test(role.ownerJobId??'')||role.roleHash!==digest(stableJson({...role,roleHash:undefined})))fail('task_result_role_changed');
    const owner=this.source(role.ownerJobId);
    if(sourceHash(owner)!==role.ownerHash||owner.event.synthetic_callback)fail('task_result_owner_changed');
    if(source.id!==owner.id) {
      if(role.via==='background') {
        if(!source.event.synthetic_callback||source.event.action_source_job_id!==owner.id)fail('task_result_link_changed');
      }else if(role.via==='action') {
        const proof=this.actionProof(source);if(proof.ownerJobId!==owner.id||proof.proofHash!==role.proofHash)fail('task_result_action_changed');
      }else if(role.via!=='reply'||!this.replyAssociation(source,owner))fail('task_result_link_changed');
    }else if(role.via!=='self')fail('task_result_role_changed');
    return role;
  }
  publishRole(source,owner,via) {
    this.init();const role={schema:1,scopeHash:this.scopeHash,sourceJobId:source.id,sourceHash:sourceHash(source),ownerJobId:owner.id,ownerHash:sourceHash(owner),via};
    if(via==='action')role.proofHash=this.actionProof(source).proofHash;
    role.roleHash=digest(stableJson(role));this.publish(this.roleFile(source.id),role);
    const current=this.role(source);if(!same(role,current))fail('task_result_association_conflict');return current;
  }
  replyAssociation(source,owner) {
    if(source.id===owner.id||source.event.synthetic_callback||source.event.sender_id!==owner.event.sender_id)return false;
    let current=source;const seen=new Set([source.id]);
    for(let i=0;i<32;i++) {
      if(current.event.parent_id&&current.event.reply_to&&current.event.parent_id!==current.event.reply_to)return false;
      const parent=current.event.parent_id??current.event.reply_to;
      if(!parent||!jobPattern.test(parent)||seen.has(parent))return false;seen.add(parent);
      const inboxFile=path.join(this.inboxRoot,this.binding.bot,`job-${digest(parent)}.json`);
      if(!fs.existsSync(inboxFile)) {
        const cardOwner=this.outboundCard(parent).owner;return cardOwner.id===owner.id&&cardOwner.event.sender_id===source.event.sender_id;
      }
      current=this.source(parent);if(current.event.synthetic_callback||current.event.sender_id!==owner.event.sender_id)return false;
      if(current.id===owner.id)return true;
    }
    return false;
  }
  link(sourceJobId,targetJobId) {
    const source=this.source(sourceJobId,{active:true}),target=this.source(targetJobId),targetRole=this.role(target);
    const owner=this.source(targetRole?.ownerJobId??target.id);
    if(!this.replyAssociation(source,owner))fail('task_result_link_unverified');
    if(this.history(source).length)fail('task_result_association_conflict');
    // Reserve the root owner as well: a supplement may finish it before its
    // first result, and owner lookup must still discover that frozen answer.
    this.publishRole(owner,owner,'self');
    this.publishRole(source,owner,'reply');return {linked:true,sourceJobId:source.id,ownerJobId:owner.id,businessExecuted:false};
  }
  history(owner) {
    const dir=path.join(this.dir,`results-${digest(owner.id)}`);if(!fs.existsSync(dir))return [];
    privateDirectory(dir);const files=fs.readdirSync(dir).sort();
    if(files.length>MAX_REVISIONS||files.some((f,i)=>f!==`v-${String(i+1).padStart(6,'0')}.json`))fail('task_result_history_invalid');
    const results=[];
    for(const [i,file] of files.entries()) {
      const r=this.committed(path.join(dir,file)),source=this.source(r.sourceJobId),request=requestValue(r.request);
      if(r.schema!==1||r.scopeHash!==this.scopeHash||r.ownerJobId!==owner.id||r.ownerHash!==sourceHash(owner)||r.sourceHash!==sourceHash(source)
          ||r.revision!==i+1||r.previous!==(results.at(-1)?.recordHash??null)||!same(r.request,request)
          ||r.replyKey!==digest(`${this.scopeHash}\0${owner.id}\0${request.resultKey}`)
          ||r.recordHash!==digest(stableJson({...r,recordHash:undefined})))fail('task_result_record_changed');
      const role=this.role(source);if(!role||role.ownerJobId!==owner.id)fail('task_result_association_conflict');
      const expectedUpdate=role.via==='action'&&['shorter','sources','table'].includes(source.event.action_type)?'answer_revision':undefined;
      if(r.updateKind!==expectedUpdate)fail('task_result_record_changed');
      if(r.recovery) {
        if(i!==0||source.id!==owner.id||source.event.synthetic_callback||role.via!=='self')fail('task_result_recovery_invalid');
        this.recoveryProof(source,request,{fresh:false,record:r.recovery});
      }
      if(results.some(v=>v.request.resultKey===r.request.resultKey))fail('task_result_history_invalid');results.push(r);
    }
    return results;
  }
  receipt(result) {
    const receipt=json(path.join(this.inboxRoot,this.binding.bot,`sent-${result.replyKey}.json`),{optional:true,maxBytes:4096});
    if(!receipt)return false;
    const proof=receipt.finalDeliveryEvidence;
    if(!Number.isFinite(receipt.sentAt)||receipt.sentAt<0||receipt.local||proof?.schema!==1||!Number.isFinite(proof.at)||proof.at<0
        ||!['send_response','create_response','reconciled_observation'].includes(proof.source))fail('task_result_receipt_invalid');
    return true;
  }
  recoveryFile(jobId,resultKey) {
    if(!jobPattern.test(jobId??'')||!keyPattern.test(resultKey??''))fail('task_result_recovery_invalid');
    return path.join(this.recoveryRoot,this.binding.bot,this.scopeHash,`${digest(jobId)}-${digest(resultKey)}.json`);
  }
  recoveryProof(source,value,{fresh=true,record}={}) {
    for(const dir of [this.recoveryRoot,path.join(this.recoveryRoot,this.binding.bot),path.join(this.recoveryRoot,this.binding.bot,this.scopeHash)])privateDirectory(dir);
    const proof=json(this.recoveryFile(source.id,value.resultKey),{maxBytes:16384});
    const fields=['schema','action','reviewed','scopeHash','sourceHash','markerTurnId','blockedCode','blockedAt','requestHash','requestFile','requestFileSha256','reviewedAt'];
    if(!plain(proof)||Object.keys(proof).length!==fields.length||Object.keys(proof).some(k=>!fields.includes(k))||proof.schema!==1
        ||proof.action!=='resume_delivery_only'||proof.reviewed!==true||proof.scopeHash!==this.scopeHash||proof.sourceHash!==sourceHash(source)
        ||typeof source.markerTurnId!=='string'||!source.markerTurnId||proof.markerTurnId!==source.markerTurnId
        ||proof.blockedCode!=='turn_ended_without_task_result'||!Number.isFinite(proof.blockedAt)||proof.blockedAt<0
        ||proof.requestHash!==taskResultRequestHash(value)||!/^[a-f0-9]{64}$/.test(proof.requestFileSha256??''))fail('task_result_recovery_invalid');
    const reviewedAt=Date.parse(proof.reviewedAt),age=this.now()-reviewedAt;
    if(!Number.isFinite(reviewedAt)||new Date(reviewedAt).toISOString()!==proof.reviewedAt
        ||fresh&&(age<0||age>15*60*1000))fail('task_result_recovery_expired');
    const file=proof.requestFile,relative=path.relative(this.binding.cwd,file??'');
    if(!path.isAbsolute(file??'')||file!==path.resolve(file)
        ||!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))fail('task_result_recovery_request_invalid');
    if(fresh) {
      if(fs.realpathSync(file)!==file)fail('task_result_recovery_request_invalid');
      const raw=privateRead(file,{mode:0o600,maxBytes:MAX_BYTES});
      if(fs.lstatSync(file).nlink!==1||digest(raw)!==proof.requestFileSha256
          ||!same(requestValue(JSON.parse(raw.toString('utf8'))),value))fail('task_result_recovery_request_changed');
    }
    const hash=digest(stableJson(proof));
    if(record&&(!same(record,{proofHash:hash,blockedCode:proof.blockedCode,blockedAt:proof.blockedAt,markerTurnId:proof.markerTurnId})))fail('task_result_recovery_changed');
    return {proofHash:hash,blockedCode:proof.blockedCode,blockedAt:proof.blockedAt,markerTurnId:proof.markerTurnId};
  }
  recover(jobId,request) {
    const value=requestValue(request),source=this.source(jobId,{active:true}),role=this.role(source);
    if(source.event.synthetic_callback||role&&role.ownerJobId!==source.id)fail('task_result_recovery_source_invalid');
    const history=this.history(source),existing=history.find(r=>r.request.resultKey===value.resultKey);
    if(existing) {
      if(!existing.recovery||existing.sourceJobId!==source.id||!same(existing.request,value))fail('task_result_recovery_conflict');
      this.recoveryProof(source,value,{fresh:false,record:existing.recovery});
      return {...this.output(existing,source.id),queued:true,duplicate:true,delivered:this.receipt(existing)};
    }
    if(history.length||source.taskResult||source.replyKey||source.finalDeliveryEvidence||!source.streamKey
        ||source.taskResultProtocolBlocked!=='turn_ended_without_task_result'||!Number.isFinite(source.taskResultProtocolBlockedAt)
        ||!['submitted','delivered'].includes(source.status))fail('task_result_recovery_source_invalid');
    const recovery=this.recoveryProof(source,value);
    if(recovery.blockedAt!==source.taskResultProtocolBlockedAt)fail('task_result_recovery_changed');
    this.assertRecoveryDelivery(source,value);
    return this.#submit(jobId,value,recovery);
  }
  assertRecoveryDelivery(source,value) {
    if(source.taskResult||source.replyKey||source.finalDeliveryEvidence||!source.streamKey)fail('task_result_recovery_source_invalid');
    const card=json(path.join(this.outboundRoot,this.binding.bot,`card-${digest(source.streamKey)}.json`),{maxBytes:8*1024*1024});
    if(card.key!==source.streamKey||card.jobId!==source.id||!jobPattern.test(card.messageId??'')||card.final||card.cardClosed||card.blocked||card.finalDelivered||card.taskResult
        ||card.finalReplyKey||card.finalClosedReplyKey||card.finalDeliveryEvidence||card.deliveryUncertain)fail('task_result_recovery_card_invalid');
    const receipt=path.join(this.inboxRoot,this.binding.bot,`sent-${digest(`${this.scopeHash}\0${source.id}\0${value.resultKey}`)}.json`);
    if(fs.existsSync(receipt))fail('task_result_recovery_already_sent');
  }
  submit(jobId,request) {return this.#submit(jobId,request,null);}
  #submit(jobId,request,recovery) {
    const value=requestValue(request),source=this.source(jobId,{active:true});let role=this.role(source);
    if(!role) {
      const action=source.event.synthetic_callback&&!source.event.background_completion?this.actionProof(source,{current:true}):null;
      const owner=source.event.synthetic_callback?this.source(action?.ownerJobId??source.event.action_source_job_id):source;
      if(source.event.background_completion&&this.history(owner).at(-1)?.request.status!=='background')fail('task_result_background_owner_invalid');
      role=this.publishRole(source,owner,action?'action':source.event.synthetic_callback?'background':'self');
    }
    const owner=this.source(role.ownerJobId),history=this.history(owner),existing=history.find(r=>r.request.resultKey===value.resultKey);
    if(existing) {
      if(existing.sourceJobId!==source.id||!same(existing.request,value))fail('task_result_key_conflict');
      return {...this.output(existing,source.id),queued:true,duplicate:true,delivered:this.receipt(existing)};
    }
    const prior=history.at(-1);
    // A finished original turn cannot author a later answer. Continuations must
    // submit under their own newly accepted reply-chain/callback source.
    if(!['submitted','delivered'].includes(source.status)||source.unclassifiedTurnEnded
        ||source.taskResultProtocolBlocked==='turn_ended_without_task_result'&&!recovery)fail('task_result_submitter_not_active');
    if(prior) {
      if(!this.receipt(prior))fail('task_result_prior_outstanding');
      const action=role.via==='action'?this.actionProof(source,{current:true}):null;
      if(action&&(action.version!==prior.revision||action.answerHash!==digest(parseReplyUx(prior.request.text).text)
          ||action.action==='conditions'&&prior.request.status!=='waiting'))fail('task_result_action_stale');
      if(!['waiting','background'].includes(prior.request.status)
          &&!(prior.request.status==='complete'&&action&&['shorter','sources','table'].includes(action.action)))fail('task_result_terminal_frozen');
    }else if(!['submitted','delivered'].includes(owner.status)||source.id!==owner.id&&role.via!=='reply')fail('task_result_initial_source_not_active');
    if(history.length>=MAX_REVISIONS)fail('task_result_revision_limit');
    const result={schema:1,scopeHash:this.scopeHash,ownerJobId:owner.id,ownerHash:sourceHash(owner),sourceJobId:source.id,sourceHash:sourceHash(source),
      revision:history.length+1,previous:prior?.recordHash??null,request:value,replyKey:digest(`${this.scopeHash}\0${owner.id}\0${value.resultKey}`)};
    if(recovery)result.recovery={...recovery};
    if(role.via==='action'&&['shorter','sources','table'].includes(source.event.action_type))result.updateKind='answer_revision';
    result.recordHash=digest(stableJson(result));const dir=path.join(this.dir,`results-${digest(owner.id)}`);privateDirectory(dir,{create:true});
    // Re-read authorization and source identity immediately before immutable publication.
    if(sourceHash(this.source(source.id,{active:true}))!==result.sourceHash||sourceHash(this.source(owner.id))!==result.ownerHash)fail('task_result_source_changed');
    if(recovery) {
      const latest=this.source(source.id,{active:true});this.recoveryProof(latest,value,{record:recovery});
      if(latest.taskResultProtocolBlocked!==recovery.blockedCode||latest.taskResultProtocolBlockedAt!==recovery.blockedAt
          ||latest.streamKey!==source.streamKey||this.history(latest).length)fail('task_result_recovery_changed');
      this.assertRecoveryDelivery(latest,value);
    }
    if(role.via==='action')this.actionProof(source,{current:true});
    const file=path.join(dir,`v-${String(result.revision).padStart(6,'0')}.json`);
    if(!this.publish(file,result)) {
      const current=this.history(owner).find(r=>r.request.resultKey===value.resultKey);
      if(!current||!same(current,result))fail('task_result_revision_conflict');
      return {...this.output(current,source.id),queued:true,duplicate:true,delivered:this.receipt(current)};
    }
    return {...this.output(result,source.id),queued:true,duplicate:false,delivered:false};
  }
  output(result,forJobId) {
    return Object.freeze({...result.request,replyKey:result.replyKey,ownerJobId:result.ownerJobId,sourceJobId:forJobId===result.ownerJobId?result.sourceJobId:forJobId,
      resultSourceJobId:result.sourceJobId,
      ...(result.updateKind?{updateKind:result.updateKind}:{}),
      revision:result.revision,linked:forJobId!==result.ownerJobId});
  }
  get(job) {
    if(job?.taskResultProtocolVersion!==1)return null;
    const source=this.source(job.id);if(!same(identity(job),identity(source)))fail('task_result_source_changed');
    let role=this.role(source);
    if(!role&&source.event.synthetic_callback) {
      const owner=this.source(source.event.background_completion?source.event.action_source_job_id:this.actionProof(source).ownerJobId);role={ownerJobId:owner.id};
    }
    if(!role)return null;
    const owner=this.source(role.ownerJobId),result=this.history(owner).at(-1);
    if(result)return this.output(result,source.id);
    return source.id===owner.id?null:Object.freeze({linked:true,ownerJobId:owner.id,sourceJobId:source.id,revision:0});
  }
  stats() {
    let pending=0,blocked=0;
    try {
      if(!fs.existsSync(this.dir))return {task_result_pending_count:0,task_result_blocked_count:0};
      privateDirectory(this.dir);
      for(const file of fs.readdirSync(this.dir).filter(v=>/^role-[a-f0-9]{64}\.json$/.test(v))) {
        try {const row=this.committed(path.join(this.dir,file));if(file!==`role-${digest(row.sourceJobId)}.json`)fail('task_result_role_changed');
          const role=this.role(this.source(row.sourceJobId));if(!role)fail('task_result_role_changed');
          if(role.sourceJobId!==role.ownerJobId)continue;
          const owner=this.source(role.ownerJobId),result=this.history(owner).at(-1);if(result&&!this.receipt(result))pending++;
        }catch{blocked++;}
      }
    }catch{blocked++;}
    return {task_result_pending_count:pending,task_result_blocked_count:blocked};
  }
}
