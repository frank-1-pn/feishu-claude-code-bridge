#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {enqueueActionable} from './codex-bridge-completion.mjs';
import {enqueueAgentRequest} from './codex-bridge-agent-requests.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));
try {
  const opts={};
  for(let i=2;i<process.argv.length;i+=2){const name=process.argv[i];if(!['--bot','--job-id','--state'].includes(name)||!process.argv[i+1]||name in opts)throw Error('invalid_arguments');opts[name]=process.argv[i+1];}
  if(opts['--state']!=='actionable')throw Error('invalid_state');
  const config=JSON.parse(fs.readFileSync(path.join(dir,'codex-thread-bindings.json'),'utf8').replace(/^\uFEFF/,''));
  const binding=config.bindings[opts['--bot']];if(!binding)throw Error('unknown_bot');
  const result=binding.group_access==='all_group_humans'
    ?enqueueAgentRequest({stateRoot:path.join(dir,'state'),configFile:path.join(dir,'codex-thread-bindings.json'),binding:{...binding,bot:opts['--bot']},codexHome:config.runtime?.codex_home,jobId:opts['--job-id'],kind:'actionable'})
    :enqueueActionable({root:path.join(dir,'state','completions-v1'),inboxRoot:path.join(dir,'state','codex-inbox-v2'),binding:{...binding,bot:opts['--bot']},jobId:opts['--job-id']});
  process.stdout.write(JSON.stringify({ok:true,...result})+'\n');
} catch(error){process.stderr.write(JSON.stringify({ok:false,error:error.code??'feedback_request_failed'})+'\n');process.exitCode=1;}
