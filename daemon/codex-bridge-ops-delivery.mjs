import fs from 'node:fs';
import path from 'node:path';
import {digest} from './codex-bridge-inbox.mjs';
import {atomicWriteJson} from './codex-bridge-storage.mjs';
import {opsScope,definitelyFailedOpsSend} from './codex-bridge-ops-policy.mjs';
import {sanitizeFeishuReply} from './codex-bridge-sanitize.mjs';

const stable=value=>JSON.stringify(value,(_,v)=>v && typeof v==='object' && !Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const id=value=>typeof value==='string' && /^om_[A-Za-z0-9_-]+$/.test(value) && !value.startsWith('om_cb_');
const invalid=code=>Object.assign(Error(code),{code,permanent:true});
function privateFile(file,{optional=false}={}) {
  if(optional && !fs.existsSync(file))return null;
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid() || (stat.mode&0o077)
      || stat.nlink!==1 || stat.size>256*1024 || fs.realpathSync(file)!==path.resolve(file))throw invalid('ops_delivery_private_state_invalid');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}

const plain=value=>String(value).replace(/&#(\d{1,6});/g,(_,n)=>Number(n)<=0x10ffff?String.fromCodePoint(Number(n)):'')
  .replace(/<[^>]*>/g,'').replace(/[\\*`#]/g,'').replace(/\s+/g,' ').trim();
function cardTexts(card) {
  const texts=[];
  const visit=value=>{if(!value || typeof value!=='object')return;
    if(['plain_text','markdown','lark_md'].includes(value.tag) && typeof value.content==='string')texts.push(plain(value.content));
    for(const [key,child] of Object.entries(value))if(!['confirm','behaviors'].includes(key)) {
      if(Array.isArray(child))child.forEach(visit);else if(child && typeof child==='object')visit(child);
    }
  };visit(card);return [...new Set(texts.filter(Boolean))];
}
function allStrings(value) {
  if(typeof value==='string')return [value];
  if(!value || typeof value!=='object')return [];
  return Object.values(value).flatMap(allStrings);
}
export async function verifyOpsMessage({binding,messageId,msgType,text,card,appId,route,request}) {
  if(!id(messageId))return false;
  const response=await request(binding,['api','GET',`/open-apis/im/v1/messages/${messageId}`]);
  const matches=Array.isArray(response?.items)?response.items.filter(item=>item.message_id===messageId):[];
  if(matches.length!==1)return false;
  const message=matches[0];
  if(message.chat_id!==binding.chat_id || message.msg_type!==msgType || message.deleted!==false
      || !['app','bot'].includes(message.sender?.sender_type))return false;
  const sender=message.sender;
  if(!(sender.id_type==='app_id' && typeof appId==='string' && appId && sender.id===appId)
      && !(sender.id_type==='open_id' && typeof binding.bot_open_id==='string' && sender.id===binding.bot_open_id))return false;
  if(route?.mode==='quote' && message.parent_id!==route.messageId)return false;
  if(route?.mode==='thread' && (message.parent_id!==route.messageId || route.threadId && message.thread_id!==route.threadId))return false;
  let content=message.body?.content;
  try{if(typeof content==='string')content=JSON.parse(content);}catch{return false;}
  if(msgType==='text')return content?.text===text;
  if(msgType!=='interactive' || !card || typeof content!=='object' || !content)return false;
  // Feishu may return a simplified visible card rather than the sent DSL.
  // A generic title is insufficient; require the frozen snapshot's unique BG
  // reference and all visible text. If original DSL is supplied, compare it too.
  const dsl=content.user_dsl??message.body?.user_dsl;
  if(dsl!==undefined){try{return stable(typeof dsl==='string'?JSON.parse(dsl):dsl)===stable(card) && cardTexts(card).some(value=>/BG-[A-F0-9]{12}/.test(value));}catch{return false;}}
  const texts=cardTexts(card),visible=plain(allStrings(content).join(' '));
  return texts.some(value=>/BG-[A-F0-9]{12}/.test(value)) && texts.every(value=>visible.includes(value));
}

// Use the existing serialized output lane and native router. This journal
// distinguishes a definite platform ACK from actual readback, and never turns
// a GET failure into another create request. Only private ACK evidence can
// recover a create whose local journal update was interrupted.
export class OpsDelivery {
  constructor({root,binding,codexHome,router,outbound,request,getRoute,resolveAppId,now=Date.now}) {
    Object.assign(this,{binding,router,outbound,request,getRoute,resolveAppId,now});
    this.scope=opsScope(binding,codexHome);this.dir=path.join(root,binding.bot);
    for(const dir of [root,this.dir]) {
      if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true,mode:0o700});
      const stat=fs.lstatSync(dir);
      if(!stat.isDirectory() || stat.isSymbolicLink() || stat.uid!==process.getuid() || (stat.mode&0o077)
          || fs.realpathSync(dir)!==path.resolve(dir))throw invalid('ops_delivery_private_directory_invalid');
    }
    this.busy=false;
  }
  file(key){return path.join(this.dir,`delivery-${digest(key)}.json`);}
  read(key){const state=privateFile(this.file(key),{optional:true});if(state && stable(state.scope)!==stable(this.scope))throw invalid('ops_delivery_scope_changed');return state;}
  save(state){atomicWriteJson(this.file(state.key),state);}
  nativeAck(state) {
    const keyHash=digest(`${this.router.scope}\0ops:${state.key}`),file=path.join(this.router.root,`send-${keyHash}.json`);
    const ack=privateFile(file,{optional:true});
    if(!ack)return null;
    const fallbackMode=ack.fallback==='source_unavailable' && state.route.mode!=='chat'?'chat'
      :ack.fallback==='thread_unsupported' && state.route.mode==='thread'?'quote':null;
    const expectedRoute=fallbackMode?{...state.route,mode:fallbackMode}:state.route;
    if(ack.schema!==1 || ack.scope!==this.router.scope || ack.keyHash!==keyHash
        || ack.msgType!==state.msgType || ack.content!==JSON.stringify(state.content)
        || stable(ack.route)!==stable(expectedRoute) || ack.uuid!==digest(`native-reply:${keyHash}`).slice(0,40)
        || ack.payloadHash!==digest(JSON.stringify({msgType:state.msgType,content:JSON.stringify(state.content),route:state.route})))
      throw invalid('ops_delivery_native_ack_changed');
    return ack.status==='sent' && ack.uncertain===false && ack.result?.chat_id===this.binding.chat_id && id(ack.result?.message_id)?{...ack.result,effectiveRoute:ack.route}:null;
  }
  async send(text,key,{ownerKind,ownerId,jobId,card,contextId,onMessage,cardMarker='后台任务'}={}) {
    if(!['control','alert'].includes(ownerKind) || !/^[a-f0-9]{64}$/.test(ownerId??'') || typeof key!=='string' || !key || key.length>300)
      throw invalid('ops_delivery_identity_invalid');
    const clean=sanitizeFeishuReply(text).trim();
    const content=card??{text:clean},msgType=card?'interactive':'text';
    if(!content || !clean || Buffer.byteLength(JSON.stringify(content))>30*1024)throw invalid('ops_delivery_payload_invalid');
    let state=this.read(key);
    const base={scope:this.scope,key,ownerKind,ownerId,jobId,msgType,content,...(contextId?{contextId}:{}),cardMarker};
    if(state){const {route:_,...previous}=state.intent;if(stable(previous)!==stable(base))throw invalid('ops_delivery_intent_changed');}
    let route=state?.route;
    if(!state || !state.messageId && ['pending','rejected'].includes(state.status)) {
      // Route preparation performs only GETs. A failure here proves zero new
      // create attempts, while any earlier uncertain create remains fenced.
      try{route=await this.getRoute(jobId);}catch{return {delivered:false,definitelyFailed:true};}
    }
    const intent={...base,route};
    if(state && stable(state.intent)!==stable(intent))throw invalid('ops_delivery_intent_changed');
    if(!state){state={...intent,schema:1,intent,status:'pending',createdAt:this.now()};this.save(state);}
    if(state.status==='verified')return {delivered:true,messageId:state.messageId};
    if(!state.messageId && ['submitting','unknown'].includes(state.status)) {
      const ack=this.nativeAck(state);
      if(ack){state.messageId=ack.message_id;state.status='acknowledged';this.save(state);}
      else return {delivered:false,uncertain:true};
    }
    if(!state.messageId) {
      state.status='submitting';state.submittedAt=this.now();this.save(state);
      try {
        const ack=await this.outbound.serial(()=>this.router.send({key:`ops:${key}`,route:state.route,msgType,content}));
        if(!id(ack?.message_id))throw invalid('ops_delivery_ack_invalid');
        state.messageId=ack.message_id;state.status='acknowledged';state.acknowledgedAt=this.now();this.save(state);
      }catch(error){state.status=definitelyFailedOpsSend(error)?'rejected':'unknown';this.save(state);return {delivered:false,...(state.status==='rejected'?{definitelyFailed:true}:{uncertain:true})};}
    }
    return this.verify(state,onMessage);
  }
  async verify(state,onMessage) {
    if(state.contextId)await onMessage?.(state.contextId,state.messageId);
    let verified=false;
    try{const native=this.nativeAck(state);
      if(!native || native.message_id!==state.messageId)return {delivered:false,uncertain:true,messageId:state.messageId};
      const appId=await this.resolveAppId?.();
      verified=await verifyOpsMessage({binding:this.binding,messageId:state.messageId,msgType:state.msgType,text:state.content.text,
        card:state.msgType==='interactive'?state.content:undefined,appId,route:native.effectiveRoute,request:this.request});}catch{}
    if(!verified)return {delivered:false,uncertain:true,messageId:state.messageId};
    state.status='verified';state.verifiedAt=this.now();this.save(state);
    return {delivered:true,messageId:state.messageId};
  }
  async reconcile({onMessage,onVerified}={}) {
    if(this.busy)return;
    this.busy=true;
    try {
      for(const name of fs.readdirSync(this.dir).filter(n=>/^delivery-[a-f0-9]{64}\.json$/.test(n))) {
        const state=privateFile(path.join(this.dir,name));
        if(stable(state.scope)!==stable(this.scope))continue;
        if(['submitting','unknown'].includes(state.status) && !state.messageId) {
          const ack=this.nativeAck(state);
          if(ack){state.messageId=ack.message_id;state.status='acknowledged';this.save(state);}
        }
        if(state.messageId && state.status!=='rejected' && state.status!=='verified')await this.verify(state,onMessage);
        // Idempotent owner reconciliation also closes a crash after verified
        // platform readback but before the owning control/alert receipt update.
        if(state.status==='verified')await onVerified?.(state);
      }
    }finally{this.busy=false;}
  }
  stats() {
    let pending=0,blocked=0;
    for(const name of fs.readdirSync(this.dir).filter(n=>/^delivery-[a-f0-9]{64}\.json$/.test(n))) {
      try{const s=privateFile(path.join(this.dir,name));if(stable(s.scope)!==stable(this.scope))continue;
        if(['pending','submitting','acknowledged'].includes(s.status))pending++;
        if(s.status==='unknown')blocked++;
      }catch{blocked++;}
    }
    return {ops_delivery_pending_count:pending,ops_delivery_blocked_count:blocked};
  }
}
