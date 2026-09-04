const CONSEQUENTIAL_OPERATIONS = new Set(['commit', 'rollback']);

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

export function createPactHttpConnector({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 10_000, headers = {} }) {
  if (typeof fetchImpl !== 'function') throw new Error('PACT_HTTP_FETCH_REQUIRED');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('PACT_HTTP_INVALID_TIMEOUT');
  const endpoint = `${assertBaseUrl(baseUrl)}/api/pact`;

  async function request(operation, payload = {}, options = {}) {
    if (!/^[a-z][a-z0-9_]*$/.test(operation)) throw new Error('PACT_HTTP_INVALID_OPERATION');
    const idempotencyKey = normalizeIdempotencyKey(operation, options.idempotencyKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('PACT_HTTP_TIMEOUT')), timeoutMs);
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
      if (controller.signal.aborted) throw new Error('PACT_HTTP_TIMEOUT', { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    endpoint,
    request,
    inspect: payload => request('inspect', payload),
    preview: payload => request('preview', payload),
    approve: payload => request('approve', payload),
    commit: (payload, idempotencyKey) => request('commit', payload, { idempotencyKey }),
    verify: payload => request('verify', payload),
    receipt: payload => request('receipt', payload),
    rollback: (payload, idempotencyKey) => request('rollback', payload, { idempotencyKey }),
    cancel: payload => request('cancel', payload)
  };
}
