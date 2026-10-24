const types = new Set(['permission','validation','authentication','api','http','network','transport','internal','rate_limit','quota','limit','business','server','unknown']);
const subtypes = new Set(['app_scope_not_applied','permission_denied','missing_scope','access_denied','forbidden','unauthorized',
  'invalid_argument','invalid_parameter','invalid_request','unauthenticated','token_expired','invalid_token',
  'payload_too_large','request_too_large','content_too_large','size_limit_exceeded','rate_limit_exceeded','too_many_requests','quota_exceeded']);
const numericCode = value => (typeof value==='number' || typeof value==='string' && /^\d{1,10}$/.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value)>=0 ? Number(value) : undefined;
const permissionCodes = new Set([99991672,99991668]);
const permanentSubtypes = new Set([...subtypes].filter(value=>!['rate_limit_exceeded','too_many_requests'].includes(value)));

// Only protocol enums and numbers may escape CLI output. Descriptions, URLs,
// response bodies and arbitrary "type" strings can contain private credentials.
export function larkErrorMetadata(response, fallback) {
  const detail=response?.error && typeof response.error==='object' ? response.error : response;
  const code=numericCode(detail?.code ?? detail?.api_code ?? response?.code ?? fallback?.code);
  const type=types.has(detail?.type) ? detail.type : permissionCodes.has(code) ? 'permission' : undefined;
  const subtype=subtypes.has(detail?.subtype) ? detail.subtype : undefined;
  const retry=detail?.retry_after ?? response?.retry_after;
  const retryAfter=(typeof retry==='number' || typeof retry==='string' && /^\d+(?:\.\d+)?$/.test(retry)) ? Number(retry) : NaN;
  return {...(code!==undefined?{code}:{}),...(type?{type}:{}),...(subtype?{subtype}:{}),
    ...(Number.isFinite(retryAfter) && retryAfter>=0 && retryAfter<=Number.MAX_SAFE_INTEGER/1000?{retry_after:retryAfter}:{})};
}

// Persist next-attempt times in the owning queue, never spin on permanent errors.
export function classifyFailure(error) {
  const code = String(error?.apiCode ?? error?.code ?? '');
  if (error?.permanent || ['permission', 'validation', 'authentication'].includes(error?.type)
      || permanentSubtypes.has(error?.subtype)
      || ['99991672', '99991668', '230001', '230006', '230011', '234002', '14005', '1061043',
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
  const detail=larkErrorMetadata(response,fallback);
  const error = new Error('lark_request_failed'); // Never log response bodies/tokens.
  error.apiCode = detail.code;
  error.type = detail.type;
  if(detail.subtype)error.subtype=detail.subtype;
  error.retryAfterMs = (detail.retry_after ?? 0) * 1000;
  return error;
}
