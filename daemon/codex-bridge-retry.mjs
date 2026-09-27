// Persist next-attempt times in the owning queue, never spin on permanent errors.
export function classifyFailure(error) {
  const code = String(error?.apiCode ?? error?.code ?? '');
  if (error?.permanent || ['permission', 'validation', 'authentication'].includes(error?.type)
      || ['99991672', '99991668', '230001', '230006', '230011', '234002', '14005',
        '10002', '200740', '200750', '200770', '200860', '200220',
        '300301', '300302', '300303', '300305', '300307', '300311', '300317'].includes(code)) {
    return { kind: 'permanent', code: code || 'invalid_request' };
  }
  return { kind: 'transient', code: code || 'transport_error' };
}

export function retryDelay(attempt, retryAfterMs = 0, random = Math.random) {
  return Math.max(Math.min(3600000, Math.max(0, retryAfterMs)),
    Math.round(Math.min(300000, 1000 * 2 ** Math.min(18, Math.max(0, attempt - 1))) * (0.8 + random() * 0.4)));
}

export function recordFailure(state, error, now = Date.now(), random = Math.random) {
  const failure = classifyFailure(error);
  state.attempts = (state.attempts ?? 0) + 1;
  state.error = failure.code;
  state.blocked = failure.kind === 'permanent';
  state.retryAt = state.blocked ? null : now + retryDelay(state.attempts, error?.retryAfterMs, random);
}

export function cliFailure(response, fallback) {
  const detail = response?.error ?? {};
  const error = new Error('lark_request_failed'); // Never log response bodies/tokens.
  error.apiCode = detail.code ?? detail.api_code ?? response?.code ?? fallback?.code;
  error.type = detail.type;
  error.retryAfterMs = Number(detail.retry_after ?? response?.retry_after ?? 0) * 1000;
  return error;
}
