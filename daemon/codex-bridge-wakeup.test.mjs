import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WakeSignal,EventFileWakeup} from './codex-bridge-wakeup.mjs';
import {DurableInbox,digest} from './codex-bridge-inbox.mjs';

function root(t) {const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'wake-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function fakeWatch() {
 const watchers=[];
 return {watchers,watch:(dir,callback)=>{const watcher=new EventEmitter();Object.assign(watcher,{dir,callback,closed:false,close(){this.closed=true;this.emit('close');}});watchers.push(watcher);return watcher;}};
}
test('signals before wait and during async lane work remain pending, with coalesced burst and timed fallback',async()=>{
 const wake=new WakeSignal();wake.signal();wake.signal();await wake.wait(10000);assert.equal(wake.pending,false);
 const wait=wake.wait(10000);wake.signal();await wait;
 // The lane has resumed work; a new signal must not disappear with the old wait.
 wake.signal();await delay(1);await wake.wait(10000);assert.equal(wake.pending,false);
 const start=Date.now();await wake.wait(20);assert.ok(Date.now()-start>=15);wake.close();
});
test('close resolves an active wait and removes all pending timers without permitting a second waiter',async()=>{
 const wake=new WakeSignal(),waiting=wake.wait(10000);assert.throws(()=>wake.wait(),/already_active/);
 wake.close();await waiting;assert.equal(wake.waiter,null);wake.signal();await wake.wait(10000);assert.equal(wake.pending,false);
});
test('watch filters the exact file and accepts rename/unknown-name events without parsing or trusting message data',()=>{
 const fake=fakeWatch(),wake=new WakeSignal(),watcher=new EventFileWakeup('/fixture/events/bot.ndjson',wake,{watch:fake.watch,stat:()=>({dev:1,ino:2})});
 fake.watchers[0].callback('change','other.ndjson');assert.equal(wake.pending,false);
 fake.watchers[0].callback('rename',Buffer.from('bot.ndjson'));assert.equal(wake.pending,true);wake.pending=false;
 fake.watchers[0].callback('change',null);assert.equal(wake.pending,true);watcher.close();wake.close();
 assert.equal(fake.watchers[0].closed,true);
});
test('watch failure, missing directory and directory inode replacement rearm with fallback intact',async()=>{
 const fake=fakeWatch(),wake=new WakeSignal();let available=false,ino=2;
 const watcher=new EventFileWakeup('/fixture/events/bot.ndjson',wake,{watch:fake.watch,stat:()=>{if(!available)throw Error('ENOENT');return {dev:1,ino};}});
 assert.equal(watcher.watcher,null);await wake.wait(10);
 available=true;watcher.ensure();assert.equal(fake.watchers.length,1);
 fake.watchers[0].emit('error',Error('watch_failed'));assert.equal(watcher.watcher,null);assert.equal(fake.watchers[0].closed,true);
 watcher.ensure();assert.equal(fake.watchers.length,2);ino++;watcher.ensure();assert.equal(fake.watchers.length,3);assert.equal(fake.watchers[1].closed,true);
 watcher.close();watcher.ensure();assert.equal(fake.watchers.length,3);wake.close();
});
test('real directory watch or its 500ms fallback covers append and atomic NDJSON replacement then releases the listener',async t=>{
 const dir=root(t),file=path.join(dir,'bot.ndjson');fs.writeFileSync(file,'');
 const wake=new WakeSignal(),watcher=new EventFileWakeup(file,wake);t.after(()=>{watcher.close();wake.close();});
 // macOS can drop directory events during parallel fixture churn. Exact event
 // signaling is tested deterministically above; real ingress must also survive
 // that loss via the same 500ms wait used by the worker.
 fs.appendFileSync(file,'{"fixture":1}\n');await wake.wait(500);assert.equal(wake.waiter,null);
 assert.equal(fs.readFileSync(file,'utf8'),'{"fixture":1}\n');
 await delay(20);wake.pending=false;
 const temp=path.join(dir,'new');fs.writeFileSync(temp,'{"fixture":2}\n');fs.renameSync(temp,file);
 await wake.wait(500);assert.equal(fs.readFileSync(file,'utf8'),'{"fixture":2}\n');
 const handle=watcher.watcher;watcher.close();assert.equal(watcher.watcher,null);assert.ok(handle);
});
test('durable enqueue is persisted before dispatch wake; duplicate accepts never retrigger business execution',async t=>{
 const dir=root(t),rollout=path.join(dir,'rollout');fs.writeFileSync(rollout,'');const wake=new WakeSignal();let queued=0,injects=0,inbox;
 inbox=new DurableInbox(dir,'fixture',{onQueued:()=>{queued++;assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'fixture',`job-${digest('om_once')}.json`),'utf8')).status,'queued');wake.signal();},
  prepare:async e=>e,target:async()=>({rollout}),inject:async()=>{injects++;}});
 inbox.enqueue({message_id:'om_once'});inbox.enqueue({message_id:'om_once'});await wake.wait(10000);
 await Promise.all([inbox.dispatchOne(),inbox.dispatchOne()]);assert.equal(queued,1);assert.equal(injects,1);
 const resumed=new DurableInbox(dir,'fixture',{onQueued:()=>assert.fail('duplicate cannot wake'),inject:()=>assert.fail('submitted cannot replay')});
 resumed.enqueue({message_id:'om_once'});assert.equal(await resumed.dispatchOne(),false);wake.close();
});
test('failed durable accept never signals dispatch, and separate bots cannot wake or block each other',async t=>{
 const dir=root(t),a=new WakeSignal(),b=new WakeSignal();let inbox=new DurableInbox(dir,'a',{onQueued:()=>a.signal()});
 inbox.save=()=>{throw Error('storage_failed');};assert.throws(()=>inbox.enqueue({message_id:'om_failed'}),/storage_failed/);assert.equal(a.pending,false);assert.equal(inbox.jobs.size,0);
 const other=new DurableInbox(dir,'b',{onQueued:()=>b.signal()});const waiting=b.wait(10000);other.enqueue({message_id:'om_other'});await waiting;
 assert.equal(a.pending,false);assert.equal(other.jobs.size,1);a.close();b.close();
});
test('runtime routes watcher hints only through persistent intake and wakes a single dispatch lane with 500ms fallback',()=>{
 const source=fs.readFileSync(new URL('./codex-bridge-worker.mjs',import.meta.url),'utf8');
 assert.match(source,/EventFileWakeup\(binding\.logPath,intakeWake\)/);
 assert.match(source,/onQueued:\(\)=>dispatchWake\.signal\(\)/);
 assert.match(source,/loop\('intake',intake,500,intakeWake\)/);
 assert.match(source,/loop\('dispatch',\(\)=>inbox\.dispatchOne\(\),500,dispatchWake\)/);
 assert.match(source,/if\(i===99\)intakeWake\.signal\(\)/);
 assert.match(source,/process\.once\('SIGTERM', stop\)/);
});
