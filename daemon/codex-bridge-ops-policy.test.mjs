import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {opsScope,readOpsPolicy,readOpsHealth,definitelyFailedOpsSend} from './codex-bridge-ops-policy.mjs';

const binding={bot:'fixture',profile:'fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_owner',codex_thread_id:'thread',cwd:'/fixture',group_access:'all_group_humans',bot_open_id:'ou_bot',fast_actionable_classification:true};
const home='/fixture/home';
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-ops-policy-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function publish(root,value){const dir=path.join(root,binding.bot);fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(path.join(dir,'policy.json'),JSON.stringify(value),{mode:0o600});}
const policy=()=>({schema:1,scope:opsScope(binding,home),enabled:true,monitoring:true,routing:true,taskControls:true,timezone:'Australia/Brisbane'});
test('absent scoped opt-in leaves other bots unchanged',t=>{const root=fixture(t);assert.deepEqual(readOpsPolicy({root,binding,codexHome:home}),{enabled:false,reason:null});});
test('exact owned private scope enables only the requested operational bot',t=>{const root=fixture(t);publish(root,policy());assert.equal(readOpsPolicy({root,binding,codexHome:home}).enabled,true);assert.equal(readOpsPolicy({root,binding:{...binding,cwd:'/another'},codexHome:home}).enabled,false);assert.equal(readOpsPolicy({root,binding,codexHome:'/another'}).enabled,false);});
test('changed identity, unknown fields, missing booleans, and wrong timezone fail closed',t=>{
 const root=fixture(t);publish(root,policy());const file=path.join(root,binding.bot,'policy.json');
 for(const v of [{...policy(),extra:true},{...policy(),routing:undefined},{...policy(),timezone:'Asia/Shanghai'},{...policy(),scope:{...policy().scope,chat_id:'oc_other'}}]){fs.writeFileSync(file,JSON.stringify(v));assert.equal(readOpsPolicy({root,binding,codexHome:home}).reason,'ops_policy_invalid');}
});
test('policy cannot be supplied through links, public modes, or a shared directory',t=>{
 const root=fixture(t);publish(root,policy());const file=path.join(root,binding.bot,'policy.json');fs.chmodSync(file,0o644);assert.equal(readOpsPolicy({root,binding,codexHome:home}).enabled,false);fs.chmodSync(file,0o600);fs.chmodSync(path.dirname(file),0o755);assert.equal(readOpsPolicy({root,binding,codexHome:home}).enabled,false);fs.chmodSync(path.dirname(file),0o700);fs.renameSync(file,file+'.real');fs.symlinkSync(file+'.real',file);assert.equal(readOpsPolicy({root,binding,codexHome:home}).enabled,false);
});
test('watchdog health is dated evidence, missing or stale facts stay unknown',t=>{
 const root=fixture(t),dir=path.join(root,'state');fs.mkdirSync(dir,{mode:0o700});const file=path.join(dir,'macos-watchdog.status.json'),now=Date.now();
 const write=value=>fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});
 const state={pid:process.pid,checked_at:new Date(now-1000).toISOString(),bridge:{healthy:true},subscribers:{fixture:{socket:{verified:true}}}};write(state);assert.deepEqual(readOpsHealth({daemonDir:root,binding,now}),{transport_healthy:true,delivery_healthy:true});
 write({...state,checked_at:new Date(now-90001).toISOString()});assert.deepEqual(readOpsHealth({daemonDir:root,binding,now}),{});
 write({...state,subscribers:{fixture:{socket:{}}}});assert.deepEqual(readOpsHealth({daemonDir:root,binding,now}),{});
 write({...state,bridge:{healthy:false}});assert.equal(readOpsHealth({daemonDir:root,binding,now}).delivery_healthy,false);
});
test('unknown network outcomes never become definite failures',()=>{assert.equal(definitelyFailedOpsSend(Error('timeout')),false);assert.equal(definitelyFailedOpsSend({deliveryUncertain:true,permanent:true}),false);assert.equal(definitelyFailedOpsSend({deliveryUncertain:false}),true);});
