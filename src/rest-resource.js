import { canonicalStringify, sha256Hex } from './engine.js';
import { definePactAdapter } from './adapter.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value, code, max = 256) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  const normalized = value.trim();
  if (normalized.length > max) fail(code);
  return normalized;
}

function assertJson(value, code) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail(code);
    return JSON.parse(encoded);
  } catch (error) {
    if (error?.message === code) throw error;
    fail(code);
  }
}

function same(a, b) {
  return canonicalStringify(a) === canonicalStringify(b);
}

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('PACT_REST_INVALID_BASE_URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) fail('PACT_REST_REQUIRES_HTTPS');
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

function resolveResourceUrl(base, resourcePath) {
  resourcePath = nonEmpty(resourcePath, 'PACT_REST_RESOURCE_PATH_REQUIRED', 2048);
  let resolved;
  try { resolved = new URL(resourcePath, `${base.toString().replace(/\/$/, '')}/`); } catch { fail('PACT_REST_INVALID_RESOURCE_PATH'); }
  if (resolved.origin !== base.origin) fail('PACT_REST_CROSS_ORIGIN_RESOURCE');
  return resolved.toString();
}

function normalizeHeaders(value) {
  if (value == null) return {};
  if (!isPlainObject(value)) fail('PACT_REST_INVALID_HEADERS');
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = String(key).trim().toLowerCase();
    if (!name || /[\r\n]/.test(name)) fail('PACT_REST_INVALID_HEADERS');
    if (['if-match', 'idempotency-key', 'content-type', 'accept'].includes(name)) fail('PACT_REST_RESERVED_HEADER');
    const val = String(raw);
    if (/[\r\n]/.test(val)) fail('PACT_REST_INVALID_HEADERS');
    out[name] = val;
  }
  return out;
}

function responseHeader(response, name) {
  if (!response?.headers || typeof response.headers.get !== 'function') return null;
  const value = response.headers.get(name);
  return value == null ? null : String(value).trim();
}

async function responseJson(response, code) {
  const text = await response.text();
  if (!text) fail(code);
  let value;
  try { value = JSON.parse(text); } catch { fail(code); }
  if (!isPlainObject(value)) fail(code);
  return value;
}

function validateRecord(value) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.version) || value.version < 0 ||
      typeof value.etag !== 'string' || !value.etag || !isPlainObject(value.resource) || !Array.isArray(value.replays)) {
    fail('PACT_REST_CORRUPT_RECORD');
  }
  assertJson(value.resource, 'PACT_REST_CORRUPT_RECORD');
  for (const replay of value.replays) {
    if (!isPlainObject(replay) || typeof replay.key !== 'string' || typeof replay.payloadHash !== 'string' || !isPlainObject(replay.snapshot)) {
      fail('PACT_REST_CORRUPT_RECORD');
    }
    if (!Number.isSafeInteger(replay.snapshot.version) || replay.snapshot.version < 0 || !isPlainObject(replay.snapshot.resource)) {
      fail('PACT_REST_CORRUPT_RECORD');
    }
  }
  return clone(value);
}

function canonicalFromRecord(record) {
  return { version: record.version, resource: clone(record.resource) };
}

function validateCanonical(value, expectedVersion = null) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.version) || value.version < 0 || !isPlainObject(value.resource)) {
    fail('PACT_REST_INVALID_CANONICAL_STATE');
  }
  if (expectedVersion != null && value.version !== expectedVersion) fail('PACT_REST_INVALID_NEXT_VERSION');
  assertJson(value.resource, 'PACT_REST_INVALID_CANONICAL_STATE');
  return clone(value);
}

function validatePath(path) {
  if (!Array.isArray(path) || path.length < 1 || path.length > 32) fail('PACT_REST_PATH_REQUIRED');
  return path.map(segment => {
    if (typeof segment !== 'string' || !segment || segment.length > 128 || FORBIDDEN_PATH_SEGMENTS.has(segment) || segment.includes('.')) {
      fail('PACT_REST_UNSAFE_PATH');
    }
    return segment;
  });
}

