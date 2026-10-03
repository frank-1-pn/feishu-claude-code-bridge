import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {opsScope} from './codex-bridge-ops-policy.mjs';
import {DurableInbox,digest} from './codex-bridge-inbox.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {RESEARCH_LIMITS,readResearchPolicy,safeResearchProtocol,validateResearchUrl,isPublicResearchIp,fetchResearchSource,
  makeResearchSnapshot,prepareResearchInputs,verifyResearchEvidence,reviewResearchCitations} from './codex-bridge-research.mjs';
import {enqueueBackgroundTask,readBackgroundTask,backgroundTaskStatus} from './codex-bridge-background-store.mjs';
import {runBackgroundTask,codexArguments,RESEARCH_DISABLED_FEATURES} from './codex-bridge-background-runner.mjs';
import {BackgroundScheduler,verifyBackgroundCompletion,verifyBackgroundExecution,parseBackgroundArguments} from './codex-bridge-background.mjs';
import {enqueueAutomaticBackgroundTask,AUTOMATIC_BACKGROUND_KEY,verifyAutomaticBackgroundReceipt} from './codex-bridge-task-router.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex'),url='https://example.org/public/report';
const lookup=async()=>[{address:'93.184.216.34',family:4}];
function transport(responses=[{}]) {
  const calls=[];
  const request=(target,options,callback)=>{
    const spec=responses[Math.min(calls.length,responses.length-1)],req=new EventEmitter(),res=new EventEmitter();
    calls.push({url:target.href,options});req.destroy=()=>{req.destroyed=true;};res.destroy=()=>{res.destroyed=true;if(spec.abortOnDestroy)res.emit('aborted');};
    res.statusCode=spec.status??200;res.headers=spec.headers??{'content-type':'text/html; charset=utf-8'};
    res.socket={remoteAddress:spec.ip??'93.184.216.34'};
    req.end=()=>queueMicrotask(()=>{
      if(req.destroyed)return;callback(res);
      if(!res.destroyed){res.emit('data',Buffer.from(spec.body??'<html><script>hidden code</script><h1>Public research fixture</h1><p>Fresh public facts.</p></html>'));res.emit('end');}
    });return req;
  };return {calls,request};
}
function fixture(t) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'research-test-')));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'background'),bot='fixture',botDir=path.join(root,bot),cwd=path.join(base,'cwd'),home=path.join(base,'home');
  for(const dir of [root,botDir,cwd,home])fs.mkdirSync(dir,{mode:0o700});
  const cli=path.join(base,'cli.mjs');fs.writeFileSync(cli,'// fixture, never executed\n',{mode:0o600});
  const binding={bot,profile:'fixture',cwd,chat_id:'oc_fixture',allowed_sender_id:'ou_owner',bot_open_id:'ou_bot',group_access:'all_group_humans',codex_thread_id:'fixture-thread',fast_actionable_classification:true};
  const policyFile=path.join(botDir,'research-policy.json'),sourcesFile=path.join(cwd,'sources.json');
  const policy={schema:1,scope:opsScope(binding,home),enabled:true,allowedOrigins:['https://example.org'],limits:{...RESEARCH_LIMITS}};
  const write=(file,object)=>fs.writeFileSync(file,JSON.stringify(object)+'\n',{mode:0o600});
  write(policyFile,policy);write(sourcesFile,{schema:1,urls:[url]});
  const inboxRoot=path.join(base,'inbox'),inbox=new DurableInbox(inboxRoot,bot,{});
  const event={type:'im.message.receive_v1',message_id:'om_research_fixture',chat_id:binding.chat_id,chat_type:'group',sender_type:'user',sender_id:'ou_member',
    message_type:'text',content:JSON.stringify({text:'请深入研究昆士兰公园公开生态资料的管理要求，先给研究报告草稿，不要外发。'}),create_time:String(Date.now()),bridge_binding:bindingSnapshot(binding)};
  const source=inbox.enqueue(event);Object.assign(source,{status:'delivered',markerSeen:true,feedbackDisposition:'actionable'});inbox.save(source);
  const options={root,inboxRoot,binding,jobId:source.id,taskKey:'research',title:'研究草稿',promptText:'分析提供的来源并给可核验草稿，引用真实URL与查询日期。',sourcesFile,codexCliJs:cli,codexHome:home};
  const queued=enqueueBackgroundTask(options),task=readBackgroundTask(root,binding,queued.taskId),taskDir=path.join(botDir,task.id),nonce=randomUUID();
  write(path.join(taskDir,'claim.json'),{schema:1,taskId:task.id,nonce,claimedAt:Date.now()});
  return {base,root,botDir,cwd,home,cli,binding,policy,policyFile,sourcesFile,inboxRoot,inbox,source,options,task,taskDir,nonce,write};
}
const citation=(prepared)=>`根据真实材料的研究草稿。来源：[报告](${url})，查询日期：${JSON.parse(fs.readFileSync(prepared.manifestFile)).sources[0].queriedAt.slice(0,10)}。`;

