import fs from 'node:fs';
import path from 'node:path';
import {digest} from './codex-bridge-inbox.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';
import {bindingSnapshot,isBoundJob} from './codex-bridge-ux.mjs';
import {recordFailure} from './codex-bridge-retry.mjs';

const terminal=new Set(['DONE','ERROR']);
const missing=new Set(['230110','231003','231004','231005','231011']);
const permanent=new Set(['231001','231002','231006','231007','231008','231010','231013','231014','231017','231018','231019','231020','231021','231022']);
const permission=new Set(['99991672','99991668']);
const validId=id=>typeof id==='string' && /^[A-Za-z0-9_-]{1,512}$/.test(id);

export function reactionForJob(job,now=Date.now(),maxAgeMs=86400000) {
  if(now-job.acceptedAt>maxAgeMs)return null;
  // DONE means the reply outbox has committed delivery, not merely model output.
  if(job.completionDisposition==='silent')return null;
  if(job.status==='done')return 'DONE';
  if(job.status==='failed' || job.replyRetry?.blocked)return 'ERROR';
  if(job.status==='waiting_input')return 'OneSecond';
  if(job.timeoutNotified || job.error==='rollout_read_failed')return 'OneSecond';
  if(job.markerSeen && ['delivered','reply_pending'].includes(job.status))return 'Typing';
  return ['queued','submitted','delivered','reply_pending'].includes(job.status)?'OnIt':null;
}

