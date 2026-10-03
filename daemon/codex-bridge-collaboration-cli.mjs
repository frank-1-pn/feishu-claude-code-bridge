#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {privateRead} from './codex-bridge-background-store.mjs';
import {CollaborationContext} from './codex-bridge-collaboration.mjs';
const daemonDir=path.dirname(fileURLToPath(import.meta.url));
export function parseCollaborationArguments(argv) {
  const opts={};
  for(let i=0;i<argv.length;i+=2) {
    const name=argv[i];if(!['--bot','--job-id','--action','--request-file'].includes(name)||!argv[i+1]||name in opts)throw Error('collaboration_arguments_invalid');
    opts[name]=argv[i+1];
  }
  if(!['register','resolve','propose','record','decide'].includes(opts['--action'])||!opts['--bot']||!opts['--job-id']
      ||opts['--action']==='resolve'&&opts['--request-file']!==undefined
      ||opts['--action']!=='resolve'&&!path.isAbsolute(opts['--request-file']??''))throw Error('collaboration_arguments_invalid');
  return opts;
}
export function runCollaborationCli(argv,{configFile=path.join(daemonDir,'codex-thread-bindings.json'),stateRoot=path.join(daemonDir,'state'),now=Date.now}={}) {
  const opts=parseCollaborationArguments(argv),config=JSON.parse(privateRead(configFile,{mode:0o600,maxBytes:256*1024}).toString('utf8'));
  const selected=config.bindings?.[opts['--bot']];if(!selected)throw Error('collaboration_unknown_bot');
  const context=new CollaborationContext({root:path.join(stateRoot,'collaboration-v1'),inboxRoot:path.join(stateRoot,'codex-inbox-v2'),
    completionRoot:path.join(stateRoot,'completions-v1'),binding:{...selected,bot:opts['--bot']},codexHome:config.runtime?.codex_home,now});
  let request={};
  if(opts['--request-file']) {
    const file=opts['--request-file'],cwd=fs.realpathSync(selected.cwd),relative=path.relative(cwd,file),stat=fs.lstatSync(file);
    if(!path.isAbsolute(file)||file!==path.resolve(file)||!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)
        ||fs.realpathSync(file)!==path.resolve(file)||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)
      throw Error('collaboration_request_path_invalid');
    request=JSON.parse(privateRead(file,{mode:0o600,maxBytes:16384}).toString('utf8'));
  }
  if(!request||typeof request!=='object'||Array.isArray(request)||'jobId' in request)throw Error('collaboration_request_invalid');
  const input={...request,jobId:opts['--job-id']};
  if(opts['--action']==='resolve') {
    if(Object.keys(request).length)throw Error('collaboration_request_invalid');return context.resolve(input);
  }
  return context[{register:'register',propose:'proposeChange',record:'recordChange',decide:'decideChange'}[opts['--action']]](input);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {process.stdout.write(JSON.stringify({ok:true,...runCollaborationCli(process.argv.slice(2))})+'\n');}
  catch(error){process.stderr.write(JSON.stringify({ok:false,error:error.code??'collaboration_request_failed'})+'\n');process.exitCode=1;}
}
