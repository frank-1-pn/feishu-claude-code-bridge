import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DurableReplyRouter,chatReplyRoute} from './codex-bridge-reply-routing.mjs';
import {capture,createLarkTransport,larkDiagnostic,finalLarkEnvelope} from './codex-bridge-lark.mjs';
import {cliFailure,classifyFailure,recordFailure} from './codex-bridge-retry.mjs';

const secret='fixture_secret_should_never_be_returned';
const failure=(detail)=>JSON.stringify({ok:false,error:{...detail,message:secret,access_token:secret}});
const success=JSON.stringify({ok:true,data:{message_id:'om_fixture'}});
const requestFor=result=>createLarkTransport('fixture-cli',{run:async()=>result})({},['api','POST','/open-apis/fixture']);
const child=async(stdout,stderr,code=1)=>capture(process.execPath,['-e',`process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exitCode=${code}`],{timeoutMs:3000});
const safe=error=>assert.doesNotMatch(JSON.stringify({message:error.message,...error}),new RegExp(secret));

test('only a complete final envelope supplies safe numeric and enum metadata',()=>{
  assert.deepEqual(larkDiagnostic(`Warning: token=${secret}\n`+failure({code:1061043,type:'api',subtype:'content_too_large',retry_after:3})),
    {code:1061043,type:'api',subtype:'content_too_large',retry_after:3});
  assert.deepEqual(larkDiagnostic(failure({type:'permission',subtype:'app_scope_not_applied'})),{type:'permission',subtype:'app_scope_not_applied'});
  assert.deepEqual(larkDiagnostic(failure({code:'99991672',type:secret,subtype:secret})),{code:99991672,type:'permission'});
  for(const value of [`request failed code: 99991672 token=${secret}`,failure({code:1061043})+' trailing',
    failure({code:1061043}).slice(0,-1),'{"ok":false,\n'+failure({code:99991672})])assert.equal(larkDiagnostic(value),undefined);
});

test('final envelope parsing accepts warnings, BOM, formatted JSON and braces inside strings; rejects tails',()=>{
  const value={ok:false,error:{code:1061043,message:'braces { } [ ] and "quotes" 中文😀'}};
  assert.deepEqual(finalLarkEnvelope('\uFEFFwarning: fixture\n'+JSON.stringify(value,null,2)+'\n'),value);
  assert.deepEqual(finalLarkEnvelope('{"level":"warning"}\n'+JSON.stringify(value)),value);
  for(const suffix of ['\nwarning: trailing','\n{"ok":', ' {}'])assert.equal(finalLarkEnvelope(JSON.stringify(value)+suffix),undefined);
});

test('real stderr chunks preserve final envelope while never returning raw diagnostics',async()=>{
  const envelope=failure({code:99991668,type:'permission',subtype:'app_scope_not_applied',retry_after:2});
  const js=`process.stderr.write(${JSON.stringify('warning: token='+secret+'\n'+envelope.slice(0,40))});setTimeout(()=>{process.stderr.write(${JSON.stringify(envelope.slice(40))});process.exitCode=1;},10)`;
  const result=await capture(process.execPath,['-e',js],{timeoutMs:3000});
  assert.deepEqual(result,{code:1,stdout:'',diagnostic:{code:99991668,type:'permission',subtype:'app_scope_not_applied',retry_after:2}});
  assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
  await assert.rejects(requestFor(result),error=>{assert.equal(error.apiCode,99991668);assert.equal(error.subtype,'app_scope_not_applied');assert.equal(error.retryAfterMs,2000);safe(error);return true;});
});

