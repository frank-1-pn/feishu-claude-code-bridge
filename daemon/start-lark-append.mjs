// One-shot launcher: one subscriber, append descriptors, no pipe relay.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { atomicWriteText } from './codex-bridge-storage.mjs';
import { pathToFileURL } from 'node:url';

export async function launchAppend({ executable, args, log, errorLog, pidFile }) {
  const out = fs.openSync(log, 'a+', 0o600), err = fs.openSync(errorLog, 'a', 0o600);
  try {
    const size = fs.fstatSync(out).size;
    if (size) {
      const last = Buffer.alloc(1); fs.readSync(out,last,0,1,size-1);
      if(last[0]!==10) fs.writeSync(out,'\n');
    }
    fs.writeSync(err,`\nbridge-subscriber-start ${new Date().toISOString()}\n`);
    const child = spawn(executable,args,{windowsHide:true,detached:true,stdio:['ignore',out,err],env:{...process.env,LARK_CLI_NO_PROXY:'1'}});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    atomicWriteText(pidFile,String(child.pid)); child.unref(); return child.pid;
  } finally { fs.closeSync(out);fs.closeSync(err); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [executable,log,errorLog,pidFile,profile='']=process.argv.slice(2);
  const args=subscriberArgs(profile);
  const pid=await launchAppend({executable,args,log,errorLog,pidFile});process.stdout.write(JSON.stringify({pid})+'\n');
}

// Both event types share the same authenticated WebSocket and CLI singleton.
// The v1.0.39 generic processor preserves nested action/operator/context fields.
export function subscriberArgs(profile='') {
  return [...(profile?['--profile',profile]:[]),'event','+subscribe','--event-types',
    'im.message.receive_v1,card.action.trigger','--compact','--as','bot'];
}