test('default absent/invalid policy is closed; public protocol contains only explicitly enabled scoped whitelist',t=>{
  const f=fixture(t),enabled=readResearchPolicy({root:f.root,binding:f.binding,codexHome:f.home});
  assert.equal(enabled.enabled,true);assert.equal(enabled.policySha256,sha(fs.readFileSync(f.policyFile)));
  assert.deepEqual(safeResearchProtocol(enabled).allowedOrigins,['https://example.org']);
  assert.doesNotMatch(JSON.stringify(safeResearchProtocol(enabled)),/ou_|oc_|fixture-thread|codexHome/);
  fs.chmodSync(f.policyFile,0o644);assert.equal(readResearchPolicy({root:f.root,binding:f.binding,codexHome:f.home}).enabled,false);
  fs.chmodSync(f.policyFile,0o600);f.write(f.policyFile,{...f.policy,scope:{...f.policy.scope,codexHome:'/other'}});
  assert.equal(readResearchPolicy({root:f.root,binding:f.binding,codexHome:f.home}).enabled,false);
  fs.unlinkSync(f.policyFile);assert.deepEqual(readResearchPolicy({root:f.root,binding:f.binding,codexHome:f.home}),{enabled:false,reason:null});
});

test('URL gate rejects private hosts, credential/query/fragment/path leakage, aliases and foreign origins',()=>{
  assert.equal(validateResearchUrl(url,['https://example.org']),url);
  for(const bad of ['https://127.0.0.1/a','http://localhost/a','https://[::1]/a','https://example.org:444/a',
    'https://user:pass@example.org/a','https://example.org/a?q=private','https://example.org/a#secret','https://example.org/%2e%2e/private',
    'https://example.org/a/../private','https://example.org/private/auth','https://example.org/om_internal','file:///etc/passwd',
    'https://EXAMPLE.org/a','https://example.org./a','https://example.org\\@localhost/a','https://example.org/a\n','https://unapproved.org/a'])
    assert.throws(()=>validateResearchUrl(bad,['https://example.org']),{code:'research_url_rejected'},bad);
});

test('DNS gate excludes all special/private IPv4 and IPv6 classes conservatively',()=>{
  for(const ip of ['8.8.8.8','93.184.216.34','2606:4700::1111','2001:4860:4860::8888'])assert.equal(isPublicResearchIp(ip),true,ip);
  for(const ip of ['127.0.0.1','0.0.0.0','10.1.2.3','172.16.0.1','192.168.0.1','169.254.169.254','100.64.0.1','192.0.2.1',
    '198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::1','::','fc00::1','fe80::1','::ffff:127.0.0.1',
    '64:ff9b::a00:1','2001:db8::1','2001:0::1','2002:7f00:1::','3fff::1','not-ip'])assert.equal(isPublicResearchIp(ip),false,ip);
});

