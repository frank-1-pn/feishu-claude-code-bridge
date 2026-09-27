import { QUICK_ACTIONS, normalizeForm } from './codex-bridge-actions.mjs';

const text = content => ({ tag: 'plain_text', content });
const callback = (context, action) => [{ type: 'callback', value: { context_id: context.contextId, version: context.version, action } }];

export function buildActionElements(context, { includeForm = true } = {}) {
  if (!/^[a-f0-9]{64}$/.test(context?.contextId ?? '') || !Number.isInteger(context.version)) throw new Error('invalid_action_context');
  const elements = [];
  if (context.mode !== 'waiting') elements.push({ tag: 'column_set', element_id: 'action_buttons', flex_mode: 'flow', columns:
    Object.entries(QUICK_ACTIONS).map(([action, spec]) => ({ tag: 'column', width: 'auto', elements: [{ tag: 'button',
      element_id: `action_${action}`, text: text(spec.label), type: 'default', size: 'small', behaviors: callback(context, action) }] })) });
  if (!includeForm) return elements;
  const form = normalizeForm(context.form);
  const fields = form.fields.flatMap((field, index) => {
    const common = { element_id: `form_field_${index}`, name: field.name, required: field.required, width: 'fill' };
    if (field.type === 'text') return [{ tag: 'input', ...common, label: text(field.label), label_position: 'top',
      placeholder: text(field.required ? '请填写' : '选填'), max_length: field.maxLength,
      ...(field.maxLength > 300 ? { input_type: 'multiline_text', rows: 2 } : {}) }];
    return [{ tag: 'markdown', content: field.label }, { tag: 'select_static', ...common,
      placeholder: text(field.required ? '请选择' : '保持原样'), options: field.options.map(option => ({ text: text(option.label), value: option.value })) }];
  });
  // CardKit 2.0 only permits form at the body root, never inside a fold panel.
  elements.push({ tag: 'form', element_id: 'form_conditions', name: 'form_conditions', direction: 'vertical', vertical_spacing: '8px',
    elements: [{ tag: 'markdown', content: form.title }, ...fields,
      { tag: 'button', element_id: 'form_submit', name: 'form_submit', form_action_type: 'submit',
        text: text('提交这些要求'), type: 'primary', behaviors: callback(context, 'conditions') }] });
  return elements;
}
