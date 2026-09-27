import fs from 'node:fs';
import { digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';

// Original adapter following the documented CardKit contract and CowAgent's
// serialized latest-snapshot/final-drain design. No model reasoning is accepted.
export function streamCard(text, final) {
  return { schema:'2.0', config:{update_multi:true,streaming_mode:!final,
    ...(final ? {} : {streaming_config:{print_frequency_ms:{default:70},print_step:{default:3},print_strategy:'fast'}})},
    header:{template:final?'green':'blue',title:{tag:'plain_text',content:final?'处理完成':'正在处理'}},
    body:{elements:[{tag:'markdown',element_id:'answer',content:text||'正在处理…'}]} };
}

export async function updateStreamCard({file,s,final,binding,request,now}) {
  const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));
  const merge=patch=>{const current=read();Object.assign(current,patch);atomicWriteJson(file,current);return current;};
  let current=read();
  if(!current.cardId){
    // Entity creation has no UUID in the official schema. A crash here may
    // leave an unsent entity, but must never create two visible messages.
    const result=await request(binding,['api','POST','/open-apis/cardkit/v1/cards','--data',JSON.stringify({type:'card_json',data:JSON.stringify(streamCard('',false))})]);
    if(!/^[A-Za-z0-9_-]+$/.test(result?.card_id??''))throw Error('card_entity_id_missing');
    current=merge({cardId:result.card_id,cardSequence:0});
  }
  if(!current.messageId){
    const result=await request(binding,['api','POST','/open-apis/im/v1/messages','--params',JSON.stringify({receive_id_type:'chat_id'}),
      '--data',JSON.stringify({receive_id:binding.chat_id,msg_type:'interactive',content:JSON.stringify({type:'card',data:{card_id:current.cardId}}),uuid:digest(`card:${s.key}`).slice(0,32)})]);
    if(!/^om_[A-Za-z0-9_-]+$/.test(result?.message_id??''))throw Error('card_message_id_missing');
    current=merge({messageId:result.message_id});
  }
  // Finish an uncertain operation with its original sequence+uuid before
  // advancing. This also drains an older queued progress snapshot before final.
  const apply=async operation=>{
    await request(binding,['api','PUT',operation.endpoint,'--data',JSON.stringify(operation.body)]);
    const latest=read();latest.cardSequence=operation.sequence;delete latest.cardPending;
    latest.sentRevision=operation.revision;latest.lastSentAt=now();latest.retryAt=0;latest.attempts=0;
    if(operation.final)latest.cardClosed=true;
    atomicWriteJson(file,latest);return latest;
  };
  if(current.cardPending)current=await apply(current.cardPending);
  if(current.sentRevision===s.revision && (!final || current.cardClosed))return;
  const sequence=(current.cardSequence??0)+1;
  const operation={sequence,revision:s.revision,final,endpoint:`/open-apis/cardkit/v1/cards/${current.cardId}${final?'':'/elements/answer/content'}`,
    body:{uuid:digest(`${s.key}:${sequence}`).slice(0,40),sequence,
      ...(final?{card:{type:'card_json',data:JSON.stringify(streamCard(s.text,true))}}:{content:s.text})}};
  merge({cardPending:operation});await apply(operation);
}