test('GET transport pins resolved public IP, strips ambient auth/proxy and refuses mixed answers/rebinding',async t=>{
  const f=fixture(t),io=transport(),body=await fetchResearchSource(url,f.policy,{lookup,request:io.request});
  assert.equal(body.status,200);assert.equal(body.chain[0].pinnedAddress,'93.184.216.34');
  const call=io.calls[0];assert.equal(call.options.method,'GET');assert.equal(call.options.agent,false);assert.equal(call.options.servername,'example.org');
  let pinned;call.options.lookup('example.org',{},(_error,address,family)=>{pinned={address,family};});
  assert.deepEqual(pinned,{address:'93.184.216.34',family:4});assert.equal(call.options.headers.Authorization,undefined);assert.equal(call.options.headers.Cookie,undefined);
  await assert.rejects(fetchResearchSource(url,f.policy,{lookup:async()=>[...(await lookup()),{address:'127.0.0.1',family:4}],request:io.request}),{code:'research_dns_rejected'});
  await assert.rejects(fetchResearchSource(url,f.policy,{lookup,request:transport([{ip:'10.0.0.1'}]).request}),{code:'research_dns_rejected'});
  await assert.rejects(fetchResearchSource(url,f.policy,{lookup,request:transport([{ip:'8.8.8.8'}]).request}),{code:'research_dns_rejected'});
});

test('redirects repeat origin/DNS checks, reject private targets, traversal and downgrade',async t=>{
  const f=fixture(t),redirect={status:302,headers:{location:'/public/final'}},io=transport([redirect,{}]);
  const final=await fetchResearchSource(url,f.policy,{lookup,request:io.request});assert.equal(final.url,'https://example.org/public/final');assert.equal(final.chain.length,2);
  for(const location of ['http://127.0.0.1/a','https://foreign.org/a','/a/../private','//127.0.0.1/a','/public/final?token=secret'])
    await assert.rejects(fetchResearchSource(url,f.policy,{lookup,request:transport([{status:302,headers:{location}}]).request}));
  const downgrade={...f.policy,allowedOrigins:['https://example.org','http://example.org']};
  await assert.rejects(fetchResearchSource(url,downgrade,{lookup,request:transport([{status:302,headers:{location:'http://example.org/public/final'}}]).request}),{code:'research_redirect_rejected'});
  await assert.rejects(fetchResearchSource(url,f.policy,{lookup,request:transport([redirect]).request}),{code:'research_redirect_rejected'});
});

test('HTTP status, MIME, encoding, bytes and cancellation fail with bounded safe categories',async t=>{
  const f=fixture(t);
  for(const spec of [{status:404},{headers:{'content-type':'application/octet-stream'}},{headers:{'content-type':'text/html','content-encoding':'gzip'}},
    {headers:{'content-type':'text/html; charset=iso-8859-1'}},{headers:{'content-type':'text/plain','content-length':String(RESEARCH_LIMITS.maxSourceBytes+1)}},
    {body:'x'.repeat(RESEARCH_LIMITS.maxSourceBytes+1)},{body:'x'.repeat(RESEARCH_LIMITS.maxSourceBytes+1),abortOnDestroy:true}])
    await assert.rejects(fetchResearchSource(url,f.policy,{lookup,request:transport([spec]).request}),error=>/^research_(?:response_rejected|source_too_large)$/.test(error.code));
  const abort=new AbortController(),pending=fetchResearchSource(url,f.policy,{lookup:()=>new Promise(()=>{}),signal:abort.signal});abort.abort();
  await assert.rejects(pending,{code:'research_cancelled'});
});

test('sources/policy snapshots are private, scoped, immutable and participate in request identity',t=>{
  const f=fixture(t);assert.equal(f.task.research.policySha256,sha(fs.readFileSync(f.policyFile)));assert.equal(f.task.research.sourcesSha256,sha(fs.readFileSync(f.sourcesFile)));
  assert.equal(enqueueBackgroundTask(f.options).duplicate,true);
  f.write(f.sourcesFile,{schema:1,urls:['https://example.org/public/other']});assert.throws(()=>enqueueBackgroundTask(f.options),{code:'background_task_conflict'});
  fs.chmodSync(f.sourcesFile,0o644);assert.throws(()=>makeResearchSnapshot({root:f.root,binding:f.binding,codexHome:f.home,sourcesFile:f.sourcesFile}));
  fs.chmodSync(f.sourcesFile,0o600);const link=path.join(f.cwd,'link.json');fs.symlinkSync(f.sourcesFile,link);
  assert.throws(()=>makeResearchSnapshot({root:f.root,binding:f.binding,codexHome:f.home,sourcesFile:link}));
  f.write(f.policyFile,{...f.policy,enabled:false});assert.throws(()=>enqueueBackgroundTask({...f.options,taskKey:'other'}),{code:'research_policy_disabled'});
});