function getPath(object, segments) {
  return segments.reduce((node, key) => node?.[key], object);
}

function assertStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.create !== 'function' || typeof store.compareAndSwap !== 'function') {
    fail('PACT_REST_ATOMIC_STORE_REQUIRED');
  }
}

export function createPactRestResourceBridge({
  store,
  key,
  baseUrl,
  resourcePath,
  fetchImpl = globalThis.fetch,
  headers = {},
  method = 'PUT',
  maxRetries = 12
} = {}) {
  assertStore(store);
  key = nonEmpty(key, 'PACT_REST_KEY_REQUIRED');
  if (typeof fetchImpl !== 'function') fail('PACT_REST_FETCH_REQUIRED');
  const base = normalizeBaseUrl(baseUrl);
  const url = resolveResourceUrl(base, resourcePath);
  const staticHeaders = normalizeHeaders(headers);
  method = nonEmpty(method, 'PACT_REST_METHOD_REQUIRED', 16).toUpperCase();
  if (!['PUT', 'PATCH'].includes(method)) fail('PACT_REST_UNSUPPORTED_METHOD');
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 1 || maxRetries > 64) fail('PACT_REST_INVALID_RETRY_LIMIT');
  const storeKey = `rest:${key}`;

  async function fetchProvider() {
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json', ...staticHeaders } });
    } catch (cause) {
      throw new Error('PACT_REST_PROVIDER_READ_FAILED', { cause });
    }
    if (!response?.ok) {
      const error = new Error(`PACT_REST_PROVIDER_HTTP_${response?.status ?? 0}`);
      error.status = response?.status ?? 0;
      throw error;
    }
    const etag = responseHeader(response, 'etag');
    if (!etag) fail('PACT_REST_ETAG_REQUIRED');
    const resource = await responseJson(response, 'PACT_REST_INVALID_PROVIDER_RESPONSE');
    return { etag, resource };
  }

  async function synchronize() {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const remote = await fetchProvider();
      const raw = await store.get(storeKey);
      if (!raw) {
        const initial = { version: 0, etag: remote.etag, resource: clone(remote.resource), replays: [] };
        if (await store.create(storeKey, initial)) return clone(initial);
        continue;
      }
      const current = validateRecord(raw);
      if (current.etag === remote.etag) {
        if (!same(current.resource, remote.resource)) fail('PACT_REST_ETAG_REUSED_FOR_DIFFERENT_STATE');
        return current;
      }
      const next = {
        version: current.version + 1,
        etag: remote.etag,
        resource: clone(remote.resource),
        replays: clone(current.replays)
      };
      if (await store.compareAndSwap(storeKey, current.version, next)) return clone(next);
    }
    fail('PACT_REST_CONTENTION');
  }

  async function read() {
    return canonicalFromRecord(await synchronize());
  }

  async function appendReplay(current, { idempotencyKey, payloadHash, snapshot }) {
    const candidate = {
      ...current,
      replays: [...clone(current.replays), { key: idempotencyKey, payloadHash, snapshot: clone(snapshot) }]
    };
    return store.compareAndSwap(storeKey, current.version, candidate);
  }

  async function commit({ expectedVersion, nextState, authorization, idempotencyKey } = {}) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail('PACT_REST_INVALID_EXPECTED_VERSION');
    const next = validateCanonical(nextState, expectedVersion + 1);
    if (!isPlainObject(authorization)) fail('PACT_REST_AUTHORIZATION_REQUIRED');
    const authorizationId = nonEmpty(authorization.authorizationId, 'PACT_REST_AUTHORIZATION_ID_REQUIRED');
    idempotencyKey = nonEmpty(idempotencyKey, 'PACT_REST_IDEMPOTENCY_KEY_REQUIRED');
    if (authorizationId !== idempotencyKey) fail('PACT_REST_AUTHORIZATION_BINDING_MISMATCH');
    const payloadHash = await sha256Hex({ expectedVersion, nextState: next, authorizationId, idempotencyKey });

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const current = await synchronize();
      const replay = current.replays.find(entry => entry.key === idempotencyKey);
      if (replay) {
        if (replay.payloadHash !== payloadHash) fail('PACT_REST_IDEMPOTENCY_CONFLICT');
        return clone(replay.snapshot);
      }

      if (current.version === expectedVersion + 1 && same(current.resource, next.resource)) {
        if (await appendReplay(current, { idempotencyKey, payloadHash, snapshot: next })) return clone(next);
        continue;
      }
      if (current.version !== expectedVersion) fail('PACT_REST_STALE_PROVIDER_STATE');

      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...staticHeaders,
            'if-match': current.etag,
            'idempotency-key': idempotencyKey
          },
          body: JSON.stringify(next.resource)
        });
      } catch (cause) {
        throw new Error('PACT_REST_COMMIT_UNCERTAIN', { cause });
      }

      if (response?.status === 409 || response?.status === 412) fail('PACT_REST_STALE_PROVIDER_STATE');
      if (!response?.ok) {
        const error = new Error(`PACT_REST_PROVIDER_HTTP_${response?.status ?? 0}`);
        error.status = response?.status ?? 0;
        throw error;
      }
      const etag = responseHeader(response, 'etag');
      if (!etag) fail('PACT_REST_ETAG_REQUIRED');
      const resource = await responseJson(response, 'PACT_REST_INVALID_PROVIDER_RESPONSE');
      if (!same(resource, next.resource)) fail('PACT_REST_PROVIDER_POSTCONDITION_FAILED');

      const candidate = {
        version: next.version,
        etag,
        resource: clone(resource),
        replays: [...clone(current.replays), { key: idempotencyKey, payloadHash, snapshot: clone(next) }]
      };
      if (await store.compareAndSwap(storeKey, current.version, candidate)) return clone(next);

      // Another PACT instance may have persisted this exact provider write after
      // our response arrived. Re-sync and resolve through the replay/recovery path.
    }
    fail('PACT_REST_CONTENTION');
  }

  return Object.freeze({ url, read, commit });
}

