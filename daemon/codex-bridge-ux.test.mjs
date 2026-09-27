import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReplyUx, publicPhase } from './codex-bridge-ux.mjs';

test('explicit clarification suffix becomes a bounded waiting form', () => {
  const form={version:1,title:'请一次补充',fields:[{name:'audience',label:'给谁看',type:'text',required:true},
    {name:'format',label:'格式',type:'select',options:[{label:'表格',value:'table'}]}]};
  const result=parseReplyUx(`还缺两个条件。\n\n\`\`\`feishu-form\n${JSON.stringify(form)}\n\`\`\``);
  assert.equal(result.status,'waiting');assert.equal(result.text,'还缺两个条件。');assert.equal(result.form.fields.length,2);
});
test('ordinary questions, examples, malformed and duplicate fields do not hide user output', () => {
  const samples=['有什么问题吗？','```feishu-form\n{}\n```','```feishu-form\ninvalid\n```',
    '```feishu-form\n{"version":1,"title":"x","fields":[]}\n```',
    '```feishu-form\n{"version":1,"title":"x","fields":[{"name":"a","label":"a","type":"text"},{"name":"a","label":"b","type":"text"}]}\n```',
    '```feishu-form\n{}\n```\n这是一个例子。'];
  for(const s of samples){assert.deepEqual(parseReplyUx(s),{text:s,status:'complete'});}
});
test('public phase does not infer research or completion from ordinary prose', () => {
  assert.equal(publicPhase('我建议检索一下'),'working');assert.equal(publicPhase('[检索] 查询官方资料'),'searching');
  assert.equal(publicPhase('[整理] 正在对比'),'organizing');assert.equal(publicPhase('[等待] 服务恢复'),'waiting');
});