test('aggregate source budget stops another GET once consumed and bounds the last response by remaining bytes',async t=>{
  for(const bodyBytes of [1024,768]) {
    const f=fixture(t),urls=[url,url+'/next',url+'/third'];
    f.policy.limits={...f.policy.limits,maxSourceBytes:1024,maxTotalBytes:1024};f.write(f.policyFile,f.policy);
    f.write(f.sourcesFile,{schema:1,urls});
    const task={...f.task,research:makeResearchSnapshot(f.options)},io=transport([{body:'x'.repeat(bodyBytes),headers:{'content-type':'text/plain'}}]);
    const prepared=await prepareResearchInputs(f.taskDir,{task,nonce:f.nonce,lookup,request:io.request});
    assert.equal(prepared.errorCategory,'research_source_too_large');assert.equal(prepared.input,null);
    assert.equal(io.calls.length,bodyBytes===1024?1:2);
  }
});

test('manifest binds actual bytes, extracted material and citations; no unvisited URL or missing query date can pass',async t=>{
  const f=fixture(t),prepared=await prepareResearchInputs(f.taskDir,{task:f.task,nonce:f.nonce,lookup,request:transport().request});
  assert.equal(prepared.status,'ready');assert.match(prepared.input,/Fresh public facts/);assert.doesNotMatch(prepared.input,/hidden code/);
  const manifest=JSON.parse(fs.readFileSync(prepared.manifestFile)),text=citation(prepared);
  assert.equal(manifest.sources[0].sha256,sha(fs.readFileSync(path.join(f.taskDir,'research','source-01.bin'))));
  const evidence=verifyResearchEvidence(f.taskDir,{task:f.task,nonce:f.nonce,manifestSha256:prepared.manifestSha256,resultText:text});
  assert.deepEqual(evidence.citationUrls,[url]);assert.equal(evidence.fetchedSourceCount,1);
  assert.throws(()=>reviewResearchCitations('没有实际来源。',manifest),{code:'research_citation_missing'});
  assert.throws(()=>reviewResearchCitations(`来源 ${url}`,manifest),{code:'research_query_date_missing'});
  assert.throws(()=>reviewResearchCitations(text+' https://foreign.org/report',manifest),{code:'research_citation_unverified'});
  fs.writeFileSync(path.join(f.taskDir,'research','source-01.txt'),'tampered');
  assert.throws(()=>verifyResearchEvidence(f.taskDir,{task:f.task,nonce:f.nonce,manifestSha256:prepared.manifestSha256,resultText:text}),{code:'research_evidence_invalid'});
});

