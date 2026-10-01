import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest} from './codex-bridge-inbox.mjs';
import {bindingSnapshot,isBoundJob} from './codex-bridge-ux.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const requestPath=(root,binding,id,prefix='decision')=>path.join(root,binding.bot,`${prefix}-${digest(id)}.json`);
function validate(binding,job) {
  if(binding.group_access!=='all_group_humans' || !isBoundJob(binding,job) || job.event?.synthetic_callback)fail('completion_scope_mismatch');
}
export function readDisposition({root,binding,job}) {
  const files=['decision','silent'].map(prefix=>requestPath(root,binding,job.id,prefix)).filter(file=>fs.existsSync(file));
  if(!files.length)return null;validate(binding,job);let disposition;
  for(const file of files) {
    const request=JSON.parse(fs.readFileSync(file,'utf8'));
    if(request.schema!==1 || request.jobId!==job.id || !['silent','actionable'].includes(request.disposition)
        || JSON.stringify(request.binding)!==JSON.stringify(bindingSnapshot(binding)))fail('completion_request_changed');
    if(disposition && disposition!==request.disposition)fail('completion_disposition_conflict');disposition=request.disposition;
  }
  return disposition;
}
// One immutable disposition across both tools. An exclusive hard link publishes
// fully written bytes atomically, so concurrent actionable/silent calls cannot
// both win. A crash never exposes a partial decision or changes the worker job.
function enqueueDisposition({root,inboxRoot,binding,jobId,disposition}) {
  if(!/^[A-Za-z0-9_-]+$/.test(binding.bot??'') || !/^om_[A-Za-z0-9_-]+$/.test(jobId??''))fail('invalid_completion_identity');
  const file=path.join(inboxRoot,binding.bot,`job-${digest(jobId)}.json`);
  if(!fs.existsSync(file))fail('unknown_completion_job');
  const job=JSON.parse(fs.readFileSync(file,'utf8'));
  if(job.id!==jobId)fail('completion_identity_mismatch');validate(binding,job);
  if(disposition==='actionable' && job.unclassifiedTurnEnded)fail('completion_job_turn_ended');
  const prior=readDisposition({root,binding,job});
  if(prior && prior!==disposition)fail('completion_disposition_conflict');
  if(!['submitted','delivered'].includes(job.status)
      && !(job.status==='done' && disposition==='silent' && job.completionDisposition==='silent'))fail('completion_job_not_active');
  if(prior)return {queued:true,duplicate:true};
  const target=requestPath(root,binding,jobId),request={schema:1,jobId,disposition,binding:bindingSnapshot(binding)};
  fs.mkdirSync(path.dirname(target),{recursive:true});const tmp=target+'.tmp-'+randomUUID();let fd;
  try {
    fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(request));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    try{fs.linkSync(tmp,target);}catch(error){if(error.code!=='EEXIST')throw error;const current=readDisposition({root,binding,job});if(current!==disposition)fail('completion_disposition_conflict');return {queued:true,duplicate:true};}
  } finally {if(fd!==undefined)fs.closeSync(fd);fs.rmSync(tmp,{force:true});}
  return {queued:true,duplicate:false};
}
export const enqueueSilentCompletion=options=>enqueueDisposition({...options,disposition:'silent'});
export const enqueueActionable=options=>enqueueDisposition({...options,disposition:'actionable'});
export const readSilentCompletion=options=>readDisposition(options)==='silent';
