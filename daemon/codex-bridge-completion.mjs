import fs from 'node:fs';
import path from 'node:path';
import {digest} from './codex-bridge-inbox.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';
import {bindingSnapshot,isBoundJob} from './codex-bridge-ux.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const requestPath=(root,binding,id)=>path.join(root,binding.bot,`silent-${digest(id)}.json`);
function validate(binding,job) {
  if(binding.group_access!=='all_group_humans' || !isBoundJob(binding,job) || job.event?.synthetic_callback)fail('completion_scope_mismatch');
}
// Write a separate immutable control request, never mutate a live worker's job.
// Rollout marker proof is independently required before the worker can commit.
export function enqueueSilentCompletion({root,inboxRoot,binding,jobId}) {
  if(!/^[A-Za-z0-9_-]+$/.test(binding.bot??'') || !/^om_[A-Za-z0-9_-]+$/.test(jobId??''))fail('invalid_completion_identity');
  const file=path.join(inboxRoot,binding.bot,`job-${digest(jobId)}.json`);
  if(!fs.existsSync(file))fail('unknown_completion_job');
  const job=JSON.parse(fs.readFileSync(file,'utf8'));
  if(job.id!==jobId)fail('completion_identity_mismatch');
  validate(binding,job);
  if(!['submitted','delivered'].includes(job.status) && !(job.status==='done' && job.completionDisposition==='silent'))fail('completion_job_not_active');
  const target=requestPath(root,binding,jobId);
  const request={schema:1,jobId,disposition:'silent',binding:bindingSnapshot(binding)};
  if(fs.existsSync(target)) {
    if(JSON.stringify(JSON.parse(fs.readFileSync(target,'utf8')))!==JSON.stringify(request))fail('completion_request_changed');
    return {queued:true,duplicate:true};
  }
  fs.mkdirSync(path.dirname(target),{recursive:true});atomicWriteJson(target,request);
  return {queued:true,duplicate:false};
}
export function readSilentCompletion({root,binding,job}) {
  const file=requestPath(root,binding,job.id);
  if(!fs.existsSync(file))return false;
  validate(binding,job);
  const request=JSON.parse(fs.readFileSync(file,'utf8'));
  if(request.schema!==1 || request.jobId!==job.id || request.disposition!=='silent'
      || JSON.stringify(request.binding)!==JSON.stringify(bindingSnapshot(binding)))fail('completion_request_changed');
  return true;
}
