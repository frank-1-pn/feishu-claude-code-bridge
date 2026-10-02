import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {OpsDelivery,verifyOpsMessage} from './codex-bridge-ops-delivery.mjs';
import {DurableReplyRouter,chatReplyRoute} from './codex-bridge-reply-routing.mjs';
import {digest} from './codex-bridge-inbox.mjs';

const binding={bot:'fixture',profile:'fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_owner',bot_open_id:'ou_bot',cwd:'/fixture',codex_thread_id:'thread'};
const ctx={ownerKind:'control',ownerId:digest('control'),jobId:'om_source'};
function fixture(t,behavior={}) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ops-delivery-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let creates=0,reads=0,body;const request=async(_b,args)=>{
  if(args[1]==='POST'){creates++;if(behavior.createError)throw behavior.createError;
   body=JSON.parse(args[args.indexOf('--data')+1]);return {message_id:'om_result',chat_id:binding.chat_id};}
  reads++;if(behavior.readFails)throw Error('read_failed');
  return {items:[{message_id:'om_result',chat_id:behavior.wrongChat?'oc_other':binding.chat_id,msg_type:body.msg_type,deleted:false,sender:{sender_type:'app',id_type:'app_id',id:'cli_fixture'},body:{content:body.content}}]};
 };
 const router=new DurableReplyRouter({root:path.join(root,'router'),binding,request}),outbound={serial:fn=>fn()};
 const delivery=new OpsDelivery({root:path.join(root,'deliveries'),binding,codexHome:'/fixture/home',router,outbound,request,getRoute:()=>chatReplyRoute(binding),resolveAppId:async()=> 'cli_fixture'});
 return {delivery,router,behavior,counts:()=>({creates,reads}),root};
}
test('control and alert replies are confirmed only after actual message readback',async t=>{
 const f=fixture(t);assert.deepEqual(await f.delivery.send('后台任务已安排','control:test',ctx),{delivered:true,messageId:'om_result'});
 assert.deepEqual(f.counts(),{creates:1,reads:1});assert.equal(f.delivery.read('control:test').status,'verified');
 assert.deepEqual(await f.delivery.send('后台任务已安排','control:test',ctx),{delivered:true,messageId:'om_result'});assert.equal(f.counts().creates,1);
});
test('failed GET never causes another message creation and can reconcile by read only',async t=>{
 const f=fixture(t,{readFails:true});assert.equal((await f.delivery.send('等待核验','control:test',ctx)).delivered,false);
 assert.equal(f.delivery.read('control:test').status,'acknowledged');f.behavior.readFails=false;let reconciled;
 await f.delivery.reconcile({onVerified:state=>{reconciled=state.ownerId;}});
 assert.equal(reconciled,ctx.ownerId);assert.equal(f.delivery.read('control:test').status,'verified');assert.equal(f.counts().creates,1);
});
test('unknown create ACK remains stopped across another send and restart',async t=>{
 const f=fixture(t,{createError:Error('timeout')});assert.equal((await f.delivery.send('等待核验','control:test',ctx)).uncertain,true);
 f.behavior.createError=null;assert.equal((await f.delivery.send('等待核验','control:test',ctx)).uncertain,true);
 await f.delivery.reconcile();assert.equal(f.counts().creates,1);assert.equal(f.delivery.stats().ops_delivery_blocked_count,1);
});
test('crash after native router ACK is recovered without resending',async t=>{
 const f=fixture(t);await f.delivery.send('后台任务状态','control:test',ctx);
 const state=f.delivery.read('control:test');delete state.messageId;delete state.verifiedAt;state.status='submitting';f.delivery.save(state);
 let verified=0;await f.delivery.reconcile({onVerified:()=>{verified++;}});
 assert.equal(verified,1);assert.equal(f.delivery.read('control:test').status,'verified');assert.equal(f.counts().creates,1);
});
test('changed private ACK content cannot recover an unknown create',async t=>{
 const f=fixture(t);await f.delivery.send('后台任务状态','control:test',ctx);
 const state=f.delivery.read('control:test');delete state.messageId;state.status='submitting';f.delivery.save(state);
 const file=path.join(f.router.root,fs.readdirSync(f.router.root)[0]),ack=JSON.parse(fs.readFileSync(file));ack.content=JSON.stringify({text:'changed'});fs.writeFileSync(file,JSON.stringify(ack));
 await assert.rejects(()=>f.delivery.reconcile(),{code:'ops_delivery_native_ack_changed'});assert.equal(f.counts().creates,1);
});
test('same delivery key cannot change body, owner, or destination',async t=>{
 const f=fixture(t);await f.delivery.send('任务状态','control:test',ctx);
 await assert.rejects(()=>f.delivery.send('另一份内容','control:test',ctx),{code:'ops_delivery_intent_changed'});
 await assert.rejects(()=>f.delivery.send('任务状态','control:test',{...ctx,ownerId:digest('other')}),{code:'ops_delivery_intent_changed'});
});
test('a card context binds the actual created message before confirmed readback',async t=>{
 const f=fixture(t),bindings=[];
 const result=await f.delivery.send('后台任务状态','control:card',{...ctx,card:{schema:'2.0',header:{title:{tag:'plain_text',content:'后台任务 · BG-A12345678901'}}},contextId:'ctx',onMessage:(contextId,messageId)=>bindings.push({contextId,messageId})});
 assert.equal(result.delivered,true);assert.deepEqual(bindings,[{contextId:'ctx',messageId:'om_result'}]);assert.equal(f.counts().creates,1);
});
test('wrong chat, deleted message, human sender, partial identity and mismatched text fail readback',async()=>{
 const message={message_id:'om_result',chat_id:binding.chat_id,msg_type:'text',deleted:false,sender:{sender_type:'app',id_type:'app_id',id:'cli_fixture'},body:{content:JSON.stringify({text:'expected'})}};
 for(const change of [{chat_id:'oc_other'},{deleted:true},{deleted:undefined},{sender:{sender_type:'user'}},{body:{content:JSON.stringify({text:'different'})}}]) {
  const request=async()=>({items:[{...message,...change}]});assert.equal(await verifyOpsMessage({binding,messageId:'om_result',msgType:'text',text:'expected',appId:'cli_fixture',request}),false);
 }
});
test('definite rejected creation can retry the same intention without claiming delivery',async t=>{
 const f=fixture(t,{createError:Object.assign(Error('permission'),{apiCode:99991672})});
 const result=await f.delivery.send('后台任务状态','control:test',ctx);assert.equal(result.delivered,false);assert.equal(result.definitelyFailed,true);
 assert.equal(f.delivery.read('control:test').status,'rejected');assert.equal(f.counts().reads,0);
});
test('readback binds the sender and original reply; a matching generic card title is insufficient',async()=>{
 const card={schema:'2.0',header:{title:{tag:'plain_text',content:'后台任务 · BG-A12345678901'}},
  body:{elements:[{tag:'markdown',content:'**资料分析草稿**'},{tag:'markdown',content:'当前状态：已排队\n结果尚未回包'},
    {tag:'button',text:{tag:'plain_text',content:'取消后台任务'},confirm:{title:{tag:'plain_text',content:'确认取消？'}}}]}};
 const base={message_id:'om_result',chat_id:binding.chat_id,msg_type:'interactive',parent_id:'om_source',deleted:false,
  sender:{sender_type:'app',id_type:'app_id',id:'cli_fixture'},body:{content:JSON.stringify(card)}};
 const verify=message=>verifyOpsMessage({binding,messageId:'om_result',msgType:'interactive',card,appId:'cli_fixture',route:{mode:'quote',messageId:'om_source'},request:async()=>({items:[message]})});
 assert.equal(await verify(base),true);
 assert.equal(await verify({...base,sender:{...base.sender,id:'cli_another'}}),false);
 assert.equal(await verify({...base,parent_id:'om_other'}),false);
 assert.equal(await verify({...base,body:{content:JSON.stringify({title:'后台任务',elements:[]})}}),false);
 assert.equal(await verify({...base,body:{content:JSON.stringify({title:card.header.title.content,elements:[{text:'资料分析草稿'},{text:'当前状态：已排队\n结果尚未回包'},{text:'取消后台任务'}]})}}),true);
 assert.equal(await verify({...base,body:{content:JSON.stringify({title:card.header.title.content,elements:[{text:'资料分析草稿'},{text:'当前状态：已完成'}]})}}),false);
 assert.equal(await verify({...base,body:{content:JSON.stringify({user_dsl:JSON.stringify(card)})}}),true);
});
test('a failed read-only route preparation can retry, while an uncertain create never re-enters preparation',async t=>{
 const f=fixture(t);const route=f.delivery.getRoute;
 f.delivery.getRoute=async()=>{throw Error('read_unavailable');};
 assert.deepEqual(await f.delivery.send('任务状态','control:test',ctx),{delivered:false,definitelyFailed:true});
 assert.equal(f.counts().creates,0);assert.equal(f.delivery.read('control:test'),null);
 f.delivery.getRoute=route;assert.equal((await f.delivery.send('任务状态','control:test',ctx)).delivered,true);
 const uncertain=fixture(t,{createError:Error('timeout')});await uncertain.delivery.send('任务状态','control:unknown',ctx);
 uncertain.delivery.getRoute=async()=>{throw Error('read_unavailable');};
 assert.equal((await uncertain.delivery.send('任务状态','control:unknown',ctx)).uncertain,true);
 assert.equal(uncertain.counts().creates,1);assert.equal(uncertain.delivery.read('control:unknown').status,'unknown');
});
