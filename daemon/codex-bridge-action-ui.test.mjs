import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActionElements } from './codex-bridge-action-ui.mjs';
import { DEFAULT_FORM } from './codex-bridge-actions.mjs';

const context = { contextId: 'a'.repeat(64), version: 1, mode: 'complete', form: DEFAULT_FORM };
const flatten = elements => elements.flatMap(element => [element, ...flatten(element.elements ?? []), ...flatten(element.columns ?? [])]);

test('three quick actions use callback allowlist with no prompt or private context', () => {
  const all = flatten(buildActionElements(context, { includeForm: false }));
  const buttons = all.filter(element => element.tag === 'button');
  assert.deepEqual(buttons.map(button => button.text.content), ['再简短一点', '补充依据', '转表格']);
  for (const button of buttons) {
    assert.equal(button.behaviors[0].type, 'callback');
    assert.deepEqual(Object.keys(button.behaviors[0].value).sort(), ['action', 'context_id', 'version']);
  }
});

test('one root form batches optional fields with a named submit button and valid unique IDs', () => {
  const elements = buildActionElements(context); const form = elements.find(element => element.tag === 'form');
  assert.ok(form); assert.equal(elements.filter(element => element.tag === 'form').length, 1);
  const all = flatten(elements); const fields = all.filter(element => ['input', 'select_static'].includes(element.tag));
  assert.deepEqual(fields.map(field => field.name), ['purpose', 'length', 'format', 'extra']);
  assert.equal(fields.some(field => field.required), false);
  const submit = form.elements.find(element => element.form_action_type === 'submit');
  assert.equal(submit.name, 'form_submit'); assert.equal(submit.behaviors[0].value.action, 'conditions');
  const ids = all.map(element => element.element_id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length); for (const id of ids) assert.match(id, /^(action|form)_[a-z0-9_]{1,13}$/);
});

test('waiting state shows the required clarification form without irrelevant rewrite buttons', () => {
  const elements = buildActionElements({ ...context, mode: 'waiting', form: { title: '补充条件', fields: [{ name: 'purpose', label: '用途', type: 'text', required: true }] } });
  assert.equal(elements.length, 1); assert.equal(elements[0].tag, 'form');
  const field = elements[0].elements.find(element => element.tag === 'input'); assert.equal(field.required, true);
  assert.equal(flatten(elements).filter(element => element.tag === 'button').length, 1);
});
