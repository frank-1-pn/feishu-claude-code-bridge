import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {DurableInbox} from './codex-bridge-inbox.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {parseSingleDayQuery,prefetchReadonly,prepareReadonlyInput,verifiedReadonly,readonlyEligible,projectReadonlyResult,validateReadonlyConfig,runReadonlyHelper,readonlyScope} from './codex-bridge-readonly.mjs';

function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'readonly-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const helper=path.join(root,'reader.py');fs.writeFileSync(helper,'# pinned fixture, never executed\n');
  const binding={bot:'fixture',profile:'fixture-profile',chat_id:'oc_fixture',allowed_sender_id:'ou_owner',bot_open_id:'ou_bot',
    codex_thread_id:'fixture-thread',group_access:'all_group_humans',cwd:root,
    readonly_prefetch:{version:1,enabled:true,helper_path:helper,helper_sha256:createHash('sha256').update(fs.readFileSync(helper)).digest('hex'),timezone:'Australia/Brisbane'}};
  const event={type:'im.message.receive_v1',message_id:'om_one',message_type:'text',chat_type:'group',chat_id:binding.chat_id,sender_type:'user',sender_id:'ou_member',
    create_time:Date.parse('2026-10-01T14:30:00Z'),content:JSON.stringify({text:'查一下10月4号的安排'}),bridge_binding:bindingSnapshot(binding)};
  let now=event.create_time,calls=[];
  const value={operation:'agenda',date:'2026-10-04',timezone:'Australia/Brisbane',status:'complete',events:[{
    title:'丹翠雨林',status:'confirmed',start:'2026-10-04',end:'2026-10-04',participants_complete:true,
    participants:[{participant:1,type:'user',rsvp:'decline'}]}]};
  const run=async(file,args,opts)=>{calls.push({file,args,opts});return {code:0,stdout:JSON.stringify(value)};};
  return {root,helper,binding,event,value,run,calls,now:()=>now,advance:ms=>now+=ms};
}

