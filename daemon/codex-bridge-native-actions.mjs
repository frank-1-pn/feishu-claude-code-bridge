import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { digest } from './codex-bridge-inbox.mjs';
import { atomicWriteJson } from './codex-bridge-storage.mjs';
import { normalizeActionCallback } from './codex-bridge-actions.mjs';
import { bindingSnapshot } from './codex-bridge-ux.mjs';
import { recordFailure } from './codex-bridge-retry.mjs';
import { taskDue } from './codex-bridge-tasks.mjs';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const copy = value => JSON.parse(JSON.stringify(value));
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const fail = code => { throw Object.assign(Error(code),{nativeActionCode:code}); };
const idValid = value => typeof value === 'string' && /^om_[A-Za-z0-9_-]+$/.test(value);
const kinds = new Set(['task_open','task_create','voice_confirm']);
const allowedNames = {task_open:[],task_create:['summary','due','reminder'],voice_confirm:['transcript']};
const feedback = {
  unauthorized:'会话或操作人不匹配，未执行。', unbound_card:'卡片尚未就绪，请稍后重试。',
  stale_context:'这张卡片已失效，请使用最新卡片。', expired:'确认已过期，请重新发起。',
  stale_form:'这份表单已经提交，不会重复执行。', replay_mismatch:'重复事件内容不一致，未执行。',
  invalid_form_values:'表单内容无效，请检查必填项、选项和长度。',
  storage_unavailable:'暂未能保存，请稍后重试。', invalid_action:'无法识别这次操作，未执行。',
};
const outcome = (reason,id) => ({ accepted:['accepted','duplicate'].includes(reason), duplicate:reason==='duplicate', reason,
  ...(id?{operationId:id}:{}), response:{toast:{type:['accepted','duplicate'].includes(reason)?'success':'error',
    content:['accepted','duplicate'].includes(reason)?'确认已保存，正在处理。':feedback[reason]??feedback.invalid_action}} });

function normalizeNativeForm(kind,form) {
  if (kind === 'task_open') { if (form?.fields?.length) fail('invalid_form'); return {fields:[]}; }
  if (!plain(form) || !Array.isArray(form.fields) || !form.fields.length || form.fields.length > 3) fail('invalid_form');
  const seen = new Set();
  const fields = form.fields.map(field => {
    if (!plain(field) || !allowedNames[kind].includes(field.name) || seen.has(field.name)
        || !['text','select'].includes(field.type) || typeof field.label !== 'string' || !field.label.trim() || field.label.length > 80)
      fail('invalid_form');
    seen.add(field.name);
    const normalized = {name:field.name,label:field.label,type:field.type,required:field.required===true};
    if (field.type === 'text') {
      const cap = field.name==='transcript'?6000:field.name==='summary'?1000:80;
      normalized.maxLength = field.maxLength ?? cap;
      if (!Number.isInteger(normalized.maxLength) || normalized.maxLength < 1 || normalized.maxLength > cap) fail('invalid_form');
    } else {
      if (!Array.isArray(field.options) || !field.options.length || field.options.length > 20) fail('invalid_form');
      const values = new Set();
      normalized.options = field.options.map(option => {
        if (!plain(option) || typeof option.value !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(option.value)
            || values.has(option.value) || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 80) fail('invalid_form');
        values.add(option.value); return {value:option.value,label:option.label};
      });
    }
    return normalized;
  });
  if (kind==='voice_confirm' && (fields.length!==1 || fields[0].name!=='transcript' || fields[0].type!=='text' || !fields[0].required)) fail('invalid_form');
  if (kind==='task_create' && !fields.some(field=>field.name==='summary' && field.type==='text' && field.required)) fail('invalid_form');
  return {fields};
}

