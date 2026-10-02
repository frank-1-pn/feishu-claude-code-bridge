import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './codex-bridge-inbox.mjs';
import { bindingSnapshot, isBoundJob } from './codex-bridge-ux.mjs';
import { isAuthorizedMessage } from './codex-bridge-authorization.mjs';
import { readDisposition } from './codex-bridge-completion.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';

export const backgroundFailure=code=>Object.assign(Error(code),{code});
export const stableJson=value=>JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export const backgroundTaskId=(bot,sourceJobId,taskKey)=>digest(`${bot}\0${sourceJobId}\0${taskKey}`);
export const backgroundBinding=binding=>({...bindingSnapshot(binding),cwd:fs.realpathSync(binding.cwd)});
function noSymlinkParents(file) {
  const absolute=path.resolve(file);let current=path.parse(absolute).root;
  for(const part of absolute.slice(current.length).split(path.sep).slice(0,-1)) {
    current=path.join(current,part);const stat=fs.lstatSync(current);
    if(!stat.isDirectory() || stat.isSymbolicLink())throw backgroundFailure('background_private_path_invalid');
  }
}
export function privateDirectory(dir,{create=false}={}) {
  if(create)fs.mkdirSync(dir,{recursive:true,mode:0o700});
  noSymlinkParents(path.join(dir,'entry'));const stat=fs.lstatSync(dir);
  if(!stat.isDirectory() || stat.isSymbolicLink() || stat.mode&0o077
      || (process.getuid && stat.uid!==process.getuid()))throw backgroundFailure('background_private_directory_invalid');
}
export function privateRead(file,{maxBytes=512*1024,optional=false,mode}={}) {
  const before=fs.lstatSync(file,{throwIfNoEntry:false});
  if(!before && optional)return null;
  noSymlinkParents(file);let fd;
  try {
    fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));const stat=fs.fstatSync(fd);
    if(!before || !stat.isFile() || before.isSymbolicLink() || stat.dev!==before.dev || stat.ino!==before.ino || stat.size>maxBytes
        || stat.mode&0o022 || (mode!==undefined && (stat.mode&0o777)!==mode) || (process.getuid && stat.uid!==process.getuid()))throw backgroundFailure('background_private_file_invalid');
    const bytes=fs.readFileSync(fd);if(bytes.length>maxBytes)throw backgroundFailure('background_private_file_invalid');return bytes;
  } finally {if(fd!==undefined)fs.closeSync(fd);}
}
export const BACKGROUND_PROXY_FIELDS=Object.freeze(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NO_PROXY','no_proxy']);
export function readBackgroundTransport({root,binding,codexHome}) {
  privateDirectory(root);privateDirectory(path.join(root,binding.bot));
  const bytes=privateRead(path.join(root,binding.bot,'transport.json'),{optional:true,maxBytes:32*1024,mode:0o600});
  if(bytes===null)return null;
  const transport=JSON.parse(bytes.toString('utf8'));
  if(!transport || typeof transport!=='object' || Array.isArray(transport) || transport.schema!==1 || Object.keys(transport).some(key=>!['schema','binding','codexHome','proxyEnv'].includes(key))
      || stableJson(transport.binding)!==stableJson(backgroundBinding(binding)) || transport.codexHome!==codexHome
      || !transport.proxyEnv || typeof transport.proxyEnv!=='object' || Array.isArray(transport.proxyEnv)
      || Object.entries(transport.proxyEnv).some(([key,value])=>!BACKGROUND_PROXY_FIELDS.includes(key) || typeof value!=='string' || value.length>8192))
    throw backgroundFailure('background_transport_invalid');
  return transport.proxyEnv;
}
export const readBackgroundJson=(file,options)=>{
  const bytes=privateRead(file,options);return bytes===null?null:JSON.parse(bytes.toString('utf8'));
};
export function publishBackgroundJson(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=`${file}.${randomUUID()}.tmp`;let fd;
  try {
    fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,stableJson(value)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    try{fs.linkSync(tmp,file);return true;}catch(error){if(error.code!=='EEXIST')throw error;return false;}
  } finally {if(fd!==undefined)fs.closeSync(fd);fs.rmSync(tmp,{force:true});}
}
const sourceFingerprint=job=>({id:job.id,acceptedAt:job.acceptedAt,sequence:job.sequence,
  identity:Object.fromEntries(['type','message_id','chat_id','sender_id','sender_type','chat_type','codex_thread_id','bridge_binding']
    .filter(key=>job.event?.[key]!==undefined).map(key=>[key,job.event[key]]))});
export function backgroundSourceActionable({job,binding,completionRoot}) {
  if(!job.markerSeen || job.unclassifiedTurnEnded || job.completionDisposition==='silent' || job.feedbackDisposition==='silent')return false;
  const disposition=completionRoot?readDisposition({root:completionRoot,binding,job}):null;
  return disposition==='actionable' || (disposition!== 'silent' && job.feedbackDisposition==='actionable');
}
export function readBackgroundSource({inboxRoot,binding,jobId,active=false,completionRoot}) {
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(binding.bot??'') || !/^om_[A-Za-z0-9_-]+$/.test(jobId??''))throw backgroundFailure('background_identity_invalid');
  const job=readBackgroundJson(path.join(inboxRoot,binding.bot,`job-${digest(jobId)}.json`),{maxBytes:8*1024*1024});
  if(job.id!==jobId || job.event?.message_id!==jobId || job.event?.synthetic_callback
      || job.event?.sender_type!=='user' || !isAuthorizedMessage(binding,job.event)
      || !isBoundJob(binding,job) || stableJson(job.event?.bridge_binding)!==stableJson(bindingSnapshot(binding)))
    throw backgroundFailure('background_source_binding_mismatch');
  if(active) {
    if(!['submitted','delivered'].includes(job.status) || !job.markerSeen || job.unclassifiedTurnEnded
        || job.completionDisposition==='silent' || job.feedbackDisposition==='silent')throw backgroundFailure('background_source_not_active');
    if(!backgroundSourceActionable({job,binding,completionRoot}))throw backgroundFailure('background_source_unclassified');
  }
  return job;
}
function requestFields(task) {
  return {bot:task.bot,sourceJobId:task.sourceJobId,taskKey:task.taskKey,title:task.title,prompt:task.prompt,
    runAtInput:task.runAtInput,timeoutMs:task.timeoutMs,binding:task.binding,sourceFingerprint:task.sourceFingerprint,
    inboxRoot:task.inboxRoot,sourceEvent:task.sourceEvent,codexCliJs:task.codexCliJs,codexHome:task.codexHome};
}
export function readBackgroundTask(root,binding,taskId) {
  if(!/^[a-f0-9]{64}$/.test(taskId??''))throw backgroundFailure('background_task_identity_invalid');
  for(const dir of [root,path.join(root,binding.bot),path.join(root,binding.bot,taskId)])privateDirectory(dir);
  const task=readBackgroundJson(path.join(root,binding.bot,taskId,'task.json'),{maxBytes:128*1024});
  if(task.schema!==1 || task.id!==taskId || task.bot!==binding.bot
      || backgroundTaskId(task.bot,task.sourceJobId,task.taskKey)!==task.id
      || !Number.isFinite(task.createdAt) || !Number.isFinite(task.runAt) || task.runAt!==(task.runAtInput===null?task.createdAt:Date.parse(task.runAtInput))
      || digest(stableJson(requestFields(task)))!==task.requestHash)throw backgroundFailure('background_task_changed');
  return task;
}
export function validateBackgroundTaskSource(task,{inboxRoot,binding,completionRoot,active=false}) {
  if(stableJson(task.binding)!==stableJson(backgroundBinding(binding)) || task.inboxRoot!==path.resolve(inboxRoot))
    throw backgroundFailure('background_task_binding_changed');
  const job=readBackgroundSource({inboxRoot,binding,jobId:task.sourceJobId,completionRoot,active});
  if(stableJson(sourceFingerprint(job))!==stableJson(task.sourceFingerprint))throw backgroundFailure('background_source_changed');
  return job;
}
export function enqueueBackgroundTask({root,inboxRoot,binding,jobId,taskKey,title,promptFile,runAt,timeoutMs=1800000,
  codexCliJs,codexHome,completionRoot=path.join(path.dirname(root),'completions-v1'),now=Date.now}) {
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(taskKey??'') || typeof title!=='string' || !title.trim() || title.length>200)
    throw backgroundFailure('background_request_invalid');
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<60000 || timeoutMs>1800000)throw backgroundFailure('background_timeout_invalid');
  const source=readBackgroundSource({inboxRoot,binding,jobId,completionRoot,active:true});
  if(!path.isAbsolute(promptFile??'') || fs.realpathSync(promptFile)!==path.resolve(promptFile))throw backgroundFailure('background_prompt_path_invalid');
  const cwd=fs.realpathSync(binding.cwd),relative=path.relative(cwd,promptFile);
  if(!relative || relative.startsWith(`..${path.sep}`) || relative==='..' || path.isAbsolute(relative))throw backgroundFailure('background_prompt_outside_cwd');
  const bytes=privateRead(promptFile,{maxBytes:64*1024});
  const prompt=bytes.toString('utf8');if(!bytes.length || !prompt.trim() || !bytes.equals(Buffer.from(prompt)))throw backgroundFailure('background_prompt_invalid');
  if(runAt!==undefined && (typeof runAt!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(runAt)
      || !Number.isFinite(Date.parse(runAt)) || new Date(runAt.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==runAt.slice(0,10)))throw backgroundFailure('background_run_at_invalid');
  const runAtInput=runAt===undefined?null:new Date(runAt).toISOString();
  if(!path.isAbsolute(codexCliJs??'') || !path.isAbsolute(codexHome??''))throw backgroundFailure('background_runtime_invalid');
  const createdAt=now(),id=backgroundTaskId(binding.bot,jobId,taskKey);
  const task={schema:1,id,bot:binding.bot,sourceJobId:jobId,taskKey,title:title.trim(),prompt,createdAt,
    runAt:runAtInput===null?createdAt:Date.parse(runAtInput),runAtInput,timeoutMs,codexCliJs,codexHome,cwd,
    inboxRoot:path.resolve(inboxRoot),binding:backgroundBinding(binding),sourceFingerprint:sourceFingerprint(source),sourceEvent:Object.fromEntries(['type','message_id','chat_id','chat_type','sender_id','sender_type','mentions','root_id','parent_id','thread_id','create_time','timestamp'].filter(key=>source.event[key]!==undefined).map(key=>[key,source.event[key]]))};
  task.requestHash=digest(stableJson(requestFields(task)));
  if(Buffer.byteLength(stableJson(task)+'\n')>128*1024)throw backgroundFailure('background_snapshot_too_large');
  for(const dir of [root,path.join(root,binding.bot),path.join(root,binding.bot,id)])privateDirectory(dir,{create:true});
  const file=path.join(root,binding.bot,id,'task.json');
  const duplicate=!publishBackgroundJson(file,task);
  if(duplicate && readBackgroundTask(root,binding,id).requestHash!==task.requestHash)throw backgroundFailure('background_task_conflict');
  return {taskId:id,status:'queued',queued:true,duplicate,delivered:false};
}
export function backgroundTaskStatus({root,inboxRoot,binding,jobId,taskKey}) {
  const taskId=backgroundTaskId(binding.bot,jobId,taskKey),task=readBackgroundTask(root,binding,taskId);
  if(task.sourceJobId!==jobId || task.taskKey!==taskKey)throw backgroundFailure('background_task_source_mismatch');
  validateBackgroundTaskSource(task,{inboxRoot,binding});
  const schedule=readBackgroundJson(path.join(root,binding.bot,taskId,'schedule.json'),{optional:true});
  return {taskId,status:schedule?.status??'queued',notification:schedule?.notification?.status??'pending',delivered:schedule?.notification?.status==='notified'};
}
export function cancelBackgroundTask(options) {
  const status=backgroundTaskStatus(options),dir=path.join(options.root,options.binding.bot,status.taskId);
  if(status.notification==='notified')return {...status,cancelled:false};
  let claim=readBackgroundJson(path.join(dir,'claim.json'),{optional:true});
  const run=readBackgroundJson(path.join(dir,'run.json'),{optional:true});
  if(claim?.taskId===status.taskId && run?.schema===1 && run.taskId===status.taskId && run.nonce===claim.nonce && run.taskSha256===digest(privateRead(path.join(dir,'task.json'),{maxBytes:128*1024}))
      && ['completed','failed','cancelled','timed_out'].includes(run.status))
    return {...status,status:run.status,alreadyFinished:true,cancelRequested:false};
  const prior=readBackgroundJson(path.join(dir,'cancel.json'),{optional:true});
  const record={schema:1,taskId:status.taskId,nonce:claim?.nonce??null,requestedAt:prior?.requestedAt??(options.now??Date.now)()};
  if(!prior || prior.nonce!==record.nonce)atomicWriteJson(path.join(dir,'cancel.json'),record);
  // Close the race where the scheduler claimed while CLI published cancellation.
  claim=readBackgroundJson(path.join(dir,'claim.json'),{optional:true});
  if(claim && record.nonce!==claim.nonce)atomicWriteJson(path.join(dir,'cancel.json'),{...record,nonce:claim.nonce});
  return {...status,cancelRequested:true,delivered:false};
}
