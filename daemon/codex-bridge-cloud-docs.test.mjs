import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableInbox, digest } from './codex-bridge-inbox.mjs';
import { CloudDocOutbox, cloudDocBatches } from './codex-bridge-cloud-docs.mjs';
import { CLOUD_DOC_PRESENTATION_VERSION } from './codex-bridge-cloud-presentation.mjs';

const paragraph=(id,content='正文')=>({block_id:id,block_type:2,text:{elements:[{text_run:{content}}]}});
const converted=(n=1)=>({first_level_block_ids:Array.from({length:n},(_,i)=>`block${i}`),
  blocks:Array.from({length:n},(_,i)=>paragraph(`block${i}`))});
const apiError=(code,message='sensitive raw diagnostics')=>Object.assign(Error(message),{apiCode:code});

function fixture(t,{text='完整报告，保留准确来源和原始附件。\n'.repeat(180),conversion=converted()}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-doc-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binding={bot:'fixture',profile:'fixture-profile',chat_id:'oc_fixture',allowed_sender_id:'ou_reader',codex_thread_id:'thread-fixture'};
  const inboxRoot=path.join(root,'inbox'), inbox=new DurableInbox(inboxRoot,binding.bot,{});
  const job=inbox.enqueue({message_id:'om_report',chat_id:binding.chat_id,sender_id:binding.allowed_sender_id,message_type:'text',content:'请给报告'});
  Object.assign(job,{status:'reply_pending',reply:text,replyKey:digest('final')});inbox.save(job);
  const clock={now:1000},server={calls:[],docs:0,documents:[],privacy:null,members:[],writes:new Map(),blocks:[],conversion,
    before:null,after:null,notifications:[]};
  const request=async(b,args)=>{
    assert.equal(b.profile,binding.profile);assert.equal(args[0],'api');
    const [_,method,url]=args, dataIndex=args.indexOf('--data'),paramsIndex=args.indexOf('--params');
    const data=dataIndex>=0?JSON.parse(args[dataIndex+1]):undefined,params=paramsIndex>=0?JSON.parse(args[paramsIndex+1]):{};
    const call={method,url,data,params};server.calls.push(call);await server.before?.(call);
    let result;
    if(url.endsWith('/blocks/convert')) result=structuredClone(server.conversion);
    else if(url==='/open-apis/docx/v1/documents') {
      server.docs++;server.documents.push(data);result={document:{document_id:`docFixture${server.docs}`,revision_id:1}};
    } else if(url==='/open-apis/bot/v3/info') result={bot:{open_id:'ou_bot'}};
    else if(url.endsWith('/public')&&method==='PATCH'){server.privacy={...data};result={permission_public:server.privacy};}
    else if(url.endsWith('/public')) result={permission_public:structuredClone(server.privacy)};
    else if(url.endsWith('/members')&&method==='POST') {server.members.push(data);result={member:{...data}};}
    else if(url.endsWith('/members')) result={items:structuredClone(server.members)};
    else if(url.endsWith('/descendant')) {
      assert.match(params.client_token,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      if(server.writes.has(params.client_token)) {
        const prior=server.writes.get(params.client_token);assert.deepEqual(prior.call,call);result=prior.result;
      } else {
        assert.equal(params.document_revision_id,server.writes.size+1);
        result={block_id_relations:data.descendants.map(b=>({temporary_block_id:b.block_id,block_id:`actual_${b.block_id}`})),document_revision_id:server.writes.size+2};
        server.blocks.push(...data.descendants);server.writes.set(params.client_token,{call:structuredClone(call),result});
      }
    } else if(url==='/open-apis/drive/v1/metas/batch_query') result={metas:[{doc_token:data.request_docs[0].doc_token,url:`https://fixture.feishu.cn/docx/${data.request_docs[0].doc_token}`}]};
    else throw Error('unexpected API');
    await server.after?.(call,result);return result;
  };
  const options={root:path.join(root,'private-outbox'),inboxRoot,binding,request,resolveAppId:async()=> 'cli_fixture',now:()=>clock.now,
    notify:async(text,key,record)=>server.notifications.push({text,key,record})};
  const enqueue={jobId:job.id,replyKey:job.replyKey,text:text.trim()};
  const done=()=>{job.status='done';delete job.reply;inbox.save(job);};
  return {root,binding,inbox,job,clock,server,options,enqueue,done};
}

test('native table/code conversion keeps nested content, strips read-only fields and links images without fetching',()=>{
  const c={first_level_block_ids:['table','code','image'],blocks:[
    {block_id:'table',block_type:31,parent_id:'unused',revision_id:0,children:['cell'],
      table:{cells:['cell'],property:{row_size:1,column_size:1,merge_info:[{row_span:1,col_span:1}]}}},
    {block_id:'cell',block_type:32,table_cell:{},children:['text']},paragraph('text','甲|乙'),
    {block_id:'code',block_type:14,code:{style:{language:30},elements:[{text_run:{content:'const x = "😀";'}}]}},
    {block_id:'image',block_type:27,image:{token:''}}],block_id_to_image_urls:[{block_id:'image',image_url:'https://example.org/img.png'}]};
  const original=structuredClone(c),result=cloudDocBatches(c);assert.deepEqual(c,original);
  assert.deepEqual(result.batches[0].children_id,['table','code','image']);
  const [table,cell,text,code,image]=result.batches[0].descendants;
  assert.deepEqual(table.table,{property:{row_size:1,column_size:1}});
  assert.equal(table.parent_id,undefined);assert.equal(table.revision_id,undefined);
  assert.equal(text.text.elements[0].text_run.content,'甲|乙');assert.equal(code.code.style.language,30);
  assert.equal(image.block_type,2);assert.match(image.text.elements[0].text_run.content,/https:\/\/example.org\/img.png/);
  assert.equal(result.imageCount,1);
});

test('subtree batching preserves order and rejects cycles, missing/orphan nodes and unsupported embeds',()=>{
  const r=cloudDocBatches(converted(1001));assert.deepEqual(r.batches.map(x=>x.descendants.length),[1000,1]);
  assert.equal(r.batches[1].children_id[0],'block1000');
  for(const c of [
    {first_level_block_ids:['x'],blocks:[{...paragraph('x'),children:['x']}]},
    {first_level_block_ids:['missing'],blocks:[paragraph('x')]},
    {first_level_block_ids:['x'],blocks:[paragraph('x'),paragraph('orphan')]},
    {first_level_block_ids:['x'],blocks:[{block_id:'x',block_type:43,board:{}}]}
  ]) assert.throws(()=>cloudDocBatches(c),/cloud_doc_/);
});

test('one final creates one doc, restricts access before contents, shares only reader and notifies after final delivery',async t=>{
  const f=fixture(t),o=new CloudDocOutbox(f.options);
  assert.equal(o.enqueue(f.enqueue).status,'queued');assert.equal(o.enqueue(f.enqueue).status,'queued');
  await Promise.all([o.flush(),o.flush()]);assert.equal(f.server.docs,1);assert.equal(o.result(f.job.replyKey).status,'ready');
  assert.equal(f.server.notifications.length,0);f.done();await o.flush();assert.equal(f.server.notifications.length,1);
  assert.equal(f.server.members.length,1);assert.deepEqual(f.server.members[0],{member_type:'openid',member_id:'ou_reader',perm:'view',type:'user'});
  assert.equal(f.server.privacy.link_share_entity,'closed');assert.equal(f.server.privacy.external_access_entity,'closed');
  const writeIndex=f.server.calls.findIndex(c=>c.url.endsWith('/descendant'));
  assert(f.server.calls.slice(0,writeIndex).some(c=>c.url.endsWith('/public')&&c.method==='PATCH'));
  const calls=f.server.calls.length,restarted=new CloudDocOutbox(f.options);
  restarted.enqueue(f.enqueue);await restarted.flush();assert.equal(f.server.calls.length,calls);assert.equal(f.server.notifications.length,1);
  assert.equal(f.server.notifications[0].record.jobId,f.job.id);assert.equal(f.server.notifications[0].record.replyKey,f.job.replyKey);
});

test('ambiguous native create is checkpointed and never creates a second document on restart',async t=>{
  const f=fixture(t);f.server.after=async c=>{if(c.url==='/open-apis/docx/v1/documents')throw Object.assign(Error('socket lost'),{code:'ECONNRESET'});};
  let o=new CloudDocOutbox(f.options);o.enqueue(f.enqueue);await o.flush();assert.equal(f.server.docs,1);
  assert.equal(o.result(f.job.replyKey).error,'cloud_doc_create_uncertain');
  f.clock.now+=3600000;f.done();o=new CloudDocOutbox(f.options);o.enqueue(f.enqueue);await o.flush();
  assert.equal(f.server.docs,1);assert.equal(f.server.blocks.length,0);assert.equal(f.server.members.length,0);
  assert.equal(o.retry(f.job.replyKey),false);
  assert.equal(f.server.notifications.length,1);assert.doesNotMatch(f.server.notifications[0].text,/docFixture/);
});

test('lost write acknowledgement reuses persisted UUID and revision; committed earlier batches are not repeated',async t=>{
  const f=fixture(t,{conversion:converted(1001)});let lost=false;
  f.server.after=async c=>{if(c.url.endsWith('/descendant')&&c.data.children_id[0]==='block1000'&&!lost){lost=true;throw Object.assign(Error('lost'),{code:'ETIMEDOUT'});}};
  let o=new CloudDocOutbox(f.options);o.enqueue(f.enqueue);await o.flush();assert.equal(o.result(f.job.replyKey).status,'queued');
  assert.equal(f.server.writes.size,2);assert.equal(f.server.blocks.length,1001);f.clock.now+=100000;
  o=new CloudDocOutbox(f.options);await o.flush();assert.equal(o.result(f.job.replyKey).status,'ready');
  const writes=f.server.calls.filter(c=>c.url.endsWith('/descendant'));
  assert.equal(writes.length,3);assert.deepEqual(writes[1],writes[2]);assert.equal(f.server.blocks.length,1001);assert.equal(f.server.docs,1);
});

test('permission failure falls back without body leakage or interrupting the authoritative job',async t=>{
  const f=fixture(t);f.server.before=async c=>{if(c.url.endsWith('/blocks/convert'))throw apiError(99991672,'private credential string');};
  const o=new CloudDocOutbox(f.options);o.enqueue(f.enqueue);await o.flush();
  assert.equal(f.server.docs,0);assert.equal(o.result(f.job.replyKey).status,'blocked');assert.equal(f.job.status,'reply_pending');
  f.done();await o.flush();assert.equal(f.server.notifications.length,1);
  const persisted=fs.readFileSync(path.join(o.dir,fs.readdirSync(o.dir)[0]),'utf8');assert.doesNotMatch(persisted,/private credential string/);
  assert.equal(o.stats().cloud_doc_failed_count,1);
});

test('sharing acknowledged late is reconciled from exact bound member; no broad grants or duplicate share',async t=>{
  const f=fixture(t);let lost=false;
  f.server.after=async c=>{if(c.url.endsWith('/members')&&c.method==='POST'&&!lost){lost=true;throw Object.assign(Error('lost'),{code:'ETIMEDOUT'});}};
  let o=new CloudDocOutbox(f.options);o.enqueue(f.enqueue);await o.flush();assert.equal(o.result(f.job.replyKey).status,'queued');
  f.clock.now+=100000;o=new CloudDocOutbox(f.options);await o.flush();assert.equal(o.result(f.job.replyKey).status,'ready');
  assert.equal(f.server.calls.filter(c=>c.url.endsWith('/members')&&c.method==='POST').length,1);
});

test('wrong collaborator, privacy drift and malformed grant cannot expose a report link',async t=>{
  for(const issue of ['collaborator','privacy','grant']) {
    const f=fixture(t);if(issue==='collaborator')f.server.members=[{member_type:'openchat',member_id:'oc_elsewhere',perm:'view'}];
    f.server.after=async(c,r)=>{
      if(issue==='privacy'&&c.url.endsWith('/public')&&c.method==='GET')r.permission_public.link_share_entity='tenant_readable';
      if(issue==='grant'&&c.url.endsWith('/members')&&c.method==='POST')r.member.member_id='ou_wrong';
    };
    const o=new CloudDocOutbox(f.options);o.enqueue(f.enqueue);await o.flush();assert.equal(o.result(f.job.replyKey).status,'blocked');
    assert.equal(o.result(f.job.replyKey).url,undefined);
    if(issue!=='grant')assert.equal(f.server.blocks.length,0);
  }
});

test('rebinding, tampered finals, short messages, disabled config and corrupt journal fail without API mutation',async t=>{
  const f=fixture(t),o=new CloudDocOutbox(f.options);assert.throws(()=>o.enqueue({...f.enqueue,text:'changed'}),/final_not_authorized/);
  f.job.event.sender_id='ou_elsewhere';f.inbox.save(f.job);assert.throws(()=>o.enqueue(f.enqueue),/binding_mismatch/);
  f.job.event.sender_id=f.binding.allowed_sender_id;f.inbox.save(f.job);o.enqueue(f.enqueue);
  const rebound=new CloudDocOutbox({...f.options,binding:{...f.binding,codex_thread_id:'new-thread'}});await rebound.flush();
  assert.equal(f.server.calls.length,0);assert.equal(rebound.result(f.job.replyKey).status,'missing');
  const disabled=new CloudDocOutbox({...f.options,binding:{...f.binding,cloud_docs:{enabled:false}}});assert.equal(disabled.enqueue(f.enqueue).status,'disabled');await disabled.flush();
  const short=fixture(t,{text:'短回答'});assert.equal(new CloudDocOutbox(short.options).enqueue(short.enqueue).status,'skipped');
  fs.writeFileSync(path.join(o.dir,`doc-${o.key(f.job.replyKey)}.json`),'invalid json');
  const corrupted=new CloudDocOutbox(f.options);assert.throws(()=>corrupted.enqueue(f.enqueue),/state_corrupt/);await corrupted.flush();
  assert.equal(f.server.calls.length,0);
});

test('API rejection before create can retry safely; missing write evidence blocks final cloud success',async t=>{
  const f=fixture(t);let rate=true;
  f.server.before=async c=>{if(c.url==='/open-apis/docx/v1/documents'&&rate){rate=false;throw apiError(99991400);}};
  const o=new CloudDocOutbox(f.options);o.enqueue(f.enqueue);await o.flush();assert.equal(f.server.docs,0);assert.equal(o.result(f.job.replyKey).status,'queued');
  f.server.after=async(c,r)=>{if(c.url.endsWith('/descendant'))r.block_id_relations=[];};f.clock.now+=100000;await o.flush();
  assert.equal(f.server.docs,1);assert.equal(o.result(f.job.replyKey).error,'cloud_doc_write_unverified');assert.equal(f.server.members.length,0);
});

test('explicit permission repair resumes the same document and validates the returned cloud domain',async t=>{
  const f=fixture(t);let deny=true;
  f.server.before=async c=>{if(deny&&c.url.endsWith('/members')&&c.method==='POST')throw apiError(1063004);};
  const o=new CloudDocOutbox(f.options);o.enqueue(f.enqueue);await o.flush();assert.equal(o.result(f.job.replyKey).status,'blocked');
  assert.equal(f.server.docs,1);deny=false;assert.equal(o.retry(f.job.replyKey),true);
  f.server.after=async(c,r)=>{if(c.url.endsWith('/metas/batch_query'))r.metas[0].url='https://feishu.cn.evil.example/docx/docFixture1';};
  await o.flush();assert.equal(f.server.docs,1);assert.equal(f.server.writes.size,1);
  assert.equal(o.result(f.job.replyKey).error,'cloud_doc_url_unverified');assert.equal(o.result(f.job.replyKey).url,undefined);
  assert.equal(o.retry(f.job.replyKey),true);f.server.after=null;await o.flush();assert.equal(o.result(f.job.replyKey).status,'ready');
  assert.equal(f.server.docs,1);assert.equal(f.server.members.length,1);
});

test('live Drive appid owner is allowed only when it matches the selected CLI app',async t=>{
  for(const own of [true,false]) {
    const f=fixture(t);f.server.members=[{member_type:'appid',member_id:own?'cli_fixture':'cli_other',perm:'full_access'}];
    const o=new CloudDocOutbox(f.options);o.enqueue(f.enqueue);await o.flush();
    assert.equal(o.result(f.job.replyKey).status,own?'ready':'blocked');
    if(!own)assert.equal(f.server.blocks.length,0);
  }
});

test('automatic report applies native presentation while preserving the authorized answer and stable retry payload',async t=>{
  const text='结论：内容保持完整。\n\n| 项目 | 值 |\n\n| --- | --- |\n\n| 中文 | 42 |';
  const c={first_level_block_ids:['conclusion','heading','code'],blocks:[
    paragraph('conclusion','结论：内容保持完整。'),
    {block_id:'heading',block_type:4,heading2:{elements:[{text_run:{content:'原始代码'}}]}},
    {block_id:'code',block_type:14,code:{style:{language:30},elements:[{text_run:{content:'console.log("中文");\n'}}]}}
  ]};
  const f=fixture(t,{text,conversion:c});let lost=false;
  f.server.after=async call=>{if(call.url.endsWith('/descendant')&&!lost){lost=true;throw Object.assign(Error('lost'),{code:'ECONNRESET'});}};
  let o=new CloudDocOutbox(f.options);o.enqueue({...f.enqueue,force:true});await o.flush();
  assert.equal(f.server.calls.find(c=>c.url.endsWith('/blocks/convert')).data.content,
    '结论：内容保持完整。\n\n| 项目 | 值 |\n| --- | --- |\n| 中文 | 42 |');
  assert.equal(f.job.reply,text);assert.deepEqual(f.server.conversion,c);
  const row=JSON.parse(fs.readFileSync(path.join(o.dir,`doc-${o.key(f.job.replyKey)}.json`),'utf8'));
  assert.equal(row.presentationVersion,CLOUD_DOC_PRESENTATION_VERSION);assert.equal(row.answerHash,digest(text));
  assert(f.server.blocks.some(b=>b.block_type===19));
  const code=f.server.blocks.find(b=>b.block_type===14);
  assert.equal(code.code.style.wrap,true);assert.deepEqual(code.code.elements,c.blocks[2].code.elements);
  f.clock.now+=100000;o=new CloudDocOutbox(f.options);await o.flush();
  assert.equal(o.result(f.job.replyKey).status,'ready');assert.equal(f.server.docs,1);
  assert.equal(f.server.calls.filter(c=>c.url.endsWith('/blocks/convert')).length,1);
  const writes=f.server.calls.filter(c=>c.url.endsWith('/descendant'));assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
});