function normalizeData(kind,data) {
  if (!plain(data)) fail('invalid_context');
  const allowed = kind==='task_open'?['answer','replyKey']:kind==='voice_confirm'?['voiceId']:['answer','replyKey','sourceUrl'];
  if (Object.keys(data).some(key=>!allowed.includes(key))) fail('invalid_context');
  for (const value of Object.values(data)) if (typeof value!=='string' || value.length>4*1024*1024) fail('invalid_context');
  if (kind==='task_open' && (!data.answer?.trim() || !data.replyKey)) fail('invalid_context');
  if (kind==='voice_confirm' && !/^[A-Za-z0-9_-]{1,160}$/.test(data.voiceId??'')) fail('invalid_context');
  return copy(data);
}

function parseValues(raw,form,kind) {
  if (!plain(raw)) fail('invalid_form_values');
  const acceptedNames = form.fields.flatMap(field => field.type==='text' && field.maxLength>1000
    ? Array.from({length:Math.ceil(field.maxLength/999)},(_,i)=>`${field.name}_${i+1}`) : [field.name]);
  if (Object.keys(raw).some(name=>!acceptedNames.includes(name))) fail('invalid_form_values');
  const result = {};
  for (const field of form.fields) {
    let value;
    if (field.type==='text' && field.maxLength>1000) {
      value = Array.from({length:Math.ceil(field.maxLength/999)},(_,i)=> {
        const part=raw[`${field.name}_${i+1}`]??'';
        if(typeof part!=='string' || part.length>1000)fail('invalid_form_values');
        return part;
      }).join('');
    } else value = raw[field.name] ?? '';
    if (typeof value !== 'string') fail('invalid_form_values');
    value = value.trim();
    if(kind==='task_create' && field.name==='due') {
      // Feishu appends the device's offset as reference metadata. The picker
      // explicitly asks for Beijing wall time, as did the legacy text input.
      const picked=/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value);
      if(picked){
        if(+picked[3]>14 || +picked[4]>59 || (+picked[3]===14 && +picked[4]!==0))fail('invalid_form_values');
        value=picked[1];
      }
    }
    if (field.required && !value) fail('invalid_form_values');
    if (field.type==='text' && value.length>field.maxLength) fail('invalid_form_values');
    if (field.type==='select' && value && !field.options.some(option=>option.value===value)) fail('invalid_form_values');
    result[field.name] = value;
  }
  return result;
}