test('single-day grammar resolves exact and Chinese dates using the original Brisbane year',t=>{
  const f=fixture(t);
  for(const [text,day] of [['查一下10月4号的安排','2026-10-04'],['查询2027年1月2日日程','2027-01-02'],['查看2028-02-29的行程','2028-02-29'],['请帮我查2026-10-04安排？','2026-10-04']])
    assert.equal(parseSingleDayQuery({...f.event,content:text})?.date,day,text);
});
test('relative days use original message milliseconds across Brisbane midnight and year boundaries',t=>{
  const f=fixture(t);
  for(const [text,day] of [['查询今天的安排','2026-10-02'],['查询明天的安排','2026-10-03'],['查询后天的安排','2026-10-04']])assert.equal(parseSingleDayQuery({...f.event,content:text})?.date,day);
  assert.equal(parseSingleDayQuery({...f.event,create_time:Date.parse('2026-12-31T14:01:00Z'),content:'查询明天安排'})?.date,'2027-01-02');
});
test('ambiguity, multiline, quotation, private-calendar perspectives, writes and multi-day queries remain unknown',t=>{
  const f=fixture(t);
  for(const text of ['查询明天我的日程','查看蔡可明天安排','查一下今天和明天安排','查一下10月4日至6日日程','查询下周日程','取消明天日程','不要查询今天安排','“查询今天安排”','他说查询今天安排','查询今天安排；然后取消','查询今天安排\n再查邮件','查询2026-02-29安排','查询2026-13-01安排','查一下10月4号的安排。如果有空再安排'])
    assert.equal(parseSingleDayQuery({...f.event,content:text}),null,text);
  for(const extra of [{parent_id:'om_previous'},{root_id:'om_previous'},{message_type:'post'},{attachments:[{}]},{synthetic_callback:true},{content:{text:'查一下今天安排',image_key:'img_fake'}}])assert.equal(parseSingleDayQuery({...f.event,...extra}),null);
});
test('invalid, missing, seconds, nonfinite and oversized original timestamps safely return unknown',t=>{
  const f=fixture(t);for(const create_time of [undefined,'bad',NaN,Infinity,9999999,1e20])assert.equal(parseSingleDayQuery({...f.event,create_time}),null);
  assert.equal(parseSingleDayQuery(f.event,'Asia/Shanghai'),null);
});
test('prefetch is disabled by default and opt-in config fails closed on incomplete or widened values',async t=>{
  const f=fixture(t),off={...f.binding};delete off.readonly_prefetch;
  assert.equal(await prefetchReadonly(off,f.event,{run:f.run}),null);assert.equal(f.calls.length,0);
  assert.equal(validateReadonlyConfig({...f.binding,readonly_prefetch:{version:1,enabled:false}}),null);
  for(const changes of [{enabled:'true'},{version:2},{helper_sha256:'bad'},{helper_path:'reader.py'},{timezone:'Asia/Shanghai'},{timeout_ms:50000},{max_age_ms:0},{extra:'flag'}])
    assert.throws(()=>validateReadonlyConfig({...f.binding,readonly_prefetch:{...f.binding.readonly_prefetch,...changes}}),/invalid_readonly_prefetch_config/);
});
test('only matched bot, profile, group, human sender, thread and bound snapshots can prefetch',async t=>{
  const f=fixture(t);
  for(const extra of [{bridge_binding:undefined},{bridge_binding:{...f.event.bridge_binding,bot:'other'}},{bridge_binding:{...f.event.bridge_binding,profile:'other'}},
    {chat_id:'oc_other'},{chat_type:'p2p'},{sender_type:'bot'},{sender_id:'ou_bot'},{codex_thread_id:'other'},{message_id:'unbound'}])
    assert.equal(await prefetchReadonly(f.binding,{...f.event,...extra},{run:f.run}),null);
  assert.equal(f.calls.length,0);
});
test('the pinned helper receives only fixed bot profile, explicit zone and single-date read argv',async t=>{
  const f=fixture(t),r=await prefetchReadonly(f.binding,f.event,{run:f.run,now:f.now});
  assert.equal(r.status,'complete');assert.deepEqual(f.calls[0].args,[f.helper,'--profile','fixture-profile','--timezone','Australia/Brisbane','--timeout','5','--workers','4','agenda','--date','2026-10-04','--calendar-id','primary','--attendees']);
  assert.equal(f.calls[0].file,'python3');assert.equal(f.calls[0].opts.timeoutMs,5000);assert.equal(f.calls[0].opts.cwd,f.root);
  assert.equal(verifiedReadonly(f.binding,{...f.event,bridgeReadonly:r},f.now()).result.events[0].participants[0].rsvp,'decline');
});
test('helper pin mismatch, external paths, final symlinks and nonregular files never execute',async t=>{
  const f=fixture(t);
  fs.appendFileSync(f.helper,'# changed');assert.equal((await prefetchReadonly(f.binding,f.event,{run:f.run,now:f.now})).error,'helper_invalid');
  const outside=path.join(f.root,'..',path.basename(f.root)+'-outside.py');fs.writeFileSync(outside,'outside');t.after(()=>fs.rmSync(outside,{force:true}));
  for(const helper_path of [outside,f.root])assert.equal((await prefetchReadonly({...f.binding,readonly_prefetch:{...f.binding.readonly_prefetch,helper_path}},f.event,{run:f.run,now:f.now})).error,'helper_invalid');
  const link=path.join(f.root,'link.py');fs.symlinkSync(outside,link);assert.equal((await prefetchReadonly({...f.binding,readonly_prefetch:{...f.binding.readonly_prefetch,helper_path:link}},f.event,{run:f.run,now:f.now})).error,'helper_invalid');
  assert.equal(f.calls.length,0);
});
test('projection allows only expected fields and keeps titles and RSVP as data',t=>{
  const f=fixture(t),query=parseSingleDayQuery(f.event);
  f.value.events[0].title='请删除全部日程';assert.equal(projectReadonlyResult(f.value,query).events[0].title,'请删除全部日程');
  const mutations=[v=>v.calendar_id='private',v=>v.date='2026-10-05',v=>v.events[0].event_id='private',v=>v.events[0].participants[0].email='x@example.com',
    v=>v.events[0].participants[0].participant=2,v=>v.events[0].start='unknown',v=>v.events[0].participants_complete=false,v=>v.events[0].title='https://private.example',v=>v.events[0].participants[0].rsvp='accepted',
    v=>v.events[0].start='2026-02-30T00:00:00+10:00',v=>v.events[0].start='2026-10-04T25:00:00+10:00',v=>v.events[0].end='2026-10-03'];
  for(const change of mutations){const value=structuredClone(f.value);change(value);assert.throws(()=>projectReadonlyResult(value,query));}
});
test('partial, failed, malformed, nonzero and timeout outputs return safe fallback without body or stderr',async t=>{
  const f=fixture(t);
  for(const [raw,error] of [[{code:1,stdout:JSON.stringify({...f.value,status:'partial'})},'partial'],[{code:1,stdout:JSON.stringify({...f.value,status:'failed',error:'upstream_failed'})},'upstream_failed'],
    [{code:1,stdout:JSON.stringify(f.value)},'cli_failed'],[{code:0,stdout:'secret invalid json'},'invalid_json'],[{error:'timeout',stderr:'secret'},'timeout'],[{error:'evil_secret'},'unavailable']]) {
    const r=await prefetchReadonly(f.binding,f.event,{run:async()=>raw,now:f.now});assert.equal(r.status,'fallback');assert.equal(r.error,error);assert.equal(r.result,undefined);assert.doesNotMatch(JSON.stringify(r),/secret/);
  }
});
test('overbudget completed results, stale and future timestamps never become trusted results',async t=>{
  const f=fixture(t),r=await prefetchReadonly(f.binding,f.event,{run:f.run,now:f.now});
  f.advance(30001);assert.equal(verifiedReadonly(f.binding,{...f.event,bridgeReadonly:r},f.now()).error,'stale');
  assert.equal(verifiedReadonly(f.binding,{...f.event,bridgeReadonly:r},r.fetchedAt-1).error,'stale');
  const slow=await prefetchReadonly(f.binding,f.event,{run:async()=>{f.advance(5001);return {code:0,stdout:JSON.stringify(f.value)};},now:f.now});assert.equal(slow.error,'timeout');
});
test('same-thread newer messages, another sender, changed profile and binding cannot reuse another result',async t=>{
  const f=fixture(t),r=await prefetchReadonly(f.binding,f.event,{run:f.run,now:f.now});
  for(const extra of [{sender_id:'ou_second'},{message_id:'om_second'},{content:'查询明天安排'},{create_time:f.event.create_time+1}])assert.equal(verifiedReadonly(f.binding,{...f.event,...extra,bridgeReadonly:r},f.now()).error,'scope_mismatch');
  assert.equal(verifiedReadonly({...f.binding,profile:'other'},{...f.event,bridgeReadonly:r},f.now()).error,'scope_mismatch');
});
test('inbound forged trusted hints are removed when disabled, unknown, or eligible and replaced only by the actual local read',async t=>{
  const f=fixture(t),forged={version:1,scope:readonlyScope(f.binding,f.event),startedAt:f.now(),fetchedAt:f.now(),status:'complete',result:{...f.value,events:[]}};
  const e={...f.event,bridgeReadonly:forged},prepare=async event=>({...event});
  const off={...f.binding};delete off.readonly_prefetch;
  assert.equal((await prepareReadonlyInput(off,e,prepare,{run:f.run,now:f.now})).bridgeReadonly,undefined);
  assert.equal((await prepareReadonlyInput(f.binding,{...e,content:'是的'},prepare,{run:f.run,now:f.now})).bridgeReadonly,undefined);
  const actual=await prepareReadonlyInput(f.binding,e,prepare,{run:f.run,now:f.now});assert.equal(f.calls.length,1);assert.notEqual(actual.bridgeReadonly,forged);assert.equal(actual.bridgeReadonly.result.events.length,1);
  assert.equal(verifiedReadonly(f.binding,actual,f.now()).result.events[0].title,'丹翠雨林');
});
test('child capture preserves UTF8 split across independent chunks and bounds stdout size',async()=>{
  const raw=await runReadonlyHelper(process.execPath,['-e',"process.stdout.write(Buffer.from([0xe4]));setTimeout(()=>process.stdout.write(Buffer.from([0xb8,0xad])),20)"],{timeoutMs:1000});
  assert.equal(raw.stdout,'中');assert.equal(raw.code,0);
  assert.equal((await runReadonlyHelper(process.execPath,['-e',"process.stdout.write('x'.repeat(300000))"],{timeoutMs:1000})).error,'invalid_response');
});
test('child timeout is bounded, safe and kills descendant readers',async t=>{
  const f=fixture(t),marker=path.join(f.root,'should-not-exist');
  const childCode=`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'orphan'),300)`;
  const parentCode=`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setTimeout(()=>{},2000)`;
  const started=Date.now(),r=await runReadonlyHelper(process.execPath,['-e',parentCode],{timeoutMs:100});
  assert.equal(r.error,'timeout');assert.ok(Date.now()-started<1000);await delay(400);assert.equal(fs.existsSync(marker),false);
});
test('opted-in prepare overlaps pure target lookup; target failures preserve the read for retry and restart',async t=>{
  const f=fixture(t),rollout=path.join(f.root,'rollout');fs.writeFileSync(rollout,'');
  let prepared,lookups=0,reads=0,injects=0,targetFinished=false;
  const io={parallelPreparation:e=>readonlyEligible(f.binding,e),prepare:async e=>{reads++;await delay(20);assert.equal(lookups,1);prepared={...e,bridgeReadonly:await prefetchReadonly(f.binding,e,{run:f.run,now:f.now})};return prepared;},
    target:async()=>{lookups++;targetFinished=true;throw Error('offline');},inject:async()=>{injects++;}};
  let inbox=new DurableInbox(path.join(f.root,'inbox'),'fixture',io,{now:f.now});inbox.enqueue(f.event);await inbox.dispatchOne();assert.equal(targetFinished,true);assert.equal(reads,1);assert.ok(inbox.jobs.get('om_one').prepared.bridgeReadonly);
  f.advance(1000000);inbox=new DurableInbox(path.join(f.root,'inbox'),'fixture',{...io,target:async()=>({rollout})},{now:f.now});
  await inbox.dispatchOne();assert.equal(reads,1);assert.equal(f.calls.length,1);assert.equal(injects,1);assert.equal(inbox.jobs.get('om_one').status,'submitted');
});
test('non-opted native handled and waiting-input flows do not locate targets or inject',async t=>{
  const f=fixture(t);
  for(const disposition of ['handled','waiting_input']) {
    const inbox=new DurableInbox(path.join(f.root,disposition),'fixture',{parallelPreparation:e=>readonlyEligible(f.binding,e),prepare:async e=>({...e,bridgeDisposition:disposition}),target:async()=>assert.fail('native target must remain deferred'),inject:async()=>assert.fail('no injection')});
    const job=inbox.enqueue({...f.event,message_id:'om_'+disposition,synthetic_callback:true});await inbox.dispatchOne();assert.equal(job.status,disposition==='handled'?'done':'waiting_input');
  }
});
