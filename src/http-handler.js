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

    if (normalizeContentType(req?.headers?.['content-type']) !== 'application/json') {
      return writeJson(res, 415, { error: { code: 'PACT_HTTP_JSON_REQUIRED' } });
    }

    const body = bodyObject(req);
    if (!body) return writeJson(res, 400, { error: { code: 'PACT_HTTP_INVALID_BODY' } });

    const { action, ...payload } = body;
    if (typeof action !== 'string' || !ACTIONS.has(action) || typeof service[action] !== 'function') {
      return writeJson(res, 400, { error: { code: 'PACT_HTTP_UNKNOWN_ACTION' } });
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
