import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NativeActionStore,button,formCard} from './codex-bridge-native-actions.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-actions-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',profile:'selected',chat_id:'oc_fixture',allowed_sender_id:'ou_fixture',codex_thread_id:'thread_fixture'};
  let now=1000;
  const make=(options={})=>new NativeActionStore({root,binding,now:()=>now,...options});
  const registration={key:'answer_key',kind:'task_create',sourceJobId:'om_source',data:{replyKey:'reply_fixture'},
    form:{fields:[{name:'summary',label:'事项',type:'text',required:true,maxLength:1000},{name:'due',label:'截止时间',type:'text',maxLength:80},
      {name:'reminder',label:'提前提醒',type:'select',options:[{value:'none',label:'不提醒'},{value:'15',label:'提前15分钟'}]}]}};
  const callback=(context,values={summary:'用户确认的事项',due:'2026-10-01 12:00',reminder:'15'},eventId='fixture_event')=>({schema:'2.0',
    header:{event_type:'card.action.trigger',event_id:eventId,app_id:'cli_fixture'},event:{host:'im_message',token:`fixture_token_${eventId}`,
      operator:{open_id:binding.allowed_sender_id},context:{open_chat_id:binding.chat_id,open_message_id:'om_card'},
      action:{tag:'button',value:context.value,form_value:values}}});
  const auth={binding,authenticatedBot:binding.bot,appId:'cli_fixture'};
  const ready=(store=make(),reg=registration)=>{const context=store.register(reg);store.bindMessage(context.contextId,'om_card');return {store,context};};
  return {root,binding,make,registration,callback,auth,ready,advance:ms=>now+=ms};
}

test('registration is stable and private; changing a bound intention or card fails closed',t=>{
  const f=fixture(t),store=f.make(),context=store.register(f.registration);
  assert.deepEqual(f.make().register(f.registration),context);
  assert.equal(context.value.bridge_native,'v1');assert.equal(context.data,undefined);assert.equal(context.sourceJobId,undefined);
  assert.throws(()=>store.register({...f.registration,data:{replyKey:'different'}}),/context_conflict/);
  assert.equal(store.acceptCallback(f.callback(context),f.auth).reason,'unbound_card');
  store.bindMessage(context.contextId,'om_card');assert.throws(()=>store.bindMessage(context.contextId,'om_other'),/context_conflict/);
  assert.equal(button(context,'转待办').behaviors[0].value.context_id,context.contextId);
});

test('receipt persists only; drain runs trusted local handler once and duplicate submits do not repeat',async t=>{
  const f=fixture(t),{store,context}=f.ready();let calls=0;
  const accepted=store.acceptCallback(f.callback(context),f.auth);assert.equal(accepted.accepted,true);assert.equal(calls,0);
  assert.equal(store.acceptCallback(f.callback(context),f.auth).duplicate,true);
  assert.equal(store.acceptCallback(f.callback(context,undefined,'new_transport_event'),f.auth).duplicate,true);
  const handlers={task_create:async(operation,saved)=>{calls++;assert.equal(operation.values.summary,'用户确认的事项');assert.equal(operation.sourceJobId,'om_source');assert.equal(saved.messageId,'om_card');}};
  await Promise.all([store.drain({handlers}),store.drain({handlers})]);
  await f.make().drain({handlers});assert.equal(calls,1);assert.equal(store.stats().native_action_done_count,1);
});

