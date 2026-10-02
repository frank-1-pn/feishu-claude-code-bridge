import {digest} from './codex-bridge-inbox.mjs';
import {bindingSnapshot,isBoundJob} from './codex-bridge-ux.mjs';

const invalid=code=>Object.assign(Error(code),{code,permanent:true});
const nativeId=value=>typeof value==='string'&&/^om_[A-Za-z0-9_-]+$/.test(value)&&!value.startsWith('om_cb_');
const topicId=value=>typeof value==='string'&&/^(?:om|omt)_[A-Za-z0-9_-]+$/.test(value);
const digestContext=(binding,event)=>digest(JSON.stringify(['native-context-v3',bindingSnapshot(binding),event.message_id??event.id,
  event.chat_id,event.sender_id,event.thread_id??null,event.root_id??null,event.parent_id??null]));

export function nativeContextVerified(binding,event) {
  return !!event && isBoundJob(binding,{id:event.message_id??event.id,event})
    && event.native_context_verified===digestContext(binding,event);
}

// The digest detects changed context; it is not an authentication secret. Only
// a receipt written by the local preparation flow permits using it for bypass.
export function dispatchNativeContextVerified(binding,job) {
  return job?.dispatchContext?.version===1 && nativeContextVerified(binding,job.event)
    && job.dispatchContext.proof===job.event.native_context_verified;
}

export async function prepareDispatchNativeContext(binding,job,request) {
  const source={...job.event};
  if(!dispatchNativeContextVerified(binding,job))delete source.native_context_verified;
  const event=await hydrateNativeContext(binding,source,request);
  return {event,dispatchContext:nativeContextVerified(binding,event)
    ?{version:1,proof:event.native_context_verified}:null};
}
function verifyMessage(binding,id,message,sourceSender=binding.allowed_sender_id){
  if(message?.message_id!==id)throw invalid('native_context_message_mismatch');
  const senders=[message.sender_id,message.sender?.open_id,message.sender?.sender_id?.open_id,
    message.sender?.id_type==='open_id'||/^ou_[A-Za-z0-9_-]+$/.test(message.sender?.id??'')?message.sender?.id:undefined]
    .filter(value=>typeof value==='string');
  if((message.chat_id!==undefined&&message.chat_id!==binding.chat_id)||senders.some(sender=>sender!==sourceSender)
    ||(message.sender?.sender_type&&message.sender.sender_type!=='user'))throw invalid('native_context_binding_mismatch');
  for(const key of ['thread_id','root_id','parent_id']){
    const value=message[key];
    if(value!==undefined&&value!==null&&value!==''&&!(key==='thread_id'?topicId(value):nativeId(value)))
      throw invalid('native_context_metadata_invalid');
  }
  return message.chat_id!==undefined&&senders.length>0;
}

// Some subscriber compact formats omit native relationships. Enrich only these
// fields from a read-only lookup, never replace the original body/resources.
export async function hydrateNativeContext(binding,event,request){
  const id=event?.message_id??event?.id;
  if(!isBoundJob(binding,{id,event}))throw invalid('native_context_binding_mismatch');
  if(event.synthetic_callback)return event;
  if(!nativeId(id))throw invalid('native_context_source_invalid');
  if(nativeContextVerified(binding,event))return event;
  let response;
  try{response=await request(binding,['im','+messages-mget','--message-ids',id,'--format','json']);}
  catch{return event;}
  const messages=response?.messages;
  if(!Array.isArray(messages)||!messages.length)return event;
  const matches=messages.filter(message=>message?.message_id===id);
  if(matches.length!==1)throw invalid('native_context_message_mismatch');
  let message=matches[0];
  // Missing identity fields are an unavailable capability; conflicting fields
  // are a scope violation, never a reason to send into a different conversation.
  if(!verifyMessage(binding,id,message,event.sender_id))return event;
  let complete=true;
  // CLI's friendly output replaces parent_id with reply_to and omits root_id.
  // Only relational messages need one raw read to recover that lost metadata.
  if((message.reply_to||message.thread_id)&&(message.root_id===undefined||message.parent_id===undefined)){
    let raw;
    try{raw=await request(binding,['api','GET',`/open-apis/im/v1/messages/${id}`]);}catch{}
    if(Array.isArray(raw?.items)&&raw.items.length){
      const exact=raw.items.filter(item=>item?.message_id===id);
      if(exact.length!==1)throw invalid('native_context_message_mismatch');
      if(!verifyMessage(binding,id,exact[0],event.sender_id))return event;
      message=exact[0];
    }else complete=false;
  }
  const result={...event};
  for(const key of ['thread_id','root_id','parent_id']){
    const value=message[key];
    // Absence in a verified API result means no relationship. Never retain a
    // contradictory stale/fabricated compact field once the source is verified.
    if(value)result[key]=value;else if(complete)delete result[key];
  }
  if(complete)result.native_context_verified=digestContext(binding,result);
  else delete result.native_context_verified;
  return result;
}
