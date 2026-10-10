import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DurableInbox} from './codex-bridge-inbox.mjs';
import {bindingSnapshot} from './codex-bridge-ux.mjs';
import {enqueueActionable,enqueueSilentCompletion} from './codex-bridge-completion.mjs';
import {classifyWithFastFeedback,isExplicitOperationalRequest} from './codex-bridge-fast-feedback.mjs';

function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fast-feedback-grammar-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',profile:'fixture',chat_id:'oc_fixture',allowed_sender_id:'ou_owner',bot_open_id:'ou_bot',
    group_access:'all_group_humans',codex_thread_id:'thread',fast_actionable_classification:true};
  const inboxRoot=path.join(root,'inbox'),controlRoot=path.join(root,'control'),rollout=path.join(root,'rollout');
  fs.writeFileSync(rollout,'');let next=0;
  const q=new DurableInbox(inboxRoot,binding.bot,{prepare:async e=>e,target:async()=>({rollout}),inject:async()=>{}});
  const add=(text,extra={})=>q.enqueue({type:'im.message.receive_v1',message_id:'om_'+(++next),chat_id:binding.chat_id,
    chat_type:'group',sender_type:'user',sender_id:'ou_member',message_type:'text',content:JSON.stringify({text}),
    bridge_binding:bindingSnapshot(binding),...extra});
  const classify=job=>classifyWithFastFeedback({root:controlRoot,inboxRoot,binding,job});
  const options=job=>({root:controlRoot,inboxRoot,binding,jobId:job.id});
  const mark=async job=>{
    fs.appendFileSync(rollout,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',
      content:[{type:'input_text',text:`[飞书消息｜fixture｜${job.id}]`}]}})+'\n');
    await q.watch();assert.equal(job.markerSeen,true);
  };
  return {q,binding,controlRoot,add,classify,options,mark};
}

test('single natural mailbox/calendar reads and explicit upload/meeting requests are recognized',()=>{
  for(const text of ['查看邮箱','看一下邮箱','帮我看看邮箱里面有什么新邮件吗','请帮我看看今天的日程',
    '帮我看一下明天有什么安排','查看一下今天日程','查下明天安排','帮我看一下最近的邮件',
    '现在有什么新邮件','今天有哪些邮件呢','查一下10月4日安排',
    '上传到云盘','上传云盘吧','请上传到飞书云盘','帮我上传文件','上传HTML文件到云盘，返回链接',
    '上传文件并返回下载链接','将最新版HTML作为文件发到群里','把已有最新版HTML文件作为文件发到本群',
    '帮我约一个1小时的会议，现在开始，群内所有人参加','请预约明天下午三点的会议',
    '约会议','预约会议','请创建明天下午的会议','取消亚瑟顿高原的行程']) {
    assert.equal(isExplicitOperationalRequest(text),true,text);
  }
});

test('clarifications, third-party chat, descriptions, quotes and compound/conditional requests remain with the model',()=>{
  for(const text of ['HTML文件','放到云盘','这个文件不能直接传输','最新版HTML需要作为文件','是的','好的谢谢',
    '约会','预约会议的人很多','看看邮件广告真烦','上传文件是怎么回事','上传文件时浏览器关闭了',
    '查看邮件这件事我已经做过了','上传文件并安排会议','约一个会议并上传文件','查看邮件，安排明天会议',
    '查看邮件并发送给客户','看一下邮件和日程','上传文件，然后返回链接','已有作品说明，另外帮我发HTML，然后给链接',
    '他说上传到云盘','她想预约会议','给小王预约会议','帮我看看群里同事说的邮件','帮我看看他的邮件',
    '“看一下邮箱”','转发：上传到云盘','如果有新邮件就看看','看看邮箱的话再说','不要上传文件',
    '别预约会议','没有要求查看邮件','能否约会议','可不可以上传文件','查看邮箱还是日程',
    '上传文件\n看一下邮箱','请帮我查一下天气','查询日程这句话什么意思']) {
    assert.equal(isExplicitOperationalRequest(text),false,text);
  }
});

test('new grammar publishes only after the exact private marker and never changes the original event',async t=>{
  const f=fixture(t),job=f.add('帮我约一个1小时的会议，现在开始，群内所有人参加'),original=structuredClone(job.event);
  await f.q.dispatchOne();assert.equal(f.classify(job),null);assert.equal(fs.existsSync(f.controlRoot),false);
  const other=f.add('看一下邮箱');await f.q.dispatchOne();await f.mark(other);
  assert.equal(f.classify(job),null);await f.mark(job);assert.equal(f.classify(job),'actionable');
  assert.deepEqual(job.event,original);assert.equal(job.status,'delivered');
});

test('only one exact self-mention key prefix is removable; names and other/ambiguous mentions stay untouched',async t=>{
  const f=fixture(t);
  const cases=[
    ['@_user_1 看一下邮箱',[{id:{open_id:'ou_bot'},key:'@_user_1'}],true],
    ['@_user_1，帮我约会议',[{id:'ou_bot',key:'@_user_1'}],true],
    ['@运营助手 看一下邮箱',[{id:'ou_bot',name:'运营助手'}],false],
    ['@_user_1 看一下邮箱',[{name:'运营助手',key:'@_user_1'}],false],
    ['@_user_1 看一下邮箱',[{id:'ou_other',key:'@_user_1'}],false],
    ['@_user_1 @_user_2 看一下邮箱',[{id:'ou_bot',key:'@_user_1'},{id:'ou_other',key:'@_user_2'}],false],
    ['@_user_1 看一下邮箱',[{id:'ou_bot',key:'@_user_1'},{id:'ou_bot',key:'@_user_1'}],false],
    ['@_user_10 看一下邮箱',[{id:'ou_bot',key:'@_user_1'}],false],
    ['看看 看一下邮箱',[{id:'ou_bot',key:'看看'}],false],
  ];
  for(const [text,mentions,expected] of cases){
    const job=f.add(text,{mentions}),original=structuredClone(job.event);await f.q.dispatchOne();await f.mark(job);
    assert.equal(f.classify(job),expected?'actionable':null,text);assert.deepEqual(job.event,original);
  }
});

test('silent wins immutably and old/done/rebound/unmarked requests cannot become new actionable feedback',async t=>{
  const f=fixture(t),silent=f.add('上传到云盘');await f.q.dispatchOne();enqueueSilentCompletion(f.options(silent));
  await f.mark(silent);assert.equal(f.classify(silent),'silent');assert.throws(()=>enqueueActionable(f.options(silent)),/conflict/);
  const ended=f.add('看一下邮箱');await f.q.dispatchOne();await f.mark(ended);
  ended.unclassifiedTurnEnded=true;f.q.save(ended);assert.equal(f.classify(ended),null);
  const done=f.add('约会议');done.markerSeen=true;done.status='done';f.q.save(done);assert.equal(f.classify(done),null);
  const rebound=f.add('上传文件');await f.q.dispatchOne();await f.mark(rebound);
  rebound.event.bridge_binding.codex_thread_id='other';f.q.save(rebound);assert.equal(f.classify(rebound),null);
  const fresh=f.add('看一下邮箱');await f.q.dispatchOne();await f.mark(fresh);assert.equal(f.classify(fresh),'actionable');
});
