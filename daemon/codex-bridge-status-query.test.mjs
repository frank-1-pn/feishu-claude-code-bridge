import test from 'node:test';
import assert from 'node:assert/strict';
import { chatReplyRoute } from './codex-bridge-reply-routing.mjs';
import { bindingSnapshot } from './codex-bridge-ux.mjs';
import { buildStatusReply, lookupMessageAppLink, parseStatusQuery, safeMessageAppLink } from './codex-bridge-status-query.mjs';

const binding = { bot: 'coding', profile: 'coding-test', codex_thread_id: 'thread-fixture',
  chat_id: 'oc_fixture', allowed_sender_id: 'ou_fixture' };
const route = chatReplyRoute(binding);
const at = Date.parse('2026-11-23T13:02:03Z');
const job = (id, content, fields = {}, event = {}) => ({
  id, status: 'queued', acceptedAt: at, ...fields,
  event: { type: 'im.message.receive_v1', message_type: 'text', sender_type: 'user',
    message_id: id, content, chat_id: binding.chat_id, sender_id: binding.allowed_sender_id,
    bridge_binding: bindingSnapshot(binding), ...event },
});
const first = job('om_first', '检查接口。', { status: 'delivered', markerSeen: true, streamKey: 'first', lastActivityAt: at });
const older = { key: 'first', messageId: 'om_card_old', route, final: true, supersededBy: 'current', revision: 2, sentRevision: 2 };
const latest = { key: 'current', messageId: 'om_card_new', route, presentation: { status: 'searching' }, revision: 4, sentRevision: 4 };
const file = (jobId, extra = {}) => ({ jobId, name: 'report.html', deliveryVersion: 2, bindingScope: route.scope,
  origin: { bot: binding.bot, chatId: binding.chat_id, senderId: binding.allowed_sender_id, profile: binding.profile },
  status: 'queued', ...extra,
});
const respond = (content, args, event) => buildStatusReply({ binding, queryJob: job('om_query', content, {}, event), ...args });

test('only exact native human text aliases bypass the model', () => {
  for (const [content, expected] of [
    ['/status', 'status'], ['当前任务？', 'status'], [{ text: '现在进度' }, 'status'],
    ['{"text":"查看进度"}', 'status'], ['附件发了吗？', 'files'], [' /LAST ', 'last'], ['最近产物', 'last'],
    ['务必查看进度并取消', null], ['/status; delete', null], ['查看 进度', null], ['查看进度？\n确认后发送', null],
  ]) assert.equal(parseStatusQuery(job('om_query', content).event), expected, String(content));
  assert.equal(parseStatusQuery(job('om_image', '/status', {}, { message_type: 'image' }).event), null);
  assert.equal(parseStatusQuery(job('om_callback', '/status', {}, { synthetic_callback: true }).event), null);
  assert.equal(parseStatusQuery(job('om_bot', '/status', {}, { sender_type: 'app' }).event), null);
  assert.equal(respond('/files', { jobs: [first] }, { sender_id: 'ou_other' }), null);
});

test('a shared task uses its latest card and distinguishes arrival, current phase and file receipt', () => {
  const second = job('om_second', '再检查附件。', { status: 'delivered', markerSeen: true, streamKey: 'current', sequence: 2 });
  const result = respond('/status', {
    jobs: [first, second], cards: [older, latest],
    files: [file('om_second', { status: 'done', sendIntent: { sent: true, messageId: 'om_file' } })],
  }, { parent_id: 'om_card_old' });
  assert.equal(result.messageId, 'om_card_new');
  assert.match(result.text, /Codex 入站：已确认/);
  assert.match(result.text, /21:02:03（北京时间）/);
  assert.match(result.text, /最近公开进度：正在检索/);
  assert.match(result.text, /附件：已送达 1/);
});

test('unbound jobs and unrelated files stay hidden; ambiguous requests require an explicit reference', () => {
  const second = job('om_second', '独立任务。', { status: 'submitted', streamKey: 'current', sequence: 2 });
  const other = job('om_other', '其他会话。', { status: 'delivered', markerSeen: true }, { chat_id: 'oc_other' });
  const args = { jobs: [first, second, other], cards: [latest],
    files: [file('om_second', { name: 'allowed.html' }), file('om_first', { name: 'wrong-task.html' }),
      file('om_second', { name: 'wrong-origin.html', bindingScope: 'other' })],
  };
  assert.match(respond('/status', args).text, /2 项任务/);
  assert.match(respond('/status', args, { parent_id: 'om_other' }).text, /没有明确对应/);
  const result = respond('/files', args, { parent_id: 'om_second' });
  assert.match(result.text, /allowed.html/);
  assert.doesNotMatch(result.text, /wrong/);
  assert.match(respond('/status', args, { parent_id: 'om_second' }).text, /Codex 入站：尚未确认/);
});

test('last result uses completion proof, and file attempts without a receipt are not called delivered', () => {
  const finished = job('om_done', '已结束。', { status: 'done', markerSeen: true, completedAt: at + 1500, replyKey: 'completion' });
  const card = { ...latest, final: true, finalDelivered: true, finalReplyKey: 'completion',
    text: '完成了接口检查。\n<oai-mem-citation><citation_entries>hidden-provenance' };
  const args = { jobs: [first, finished], cards: [card],
    files: [file(finished.id, { status: 'done' }), file(finished.id, { status: 'blocked', sendIntent: { uncertain: true } })],
  };
  const result = respond('/last', args);
  assert.match(result.text, /答复已送达/);
  assert.match(result.text, /答复摘要：完成了接口检查/);
  assert.doesNotMatch(result.text, /hidden-provenance/);
  assert.match(result.text, /送达待核对 2/);
  assert.match(respond('/last', { ...args, cards: [] }).text, /答复送达待核对/);
  assert.match(respond('/last', { ...args, cards: [], hasReplyReceipt: key => key === 'completion' }).text, /答复已送达/);
});

test('message lookup only returns a unique readback AppLink for the exact message and bound chat', async () => {
  const link = 'https://applink.feishu.cn/client/chat/open?openChatId=oc_fixture&position=14';
  const response = message => async (used, args) => {
    assert.equal(used, binding);
    assert.equal(args[args.indexOf('--message-ids') + 1], 'om_target');
    return { messages: [message] };
  };
  const exact = { message_id: 'om_target', chat_id: binding.chat_id, message_app_link: link };
  assert.equal(await lookupMessageAppLink(binding, 'om_target', response(exact)), link);
  assert.equal(await lookupMessageAppLink(binding, 'om_target', response({ ...exact, message_position: 15 })), undefined);
  assert.equal(await lookupMessageAppLink(binding, 'om_target', response({ ...exact, message_id: 'om_other' })), undefined);
  assert.equal(await lookupMessageAppLink(binding, 'om_target', response({ ...exact, chat_id: 'oc_other' })), undefined);
  const threadLink = 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_fixture&open_thread_id=omt_fixture&openchatid=oc_fixture&openthreadid=omt_fixture&thread_position=23';
  assert.equal(await lookupMessageAppLink(binding, 'om_target', response({
    ...exact, thread_id: 'omt_fixture', thread_message_position: '23', message_app_link: threadLink,
  })), threadLink);
  for (const value of [link.replace('https:', 'http:'), link.replace('oc_fixture', 'oc_other'),
    link.replace('feishu.cn', 'feishu.cn.example.test'), link + '&url=https%3A%2F%2Fexample.test',
    link.replace('&position=14', ''), link + '&position=15']) assert.equal(safeMessageAppLink(value, binding.chat_id), undefined);
});
