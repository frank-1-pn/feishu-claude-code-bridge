import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { cliFailure, larkErrorMetadata } from './codex-bridge-retry.mjs';

const plain = value => value && typeof value==='object' && !Array.isArray(value);

// Consume whole JSON objects, never a regex-shaped fragment or a nested object
// from an incomplete response. Warning lines may precede the final envelope;
// any non-whitespace tail or unclosed object makes the response untrustworthy.
export function finalLarkEnvelope(value) {
  const text=String(value??'').replace(/^\uFEFF/,'');
  let offset=0, result;
  while(offset<text.length) {
    const match=/(?:^|\n)[\t ]*\{/g;match.lastIndex=offset;
    const start=match.exec(text);
    if(!start)return result && !text.slice(offset).trim() ? result : undefined;
    const begin=start.index+start[0].lastIndexOf('{');
    let depth=0, quoted=false, escaped=false, end;
    for(let i=begin;i<text.length;i++) {
      const c=text[i];
      if(quoted) { if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue; }
      if(c==='"')quoted=true;
      else if(c==='{' || c==='[')depth++;
      else if(c==='}' || c===']') { if(--depth===0){end=i+1;break;} }
    }
    if(end===undefined)return undefined;
    try{result=JSON.parse(text.slice(begin,end));}catch{return undefined;}
    if(!plain(result))return undefined;
    offset=end;
    if(!text.slice(offset).trim())return result;
  }
  return result;
}

function envelopeFailure(response) {
  if(response.ok===false || plain(response.error))return response;
  const code=larkErrorMetadata(response).code;
  if(code!==undefined && code!==0)return response;
  if(plain(response.data)){const dataCode=larkErrorMetadata(response.data).code;if(dataCode!==undefined && dataCode!==0)return response.data;}
}
const isEnvelope = response => plain(response) && (typeof response.ok==='boolean' || larkErrorMetadata(response).code!==undefined || plain(response.error));
export function larkDiagnostic(value) {
  const response=finalLarkEnvelope(value);
  return isEnvelope(response) && envelopeFailure(response) ? larkErrorMetadata(envelopeFailure(response)) : undefined;
}
const uncertain = code => Object.assign(Error('invalid_cli_response'), {code,deliveryUncertain:true});

export function capture(file, args, { cwd, env = process.env, input, timeoutMs = 120000, children } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children?.add(child);
    const decoder = new StringDecoder('utf8'); let stdout = '', bytes = 0, failure, diagnosticText='', diagnosticTruncated=false;
    const diagnosticDecoder=new StringDecoder('utf8');
    const timer = setTimeout(() => { failure = Object.assign(Error('request_timeout'), { code: 'ETIMEDOUT' }); child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { failure = Error('response_too_large'); child.kill(); return; }
      stdout += decoder.write(chunk);
    });
    child.stderr.on('data',chunk=>{diagnosticText+=diagnosticDecoder.write(chunk);if(diagnosticText.length>65536){diagnosticTruncated=true;diagnosticText=diagnosticText.slice(-65536);}});
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); children?.delete(child); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); children?.delete(child); stdout += decoder.end();
      if (failure) { failure.deliveryUncertain=true;diagnosticText='';reject(failure); return; }
      diagnosticText+=diagnosticDecoder.end();
      // Discard the partial first line of a bounded stderr tail. Keep only safe
      // metadata, including when exit status disagrees with an API envelope.
      if(diagnosticTruncated){const newline=diagnosticText.indexOf('\n');diagnosticText=newline<0?'':diagnosticText.slice(newline+1);}
      const response=finalLarkEnvelope(diagnosticText), diagnostic=larkDiagnostic(diagnosticText);
      const stderrSuccess=isEnvelope(response) && !envelopeFailure(response);
      const stderrInvalid=!response && /(?:^|\n)[\t ]*\{/.test(diagnosticText);diagnosticText='';
      resolve({ code, stdout, ...(diagnostic?{diagnostic}:{}),...(stderrSuccess?{stderrSuccess:true}:{}),...(stderrInvalid?{stderrInvalid:true}:{}) });
    });
    child.stdin.end(input);
  });
}

export function createLarkTransport(executable, { run = capture, children, cwd: defaultCwd, timeoutMs=120000 } = {}) {
  return async (binding, originalArgs, cwd = defaultCwd) => {
    const args = [...originalArgs]; let input;
    const data = args.indexOf('--data');
    if (data >= 0) { input = args[data + 1]; args[data + 1] = '-'; }
    const result = await run(executable, [...(binding.profile ? ['--profile', binding.profile] : []), ...args, '--as', 'bot'],
      { cwd, input, children, timeoutMs, env: { ...process.env, LARK_CLI_NO_PROXY: '1' } });
    const response=finalLarkEnvelope(result.stdout);
    const stdoutFailure=response && envelopeFailure(response);
    const metadata=stdoutFailure && larkErrorMetadata(stdoutFailure);
    const diagnostic=result.diagnostic && larkErrorMetadata(result.diagnostic);
    if(result.stderrInvalid || (!response && /[\[{]/.test(result.stdout??'')))throw uncertain('INVALID_RESPONSE');
    if((response && !stdoutFailure && diagnostic) || (stdoutFailure && result.stderrSuccess))throw uncertain('CLI_RESPONSE_CONFLICT');
    if(metadata && diagnostic && Object.keys(metadata).some(key=>key in diagnostic && metadata[key]!==diagnostic[key]))
      throw uncertain('CLI_RESPONSE_CONFLICT');
    if(metadata || diagnostic)throw cliFailure({...metadata,...diagnostic});
    if(!response)throw uncertain('INVALID_RESPONSE');
    // Exit status alone says nothing about a mutation's acknowledgement.
    if(result.code!==0)throw uncertain('CLI_EXIT_STATUS');
    const dataBody = response.data ?? response;
    return dataBody.code === 0 && dataBody.data ? dataBody.data : dataBody;
  };
}

// Resolve the selected profile through the CLI, retaining only its app ID.
// Never log or persist the configuration response (it can contain private data).
export async function resolveLarkAppId(executable,binding,{run=capture,cwd,children}={}) {
  const result=await run(executable,[...(binding.profile?['--profile',binding.profile]:[]),'config','show'],
    {cwd,children,timeoutMs:15000,env:{...process.env,LARK_CLI_NO_PROXY:'1'}});
  let config;try{config=JSON.parse(result.stdout);}catch{throw Object.assign(Error('reaction_identity_unavailable'),{code:'INVALID_IDENTITY'});}
  if(result.code!==0 || !/^cli_[A-Za-z0-9]+$/.test(config.appId??''))throw Object.assign(Error('reaction_identity_unavailable'),{code:'INVALID_IDENTITY'});
  return config.appId;
}
