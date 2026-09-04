const ACTIONS = new Set(['preview', 'approve', 'commit', 'verify', 'receipt', 'inspect']);

function writeJson(res, statusCode, body) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(statusCode).json(body);
  }
  res.statusCode = statusCode;
  if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json; charset=utf-8');
  if (typeof res.end === 'function') return res.end(JSON.stringify(body));
  res.body = body;
  return res;
}

function setHeader(res, name, value) {
  if (typeof res.setHeader === 'function') res.setHeader(name, value);
}

function normalizeContentType(value) {
  return String(value ?? '').split(';', 1)[0].trim().toLowerCase();
}

function protocolStatus(code) {
  if (code === 'PACT_API_TRANSACTION_NOT_FOUND') return 404;
  if (code.includes('STALE_') || code.includes('CONFLICT') || code.includes('ALREADY_CONSUMED') || code.includes('CONTENTION')) return 409;
  if (code.includes('EXPIRED')) return 410;
  if (code.includes('NOT_APPROVED') || code.includes('NOT_PREVIEWED') || code.includes('NOT_COMMITTED') || code.includes('RECEIPT_NOT_AVAILABLE')) return 409;
  if (code.includes('APPROVAL_REJECTED') || code.includes('CAPABILITY_') || code.includes('BINDING_MISMATCH')) return 403;
  return 400;
}

function bodyObject(req) {
  if (!req || typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) return null;
  return req.body;
}

function requestHeader(req, name) {
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(headers, lower)) return headers[lower];
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return value;
  }
  return undefined;
}

function parseEnvelope(body) {
  if (typeof body.operation === 'string') {
    const payload = body.payload == null ? {} : body.payload;
    if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('PACT_HTTP_INVALID_PAYLOAD');
    return { action: body.operation, payload: { ...payload } };
  }

  if (typeof body.action === 'string') {
    const { action, ...payload } = body;
    return { action, payload };
  }

  throw new Error('PACT_HTTP_UNKNOWN_ACTION');
}

function bindIdempotency(req, action, payload) {
  if (action !== 'commit') return payload;
  const raw = requestHeader(req, 'idempotency-key');
  if (raw == null || String(raw).trim() === '') return payload;
  const headerKey = String(raw).trim();
  if (headerKey.length > 256) throw new Error('PACT_HTTP_INVALID_IDEMPOTENCY_KEY');
  if (payload.idempotencyKey != null && String(payload.idempotencyKey).trim() !== headerKey) {
    throw new Error('PACT_HTTP_IDEMPOTENCY_CONFLICT');
  }
  return { ...payload, idempotencyKey: headerKey };
}

export function createPactHttpHandler({ service, releaseSha = '' } = {}) {
  if (!service || typeof service !== 'object') throw new Error('PACT_HTTP_SERVICE_REQUIRED');

  return async function pactHttpHandler(req, res) {
    setHeader(res, 'cache-control', 'no-store');
    setHeader(res, 'x-content-type-options', 'nosniff');
    setHeader(res, 'referrer-policy', 'no-referrer');
    if (releaseSha) setHeader(res, 'x-pact-release', releaseSha);

    if (req?.method !== 'POST') {
      setHeader(res, 'allow', 'POST');
      return writeJson(res, 405, { error: { code: 'PACT_HTTP_METHOD_NOT_ALLOWED' } });
    }

    if (normalizeContentType(requestHeader(req, 'content-type')) !== 'application/json') {
      return writeJson(res, 415, { error: { code: 'PACT_HTTP_JSON_REQUIRED' } });
    }

    const body = bodyObject(req);
    if (!body) return writeJson(res, 400, { error: { code: 'PACT_HTTP_INVALID_BODY' } });

    let action;
    let payload;
    try {
      ({ action, payload } = parseEnvelope(body));
      if (!ACTIONS.has(action) || typeof service[action] !== 'function') throw new Error('PACT_HTTP_UNKNOWN_ACTION');
      payload = bindIdempotency(req, action, payload);
    } catch (error) {
      const code = typeof error?.message === 'string' && /^PACT_HTTP_/.test(error.message)
        ? error.message
        : 'PACT_HTTP_INVALID_REQUEST';
      const statusCode = code === 'PACT_HTTP_IDEMPOTENCY_CONFLICT' ? 409 : 400;
      return writeJson(res, statusCode, { error: { code } });
    }

    try {
      const result = await service[action](payload);
      return writeJson(res, 200, result);
    } catch (error) {
      const code = typeof error?.message === 'string' ? error.message : '';
      if (/^PACT_(?:API|AUTHORITY|DURABLE)_/.test(code)) {
        return writeJson(res, protocolStatus(code), { error: { code } });
      }
      return writeJson(res, 500, { error: { code: 'PACT_HTTP_INTERNAL_ERROR' } });
    }
  };
}