test('bot, app, chat, sender, profile, thread, message, callback keys and TTL are all checked',t=>{
  const f=fixture(t),{store,context}=f.ready(),base=f.callback(context);
  const alter=fn=>{const event=structuredClone(base);fn(event);assert.equal(store.acceptCallback(event,f.auth).accepted,false);};
  alter(e=>e.header.app_id='cli_other');alter(e=>e.event.operator.open_id='ou_other');alter(e=>e.event.context.open_chat_id='oc_other');
  alter(e=>e.event.context.open_message_id='om_other');alter(e=>e.event.action.value.recipient='oc_other');alter(e=>e.event.action.tag='select_static');
  alter(e=>{delete e.header.event_id;delete e.event.token;});
  for(const options of [{authenticatedBot:'other'}, {binding:{...f.binding,profile:'changed'}},{binding:{...f.binding,codex_thread_id:'changed'}}])
    assert.equal(store.acceptCallback(base,{...f.auth,...options}).reason,'unauthorized');
  f.advance(24*60*60*1000);assert.equal(store.acceptCallback(base,f.auth).reason,'expired');
});

test('a form is single submission: same content is idempotent, changed content or transport replay is rejected',t=>{
  const f=fixture(t),{store,context}=f.ready();
  assert.equal(store.acceptCallback(f.callback(context),f.auth).accepted,true);
  assert.equal(store.acceptCallback(f.callback(context,{summary:'different'},'different_event'),f.auth).reason,'stale_form');
  assert.equal(store.acceptCallback(f.callback(context,{summary:'different'}),f.auth).reason,'replay_mismatch');
  assert.equal(store.stats().native_action_accepted_count,1);
});

test('only declared form fields, required values, lengths and select options are accepted',t=>{
  const f=fixture(t),{store,context}=f.ready();
  for(const values of [{summary:''},{summary:'a'.repeat(1001)},{summary:'a',recipient:'other'},{summary:{text:'a'}},{summary:'a',reminder:'arbitrary'}])
    assert.equal(store.acceptCallback(f.callback(context,values),f.auth).reason,'invalid_form_values');
  assert.equal(store.stats().native_action_accepted_count,0);
  assert.throws(()=>store.register({...f.registration,key:'bad',form:{fields:[{name:'recipient',type:'text',label:'Target'}]}}),/invalid_form/);
});

test('crash after durable intent recovers transport replay indexes and preserves one operation',async t=>{
  const f=fixture(t);let once=true;
  const {store,context}=f.ready(f.make({afterIntent:()=>{if(once){once=false;throw Error('injected_crash');}}}));
  assert.equal(store.acceptCallback(f.callback(context),f.auth).reason,'storage_unavailable');
  const restarted=f.make();assert.equal(restarted.acceptCallback(f.callback(context),f.auth).duplicate,true);
  let calls=0;await restarted.drain({handlers:{task_create:async()=>calls++}});assert.equal(calls,1);
  const saved=fs.readFileSync(path.join(f.root,f.binding.bot,'operations',`${context.contextId}.json`),'utf8');
  assert.ok(!saved.includes('fixture_token_'));assert.ok(!saved.includes('injected_crash'));
});

test('drain restarts reuse the operation ID; handlers own effect idempotency across an ack checkpoint crash',async t=>{
  const f=fixture(t),{store,context}=f.ready(f.make({afterHandle:()=>{throw Error('injected_crash');}}));
  store.acceptCallback(f.callback(context),f.auth);
  const effects=new Set(),seen=[];const handlers={task_create:async(operation)=>{seen.push(operation.id);effects.add(operation.id);}};
  await store.drain({handlers});assert.equal(effects.size,1);assert.equal(store.stats().native_action_pending_count,1);
  f.advance(10000);await f.make().drain({handlers});assert.equal(seen.length,2);assert.equal(seen[0],seen[1]);assert.equal(effects.size,1);
});

test('permanent handler failure and rebinding block effects, without passing error bodies into journal',async t=>{
  const f=fixture(t),{store,context}=f.ready();store.acceptCallback(f.callback(context),f.auth);
  let calls=0;await store.drain({handlers:{task_create:async()=>{calls++;throw Object.assign(Error('secret server body'),{permanent:true,code:'PERMISSION_REQUIRED'});}}});
  await store.drain({handlers:{task_create:async()=>calls++}});assert.equal(calls,1);assert.equal(store.stats().native_action_blocked_count,1);
  const saved=fs.readFileSync(path.join(f.root,f.binding.bot,'operations',`${context.contextId}.json`),'utf8');assert.ok(!saved.includes('secret server body'));
  await assert.rejects(store.drain({binding:{...f.binding,profile:'other'},handlers:{}}),/binding_changed/);
});