// Callback receipt only persists a local intention. Network/model effects belong
// to drain handlers and must be idempotent using operation.id, including restart.
export class NativeActionStore {
  constructor({root,binding,now=Date.now,ttlMs=24*60*60*1000,afterIntent,afterHandle}={}) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(binding?.bot??'') || !Number.isSafeInteger(ttlMs) || ttlMs<1 || ttlMs>14*24*60*60*1000)
      throw Error('invalid_native_action_store');
    this.binding=binding;this.now=now;this.ttlMs=ttlMs;this.afterIntent=afterIntent;this.afterHandle=afterHandle;
    this.scope=bindingSnapshot(binding);this.dir=path.join(root,binding.bot);
    this.contexts=path.join(this.dir,'contexts');this.operations=path.join(this.dir,'operations');this.replays=path.join(this.dir,'replays');
    for(const dir of [this.contexts,this.operations,this.replays])fs.mkdirSync(dir,{recursive:true});
    const secretFile=path.join(this.dir,'context-secret');
    if(!fs.existsSync(secretFile)){
      let fd;try{fd=fs.openSync(secretFile,'wx',0o600);fs.writeFileSync(fd,randomBytes(32).toString('hex'));fs.fsyncSync(fd);}
      catch(error){if(error.code!=='EEXIST')throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}
    }
    this.secret=fs.readFileSync(secretFile,'utf8');if(!/^[a-f0-9]{64}$/.test(this.secret))throw Error('invalid_native_action_secret');
    this.recoverIntents();
  }
  contextFile(id){if(!/^[a-f0-9]{64}$/.test(id??''))fail('invalid_action');return path.join(this.contexts,`${id}.json`);}
  operationFile(id){this.contextFile(id);return path.join(this.operations,`${id}.json`);}
  descriptor(context){return copy({contextId:context.contextId,kind:context.kind,form:context.form,expiresAt:context.expiresAt,
    value:{bridge_native:'v1',context_id:context.contextId}});}
  register({key,kind,sourceJobId,data,form}){
    if(typeof key!=='string'||!key||key.length>400||!kinds.has(kind)||!idValid(sourceJobId))fail('invalid_context');
    const identity={scope:this.scope,keyHash:digest(key),kind,sourceJobId,data:normalizeData(kind,data),form:normalizeNativeForm(kind,form)};
    const contextId=createHmac('sha256',this.secret).update(JSON.stringify([this.scope,key,kind])).digest('hex');
    const file=this.contextFile(contextId);let context;
    if(fs.existsSync(file)){context=read(file);if(!same(context.identity,identity))fail('context_conflict');}
    else{context={contextId,...identity,identity,createdAt:this.now(),expiresAt:this.now()+this.ttlMs,messageId:null};atomicWriteJson(file,context);}
    return this.descriptor(context);
  }
  bindMessage(id,messageId){
    if(!idValid(messageId)||messageId.startsWith('om_cb_'))fail('invalid_context');
    const file=this.contextFile(id),context=read(file);
    if(!same(context.scope,this.scope))fail('unauthorized');
    if(context.messageId && context.messageId!==messageId)fail('context_conflict');
    if(!context.messageId){context.messageId=messageId;atomicWriteJson(file,context);}
    return this.descriptor(context);
  }
  recoverIntents(){
    for(const name of fs.readdirSync(this.operations).filter(name=>/^[a-f0-9]{64}\.json$/.test(name))){
      const operation=read(path.join(this.operations,name));
      for(const replayHash of operation.replayHashes){
        if(!/^[a-f0-9]{64}$/.test(replayHash))throw Error('invalid_native_action_intent');
        const file=path.join(this.replays,`${replayHash}.json`),pointer={contextId:operation.contextId,id:operation.id,logical:operation.logical};
        if(fs.existsSync(file)){if(!same(read(file),pointer))throw Error('native_action_replay_conflict');}
        else atomicWriteJson(file,pointer);
      }
    }
  }
  acceptCallback(envelope,{binding=this.binding,authenticatedBot,appId}={}){
    try{
      if(this.needsRecovery){this.recoverIntents();this.needsRecovery=false;}
      const callback=normalizeActionCallback(envelope),value=callback.action?.value;
      if(authenticatedBot!==this.binding.bot || !same(bindingSnapshot(binding),this.scope)
        || (callback.appId && appId && callback.appId!==appId) || (callback.host && callback.host!=='im_message'))fail('unauthorized');
      if(!plain(value)||Object.keys(value).sort().join(',')!=='bridge_native,context_id'||value.bridge_native!=='v1'||callback.action.tag!=='button')fail('invalid_action');
      const file=this.contextFile(value.context_id);if(!fs.existsSync(file))fail('stale_context');
      const context=read(file);
      if(!same(context.scope,this.scope)||callback.operator?.open_id!==this.binding.allowed_sender_id
        ||callback.context?.open_chat_id!==this.binding.chat_id)fail('unauthorized');
      if(!context.messageId)fail('unbound_card');
      if(callback.context?.open_message_id!==context.messageId)fail('unauthorized');
      if(this.now()>=context.expiresAt)fail('expired');
      const values=parseValues(callback.action.form_value??{},context.form,context.kind);
      const logical=digest(JSON.stringify([context.contextId,values]));
      const replayHashes=[];
      if(typeof callback.eventId==='string'&&callback.eventId&&callback.eventId.length<=256)replayHashes.push(digest(`event:${callback.eventId}`));
      if(typeof callback.token==='string'&&callback.token&&callback.token.length<=1024)replayHashes.push(digest(`token:${callback.token}`));
      if(!replayHashes.length)fail('invalid_action');
      for(const replayHash of replayHashes){const replay=path.join(this.replays,`${replayHash}.json`);if(fs.existsSync(replay)&&read(replay).logical!==logical)fail('replay_mismatch');}
      const operationFile=this.operationFile(context.contextId);
      if(fs.existsSync(operationFile)){
        const prior=read(operationFile);if(prior.logical!==logical)fail('stale_form');
        prior.replayHashes=[...new Set([...prior.replayHashes,...replayHashes])];atomicWriteJson(operationFile,prior);
        this.recoverIntents();return outcome('duplicate',prior.id);
      }
      const operation={id:`native_${logical}`,contextId:context.contextId,logical,replayHashes,scope:this.scope,
        kind:context.kind,sourceJobId:context.sourceJobId,messageId:context.messageId,data:context.data,values,
        acceptedAt:this.now(),status:'pending'};
      atomicWriteJson(operationFile,operation);this.afterIntent?.(operation);this.recoverIntents();
      return outcome('accepted',operation.id);
    }catch(error){if(!error.nativeActionCode)this.needsRecovery=true;return outcome(error.nativeActionCode??'storage_unavailable');}
  }
  drain({handlers,binding=this.binding,limit=20}={}){
    if(!this.draining)this.draining=this.drainOnce({handlers,binding,limit}).finally(()=>{this.draining=null;});
    return this.draining;
  }
  async drainOnce({handlers,binding,limit}){
    if(this.needsRecovery){this.recoverIntents();this.needsRecovery=false;}
    if(!same(bindingSnapshot(binding),this.scope))throw Error('native_action_binding_changed');
    const pending=fs.readdirSync(this.operations).filter(name=>/^[a-f0-9]{64}\.json$/.test(name))
      .map(name=>({file:path.join(this.operations,name),operation:read(path.join(this.operations,name))}))
      .filter(({operation})=>['pending','running'].includes(operation.status))
      .sort((a,b)=>a.operation.acceptedAt-b.operation.acceptedAt);
    let done=0;
    for(const {file,operation} of pending.slice(0,Math.max(1,Math.min(100,limit)))){
      if((operation.retryAt??0)>this.now())continue;
      if(!same(operation.scope,this.scope)){operation.status='blocked';operation.error='native_action_binding_changed';atomicWriteJson(file,operation);continue;}
      const handler=handlers?.[operation.kind];if(typeof handler!=='function')continue;
      try{
        operation.status='running';atomicWriteJson(file,operation);
        const result=await handler(copy(operation),copy(read(this.contextFile(operation.contextId))));
        this.afterHandle?.(operation);
        // Callback retries may have added transport replay IDs while awaiting IO.
        const latest=read(file);
        if(result?.blocked===true || ['blocked','uncertain'].includes(result?.status)){
          latest.status='blocked';latest.blocked=true;
          latest.error=/^[A-Za-z0-9_]{1,80}$/.test(result.error??'')?result.error:result.status==='uncertain'?'native_action_result_uncertain':'native_action_blocked';
          delete latest.retryAt;
        }else if(result?.pending===true || ['pending','queued','running'].includes(result?.status)){
          latest.status='pending';latest.blocked=false;
          const due=Number.isFinite(result.retryAt)?result.retryAt:this.now()+5000;
          latest.retryAt=Math.max(this.now()+1000,Math.min(this.now()+300000,due));
        }else{
          latest.status='done';latest.completedAt=this.now();delete latest.error;delete latest.retryAt;done++;
        }
        atomicWriteJson(file,latest);
      }catch(error){
        const latest=read(file);recordFailure(latest,error,this.now());latest.status=latest.blocked?'blocked':'pending';
        atomicWriteJson(file,latest);
      }
    }
    return {done,...this.stats()};
  }
  stats(){
    let accepted=0,pending=0,blocked=0,done=0;
    for(const name of fs.readdirSync(this.operations).filter(name=>/^[a-f0-9]{64}\.json$/.test(name))){
      const operation=read(path.join(this.operations,name));if(!same(operation.scope,this.scope))continue;
      accepted++;if(['pending','running'].includes(operation.status))pending++;if(operation.status==='blocked')blocked++;if(operation.status==='done')done++;
    }
    return {native_action_accepted_count:accepted,native_action_pending_count:pending,native_action_blocked_count:blocked,native_action_done_count:done};
  }
}