function runner(f,{request=transport().request,lookupFn=lookup,timerOptions={}}={}) {
  let started;const launched=new Promise(resolve=>{started=resolve;}),spawns=[],signals=[];
  const child=new EventEmitter();child.pid=44420;child.stdin=new EventEmitter();child.stdin.end=input=>{child.input=input;};child.kill=signal=>signals.push(signal);
  const options={expectedCodexHome:f.home,env:{CODEX_HOME:f.home},identity:pid=>({bootId:'fixture',pid}),probe:()=>true,groupAlive:()=>false,
    spawn:(exe,args,opts)=>{spawns.push({exe,args,opts});started(child);return child;},kill:(pid,signal)=>signals.push({pid,signal}),heartbeatMs:5,
    researchIO:{lookup:lookupFn,request},...timerOptions};
  return {child,spawns,signals,launched,run:()=>runBackgroundTask(f.taskDir,f.nonce,options)};
}
test('runner supplies actual source text to model stdin, closes tools and publishes only verified final evidence',async t=>{
  const f=fixture(t),r=runner(f),run=r.run();await r.launched;
  assert.match(r.child.input,/Fresh public facts/);assert.match(r.child.input,/https:\/\/example.org\/public\/report/);
  const args=codexArguments(f.task,f.taskDir);
  assert.deepEqual(RESEARCH_DISABLED_FEATURES,['shell_tool','unified_exec','plugins','remote_plugin','plugin_sharing',
    'browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','image_generation','goals',
    'code_mode','code_mode_only','code_mode_host','view_image','skill_mcp_dependency_install','tool_suggest','auth_elicitation']);
  for(const feature of RESEARCH_DISABLED_FEATURES)assert.ok(args.includes(`features.${feature}=false`),feature);
  assert.ok(args.includes('code_mode.disable_in_process_fallback=false'));
  assert.deepEqual(r.spawns[0].args,args);
  assert.ok(args.includes('web_search="disabled"'));assert.ok(args.includes('agents.enabled=false'));assert.ok(args.includes('features.multi_agent_v2=false'));
  assert.equal(args.includes('resume'),false);assert.deepEqual(r.spawns[0].opts.stdio,['pipe','ignore','ignore']);
  const prepared={manifestFile:path.join(f.taskDir,'research','manifest.json')};fs.writeFileSync(path.join(f.taskDir,'result.txt'),citation(prepared));
  r.child.emit('close',0);const done=await run;assert.equal(done.status,'completed');assert.equal(done.researchEvidence.fetchedSourceCount,1);
  const status=backgroundTaskStatus(f.options);assert.equal(status.research.manifestSha256,done.researchEvidence.manifestSha256);assert.deepEqual(status.research.citationUrls,[url]);
  assert.equal((await r.run()).status,'indeterminate');assert.equal(r.spawns.length,1);
});

test('fetch policy change or transport failure never invokes model and never replays source GET',async t=>{
  const f=fixture(t);f.write(f.policyFile,{...f.policy,enabled:false});const r=runner(f),failed=await r.run();
  assert.equal(failed.status,'failed');assert.equal(failed.errorCategory,'research_policy_changed');assert.equal(r.spawns.length,0);
  assert.equal((await r.run()).status,'indeterminate');assert.equal(r.spawns.length,0);
});
test('failed fetch records real failure manifest and does not silently fall back to offline model',async t=>{
  const f=fixture(t),io=transport([{status:503}]),r=runner(f,{request:io.request}),failed=await r.run();
  assert.equal(failed.status,'failed');assert.equal(failed.errorCategory,'research_response_rejected');assert.equal(r.spawns.length,0);
  const manifest=JSON.parse(fs.readFileSync(path.join(f.taskDir,'research','manifest.json')));assert.equal(manifest.status,'failed');assert.equal(manifest.sources[0].status,'failed');
  assert.equal((await r.run()).status,'indeterminate');assert.equal(io.calls.length,1);
});
test('cancel and timeout during DNS fetching retain one claim and prevent a late model launch',async t=>{
  for(const status of ['cancelled','timed_out']) {
    const f=fixture(t),ticks=[],deadlines=[],r=runner(f,{lookupFn:()=>new Promise(()=>{}),timerOptions:{interval:fn=>{ticks.push(fn);return 1;},clearInterval:()=>{},timeout:fn=>{deadlines.push(fn);return 2;},clearTimeout:()=>{}}});
    const run=r.run();
    if(status==='cancelled'){f.write(path.join(f.taskDir,'cancel.json'),{schema:1,taskId:f.task.id,nonce:f.nonce});ticks[0]();}else deadlines[0]();
    const done=await run;assert.equal(done.status,status);assert.equal(r.spawns.length,0);assert.equal(r.signals.length,0);
    assert.equal((await r.run()).status,'indeterminate');
  }
});
test('successful child output with invented citation is rejected and removed',async t=>{
  const f=fixture(t),r=runner(f),run=r.run();await r.launched;
  fs.writeFileSync(path.join(f.taskDir,'result.txt'),`伪造已查证链接 https://unvisited.org/public 。查询日期 2026-10-03`);
  r.child.emit('close',0);const done=await run;assert.equal(done.status,'failed');assert.equal(done.errorCategory,'research_citation_unverified');
  assert.equal(fs.existsSync(path.join(f.taskDir,'result.txt')),false);
});