test('voice confirmation UI splits long text into native 1000-character inputs and preserves exact confirmed text',async t=>{
  const f=fixture(t),transcript='a'.repeat(999)+'🩺'+'\n中药名 10 mg '+ 'b'.repeat(1500);
  const registration={key:'voice_1',kind:'voice_confirm',sourceJobId:'om_voice',data:{voiceId:'voice_fixture'},
    form:{fields:[{name:'transcript',label:'确认转写',type:'text',required:true,maxLength:6000}]}};
  const {store,context}=f.ready(f.make(),registration);
  const card=formCard(context,{title:'确认语音',notice:'请核对药名、剂量和数值',defaults:{transcript},submitLabel:'确认后执行'});
  const inputs=card.body.elements[0].elements.filter(element=>element.tag==='input');
  assert.equal(inputs.length,3);assert.ok(inputs.every(input=>input.max_length<=1000));
  assert.ok(inputs.every(input=>input.default_value.isWellFormed()));
  assert.equal(inputs.map(input=>input.default_value).join(''),transcript);
  const values=Object.fromEntries(inputs.map(input=>[input.name,input.default_value]));
  assert.equal(store.acceptCallback(f.callback(context,values),f.auth).accepted,true);
  let confirmed;await store.drain({handlers:{voice_confirm:async(operation)=>{confirmed=operation.values.transcript;}}});
  assert.equal(confirmed,transcript);
  assert.throws(()=>formCard(context,{defaults:{transcript:'x'.repeat(6001)}}),/invalid_native_action_default/);
  const short=formCard(context,{defaults:{transcript:'short phrase'}});assert.equal(short.body.elements[0].elements.filter(e=>e.tag==='input').length,1);
});

test('task-open buttons reject injected form values and exact defaults stay ordinary input text',t=>{
  const f=fixture(t),{store,context}=f.ready(f.make(),{key:'open_task',kind:'task_open',sourceJobId:'om_source',data:{answer:'answer',replyKey:'reply_fixture'}});
  assert.equal(store.acceptCallback(f.callback(context,{summary:'injection'}),f.auth).accepted,false);
  assert.equal(store.acceptCallback(f.callback(context,{}),f.auth).accepted,true);
  const task=f.ready().context,card=formCard(task,{defaults:{summary:'<script>literal input</script>',reminder:'none'}});
  assert.equal(card.body.elements[0].elements.find(e=>e.tag==='input').default_value,'<script>literal input</script>');
  assert.equal(card.body.elements[0].elements.find(e=>e.tag==='select_static').initial_option,undefined);
});

test('pending handler results remain queued with bounded backoff; uncertain results block instead of claiming done',async t=>{
  const f=fixture(t),{store,context}=f.ready();store.acceptCallback(f.callback(context),f.auth);let calls=0;
  const handlers={task_create:async()=>{calls++;return {pending:true,retryAt:0};}};
  await store.drain({handlers});assert.equal(store.stats().native_action_pending_count,1);assert.equal(store.stats().native_action_done_count,0);
  await store.drain({handlers});assert.equal(calls,1);
  f.advance(1000);await store.drain({handlers:{task_create:async()=>({status:'pending',retryAt:999999999})}});
  f.advance(300000);await store.drain({handlers:{task_create:async()=>({status:'uncertain',error:'task_result_needs_verification'})}});
  assert.equal(store.stats().native_action_blocked_count,1);assert.equal(store.stats().native_action_done_count,0);
  await store.drain({handlers});assert.equal(calls,1);
});
