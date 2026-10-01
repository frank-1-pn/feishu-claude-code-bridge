import test from 'node:test';
import assert from 'node:assert/strict';
import {isAuthorizedMessage} from './codex-bridge-authorization.mjs';
import {bindingSnapshot,isBoundJob} from './codex-bridge-ux.mjs';
const binding={bot:'example',chat_id:'oc_group',allowed_sender_id:'ou_owner',bot_open_id:'ou_bot',group_access:'all_members_mentions',codex_thread_id:'thread'};
const event={type:'im.message.receive_v1',chat_id:'oc_group',chat_type:'group',sender_id:'ou_newmember',sender_type:'user',mentions:[{id:'ou_bot'}]};
test('new group members can address exact bot, with scoped jobs',()=>{
 assert.equal(isAuthorizedMessage(binding,event),true);
 assert.equal(isBoundJob(binding,{event:{...event,bridge_binding:bindingSnapshot(binding)}}),true);
 assert.equal(isAuthorizedMessage(binding,{...event,mentions:[{id:{open_id:'ou_bot'}}]}),true);
});
test('group authorization denies unrelated traffic',()=>{
 for(const patch of [{chat_id:'oc_other'},{chat_type:'p2p'},{mentions:[]},{mentions:[{id:'ou_otherbot'}]},{sender_type:'app'},{sender_id:''},{type:'card.action.trigger'}]) assert.equal(isAuthorizedMessage(binding,{...event,...patch}),false);
 assert.equal(isAuthorizedMessage({...binding,bot_open_id:undefined},event),false);
 assert.equal(isBoundJob(binding,{event:{...event,bridge_binding:{...bindingSnapshot(binding),bot_open_id:'ou_otherbot'}}}),false);
});
test('legacy single sender bindings remain restricted',()=>{
 const {group_access,bot_open_id,...legacy}=binding;
 assert.equal(isAuthorizedMessage(legacy,event),false);
 assert.equal(isAuthorizedMessage(legacy,{...event,sender_id:'ou_owner',mentions:[]}),true);
 assert.equal('group_access' in bindingSnapshot(legacy),false);
});
