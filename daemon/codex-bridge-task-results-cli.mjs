#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateRead} from './codex-bridge-background-store.mjs';
import {TaskResultStore} from './codex-bridge-task-results.mjs';
import {enqueueAgentRequest} from './codex-bridge-agent-requests.mjs';
const daemonDir=path.dirname(fileURLToPath(import.meta.url));
const fail=code=>{throw Object.assign(Error(code),{code});};
export function parseTaskResultArguments(argv) {
  const opts={};
  for(let i=0;i<argv.length;i+=2) {
    const name=argv[i];if(!['--bot','--job-id','--action','--request-file'].includes(name)||!argv[i+1]||name in opts)fail('task_result_arguments_invalid');opts[name]=argv[i+1];
  }
  if(!['complete','link'].includes(opts['--action'])||!opts['--bot']||!opts['--job-id']||!path.isAbsolute(opts['--request-file']??''))fail('task_result_arguments_invalid');return opts;
}
export function runTaskResultCli(argv,{configFile=path.join(daemonDir,'codex-thread-bindings.json'),stateRoot=path.join(daemonDir,'state'),spool=false}={}) {
  const opts=parseTaskResultArguments(argv),config=JSON.parse(privateRead(configFile,{mode:0o600,maxBytes:256*1024}));
  if(fs.lstatSync(configFile).nlink!==1)fail('task_result_private_file_invalid');
  const selected=config.bindings?.[opts['--bot']];if(!selected)fail('task_result_unknown_bot');
  const file=opts['--request-file'],cwd=fs.realpathSync(selected.cwd),relative=path.relative(cwd,file),stat=fs.lstatSync(file);
  if(file!==path.resolve(file)||fs.realpathSync(file)!==file||!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)
      ||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('task_result_request_path_invalid');
  const request=JSON.parse(privateRead(file,{mode:0o600,maxBytes:96*1024}));
  if(spool&&selected.group_access==='all_group_humans')return enqueueAgentRequest({stateRoot,configFile,binding:{...selected,bot:opts['--bot']},codexHome:config.runtime?.codex_home,
    jobId:opts['--job-id'],kind:opts['--action']==='complete'?'result':'link',request});
  const store=new TaskResultStore({root:path.join(stateRoot,'task-results-v1'),inboxRoot:path.join(stateRoot,'codex-inbox-v2'),
    completionRoot:path.join(stateRoot,'completions-v1'),backgroundRoot:path.join(stateRoot,'background-v1'),binding:{...selected,bot:opts['--bot']},codexHome:config.runtime?.codex_home});
  if(opts['--action']==='complete')return store.submit(opts['--job-id'],request);
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).length!==1||typeof request.targetJobId!=='string')fail('task_result_link_request_invalid');
  return store.link(opts['--job-id'],request.targetJobId);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const result=runTaskResultCli(process.argv.slice(2),{spool:true});process.stdout.write(JSON.stringify({ok:true,queued:result.queued??false,duplicate:result.duplicate??false,
    applied:result.applied??false,delivered:result.delivered??false,requestKey:result.requestKey,requestHash:result.requestHash,
    linked:result.linked,revision:result.revision,replyKey:result.replyKey})+'\n');}
  catch(error){process.stderr.write(JSON.stringify({ok:false,error:error.code??'task_result_request_failed'})+'\n');process.exitCode=1;}
}
