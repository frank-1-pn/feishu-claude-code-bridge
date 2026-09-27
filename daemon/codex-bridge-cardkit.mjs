import fs from 'node:fs';
import { digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { buildPresentation, markdownElements, sourceMarkdown } from './codex-bridge-presentation.mjs';

// Original adapter following the documented CardKit contract and CowAgent's
// serialized latest-snapshot/final-drain design. No model reasoning is accepted.
export function streamCard(text, final, options = {}) {
  const view = buildPresentation(text, { ...options, final });
  const panel = (id, title, elements) => ({ tag:'collapsible_panel', element_id:id, expanded:false,
    header:{title:{tag:'plain_text',content:title}}, elements });
  const answerElements=markdownElements(view.answer,'answer');
  answerElements[0].element_id='answer';
  const elements = [{tag:'markdown',element_id:'status',content:`**${view.status}**`},...answerElements];
  if(view.detailText) elements.push(panel('details','完整答复',markdownElements(view.detailText)));
  if(view.sources.length) elements.push(panel('sources','来源与依据',[{tag:'markdown',element_id:'source_list',content:sourceMarkdown(view.sources)}]));
  if(view.publicProgress.length) elements.push(panel('progress','公开进度（最近记录）',markdownElements(view.publicProgress.join('\n\n---\n\n'),'progress_text')));
  if(view.report) {
    const name=view.report.fileName.replace(/[<>]/g,'').replace(/([\\`*_{}\[\]()#+.!|~])/g,'\\$1');
    const label=view.report.delivered?'完整报告已作为附件发送':'完整报告尚未确认送达';
    elements.push({tag:'markdown',element_id:'report',content:`${label}：${name}${view.report.delivered && view.report.url?`\n\n[打开完整报告](<${view.report.url}>)`:''}`});
  }
  // Interactive components are supplied only by the trusted action builder.
  // Forms stay top-level: Feishu does not allow form inside collapsible_panel.
  if(final && Array.isArray(options.interactions)) elements.push(...options.interactions);
  return { schema:'2.0', config:{update_multi:true,streaming_mode:!final,width_mode:'fill',summary:{content:view.summary},enable_forward_interaction:false,
    ...(final ? {} : {streaming_config:{print_frequency_ms:{default:70},print_step:{default:3},print_strategy:'fast'}})},
    header:{template:view.state==='error'?'red':view.state==='waiting'?'orange':final?'green':'blue',title:{tag:'plain_text',content:view.status}},
    body:{elements} };
}

export async function updateStreamCard({file,s,final,binding,request,now,onMessage}) {
  const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));
  const merge=patch=>{const current=read();Object.assign(current,patch);atomicWriteJson(file,current);return current;};
  let current=read();
  if(!current.cardId){
    // Entity creation has no UUID in the official schema. A crash here may
    // leave an unsent entity, but must never create two visible messages.
    const result=await request(binding,['api','POST','/open-apis/cardkit/v1/cards','--data',JSON.stringify({type:'card_json',data:JSON.stringify(streamCard('',false,s.presentation))})]);
    if(!/^[A-Za-z0-9_-]+$/.test(result?.card_id??''))throw Error('card_entity_id_missing');
    current=merge({cardId:result.card_id,cardSequence:0});
  }
  if(!current.messageId){
    const result=await request(binding,['api','POST','/open-apis/im/v1/messages','--params',JSON.stringify({receive_id_type:'chat_id'}),
      '--data',JSON.stringify({receive_id:binding.chat_id,msg_type:'interactive',content:JSON.stringify({type:'card',data:{card_id:current.cardId}}),uuid:digest(`card:${s.key}`).slice(0,32)})]);
    if(!/^om_[A-Za-z0-9_-]+$/.test(result?.message_id??''))throw Error('card_message_id_missing');
    current=merge({messageId:result.message_id});
  }
  // Persist the actual message binding before publishing clickable controls.
  // The hook is idempotent and also runs when resuming an already-sent card.
  await onMessage?.(current.messageId,current.presentation??s.presentation);
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
  // A finalized card must never reopen because of a stale progress snapshot.
  if(current.cardClosed && !final)return;
  if(current.sentRevision===s.revision && (!final || current.cardClosed))return;
  const sequence=(current.cardSequence??0)+1;
  const fullUpdate=final || Boolean(s.presentation);
  const operation={sequence,revision:s.revision,final,endpoint:`/open-apis/cardkit/v1/cards/${current.cardId}${fullUpdate?'':'/elements/answer/content'}`,
    body:{uuid:digest(`${s.key}:${sequence}`).slice(0,40),sequence,
      ...(fullUpdate?{card:{type:'card_json',data:JSON.stringify(streamCard(s.text,final,s.presentation))}}:{content:s.text})}};
  merge({cardPending:operation});await apply(operation);
}
