import fs from 'node:fs';
import path from 'node:path';
import {bindingSnapshot} from './codex-bridge-ux.mjs';

const plain=value=>value && typeof value==='object' && !Array.isArray(value);
const stable=value=>JSON.stringify(value,(_,v)=>plain(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const failure=code=>Object.assign(Error(code),{code,permanent:true});

export function opsScope(binding,codexHome) {
  return {...bindingSnapshot(binding),cwd:binding.cwd,codexHome};
}

// A scoped maintenance opt-in, never a message-provided capability. Absent
// policy leaves every legacy bot unchanged; damaged policy fails this feature
// closed without preventing the existing bridge from receiving messages.
function privateJson(file,{maxBytes=16384,optional=false}={}) {
  if(optional && !fs.existsSync(file))return null;
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.uid!==process.getuid()
      || (stat.mode&0o777)!==0o600 || stat.size>maxBytes || fs.realpathSync(file)!==path.resolve(file))
    throw failure('ops_private_file_invalid');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}

export function readOpsPolicy({root,binding,codexHome}) {
  try {
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(binding.bot??''))throw failure('ops_bot_invalid');
    const file=path.join(root,binding.bot,'policy.json');
    if(!fs.existsSync(file))return {enabled:false,reason:null};
    for(const dir of [root,path.dirname(file)]) {
      const stat=fs.lstatSync(dir);
      if(!stat.isDirectory() || stat.isSymbolicLink() || stat.uid!==process.getuid()
          || (stat.mode&0o077) || fs.realpathSync(dir)!==path.resolve(dir))throw failure('ops_private_directory_invalid');
    }
    const policy=privateJson(file);
    if(!plain(policy) || policy.schema!==1
        || Object.keys(policy).some(k=>!['schema','scope','enabled','monitoring','routing','taskControls','timezone'].includes(k))
        || stable(policy.scope)!==stable(opsScope(binding,codexHome))
        || ['enabled','monitoring','routing','taskControls'].some(k=>typeof policy[k]!=='boolean')
        || policy.timezone!=='Australia/Brisbane'
        || binding.group_access!=='all_group_humans' || binding.fast_actionable_classification!==true)
      throw failure('ops_policy_scope_or_fields_invalid');
    return {...policy,reason:null};
  }catch{return {enabled:false,reason:'ops_policy_invalid'};}
}

// Health is a dated readback from the original watchdog's actual subscriber
// probes. Stale/missing/partial evidence is unknown, never manufactured healthy.
export function readOpsHealth({daemonDir,binding,now=Date.now()}) {
  try {
    const state=privateJson(path.join(daemonDir,'state','macos-watchdog.status.json'),{maxBytes:256*1024});
    const checkedAt=Date.parse(state.checked_at),age=now-checkedAt,sub=state.subscribers?.[binding.bot];
    if(!Number.isFinite(age) || age<0 || age>90000 || !Number.isSafeInteger(state.pid)
        || typeof sub?.socket?.verified!=='boolean' || typeof state.bridge?.healthy!=='boolean')return {};
    process.kill(state.pid,0);
    return {transport_healthy:sub.socket.verified,delivery_healthy:state.bridge.healthy};
  }catch{return {};}
}

export function definitelyFailedOpsSend(error) {
  // The original router sets this flag only after a definite, first-attempt
  // platform rejection. A timeout followed by a rejection remains uncertain.
  return error?.deliveryUncertain===false;
}