const plainText = content => ({tag:'plain_text',content:String(content)});
function inputChunks(value){
  const chunks=[];let offset=0;
  while(offset<value.length){
    let end=Math.min(value.length,offset+1000);
    // Never render half a surrogate pair in an editable field.
    if(end<value.length && /[\uD800-\uDBFF]/.test(value[end-1]) && /[\uDC00-\uDFFF]/.test(value[end]))end--;
    chunks.push(value.slice(offset,end));offset=end;
  }
  return chunks.length?chunks:[''];
}
export function button(context,label='确认',options={}){
  if(!/^[a-f0-9]{64}$/.test(context?.contextId??'')||context.value?.bridge_native!=='v1')throw Error('invalid_native_action_context');
  return {tag:'button',element_id:options.elementId??'native_confirm',text:plainText(label),type:options.type??'primary',
    ...(options.submit?{name:'native_submit',form_action_type:'submit'}:{}),
    behaviors:[{type:'callback',value:copy(context.value)}]};
}

export function formCard(context,{title='确认操作',notice='',fields=context.form?.fields,defaults={},submitLabel='确认提交'}={}){
  const normalized=normalizeNativeForm(context.kind,{fields});
  if(!same(normalized,context.form))throw Error('native_action_form_changed');
  const elements=[];
  if(notice)elements.push({tag:'markdown',content:String(notice).replace(/([\\`*_{}\[\]()#+.!|~<>])/g,'\\$1')});
  for(const field of normalized.fields){
    const value=defaults[field.name]??'';
    if(typeof value!=='string'||(field.type==='text'&&value.length>field.maxLength)
      ||(field.type==='select'&&value&&!field.options.some(option=>option.value===value)))throw Error('invalid_native_action_default');
    if(context.kind==='task_create' && field.name==='due'){
      // Keep the signed form schema and callback name stable so already-sent
      // forms can use the picker without invalidating their confirmation keys.
      let initial;
      try {if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value) && taskDue(value))initial=value;}catch{}
      elements.push({tag:'markdown',content:'截止时间（按北京时间选择，可不选）'},
        {tag:'picker_datetime',element_id:'native_due',name:field.name,required:field.required,width:'fill',
          placeholder:plainText('选择日期和时间（可不选）'),...(initial?{initial_datetime:initial}:{})});
    }else if(field.type==='text'){
      const split=field.maxLength>1000,chunks=split?inputChunks(value):[value],count=chunks.length;
      for(let part=0;part<count;part++)elements.push({tag:'input',element_id:`native_${field.name}_${part}`,name:split?`${field.name}_${part+1}`:field.name,
        label:plainText(count>1?`${field.label}（${part+1}/${count}）`:field.label),label_position:'top',
        required:field.required&&part===0,max_length:Math.min(1000,field.maxLength),width:'fill',default_value:chunks[part],
        ...(field.maxLength>300?{input_type:'multiline_text',rows:4}:{})});
    }else elements.push({tag:'select_static',element_id:`native_${field.name}`,name:field.name,required:field.required,width:'fill',
      placeholder:plainText(field.label),options:field.options.map(option=>({text:plainText(option.label),value:option.value})),
      // A blank selection maps to the handler's explicit no-reminder default.
      // Avoid relying on an unverified select default-value contract.
      });
  }
  return {schema:'2.0',config:{update_multi:true,enable_forward_interaction:false},
    header:{template:'blue',title:plainText(title)},body:{elements:[{tag:'form',element_id:'native_form',name:'native_form',
      direction:'vertical',elements:[...elements,button(context,submitLabel,{submit:true})]}]}};
}