// This feedback lane never dispatches a model task or sends a chat message.
// Intents and reaction IDs survive crashes; uncertain creates are reconciled
// against this exact app before retrying. Other users/apps are never removed.
export class DurableReactions {
  constructor({root,binding,request,resolveAppId,now=Date.now,maxAgeMs=86400000,enabled=binding.reaction_feedback!==false && binding.group_access!=='all_group_humans'}) {
    Object.assign(this,{binding,request,resolveAppId,now,maxAgeMs,enabled});
    this.dir=path.join(root,binding.bot);fs.mkdirSync(this.dir,{recursive:true});
    this.scope=digest(JSON.stringify(bindingSnapshot(binding)));
    this.metaFile=path.join(this.dir,`meta-${this.scope}.json`);
    this.meta=fs.existsSync(this.metaFile)?JSON.parse(fs.readFileSync(this.metaFile,'utf8')):{schema:1,enabledSince:now()};
    if(!fs.existsSync(this.metaFile))atomicWriteJson(this.metaFile,this.meta);
    this.rows=new Map();this.corrupt=new Set();
    for(const name of fs.readdirSync(this.dir).filter(n=>/^reaction-[a-f0-9]{64}\.json$/.test(n))) {
      try{const row=JSON.parse(fs.readFileSync(path.join(this.dir,name),'utf8'));if(row.scope===this.scope)this.rows.set(row.messageId,row);}
      catch{this.corrupt.add(name);}
    }
  }
  file(id){return path.join(this.dir,`reaction-${digest(this.scope+'\0'+id)}.json`);}
  save(row){atomicWriteJson(this.file(row.messageId),row);}
  observe(jobs) {
    for(const job of jobs) {
      if(!isBoundJob(this.binding,job) || job.event?.synthetic_callback || !/^om_[A-Za-z0-9_-]+$/.test(job.id??''))continue;
      let row=this.rows.get(job.id);
      if(!row && (!this.enabled || this.corrupt.has(path.basename(this.file(job.id))) ||
          (['done','failed'].includes(job.status) && job.acceptedAt<this.meta.enabledSince) || this.now()-job.acceptedAt>this.maxAgeMs))continue;
      if(!row){row={schema:1,scope:this.scope,messageId:job.id,createdAt:this.now(),desired:null,current:null,pending:null};this.rows.set(job.id,row);}
      // Completed acknowledgements may remain; expired active indicators clear.
      let desired=reactionForJob(job,this.now(),this.maxAgeMs);
      if(this.now()-job.acceptedAt>this.maxAgeMs && terminal.has(row.current?.emoji))desired=row.current.emoji;
      if(!this.enabled)desired=terminal.has(row.current?.emoji)?row.current.emoji:null;
      if(row.desired!==desired || !fs.existsSync(this.file(job.id))) {
        row.desired=desired;row.updatedAt=this.now();
        if(!row.retry?.blocked)delete row.retry;
        this.save(row);
      }
    }
  }
  async api(method,messageId,extra={}) {
    const {emoji,reactionId,pageToken}=extra;
    const params={message_id:messageId,...(reactionId?{reaction_id:reactionId}:{}),
      ...(method==='list'?{reaction_type:emoji,page_size:50,...(pageToken?{page_token:pageToken}:{})}:{})};
    return this.request(this.binding,['im','reactions',method,'--params',JSON.stringify(params),
      ...(method==='create'?['--data',JSON.stringify({reaction_type:{emoji_type:emoji}})]:[])]);
  }
  async recoverPending(row) {
    const emoji=row.pending.emoji;let pageToken;const seen=new Set();
    for(let page=0;page<20;page++) {
      const data=await this.api('list',row.messageId,{emoji,pageToken});
      const found=(data.items??[]).find(item=>item.operator?.operator_type==='app' && item.operator.operator_id===this.appId
        && item.reaction_type?.emoji_type===emoji && validId(item.reaction_id));
      if(found){row.current={emoji,reactionId:found.reaction_id};row.pending=null;this.save(row);return;}
      if(!data.has_more){row.pending=null;this.save(row);return;}
      if(typeof data.page_token!=='string' || !data.page_token || seen.has(data.page_token))throw Object.assign(Error('reaction_pagination_invalid'),{code:'INVALID_PAGINATION'});
      pageToken=data.page_token;seen.add(pageToken);
    }
    throw Object.assign(Error('reaction_pagination_limit'),{code:'PAGINATION_LIMIT'});
  }
  async sync(row) {
    if(row.appId && row.appId!==this.appId){row.retry={blocked:true,error:'reaction_identity_changed'};this.save(row);return;}
    if(row.pending)await this.recoverPending(row);
    // Observe can update desired while an API is in flight. Re-read the live
    // desired state after each request so late Typing cannot replace DONE.
    for(let step=0;step<4;step++) {
      if(row.current?.emoji===row.desired || (!row.current && !row.desired)){delete row.retry;this.save(row);return;}
      if(row.current) {
        try{await this.api('delete',row.messageId,{reactionId:row.current.reactionId});}
        catch(error){if(!missing.has(String(error.apiCode??error.code)))throw error;}
        row.current=null;this.save(row);continue;
      }
      const emoji=row.desired;
      row.appId=this.appId;row.pending={emoji,since:this.now()};this.save(row);
      const data=await this.api('create',row.messageId,{emoji});
      if(!validId(data.reaction_id) || data.operator?.operator_type!=='app' || data.operator.operator_id!==this.appId)
        throw Object.assign(Error('reaction_response_invalid'),{code:'INVALID_REACTION_RESPONSE'});
      row.current={emoji,reactionId:data.reaction_id};row.pending=null;row.lastAppliedAt=this.now();delete row.retry;this.save(row);
    }
  }
  fail(row,error) {
    const code=String(error.apiCode??error.code??'transport_error');
    row.retry??={};
    if(permission.has(code) || error.type==='permission' || error.type==='authentication') {
      this.meta.pauseUntil=this.now()+300000;this.meta.error=code;atomicWriteJson(this.metaFile,this.meta);
      row.retry={attempts:(row.retry.attempts??0)+1,error:code,retryAt:this.meta.pauseUntil};
    } else {
      recordFailure(row.retry,Object.assign(Error('reaction_failed'),{apiCode:code,permanent:permanent.has(code)||missing.has(code),retryAfterMs:error.retryAfterMs}),this.now());
      row.retry.retryAt=row.retry.blocked?null:Math.max(row.retry.retryAt,this.now()+3000);
    }
    this.save(row);
  }
  async flush() {
    if(this.flushing || (this.meta.pauseUntil??0)>this.now())return;
    this.flushing=true;
    try {
      for(const row of this.rows.values()) {
        if(row.retry?.blocked || (row.retry?.retryAt??0)>this.now() || (!row.pending && (row.current?.emoji??null)===row.desired))continue;
        try {
          this.appId??=await this.resolveAppId();
          if(!/^cli_[A-Za-z0-9]+$/.test(this.appId??''))throw Object.assign(Error('reaction_identity_unavailable'),{code:'INVALID_IDENTITY'});
          await this.sync(row);
          if(!row.retry){delete this.meta.error;delete this.meta.pauseUntil;atomicWriteJson(this.metaFile,this.meta);}
        } catch(error){this.fail(row,error);}
        if((this.meta.pauseUntil??0)>this.now())break;
      }
    } finally {this.flushing=false;}
  }
  stats() {
    const rows=[...this.rows.values()];
    return {reaction_pending_count:rows.filter(r=>!r.retry?.blocked&&(r.pending||(r.current?.emoji??null)!==r.desired)).length,
      reaction_blocked_count:rows.filter(r=>r.retry?.blocked).length+this.corrupt.size,
      reaction_error_count:rows.filter(r=>r.retry?.error).length+this.corrupt.size,
      reaction_last_error:this.meta.error??rows.find(r=>r.retry?.error)?.retry.error??null,
      reaction_pause_until:this.meta.pauseUntil??null};
  }
}
