import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {DeferredPerformance,performanceMetadata} from './codex-bridge-performance.mjs';
import {DurableInbox} from './codex-bridge-inbox.mjs';

const base=1790852400000;
function job(extra={}) {return {id:'om_privateMessage',event:{create_time:base,content:'客户私有正文',sender_id:'ou_privateSender'},status:'done',markerSeen:true,feedbackDisposition:'actionable',
  acceptedAt:base+100,submittedAt:base+200,deliveredAt:base+300,completedAt:base+900,finalDeliveryEvidence:{schema:1,at:base+900,source:'send_response'},firstCardSentAt:base+400,firstCardTimingSource:'create_response',firstTypingVerifiedAt:base+350,firstTypingVerifiedTimingSource:'reconciled_observation',...extra};}
function fixture(t) {const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'perf-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
async function drain(p) {for(let i=0;i<100 && p.pending.size;i++)await delay(10);assert.equal(p.pending.size,0);}

test('performance metadata contains only hashed identity, durations, counts and enumerated status/source',()=>{
  const r=performanceMetadata('privateBot',job({readonlyPrefetchIncluded:true,prepared:{bridgeReadonly:{status:'complete',startedAt:base+150,fetchedAt:base+170,result:{events:[{title:'私有客户',event_id:'private'}]}}}}));
  assert.match(r.key,/^[a-f0-9]{64}$/);assert.equal(r.timings_ms.original_to_intake,100);assert.equal(r.timings_ms.original_to_marker,300);assert.equal(r.timings_ms.original_to_final_delivery,900);
  assert.equal(r.timings_ms.prefetch,20);assert.equal(r.prefetch.used,true);assert.equal(r.prefetch.event_count,1);assert.equal(r.sources.card,'create_response');assert.equal(r.sources.typing,'reconciled_observation');
  assert.doesNotMatch(JSON.stringify(r),/privateBot|om_private|ou_private|私有|17908524|正文|event_id/);
});
test('historical and uninjected completed jobs stay legacy_unknown or unused, with missing timings null',()=>{
  assert.equal(performanceMetadata('bot',job()).prefetch.status,'legacy_unknown');assert.equal(performanceMetadata('bot',job()).prefetch.used,false);
  const r=performanceMetadata('bot',job({event:{create_time:'bad'},firstCardSentAt:undefined,firstCardTimingSource:'secret',firstTypingVerifiedTimingSource:'secret',readonlyPrefetchIncluded:true,markerSeen:false,prepared:{bridgeReadonly:{status:'complete',result:{events:[{}]}}}}));
  assert.equal(r.timings_ms.original_to_marker,null);assert.equal(r.timings_ms.intake_to_first_card,null);assert.equal(r.prefetch.used,false);assert.equal(r.prefetch.event_count,0);assert.equal(r.sources.card,'unknown');
});
test('deferred recording runs after delivery without waiting for maintenance and ignores pending jobs',async t=>{
  const root=fixture(t),scheduled=[],p=new DeferredPerformance(path.join(root,'perf'),{schedule:fn=>scheduled.push(fn)});
  const inbox=new DurableInbox(path.join(root,'inbox'),'fixture',{final:async()=>{},send:async()=>assert.fail('no automatic tests or messages')},{now:()=>base+900});
  const e={message_id:'om_privateMessage',content:'private',create_time:base},j=inbox.enqueue(e);Object.assign(j,job({event:e,status:'reply_pending',reply:'business result',replyKey:'fixtureReply'}));inbox.save(j);
  await inbox.deliverReplies();assert.equal(j.status,'done');p.observe('fixture',inbox.jobs.values());assert.equal(scheduled.length,1);assert.equal(fs.existsSync(path.join(root,'perf')),false);
  p.observe('fixture',[job({id:'om_pending',status:'delivered'})]);assert.equal(scheduled.length,1);
  scheduled[0]();await drain(p);assert.equal(fs.readdirSync(path.join(root,'perf')).length,1);
});
test('completed records dedupe across restart and repair incomplete crash writes without touching inbox',async t=>{
  const root=fixture(t),dir=path.join(root,'perf'),j=job(),r=performanceMetadata('bot',j);
  let p=new DeferredPerformance(dir);p.observe('bot',[j,j]);await drain(p);const file=path.join(dir,`perf-${r.key}.json`),before=fs.statSync(file).mtimeMs;
  p=new DeferredPerformance(dir);p.observe('bot',[j]);await drain(p);assert.equal(fs.statSync(file).mtimeMs,before);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),r);
  fs.writeFileSync(file,'{"crashed":');p=new DeferredPerformance(dir);p.observe('bot',[j]);await drain(p);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),r);
  assert.equal(fs.statSync(file).mode&0o777,0o600);assert.deepEqual(fs.readdirSync(dir),[path.basename(file)]);
});
test('metadata write failures only produce safe private categories and never block final or mark success',async t=>{
  const root=fixture(t),file=path.join(root,'not-dir');fs.writeFileSync(file,'');const errors=[],p=new DeferredPerformance(file,{onError:e=>errors.push(e)});
  p.observe('bot',[job()]);await drain(p);assert.deepEqual(errors,['performance_write_failed']);assert.equal(p.recorded.size,0);
});
