import fs from 'node:fs';
import {createLarkTransport} from './codex-bridge-lark.mjs';
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i]]=process.argv[i+1];
if(!/^oc_[A-Za-z0-9]+$/.test(args['--chat-id']||''))throw Error('invalid_chat_id');
const text=fs.readFileSync(args['--text-file'],'utf8');
try {await createLarkTransport(process.env.LARK_CLI_EXE||'/opt/homebrew/bin/lark-cli')({profile:args['--profile']||''},['im','+messages-send','--chat-id',args['--chat-id'],'--text',text]);}
catch {process.stderr.write('send_failed\n');process.exitCode=1;}
