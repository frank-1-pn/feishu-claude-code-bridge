import test from 'node:test';import assert from 'node:assert/strict';
import {selectWriterPty} from './resolve-codex-pty.mjs';import {normalizeCallback} from './macos-event-adapter.mjs';
test('writer maps by ancestry, not shared cwd or title',()=>{
 assert.deepEqual(selectWriterPty([31],[{pid:31,ppid:21},{pid:21,ppid:11}], [{pid:11,isAlive:true,sessionId:'correct'},{pid:10,isAlive:true,sessionId:'other'}]).pty_session_id,'correct');
});
test('active writer with missing or ambiguous PTY fails closed',()=>{
 assert.throws(()=>selectWriterPty([31],[],[]),/not_found/);
 assert.throws(()=>selectWriterPty([31],[{pid:31,ppid:11}],[{pid:11,isAlive:true,sessionId:'a'},{pid:11,isAlive:true,sessionId:'b'}]),/ambiguous/);
});
test('new CLI callbacks retain authenticated operator and context',()=>{
 const out=normalizeCallback({type:'card.action.trigger',operator_id:'ou_owner',chat_id:'oc_chat',message_id:'om_card',action_value:'{"bridge_native":"v1"}',form_value:'{"field":"hello"}'});
 assert.equal(out.event.operator.open_id,'ou_owner');assert.equal(out.event.context.open_chat_id,'oc_chat');assert.equal(out.event.action.value.bridge_native,'v1');assert.equal(out.event.action.form_value.field,'hello');
});
test('malformed callback JSON is rejected rather than forwarded',()=>{assert.throws(()=>normalizeCallback({type:'card.action.trigger',action_value:'{'}));});
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('worker config-only entry initializes without starting subscriptions or worker',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'macos-worker-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const placeholder=path.join(root,'executable');fs.writeFileSync(placeholder,'test fixture');
 const config={version:1,runtime:{codex_home:root,codex_cli_js:placeholder,orca_cli_exe:placeholder,lark_send_script:placeholder,lark_cli_exe:placeholder,poll_interval_ms:1000,heartbeat_interval_ms:15000,pty_turn_timeout_ms:60000,max_inbound_bytes:1024,max_event_age_ms:60000},bindings:{test:{codex_thread_id:'12345678-1234-4234-8234-123456789abc',cwd:root,chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',profile:'fixture'}}};
 const file=path.join(root,'bindings.json');fs.writeFileSync(file,JSON.stringify(config));
 const result=spawnSync(process.execPath,[path.join(import.meta.dirname,'codex-bridge-worker.mjs'),'--bindings',file,'--check-config'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).ok,true);
 assert.equal(fs.existsSync(path.join(import.meta.dirname,'state/events/test.ndjson')),false);
 config.bindings.test.group_access='all_group_humans';config.bindings.test.bot_open_id='ou_bot';
 fs.writeFileSync(file,JSON.stringify(config));
 assert.equal(spawnSync(process.execPath,[path.join(import.meta.dirname,'codex-bridge-worker.mjs'),'--bindings',file,'--check-config'],{encoding:'utf8'}).status,0);
 for(const change of [{group_access:'unknown'},{bot_open_id:''}]) {
   fs.writeFileSync(file,JSON.stringify({...config,bindings:{test:{...config.bindings.test,...change}}}));
   assert.notEqual(spawnSync(process.execPath,[path.join(import.meta.dirname,'codex-bridge-worker.mjs'),'--bindings',file,'--check-config'],{encoding:'utf8'}).status,0);
 }

});
import {workerHealth,busHealth,retryDelay} from './macos-health.mjs';
test('watchdog uses real process identity and fresh heartbeat, not recent chat activity',()=>{
 const now=100000;const snapshot={heartbeat_at:new Date(99900).toISOString()};
 assert.equal(workerHealth(snapshot,{now,alive:true,identity:true}).healthy,true);
 assert.equal(workerHealth(snapshot,{now,alive:true,identity:false}).healthy,false);
 assert.equal(workerHealth({heartbeat_at:new Date(1000).toISOString()},{now,alive:true,identity:true}).healthy,false);
 assert.equal(workerHealth({heartbeat_at:new Date(200000).toISOString()},{now,alive:true,identity:true}).healthy,false);
});
test('bus readiness never claims verified socket pong; bounded recovery backoff',()=>{
 assert.equal(busHealth({apps:[{running:true,consumers:[{event_key:'im.message.receive_v1'},{event_key:'card.action.trigger'}]}]}).socket_verified,false);
 assert.equal(busHealth({apps:[{running:true,consumers:[]}]}).healthy,false);
 assert.equal(retryDelay(1),5000);assert.equal(retryDelay(99),60000);
});
import {socketHealth} from './macos-health.mjs';
test('real pong freshness rejects silent loss, old process, wrong profile and frozen ping loop',()=>{
 const now=1000000,identity={pid:42,profile:'fixture',startedAt:900000,now};
 const good={schema:1,pid:42,profile:'fixture',started_at_ms:900000,updated_at_ms:now,state:'connected',ping_interval_ms:15000,last_pong_at_ms:now-1000,recovering_since_ms:0,pending_ping_since_ms:0};
 assert.equal(socketHealth(good,identity).verified,true);
 assert.equal(socketHealth({...good,pid:43},identity).verified,false);
 assert.equal(socketHealth({...good,profile:'other'},identity).needs_restart,true);
 assert.equal(socketHealth({...good,pending_ping_since_ms:now-31000},identity).reason,'pong_timeout');
 assert.equal(socketHealth({...good,last_pong_at_ms:now-61000},identity).reason,'pong_stale');
 assert.equal(socketHealth({...good,last_pong_at_ms:0,state:'awaiting_pong',unverified_since_ms:now-46000},identity).reason,'first_pong_timeout');
 assert.equal(socketHealth({...good,recovering_since_ms:now-61000},identity).reason,'reconnect_expired');
});
import {safeDiagnosis,diagnose} from './macos-fallback.mjs';
test('independent model fallback cannot invent commands or restart healthy components',()=>{
 assert.equal(safeDiagnosis({action:'rm -rf /'},{bridge:{healthy:true}}).action,'manual_review');
 assert.equal(safeDiagnosis({action:'restart_bridge'},{bridge:{healthy:true}}).action,'none');
 assert.equal(safeDiagnosis({action:'restart_socket'},{socket:{needs_restart:false}}).action,'none');
 assert.equal(safeDiagnosis({action:'restart_bridge'},{bridge:{healthy:false}}).action,'restart_bridge');
});
test('disabled fallback sends no external request',async()=>{assert.equal((await diagnose({enabled:false},{},{fetchImpl:()=>{throw Error('must not call');}})).reason,'disabled');});
