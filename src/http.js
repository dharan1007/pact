const CONSEQUENTIAL_OPERATIONS = new Set(['commit']);
const CANONICAL_OPERATIONS = new Set(['inspect', 'preview', 'approve', 'commit', 'verify', 'receipt']);

function assertBaseUrl(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('PACT_HTTP_REQUIRES_HTTPS');
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function safeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 2048) }; }
}

function normalizeIdempotencyKey(operation, value) {
  if (!CONSEQUENTIAL_OPERATIONS.has(operation)) return value == null ? null : String(value);
  const key = value == null ? '' : String(value).trim();
  if (!key) throw new Error('PACT_HTTP_IDEMPOTENCY_KEY_REQUIRED');
  if (key.length > 256) throw new Error('PACT_HTTP_INVALID_IDEMPOTENCY_KEY');
  return key;
}

function assertAbortSignal(signal) {
  if (signal == null) return null;
  if (typeof signal !== 'object' || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
    throw new Error('PACT_HTTP_INVALID_ABORT_SIGNAL');
  }
  return signal;
}

export function createPactHttpConnector({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 10_000, headers = {} }) {
  if (typeof fetchImpl !== 'function') throw new Error('PACT_HTTP_FETCH_REQUIRED');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('PACT_HTTP_INVALID_TIMEOUT');
  const endpoint = `${assertBaseUrl(baseUrl)}/api/pact`;

  async function request(operation, payload = {}, options = {}) {
    if (!/^[a-z][a-z0-9_]*$/.test(operation)) throw new Error('PACT_HTTP_INVALID_OPERATION');
    if (!CANONICAL_OPERATIONS.has(operation)) throw new Error('PACT_HTTP_UNSUPPORTED_OPERATION');
    const idempotencyKey = normalizeIdempotencyKey(operation, options.idempotencyKey);
    const callerSignal = assertAbortSignal(options.signal);
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;

    const abortFromCaller = () => {
      callerAborted = true;
      controller.abort(callerSignal.reason ?? new Error('PACT_HTTP_ABORTED'));
    };

    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('PACT_HTTP_TIMEOUT'));
    }, timeoutMs);

    const requestHeaders = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...headers,
      ...options.headers
    };
    if (idempotencyKey) requestHeaders['idempotency-key'] = idempotencyKey;

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: requestHeaders,
        body: JSON.stringify({ operation, payload }),
        signal: controller.signal
      });
      const body = safeJson(await response.text());
      if (!response.ok) {
        const error = new Error(body?.error?.code || body?.code || `PACT_HTTP_${response.status}`);
        error.status = response.status;
        error.details = body;
        throw error;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('PACT_HTTP_INVALID_RESPONSE');
      return body;
    } catch (error) {
      if (timedOut) throw new Error('PACT_HTTP_TIMEOUT', { cause: error });
      if (callerAborted) throw new Error('PACT_HTTP_ABORTED', { cause: callerSignal.reason ?? error });
      throw error;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  return {
    endpoint,
    request,
    inspect: (payload, options) => request('inspect', payload, options),
    preview: (payload, options) => request('preview', payload, options),
    approve: (payload, options) => request('approve', payload, options),
    commit: (payload, idempotencyKey, options = {}) => request('commit', payload, { ...options, idempotencyKey }),
    verify: (payload, options) => request('verify', payload, options),
    receipt: (payload, options) => request('receipt', payload, options)
  };
}
