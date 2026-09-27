import test from 'node:test';
import assert from 'node:assert/strict';
import {capture,createLarkTransport,larkDiagnostic} from './codex-bridge-lark.mjs';

const secret='fixture_secret_should_never_be_returned';

test('stderr diagnostic extracts numeric code and optional type without retaining credential text',()=>{
  assert.deepEqual(larkDiagnostic(`request failed code: 99991672 app_secret=${secret} token=${secret}`),{code:99991672,type:'permission'});
  assert.deepEqual(larkDiagnostic(`Error {"code":230011,"secret":"${secret}"}`),{code:230011});
  assert.equal(larkDiagnostic(`ticket=${secret}`),undefined);
  assert.equal(larkDiagnostic('message ID 123456789012345 and process ID 1234'),undefined);
});

test('real child-process stderr is reduced to safe metadata, even when an API code spans chunks',async()=>{
  const js=`process.stderr.write('access_token=${secret} code: 9999');setTimeout(()=>{process.stderr.write('1672 app_secret=${secret}');process.exitCode=1;},10);`;
  const result=await capture(process.execPath,['-e',js],{timeoutMs:3000});
  assert.deepEqual(result,{code:1,stdout:'',diagnostic:{code:99991672,type:'permission'}});
  assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
});

test('successful CLI output does not become a permission failure because stderr mentioned a code',async()=>{
  const js=`process.stderr.write('old code: 99991672 token=${secret}');process.stdout.write('{"ok":true,"data":{"value":42}}');`;
  const result=await capture(process.execPath,['-e',js],{timeoutMs:3000});
  assert.equal(result.code,0);assert.equal(result.diagnostic,undefined);assert.equal(JSON.parse(result.stdout).data.value,42);
  assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
});

test('stderr-only permission failures preserve bot/profile routing and become sanitized typed API errors',async()=>{
  let observed;
  const request=createLarkTransport('fixture-cli',{timeoutMs:3210,run:async(file,args,options)=>{
    observed={file,args,options};return {code:1,stdout:'',diagnostic:{code:99991668,type:'permission'}};
  }});
  let caught;try{await request({profile:'fixture-profile'},['api','POST','/open-apis/fixture','--data',JSON.stringify({text:secret})]);}catch(e){caught=e;}
  assert.equal(caught.apiCode,99991668);assert.equal(caught.type,'permission');assert.equal(caught.message,'lark_request_failed');
  assert.deepEqual(observed.args.slice(0,2),['--profile','fixture-profile']);assert.deepEqual(observed.args.slice(-2),['--as','bot']);
  assert.equal(observed.args[observed.args.indexOf('--data')+1],'-');assert.equal(observed.options.timeoutMs,3210);
  assert.equal(observed.options.env.LARK_CLI_NO_PROXY,'1');assert.deepEqual(JSON.parse(observed.options.input),{text:secret});
  assert.doesNotMatch(JSON.stringify({message:caught.message,...caught}),new RegExp(secret));
});

test('unrecognized or oversized stderr cannot leak through an invalid response error',async()=>{
  const js=`process.stderr.write('${secret}'+ 'x'.repeat(80000));process.exitCode=1;`;
  const captured=await capture(process.execPath,['-e',js],{timeoutMs:3000});assert.deepEqual(captured,{code:1,stdout:''});
  const request=createLarkTransport('fixture-cli',{run:async()=>captured});
  await assert.rejects(request({},['api','GET','/open-apis/fixture']),error=>error.code==='INVALID_RESPONSE'&&!JSON.stringify(error).includes(secret));
});

test('structured stdout API failures still report codes without exposing server descriptions',async()=>{
  const request=createLarkTransport('fixture-cli',{run:async()=>({code:1,stdout:JSON.stringify({ok:false,error:{code:99991672,type:'permission',message:secret}})})});
  await assert.rejects(request({},['api','GET','/open-apis/fixture']),error=>{
    assert.equal(error.apiCode,99991672);assert.equal(error.type,'permission');
    assert.doesNotMatch(JSON.stringify({message:error.message,...error}),new RegExp(secret));return true;
  });
});
