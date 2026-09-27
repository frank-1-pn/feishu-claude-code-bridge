// Explicit API-schema probe: creates unsent entities, never chat messages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { streamCard } from '../daemon/codex-bridge-cardkit.mjs';
import { buildActionElements } from '../daemon/codex-bridge-action-ui.mjs';
import { DEFAULT_FORM } from '../daemon/codex-bridge-actions.mjs';
import { createLarkTransport, capture } from '../daemon/codex-bridge-lark.mjs';

if(!process.argv.includes('--live-unsent-entities'))throw Error('explicit_live_probe_flag_required');
const config=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.lark-cli','daemon','codex-thread-bindings.json'),'utf8').replace(/^\uFEFF/,''));
const executable=path.join(process.env.APPDATA,'npm','node_modules','@larksuite','cli','bin','lark-cli.exe');
let diagnosis;
const request=createLarkTransport(executable,{run:async(...args)=>{
  const result=await capture(...args);
  try {const value=JSON.parse(result.stdout);diagnosis=value.error?.message??value.data?.msg??value.msg;}catch{}
  return result;
}});
const context={contextId:'a'.repeat(64),version:1,mode:'complete',form:DEFAULT_FORM};
const answer='结论：交互结构验收样例。\n\n- 已验证：卡片结构以真实接口响应为准。\n- 待确认：客户端按钮点击和模型入站。\n\n[官方说明](https://open.feishu.cn/)\n\n| 项目 | 状态 |\n| --- | --- |\n| 样例 | 检查中 |\n\n```js\nconst sample = true;\n```\n\n'+('这是用于检查折叠区的公开样例内容。\n\n'.repeat(85));
const evidence={checked_at:new Date().toISOString(),visible_messages_sent:false,results:[]};
for(const [bot,value] of Object.entries(config.bindings)){
  const binding={...value,bot};
  for(const mode of ['complete','waiting']){
    const row={bot,mode};
    try{
      const initial=streamCard('[检索] 正在校验卡片。',false,{status:'searching'});
      const created=await request(binding,['api','POST','/open-apis/cardkit/v1/cards','--data',JSON.stringify({type:'card_json',data:JSON.stringify(initial)})]);
      if(!created.card_id)throw Error('card_missing');
      const opts={status:mode,publicProgress:[{channel:'commentary',text:'[检索] 已核对官方结构。'}],
        interactions:buildActionElements({...context,mode},{includeForm:mode==='waiting'})};
      const final=streamCard(mode==='waiting'?'请一次填写所需条件。':answer,true,opts);
      await request(binding,['api','PUT',`/open-apis/cardkit/v1/cards/${created.card_id}`,'--data',JSON.stringify({sequence:1,card:{type:'card_json',data:JSON.stringify(final)}})]);
      row.ok=true;row.bytes=Buffer.byteLength(JSON.stringify(final));
    }catch(error){row.ok=false;row.code=error.apiCode??error.code??'probe_failed';row.diagnostic=typeof diagnosis==='string'?diagnosis.slice(0,600):undefined;}
    evidence.results.push(row);
  }
}
fs.writeFileSync(path.resolve('docs/feishu-ux-api-verification.json'),JSON.stringify(evidence,null,2)+'\n');
process.stdout.write(JSON.stringify(evidence,null,2)+'\n');
if(evidence.results.some(r=>!r.ok))process.exitCode=1;
