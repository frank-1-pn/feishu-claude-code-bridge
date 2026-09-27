import test from 'node:test';
import assert from 'node:assert/strict';
import {hydrateNativeContext} from './codex-bridge-native-context.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
const binding={bot:'fixture',profile:'selected',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',codex_thread_id:'thread_fixture'};
const event={message_id:'om_source',message_type:'text',chat_id:binding.chat_id,sender_id:binding.allowed_sender_id,
  content:'original immutable body',bridge_binding:bindingSnapshot(binding)};
const message={message_id:event.message_id,chat_id:binding.chat_id,sender:{id:binding.allowed_sender_id,id_type:'open_id',sender_type:'user'},
  thread_id:'omt_topic',root_id:'om_root',parent_id:'om_parent',content:'must never replace original'};

test('native context only adds source relationships and a scope-bound verification marker',async()=>{
 let calls=0;const request=async(actual,args)=>{calls++;assert.equal(actual.profile,'selected');assert.deepEqual(args,['im','+messages-mget','--message-ids','om_source','--format','json']);return {messages:[message]};};
 const hydrated=await hydrateNativeContext(binding,event,request);
 assert.equal(hydrated.content,event.content);assert.equal(event.thread_id,undefined);assert.equal(hydrated.thread_id,'omt_topic');
 assert.equal(hydrated.root_id,'om_root');assert.equal(hydrated.parent_id,'om_parent');assert.match(hydrated.native_context_verified,/^[a-f0-9]{64}$/);
 assert.equal(await hydrateNativeContext(binding,hydrated,request),hydrated);assert.equal(calls,1);
 await hydrateNativeContext(binding,{...hydrated,thread_id:'omt_changed'},request);assert.equal(calls,2);
});

test('wrong binding and mismatched API identity fail closed before using relationships',async()=>{
 let calls=0;await assert.rejects(hydrateNativeContext({...binding,profile:'other'},event,async()=>calls++),/binding_mismatch/);assert.equal(calls,0);
 for(const patch of [{message_id:'om_other'},{chat_id:'oc_other'},{sender:{open_id:'ou_other'}},{sender:{id:binding.allowed_sender_id,id_type:'open_id',sender_type:'app'}}])
  await assert.rejects(hydrateNativeContext(binding,event,async()=>({messages:[{...message,...patch}]})),/mismatch/);
 await assert.rejects(hydrateNativeContext(binding,event,async()=>({messages:[message,message]})),/message_mismatch/);
});

test('read failure, unsupported identity shape and absent result preserve original quote without inventing topics',async()=>{
 for(const request of [async()=>{throw Error('offline');},async()=>({messages:[]}),async()=>({messages:[{message_id:event.message_id,thread_id:'omt_unknown'}]}),async()=>({})])
  assert.equal(await hydrateNativeContext(binding,event,request),event);
 const synthetic={...event,message_id:'om_cb_source',synthetic_callback:true};let calls=0;
 assert.equal(await hydrateNativeContext(binding,synthetic,async()=>calls++),synthetic);assert.equal(calls,0);
});

test('verified top-level source clears stale compact relationships and rejects malformed native metadata',async()=>{
 const minimal={message_id:event.message_id,chat_id:binding.chat_id,sender:{open_id:binding.allowed_sender_id}};
 const clean=await hydrateNativeContext(binding,{...event,thread_id:'omt_stale'},async()=>({messages:[minimal]}));assert.equal(clean.thread_id,undefined);
 await assert.rejects(hydrateNativeContext(binding,event,async()=>({messages:[{...minimal,thread_id:'../../not-a-topic'}]})),/metadata_invalid/);
});

test('CLI reply_to transformation triggers a strictly scoped raw read for parent/root metadata',async()=>{
 const compact={...message,reply_to:'om_parent'};delete compact.root_id;delete compact.parent_id;const calls=[];
 const request=async(_binding,args)=>{calls.push(args);return args[0]==='im'?{messages:[compact]}:{items:[message]};};
 const hydrated=await hydrateNativeContext(binding,event,request);assert.equal(hydrated.root_id,'om_root');assert.equal(hydrated.parent_id,'om_parent');assert.equal(calls.length,2);
 assert.deepEqual(calls[1],['api','GET','/open-apis/im/v1/messages/om_source']);
 await assert.rejects(hydrateNativeContext(binding,event,async(_b,args)=>args[0]==='im'?{messages:[compact]}:{items:[{...message,chat_id:'oc_wrong'}]}),/binding_mismatch/);
});

test('raw lookup outage retains verified compact topic only without claiming complete metadata',async()=>{
 const compact={...message};delete compact.root_id;delete compact.parent_id;
 const hydrated=await hydrateNativeContext(binding,event,async(_b,args)=>{if(args[0]==='api')throw Error('offline');return {messages:[compact]};});
 assert.equal(hydrated.thread_id,'omt_topic');assert.equal(hydrated.root_id,undefined);assert.equal(hydrated.parent_id,undefined);assert.equal(hydrated.native_context_verified,undefined);assert.equal(hydrated.content,event.content);
});