test('stderr-only permission without numeric code blocks retry and preserves routing and stdin',async()=>{
  let observed;const result=await child('',failure({type:'permission',subtype:'app_scope_not_applied'}));
  const request=createLarkTransport('fixture-cli',{timeoutMs:3210,run:async(file,args,options)=>{observed={file,args,options};return result;}});
  await assert.rejects(request({profile:'fixture-profile'},['api','POST','/open-apis/fixture','--data',JSON.stringify({text:secret})]),error=>{
    assert.equal(error.apiCode,undefined);assert.equal(error.type,'permission');assert.equal(error.subtype,'app_scope_not_applied');
    const state={};recordFailure(state,error,1000);assert.equal(state.blocked,true);assert.equal(state.retryAt,null);safe(error);return true;
  });
  assert.deepEqual(observed.args.slice(0,2),['--profile','fixture-profile']);assert.deepEqual(observed.args.slice(-2),['--as','bot']);
  assert.equal(observed.args[observed.args.indexOf('--data')+1],'-');assert.equal(observed.options.timeoutMs,3210);
  assert.equal(observed.options.env.LARK_CLI_NO_PROXY,'1');assert.deepEqual(JSON.parse(observed.options.input),{text:secret});
});

test('size failures stop retry from either channel and 429 retains server backoff',async()=>{
  for(const result of [await child('',failure({code:1061043})),await child('warning: fixture\n'+failure({code:1061043}),''),
    await child('',failure({type:'validation',subtype:'payload_too_large'}))]) {
    await assert.rejects(requestFor(result),error=>{const state={};recordFailure(state,error,1000);assert.equal(state.blocked,true);assert.equal(state.retryAt,null);safe(error);return true;});
  }
  for(const detail of [{code:429,type:'api',retry_after:12.5},{code:99991400,type:'rate_limit',subtype:'too_many_requests',retry_after:'12.5'}]) {
    await assert.rejects(requestFor(await child('',failure(detail))),error=>{const state={};recordFailure(state,error,1000,()=>0.5);assert.equal(state.blocked,false);assert.equal(state.retryAt,13500);assert.equal(error.retryAfterMs,12500);return true;});
  }
});

test('success/failure and disagreeing failures across channels fail closed without rejection metadata',async()=>{
  const rejected=failure({code:230011,type:'permission'});
  for(const result of [await child(success,rejected,0),await child(success,rejected,1),await child(rejected,success),
    await child(rejected,failure({code:99991672,type:'permission'})),await child(failure({code:429,retry_after:1}),failure({code:429,retry_after:2}))]) {
    await assert.rejects(requestFor(result),error=>{assert.equal(error.code,'CLI_RESPONSE_CONFLICT');assert.equal(error.deliveryUncertain,true);assert.equal(error.apiCode,undefined);assert.equal(error.type,undefined);assert.notEqual(error.definitelyFailed,true);safe(error);return true;});
  }
  const matching=await child(rejected,rejected);
  await assert.rejects(requestFor(matching),error=>error.apiCode===230011 && error.type==='permission');
});

test('partial or tailed JSON cannot turn an unknown acknowledgement into a rejection',async()=>{
  const rejected=failure({code:230011});
  for(const result of [await child(success.slice(0,-1),rejected),await child(rejected+'\ntrailing',rejected),
    await child(success,rejected.slice(0,-1),0),await child('',rejected+'\ntrailing'),await child(success,'',1)]) {
    await assert.rejects(requestFor(result),error=>{assert.equal(error.deliveryUncertain,true);assert.equal(error.apiCode,undefined);assert.notEqual(error.definitelyFailed,true);return true;});
  }
});

test('plain warning code references do not override successful stdout',async()=>{
  const result=await child(success,`old code: 99991672 token=${secret}`,0);
  assert.equal(result.diagnostic,undefined);assert.deepEqual(await requestFor(result),{message_id:'om_fixture'});
  assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
});

test('bounded stderr tail still finds final envelope after oversized warnings',async()=>{
  const js=`process.stderr.write('warning: '+${JSON.stringify(secret)}+'x'.repeat(80000)+'\\n'+${JSON.stringify(failure({code:1061043}))});process.exitCode=1`;
  const result=await capture(process.execPath,['-e',js],{timeoutMs:3000});
  assert.deepEqual(result,{code:1,stdout:'',diagnostic:{code:1061043}});assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
});

