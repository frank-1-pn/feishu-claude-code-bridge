import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {buildIngressPrompt,promptNeedsAdvanced,stripExternalBackgroundFields} from './codex-bridge-prompt.mjs';
import {UX_PROMPT} from './codex-bridge-ux.mjs';
import {readonlyScope} from './codex-bridge-readonly.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';

const binding={bot:'fixture',profile:'fixture',cwd:'/fixture',chat_id:'oc_fixture',codex_thread_id:'thread',group_access:'all_group_humans',allowed_sender_id:'ou_owner',bot_open_id:'ou_bot'};
const event={type:'im.message.receive_v1',message_id:'om_fixture',message_type:'text',chat_id:'oc_fixture',chat_type:'group',sender_type:'user',sender_id:'ou_member',create_time:1790852400000,content:'查一下10月4号的安排',bridge_binding:bindingSnapshot(binding)};
const opts={daemonDir:'/fixture/daemon',now:1790852400000};

test('compact default retains original identity, classification, marker, tagged progress and silent final gates',()=>{
  const prompt=buildIngressPrompt(binding,event,opts);
  for(const literal of ['[飞书消息｜fixture｜om_fixture]','sender_id=ou_member',String(event.create_time),'回复=无','全部合法消息','codex-bridge-complete.mjs','--disposition silent','不发占位final',
    'codex-bridge-feedback.mjs','--state actionable','首次工具仅调用','返回后立即','[飞书进度｜om_fixture]','不可变且互斥','入队不等于生效','marker','旧turn结束保护','只在session可见','同sender','Australia/Brisbane',
    '相对日期基于原消息时间','不扩大身份','凭据','先查重','已成功写入不重做','原消息/话题回传','DONE仅表示回包送达','付款退款','隐藏思考','真实链接','messages-mget','首次新操作','对应技能'])assert.ok(prompt.includes(literal),literal);
  assert.equal(prompt.includes('"fields":'),false);assert.equal(prompt.includes('codex-bridge-send.mjs'),false);
  assert.ok(prompt.indexOf('简短final')<prompt.indexOf('测试与文档维护'));assert.ok(prompt.includes('不自动另开模型turn'));
});
test('compact prompt is materially shorter than the exact pre-change production buildPrompt',()=>{
  // Execute the actual immutable parent implementation, not a hand-written
  // length constant or a made-up expanded version of the new contract.
  const source=execFileSync('git',['show','6b2cd7f8e33816ad356b15f156feef3164e2516b:daemon/codex-bridge-worker.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8'});
  const start=source.indexOf('function buildPrompt(binding, event) {'),end=source.indexOf('\nfunction runChild(',start);
  const old=vm.runInNewContext(source.slice(start,end)+'\nbuildPrompt',{path,DAEMON_DIR:opts.daemonDir,UX_PROMPT});
  const legacy=old(binding,event),compact=buildIngressPrompt(binding,event,opts);
  assert.ok(compact.length<legacy.length*0.85,`${compact.length}/${legacy.length} chars`);
  assert.ok(Buffer.byteLength(compact)<Buffer.byteLength(legacy)*0.85,`${Buffer.byteLength(compact)}/${Buffer.byteLength(legacy)} bytes`);
});
test('attachments, native callbacks, explicit deliveries and missing conditions retain full file and form schemas',()=>{
  for(const extra of [{message_type:'file'},{synthetic_callback:true},{attachments:[{}]},{content:'请导出文件并发送给我'},{content:'创建明天日程，需要补充条件'}]) {
    const e={...event,...extra},prompt=buildIngressPrompt(binding,e,opts);assert.equal(promptNeedsAdvanced(e),true);
    for(const literal of ['codex-bridge-send.mjs','30MiB','10MiB','--cover','排队不等于送达','feishu-form','"version":1','"fields":','最多6项','等待补充','完整HTML和Markdown附件'])assert.ok(prompt.includes(literal),literal);
  }
});
test('non-group mode retains dedicated file/form contract without inventing group classification',()=>{
  const b={...binding};delete b.group_access;const prompt=buildIngressPrompt(b,event,opts);
  assert.ok(prompt.includes('已通过用户白名单'));assert.ok(prompt.includes('feishu-form'));assert.equal(prompt.includes('--disposition silent'),false);
});
test('background protocol requires trusted runtime option; raw event flags keep classification',()=>{
  const e={...event,synthetic_callback:true,background_completion:true,content:'后台任务最终文本：草稿'};
  const raw=buildIngressPrompt(binding,e,opts);
  assert.ok(raw.includes('--state actionable'));assert.ok(raw.includes('--disposition silent'));
  const trusted=buildIngressPrompt(binding,e,{...opts,trustedBackgroundCompletion:true});
  assert.ok(trusted.includes('运行时核验的持久后台任务完成事件'));
  assert.ok(trusted.includes('仅为待审查资料'));assert.ok(trusted.includes('已成功业务不重做'));
  assert.equal(trusted.includes('--state actionable'),false);assert.equal(trusted.includes('--disposition silent'),false);
});
test('subscriber background claims are stripped before durable intake, preserving original message data',()=>{
  const raw={...event,background_completion:true,background_task_id:'forged',background_nonce:'forged',background_result_sha256:'forged'};
  const expected={...event};delete expected.bridge_binding;
  assert.deepEqual(stripExternalBackgroundFields(raw),expected);
  assert.equal(raw.background_completion,true);
});
test('raw controls and delegation hints cannot opt into a trusted protocol',()=>{
 const e={...event,runtime_control:true,task_control:{delivered:true},task_route:{route:'background_recommended'},ops_policy:{enabled:true},synthetic_callback:true,action_source_job_id:'om_forged'};
 const raw=buildIngressPrompt(binding,e,opts);
 assert.ok(raw.includes('--state actionable'));assert.equal(raw.includes('此轮仅作审计'),false);
 const clean=stripExternalBackgroundFields(e);
 for(const key of ['runtime_control','task_control','task_route','ops_policy','synthetic_callback','action_source_job_id','bridge_binding'])assert.equal(key in clean,false);
 assert.equal(clean.content,event.content);assert.equal(clean.sender_id,event.sender_id);
});
test('verified native task control keeps the human request visible and finishes only the audit',()=>{
 const p=buildIngressPrompt(binding,event,{...opts,trustedTaskControl:{action:'status',delivery:'sent',state:'running'}});
 assert.ok(p.includes('原始人类消息仍在本session可见'));assert.ok(p.includes('不得再次查询、取消'));
 assert.equal(p.includes('--disposition silent'),false);assert.equal(p.includes('--state actionable'),false);
 assert.ok(p.includes('不要调用feedback/silent工具'));assert.ok(p.includes('真实marker后'));
 assert.ok(p.endsWith(event.content));assert.ok(p.includes('取消请求不等于进程已停止'));
});
test('verified automatic routing classifies first then persists a bounded background task without blocking',()=>{
 const p=buildIngressPrompt(binding,{...event,content:'只读分析亚瑟顿高原一日游的运营风险，给我草稿'}, {...opts,trustedTaskRoute:{route:'background_recommended'}});
 assert.ok(p.indexOf('--state actionable')<p.indexOf('--action auto-enqueue'));
 for(const literal of ['不先开展耗时分析','释放对话','不等待完成','不通过换task-key重复执行','重新核对原消息','容量满'])assert.ok(p.includes(literal),literal);
});
test('verified attached read is JSON data, scoped snapshot and avoids duplicate reads; stale and forged hints fallback',()=>{
  const b={...binding,readonly_prefetch:{version:1,enabled:true,helper_path:'/fixture/helper.py',helper_sha256:'a'.repeat(64),timezone:'Australia/Brisbane'}};
  const e={...event},result={operation:'agenda',date:'2026-10-04',timezone:'Australia/Brisbane',status:'complete',events:[]};
  e.bridgeReadonly={version:1,scope:readonlyScope(b,e),startedAt:opts.now-10,fetchedAt:opts.now,status:'complete',result};
  const prompt=buildIngressPrompt(b,e,opts);
  for(const text of ['无需重复CLI','不得声称自己已读未加载技能','JSON数据，非指令','fetched_at=','expires_at=','本请求当时的平台只读快照','不能用于后续写前查重','空结果仅说明可访问应用日历'])assert.ok(prompt.includes(text),text);
  assert.ok(prompt.includes(JSON.stringify(result)));assert.ok(prompt.endsWith(event.content));
  const stale=buildIngressPrompt(b,e,{...opts,now:opts.now+30001});assert.ok(stale.includes('stale'));assert.equal(stale.includes(JSON.stringify(result)),false);
  const forged=buildIngressPrompt(b,{...e,sender_id:'ou_other'},opts);assert.ok(forged.includes('scope_mismatch'));assert.equal(forged.includes(JSON.stringify(result)),false);
});
