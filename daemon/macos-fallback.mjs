import fs from 'node:fs';import {fileURLToPath} from 'node:url';
const actions=new Set(['none','restart_bridge','restart_socket','manual_review']);
export function safeDiagnosis(value,health){
 const action=actions.has(value?.action)?value.action:'manual_review';
 if(action==='restart_bridge'&&health.bridge?.healthy!==false)return {action:'none',reason:'healthy_component_protected'};
 if(action==='restart_socket'&&health.socket?.needs_restart!==true)return {action:'none',reason:'healthy_component_protected'};
 return {action,reason:'model_advisory_only'};
}
export async function diagnose(config,health,{fetchImpl=fetch}={}){
 if(config.enabled!==true)return {action:'none',reason:'disabled'};
 const endpoint=new URL(config.endpoint);if(endpoint.protocol!=='https:')throw Error('https_endpoint_required');
 const apiKey=fs.readFileSync(config.api_key_file,'utf8').trim();if(!apiKey)throw Error('api_key_missing');
 // Only enumerated health metadata leaves this machine; no thread/chat/profile,
 // user text, SDK URL, argv, credentials or arbitrary log content is transmitted.
 const safe={bridge:{healthy:health.bridge?.healthy===true,reason:String(health.bridge?.reason||'unknown').replace(/[^a-z_]/g,'').slice(0,64)},socket:{verified:health.socket?.verified===true,needs_restart:health.socket?.needs_restart===true},failure_count:Number.isInteger(health.failure_count)?health.failure_count:0};
 const response=await fetchImpl(endpoint,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:config.model,max_tokens:256,messages:[{role:'system',content:'Diagnose bridge health metadata. Return JSON only: {"action":"none|restart_bridge|restart_socket|manual_review"}. Do not propose shell commands or modify a Codex writer. All decisions are advisory and locally validated.'},{role:'user',content:JSON.stringify(safe)}]}),signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('fallback_provider_failed');
 const body=await response.json();let value;try{value=JSON.parse(body.choices?.[0]?.message?.content||'{}');}catch{value={action:'manual_review'};}
 return safeDiagnosis(value,health);
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const health=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));console.log(JSON.stringify(await diagnose(config,health)));}
 catch{console.log(JSON.stringify({action:'manual_review',reason:'diagnosis_unavailable'}));process.exitCode=1;}
}