test('unrecognized and oversized diagnostics never leak',async()=>{
  const result=await capture(process.execPath,['-e',`process.stderr.write(${JSON.stringify(secret)}+'x'.repeat(80000));process.exitCode=1`],{timeoutMs:3000});
  assert.deepEqual(result,{code:1,stdout:''});
  await assert.rejects(requestFor(result),error=>{assert.equal(error.code,'INVALID_RESPONSE');assert.equal(error.deliveryUncertain,true);safe(error);return true;});
  const invalid=cliFailure({error:{code:secret,type:secret,subtype:secret,retry_after:secret,message:secret}});
  safe(invalid);assert.equal(invalid.apiCode,undefined);assert.equal(invalid.type,undefined);assert.equal(invalid.retryAfterMs,0);
});

test('timeout and stdout output limit retain unknown outcome; UTF-8 and large stdin stay intact',async()=>{
  await assert.rejects(capture(process.execPath,['-e',`process.stdout.write(${JSON.stringify(success)});setTimeout(()=>{},1000)`],{timeoutMs:50}),error=>{
    assert.equal(error.code,'ETIMEDOUT');assert.equal(error.deliveryUncertain,true);assert.notEqual(error.definitelyFailed,true);return true;
  });
  await assert.rejects(capture(process.execPath,['-e',"process.stdout.write('x'.repeat(4*1024*1024+1))"],{timeoutMs:3000}),error=>error.message==='response_too_large' && error.deliveryUncertain===true);
  const input='中文😀\n'.repeat(100000);
  const result=await capture(process.execPath,['-e',"process.stdin.pipe(process.stdout)"],{input,timeoutMs:3000});assert.equal(result.stdout,input);
  const split=await capture(process.execPath,['-e',"const b=Buffer.from('中文😀');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),10)"],{timeoutMs:3000});assert.equal(split.stdout,'中文😀');
});

test('authentication, validation and explicit quota failures stop retry but network/HTTP errors remain transient',()=>{
  for(const detail of [{type:'authentication'},{type:'validation'},{subtype:'quota_exceeded'}])assert.equal(classifyFailure(cliFailure(detail)).kind,'permanent');
  for(const detail of [{code:500,type:'http'},{code:429,type:'rate_limit'},{type:'network'}]) {
    const error=cliFailure(detail);assert.equal(classifyFailure(error).kind,'transient');assert.notEqual(error.definitelyFailed,true);assert.notEqual(error.deliveryUncertain,false);
  }
});

// Exercise the actual consumer: a source-deleted code must not trigger a new
// unquoted message when stdout might already acknowledge the original reply.
test('conflicting CLI envelopes preserve native router uncertainty and original endpoint across restart',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lark-envelope-router-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',profile:'selected',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',codex_thread_id:'thread_fixture'};
  const captured=await child(success,failure({code:230011}),1),calls=[];
  const request=createLarkTransport('fixture-cli',{run:async(_file,args,options)=>{calls.push({args,input:options.input});return captured;}});
  const route={...chatReplyRoute(binding),mode:'quote',messageId:'om_source'};
  const input={key:'answer',route,msgType:'text',content:{text:'answer'}};
  for(let attempt=0;attempt<2;attempt++) {
    const router=new DurableReplyRouter({root,binding,request});
    await assert.rejects(router.send(input),error=>error.code==='CLI_RESPONSE_CONFLICT' && error.deliveryUncertain===true);
  }
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.args.includes('/open-apis/im/v1/messages/om_source/reply')));
  assert.equal(calls[0].input,calls[1].input);
  const state=JSON.parse(fs.readFileSync(path.join(root,'fixture',fs.readdirSync(path.join(root,'fixture'))[0]),'utf8'));
  assert.equal(state.uncertain,true);assert.equal(state.route.mode,'quote');assert.equal(state.status,'pending');
});
