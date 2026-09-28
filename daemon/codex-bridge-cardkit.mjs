import fs from 'node:fs';
import { digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { buildPresentation, markdownElements, sourceMarkdown, safeHttpUrl } from './codex-bridge-presentation.mjs';

// Original adapter following the documented CardKit contract and CowAgent's
// serialized latest-snapshot/final-drain design. No model reasoning is accepted.
export function streamCard(text, final, options = {}) {
  const view = buildPresentation(text, { ...options, final });
  const streaming=!final && options.streaming!==false;
  const panel = (id, title, elements) => ({ tag:'collapsible_panel', element_id:id, expanded:false,
    header:{title:{tag:'plain_text',content:title}}, elements });
  const answerElements=markdownElements(view.answer,'answer');
  answerElements[0].element_id='answer';
  const elements = [{tag:'markdown',element_id:'status',content:`**${view.status}**`},...answerElements];
  if(options.replyNotice)elements.push({tag:'markdown',element_id:'reply_notice',content:String(options.replyNotice)});
  const cloudUrl=options.cloudDoc?.status==='ready'?safeHttpUrl(options.cloudDoc.url):null;
  if(cloudUrl)elements.push({tag:'markdown',element_id:'cloud_doc',content:`[打开飞书云文档](${cloudUrl})`});
  else if(options.cloudDoc?.status==='blocked')elements.push({tag:'markdown',element_id:'cloud_doc',content:'飞书云文档暂未生成，完整内容请查看原始报告附件。'});
  if(view.detailText) elements.push(panel('details','完整答复',markdownElements(view.detailText)));
  if(view.sources.length) elements.push(panel('sources','来源与依据',[{tag:'markdown',element_id:'source_list',content:sourceMarkdown(view.sources)}]));
  if(view.publicProgress.length) elements.push(panel('progress','公开进度（北京时间，最近记录）',markdownElements(view.publicProgress.join('\n\n---\n\n'),'progress_text')));
  if(view.report) {
    const name=view.report.fileName.replace(/[<>]/g,'').replace(/([\\`*_{}\[\]()#+.!|~])/g,'\\$1');
    const label=view.report.delivered?'完整报告已作为附件发送':'完整报告尚未确认送达';
    elements.push({tag:'markdown',element_id:'report',content:`${label}：${name}${view.report.delivered && view.report.url?`\n\n[打开完整报告](<${view.report.url}>)`:''}`});
  }
  // Interactive components are supplied only by the trusted action builder.
  // Forms stay top-level: Feishu does not allow form inside collapsible_panel.
  if(final && Array.isArray(options.interactions)) elements.push(...options.interactions);
  return { schema:'2.0', config:{update_multi:true,streaming_mode:streaming,width_mode:'fill',summary:{content:view.summary},enable_forward_interaction:false,
    ...(streaming ? {streaming_config:{print_frequency_ms:{default:70},print_step:{default:3},print_strategy:'fast'}} : {})},
    header:{template:view.state==='error'?'red':view.state==='waiting'?'orange':final?'green':'blue',title:{tag:'plain_text',content:view.status}},
    body:{elements} };
}

// Compare the actual displayed structure, not presentation inputs. Metadata,
// headers, controls, element insertion/removal and phase changes require a full
// card update. Only addressable markdown contents may use the typing endpoint.
export function planCardUpdate(previous, next, {final=false}={}) {
  if(final || !previous || previous.config?.streaming_mode!==true || next.config?.streaming_mode!==true) return {mode:'full',updates:[]};
  const inspect=card=>{
    const contents=new Map();let valid=true;
    const visit=value=>{
      if(Array.isArray(value))return value.map(visit);
      if(!value || typeof value!=='object')return value;
      const result={};
      const editable=value.tag==='markdown' && typeof value.content==='string' && /^[A-Za-z0-9_-]{1,20}$/.test(value.element_id??'');
      if(editable){if(contents.has(value.element_id))valid=false;contents.set(value.element_id,value.content);}
      for(const [key,item] of Object.entries(value))result[key]=editable && key==='content'?null:visit(item);
      return result;
    };
    return {shape:JSON.stringify(visit(card)),contents,valid};
  };
  const before=inspect(previous),after=inspect(next);
  if(!before.valid || !after.valid || before.shape!==after.shape)return {mode:'full',updates:[]};
  const updates=[];
  for(const [elementId,content] of after.contents)if(before.contents.get(elementId)!==content){
    // The element API does not accept an empty content string.
    if(!content || content.length>100000)return {mode:'full',updates:[]};
    updates.push({elementId,content});
  }
  return {mode:updates.length?'elements':'none',updates};
}

function appliedCard(previous,operation) {
  if(operation.body.card)return JSON.parse(operation.body.card.data);
  if(!previous)return null; // Legacy journals had no displayed-card snapshot.
  const elementId=operation.elementId??/\/elements\/([^/]+)\/content$/.exec(operation.endpoint)?.[1];
  const card=structuredClone(previous);let found=false;
  const visit=value=>{
    if(!value || typeof value!=='object')return;
    if(value.tag==='markdown' && value.element_id===elementId){value.content=operation.body.content;found=true;}
    for(const child of Object.values(value))if(child && typeof child==='object')visit(child);
  };
  visit(card);return found?card:null;
}

export async function updateStreamCard({file,s,final,binding,request,now,onMessage,sendMessage}) {
  const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));
  const merge=patch=>{const current=read();Object.assign(current,patch);atomicWriteJson(file,current);return current;};
  let current=read();
  if(!current.cardId){
    // Entity creation has no UUID in the official schema. A crash here may
    // leave an unsent entity, but must never create two visible messages.
    const initialCard=streamCard('',false,s.presentation);
    const result=await request(binding,['api','POST','/open-apis/cardkit/v1/cards','--data',JSON.stringify({type:'card_json',data:JSON.stringify(initialCard)})]);
    if(!/^[A-Za-z0-9_-]+$/.test(result?.card_id??''))throw Error('card_entity_id_missing');
    current=merge({cardId:result.card_id,cardSequence:0,lastAppliedCard:initialCard});
  }
  if(!current.messageId){
    const content=JSON.stringify({type:'card',data:{card_id:current.cardId}});
    const result=current.route && sendMessage
      ? await sendMessage({key:`card:${s.key}`,route:current.route,msgType:'interactive',content})
      : await request(binding,['api','POST','/open-apis/im/v1/messages','--params',JSON.stringify({receive_id_type:'chat_id'}),
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
    latest.lastAppliedCard=appliedCard(latest.lastAppliedCard,operation);
    let completed=true;
    if(latest.cardBatch){
      const expected=latest.cardBatch.operations[latest.cardBatch.next];
      if(expected?.sequence!==operation.sequence || expected?.body.uuid!==operation.body.uuid)throw Error('card_batch_journal_mismatch');
      latest.cardBatch.next++;
      completed=latest.cardBatch.next===latest.cardBatch.operations.length;
      if(completed){
        if(latest.cardBatch.targetCard)latest.lastAppliedCard=latest.cardBatch.targetCard;
        delete latest.cardBatch;
      }
    }
    // A partially applied collection of element changes is not a delivered
    // revision. Recovery resumes the remaining operations before newer output.
    if(completed){latest.sentRevision=operation.revision;latest.lastSentAt=now();latest.retryAt=0;latest.attempts=0;delete latest.error;delete latest.blocked;}
    if(operation.final)latest.cardClosed=true;
    atomicWriteJson(file,latest);return latest;
  };
  const drain=async()=>{
    while(current.cardPending || current.cardBatch){
      const operation=current.cardPending??current.cardBatch.operations[current.cardBatch.next];
      if(!operation)throw Error('card_batch_journal_invalid');
      if(!current.cardPending)current=merge({cardPending:operation});
      try { current=await apply(operation); }
      catch(error) {
        const code=String(error.apiCode??error.code??'');
        if(!['300309','200850'].includes(code) || !/\/elements\/[^/]+\/content$/.test(operation.endpoint))throw error;
        // The element request was rejected because the remote stream is closed.
        // Replace its remaining batch with a newer full snapshot on THE SAME
        // entity. Persist a new sequence/UUID before I/O; uncertain full updates
        // then replay identically after restart, without another visible card.
        const latest=read(), sequence=Math.max(latest.cardSequence??0,operation.sequence,
          ...(latest.cardBatch?.operations??[]).map(op=>op.sequence))+1;
        if(sequence>2147483647)throw Object.assign(Error('card_sequence_exhausted'),{permanent:true});
        const closing=Boolean(latest.final),revision=latest.revision;
        const targetCard=streamCard(latest.text,closing,{...latest.presentation,streaming:false});
        const replacement={sequence,revision,final:closing,endpoint:`/open-apis/cardkit/v1/cards/${latest.cardId}`,
          body:{uuid:digest(`${latest.key}:stream-fallback:${sequence}`).slice(0,40),sequence,card:{type:'card_json',data:JSON.stringify(targetCard)}}};
        current=merge({cardStreamingFallback:true,cardStreamingFallbackCode:code,
          cardBatch:{revision,final:closing,targetCard,operations:[replacement],next:0},cardPending:replacement});
      }
    }
  };
  await drain();
  // A finalized card must never reopen because of a stale progress snapshot.
  if((current.cardClosed || current.final) && !final)return;
  if(current.sentRevision>=s.revision && (!final || current.cardClosed))return;
  const targetCard=final || s.presentation || current.cardStreamingFallback
    ?streamCard(s.text,final,{...s.presentation,streaming:!current.cardStreamingFallback}):null;
  // Preserve the original no-presentation adapter, including raw answer text.
  const plan=targetCard?planCardUpdate(current.lastAppliedCard,targetCard,{final}):{mode:'elements',updates:[{elementId:'answer',content:s.text}]};
  if(plan.mode==='none'){
    merge({sentRevision:s.revision,lastAppliedCard:targetCard,lastSentAt:now(),retryAt:0,attempts:0});return;
  }
  const changes=plan.mode==='full'?[null]:plan.updates;
  if((current.cardSequence??0)+changes.length>2147483647)throw Object.assign(Error('card_sequence_exhausted'),{permanent:true});
  const operations=changes.map((change,index)=>{
    const sequence=(current.cardSequence??0)+index+1;
    return {sequence,revision:s.revision,final, ...(change?{elementId:change.elementId}:{}),
      endpoint:`/open-apis/cardkit/v1/cards/${current.cardId}${change?`/elements/${change.elementId}/content`:''}`,
      body:{uuid:digest(`${s.key}:${sequence}`).slice(0,40),sequence,
        ...(change?{content:change.content}:{card:{type:'card_json',data:JSON.stringify(targetCard)}})}};
  });
  current=merge({cardBatch:{revision:s.revision,final,targetCard,operations,next:0}});
  await drain();
}
