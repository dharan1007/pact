import { createPactServerRuntimeFromEnv } from '../src/server-runtime.js';

let runtime;
let initializationError;
let initialized = false;

function setHeader(res, name, value) {
  if (typeof res?.setHeader === 'function') res.setHeader(name, value);
}

function unavailable(res) {
  setHeader(res, 'cache-control', 'no-store');
  setHeader(res, 'content-type', 'application/json; charset=utf-8');
  setHeader(res, 'x-content-type-options', 'nosniff');
  setHeader(res, 'referrer-policy', 'no-referrer');
  const body = { error: { code: 'PACT_RUNTIME_UNAVAILABLE' } };
  if (typeof res?.status === 'function' && typeof res?.json === 'function') return res.status(503).json(body);
  res.statusCode = 503;
  if (typeof res?.end === 'function') return res.end(JSON.stringify(body));
  res.body = body;
  return res;
}

function getRuntime() {
  if (!initialized) {
    initialized = true;
    try {
      runtime = createPactServerRuntimeFromEnv();
    } catch (error) {
      initializationError = error;
      console.error('[pact] runtime initialization failed', error?.message || 'PACT_RUNTIME_INIT_FAILED');
    }
  }
  return runtime;
}

export default async function pactApi(req, res) {
  const current = getRuntime();
  if (!current || initializationError) return unavailable(res);
  return current.handler(req, res);
}