export function createPactJsonResourceAdapter({ id, version = '1.0.0' } = {}) {
  id = nonEmpty(id, 'PACT_REST_ADAPTER_ID_REQUIRED');
  version = nonEmpty(version, 'PACT_REST_ADAPTER_VERSION_REQUIRED');
  return definePactAdapter({
    id,
    version,
    describe() {
      return {
        name: 'PACT JSON resource adapter',
        intent: { type: 'object', required: ['path', 'value'] },
        state: { type: 'object', required: ['version', 'resource'] }
      };
    },
    async plan({ intent, state }) {
      if (!isPlainObject(intent) || !isPlainObject(state) || !isPlainObject(state.resource)) fail('PACT_REST_INVALID_RESOURCE_INTENT');
      const path = validatePath(intent.path);
      if (!Object.prototype.hasOwnProperty.call(intent, 'value')) fail('PACT_REST_VALUE_REQUIRED');
      assertJson(intent.value, 'PACT_REST_VALUE_MUST_BE_JSON');
      return {
        effects: [{ path: `resource.${path.join('.')}`, before: clone(getPath(state.resource, path)), after: clone(intent.value) }],
        invariants: [],
        metadata: { adapter: id, semantics: 'json-path-replace' }
      };
    },
    async verify({ intent, state }) {
      if (!isPlainObject(intent) || !isPlainObject(state) || !isPlainObject(state.resource) || !Object.prototype.hasOwnProperty.call(intent, 'value')) return false;
      let path;
      try { path = validatePath(intent.path); } catch { return false; }
      return same(getPath(state.resource, path), intent.value);
    }
  });
}