test('completed source provenance is reverified by scheduler and synthetic completion, then delivered for main review',async t=>{
  const f=fixture(t),r=runner(f),run=r.run();await r.launched;
  fs.writeFileSync(path.join(f.taskDir,'result.txt'),citation({manifestFile:path.join(f.taskDir,'research','manifest.json')}));r.child.emit('close',0);await run;
  f.source.status='done';f.inbox.save(f.source);
  const scheduler=new BackgroundScheduler({...f.options,inbox:f.inbox,probe:async()=>true,launch:()=>{throw Error('no replay');}});
  await scheduler.tick();const event=[...f.inbox.jobs.values()].find(job=>job.event.background_completion).event;
  assert.equal(verifyBackgroundCompletion(f.binding,event,f.root),true);
  const execution=verifyBackgroundExecution(f.binding,f.task.id,f.root);assert.equal(execution.verified,true);assert.equal(execution.status,'completed');assert.equal(execution.nonce,f.nonce);
  const result=JSON.parse(JSON.parse(event.content).text.split('\n').at(-1));
  assert.equal(result.research.manifestFile,path.join(f.taskDir,'research','manifest.json'));assert.deepEqual(result.research.citationUrls,[url]);
  fs.writeFileSync(path.join(f.taskDir,'research','source-01.bin'),'changed');assert.equal(verifyBackgroundCompletion(f.binding,event,f.root),false);
  assert.equal(verifyBackgroundExecution(f.binding,f.task.id,f.root),null);
});

test('read-only execution projection rejects invented terminals and accepts never-started cancellation only without any launch claim',t=>{
  const f=fixture(t),runFile=path.join(f.taskDir,'run.json'),claimFile=path.join(f.taskDir,'claim.json');
  assert.equal(verifyBackgroundExecution(f.binding,f.task.id,f.root),null);
  f.write(runFile,{schema:1,taskId:f.task.id,nonce:f.nonce,status:'completed',taskSha256:digest(fs.readFileSync(path.join(f.taskDir,'task.json'))),exitCode:0,resultBytes:1,resultSha256:'a'.repeat(64)});
  assert.equal(verifyBackgroundExecution(f.binding,f.task.id,f.root),null);fs.unlinkSync(runFile);fs.unlinkSync(claimFile);
  f.write(path.join(f.taskDir,'cancel.json'),{schema:1,taskId:f.task.id,nonce:null,requestedAt:123});
  assert.deepEqual(verifyBackgroundExecution(f.binding,f.task.id,f.root),{verified:true,status:'cancelled',nonce:null,completedAt:null,neverStarted:true});
  f.write(path.join(f.taskDir,'run-claim.json'),{schema:1,taskId:f.task.id,nonce:f.nonce});assert.equal(verifyBackgroundExecution(f.binding,f.task.id,f.root),null);
});

test('auto-enqueue accepts only sources passthrough, freezes source identity and preserves the original research plan',t=>{
  const f=fixture(t);
  const opts=parseBackgroundArguments(['--bot','fixture','--job-id',f.source.id,'--action','auto-enqueue','--sources-file',f.sourcesFile]);
  assert.equal(opts['--sources-file'],f.sourcesFile);
  assert.throws(()=>parseBackgroundArguments(['--bot','fixture','--job-id',f.source.id,'--action','auto-enqueue','--sources-file',f.sourcesFile,'--prompt-file','changed']),{code:'background_arguments_invalid'});
  const receipt=enqueueAutomaticBackgroundTask({...f.options}),task=readBackgroundTask(f.root,f.binding,receipt.taskId);
  assert.equal(receipt.backgroundQueued,true);assert.equal(task.taskKey,AUTOMATIC_BACKGROUND_KEY);assert.equal(task.delegation.sourceTimestamp,Number(f.source.event.create_time));
  assert.equal(task.research.policySha256,f.task.research.policySha256);assert.equal(verifyAutomaticBackgroundReceipt({...f.options,receipt}),true);
  assert.equal(enqueueAutomaticBackgroundTask({...f.options}).duplicate,true);
  f.write(f.sourcesFile,{schema:1,urls:['https://example.org/public/other']});assert.throws(()=>enqueueAutomaticBackgroundTask({...f.options}),/background_auto_conflict/);
});
