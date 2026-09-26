import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatProgressReply,
  progressFingerprint,
  progressGate,
  rolloutAssistantMessage,
  rolloutTaskCompletion,
} from './codex-bridge-progress.mjs';

function assistantItem(phase, text) {
  return {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase,
      content: [{ type: 'output_text', text }],
    },
  };
}

test('extracts explicit commentary and final answer messages', () => {
  assert.deepEqual(
    rolloutAssistantMessage(assistantItem('commentary', '正在校验。')),
    { phase: 'commentary', text: '正在校验。' },
  );
  assert.deepEqual(
    rolloutAssistantMessage(assistantItem('final_answer', '完成。')),
    { phase: 'final_answer', text: '完成。' },
  );
});

test('never exposes reasoning or user messages', () => {
  assert.equal(rolloutAssistantMessage({ type: 'response_item', payload: { type: 'reasoning' } }), null);
  assert.equal(rolloutAssistantMessage({
    type: 'response_item',
    payload: { type: 'message', role: 'user', phase: 'commentary', content: [] },
  }), null);
});

test('uses task completion fallback and classifies upstream Bad Request for one retry', () => {
  assert.deepEqual(rolloutTaskCompletion({
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: ' final from event ' },
  }), { kind: 'final', text: 'final from event' });
  assert.deepEqual(rolloutTaskCompletion({
    type: 'event_msg',
    payload: { type: 'task_complete', error: { message: '{"detail":"Bad Request"}' } },
  }), { kind: 'retryable_error', error: 'rollout_task_bad_request' });
  assert.deepEqual(rolloutTaskCompletion({
    type: 'event_msg',
    payload: { type: 'task_complete' },
  }), { kind: 'empty_complete', error: 'rollout_turn_completed_without_final_answer' });
});

test('progress gate limits rate and total message count', () => {
  assert.deepEqual(progressGate({ sentCount: 0, lastSentAt: 0 }, 1000, 10000, 8), { ok: true, reason: null });
  assert.deepEqual(progressGate({ sentCount: 1, lastSentAt: 1000 }, 5000, 10000, 8), { ok: false, reason: 'min_interval' });
  assert.deepEqual(progressGate({ sentCount: 8, lastSentAt: 0 }, 5000, 10000, 8), { ok: false, reason: 'max_messages' });
});

test('fingerprint is stable and scoped to bot and inbound message', () => {
  const value = progressFingerprint('bot1', 'om_1', '进度');
  assert.equal(value, progressFingerprint('bot1', 'om_1', '进度'));
  assert.notEqual(value, progressFingerprint('coding', 'om_1', '进度'));
  assert.notEqual(value, progressFingerprint('bot1', 'om_2', '进度'));
});

test('formats commentary directly and safely truncates progress text', () => {
  assert.equal(formatProgressReply('  正在抓取全文。  '), '正在抓取全文。');
  const reply = formatProgressReply('😀'.repeat(5), 3);
  assert.match(reply, /^😀😀😀\n…/u);
});
