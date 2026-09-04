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
    receipt: (payload, options) => request('receipt', payload, options),
    rollback: (payload, idempotencyKey, options = {}) => request('rollback', payload, { ...options, idempotencyKey }),
    cancel: (payload, options) => request('cancel', payload, options)
  };
}

function assertRestFunction(value, code) {
  if (typeof value !== 'function') throw new Error(code);
  return value;
}

function assertRestPath(baseUrl, value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) throw new Error('PACT_REST_INVALID_RESOURCE_PATH');
  const base = new URL(`${baseUrl}/`);
  const resolved = new URL(value, base);
  if (resolved.origin !== base.origin) throw new Error('PACT_REST_INVALID_RESOURCE_PATH');
  return resolved.toString();
}

function assertRestObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value;
}

function cloneJson(value, code) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error(code);
    return JSON.parse(text);
  } catch {
    throw new Error(code);
  }
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) ?? response?.headers?.get?.(name.toLowerCase()) ?? null;
}

function defaultRevision({ response, body }) {
  const etag = responseHeader(response, 'etag');
  if (typeof etag === 'string' && etag.trim()) return etag;
  const candidate = body?.revision ?? body?.version;
  if ((typeof candidate === 'string' && candidate.trim()) || Number.isFinite(candidate)) return String(candidate);
  throw new Error('PACT_REST_REVISION_REQUIRED');
}

function normalizeRestHeaders(input) {
  if (input == null) return {};
  assertRestObject(input, 'PACT_REST_INVALID_HEADERS');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') throw new Error('PACT_REST_INVALID_HEADERS');
    out[key.toLowerCase()] = value;
  }
  return out;
}

async function parseRestResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new Error('PACT_REST_INVALID_JSON_RESPONSE'); }
}

export function createPactRestIntegration({
  id,
  version,
  baseUrl,
  fetchImpl = globalThis.fetch,
  headers = {},
  resourcePath,
  plan,
  buildApply,
  verify,
  stateFrom = body => body,
  revisionFrom = defaultRevision
}) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('PACT_REST_ID_REQUIRED');
  if (typeof version !== 'string' || !version.trim()) throw new Error('PACT_REST_VERSION_REQUIRED');
  if (typeof fetchImpl !== 'function') throw new Error('PACT_REST_FETCH_REQUIRED');
  const origin = assertBaseUrl(baseUrl);
  const readPath = assertRestFunction(resourcePath, 'PACT_REST_RESOURCE_PATH_REQUIRED');
  const planFn = assertRestFunction(plan, 'PACT_REST_PLAN_REQUIRED');
  const applyBuilder = assertRestFunction(buildApply, 'PACT_REST_BUILD_APPLY_REQUIRED');
  const verifyFn = assertRestFunction(verify, 'PACT_REST_VERIFY_REQUIRED');
  const stateMapper = assertRestFunction(stateFrom, 'PACT_REST_STATE_MAPPER_REQUIRED');
  const revisionMapper = assertRestFunction(revisionFrom, 'PACT_REST_REVISION_MAPPER_REQUIRED');
  const configuredHeaders = normalizeRestHeaders(headers);

  async function request({ method, path, body, requestHeaders = {}, signal }) {
    const url = assertRestPath(origin, path);
    const normalized = normalizeRestHeaders(requestHeaders);
    const finalHeaders = {
      accept: 'application/json',
      ...configuredHeaders,
      ...normalized
    };
    const init = { method, headers: finalHeaders, signal: assertAbortSignal(signal) ?? undefined };
    if (body !== undefined) {
      finalHeaders['content-type'] = 'application/json';
      init.body = JSON.stringify(cloneJson(body, 'PACT_REST_BODY_MUST_BE_JSON'));
    }
    const response = await fetchImpl(url, init);
    const parsed = await parseRestResponse(response);
    if (!response.ok) {
      const error = new Error(parsed?.error?.code || parsed?.code || `PACT_REST_HTTP_${response.status}`);
      error.status = response.status;
      error.details = parsed;
      throw error;
    }
    return { response, body: parsed };
  }

  return Object.freeze({
    id: id.trim(),
    version: version.trim(),
    async read(context = {}) {
      const path = await readPath(context);
      const { response, body } = await request({ method: 'GET', path, signal: context.signal });
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('PACT_REST_INVALID_STATE_RESPONSE');
      const state = await stateMapper(cloneJson(body, 'PACT_REST_INVALID_STATE_RESPONSE'), { response, context });
      assertRestObject(state, 'PACT_REST_INVALID_STATE_RESPONSE');
      const revision = await revisionMapper({ response, body: cloneJson(body, 'PACT_REST_INVALID_STATE_RESPONSE'), state: cloneJson(state, 'PACT_REST_INVALID_STATE_RESPONSE'), context });
      if (typeof revision !== 'string' || !revision.trim()) throw new Error('PACT_REST_REVISION_REQUIRED');
      return { revision, state: cloneJson(state, 'PACT_REST_INVALID_STATE_RESPONSE') };
    },
    async plan(context) {
      return planFn(context);
    },
    async apply(context = {}) {
      const idempotencyKey = typeof context.idempotencyKey === 'string' ? context.idempotencyKey.trim() : '';
      if (!idempotencyKey) throw new Error('PACT_REST_IDEMPOTENCY_KEY_REQUIRED');
      if (idempotencyKey.length > 256) throw new Error('PACT_REST_INVALID_IDEMPOTENCY_KEY');
      if (typeof context.revision !== 'string' || !context.revision.trim()) throw new Error('PACT_REST_REVISION_REQUIRED');
      const spec = assertRestObject(await applyBuilder(context), 'PACT_REST_INVALID_APPLY_SPEC');
      const method = typeof spec.method === 'string' ? spec.method.toUpperCase() : '';
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('PACT_REST_INVALID_APPLY_METHOD');
      const path = spec.path ?? await readPath(context);
      const operationHeaders = normalizeRestHeaders(spec.headers);
      operationHeaders['if-match'] = context.revision;
      operationHeaders['idempotency-key'] = idempotencyKey;
      const { body } = await request({ method, path, body: spec.body, requestHeaders: operationHeaders, signal: context.signal });
      return body;
    },
    async verify(context) {
      const result = await verifyFn(context);
      if (typeof result !== 'boolean') throw new Error('PACT_REST_VERIFY_MUST_RETURN_BOOLEAN');
      return result;
    }
  });
}
