import { sha256Hex } from './engine.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function nonEmpty(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  return value.trim();
}

function assertJson(value, code) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail(code);
    JSON.parse(encoded);
  } catch {
    fail(code);
  }
}

function validateCanonical(value) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.version) || value.version < 0) fail('PACT_CANONICAL_INVALID_STATE');
  assertJson(value, 'PACT_CANONICAL_INVALID_STATE');
  return clone(value);
}

function validateRecord(record) {
  if (!isPlainObject(record) || !Number.isSafeInteger(record.version) || record.version < 0 || !isPlainObject(record.canonical) || !Array.isArray(record.replays)) {
    fail('PACT_CANONICAL_CORRUPT_RECORD');
  }
  const canonical = validateCanonical(record.canonical);
  if (canonical.version !== record.version) fail('PACT_CANONICAL_CORRUPT_RECORD');
  for (const replay of record.replays) {
    if (!isPlainObject(replay) || typeof replay.key !== 'string' || typeof replay.payloadHash !== 'string' || !isPlainObject(replay.snapshot)) {
      fail('PACT_CANONICAL_CORRUPT_RECORD');
    }
    validateCanonical(replay.snapshot);
  }
  return clone(record);
}

export function createCanonicalStateRepository({ store, key, initialState, maxRetries = 12 } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.create !== 'function' || typeof store.compareAndSwap !== 'function') {
    fail('PACT_CANONICAL_ATOMIC_STORE_REQUIRED');
  }
  key = nonEmpty(key, 'PACT_CANONICAL_KEY_REQUIRED');
  if (key.length > 256) fail('PACT_CANONICAL_INVALID_KEY');
  const initial = validateCanonical(initialState);
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 1 || maxRetries > 64) fail('PACT_CANONICAL_INVALID_RETRY_LIMIT');

  async function ensureRecord() {
    const current = await store.get(key);
    if (current) return validateRecord(current);
    const candidate = { version: initial.version, canonical: clone(initial), replays: [] };
    if (await store.create(key, candidate)) return clone(candidate);
    const raced = await store.get(key);
    if (!raced) fail('PACT_CANONICAL_INITIALIZATION_RACE');
    return validateRecord(raced);
  }

  async function read() {
    return clone((await ensureRecord()).canonical);
  }

  async function commit({ expectedVersion, nextState, authorization, idempotencyKey } = {}) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail('PACT_CANONICAL_INVALID_EXPECTED_VERSION');
    const next = validateCanonical(nextState);
    if (next.version !== expectedVersion + 1) fail('PACT_CANONICAL_INVALID_NEXT_VERSION');
    idempotencyKey = nonEmpty(idempotencyKey, 'PACT_CANONICAL_IDEMPOTENCY_KEY_REQUIRED');
    if (idempotencyKey.length > 256) fail('PACT_CANONICAL_INVALID_IDEMPOTENCY_KEY');
    if (!isPlainObject(authorization)) fail('PACT_CANONICAL_AUTHORIZATION_REQUIRED');
    const authorizationId = nonEmpty(authorization.authorizationId, 'PACT_CANONICAL_AUTHORIZATION_ID_REQUIRED');
    if (authorizationId !== idempotencyKey) fail('PACT_CANONICAL_AUTHORIZATION_BINDING_MISMATCH');

    const payloadHash = await sha256Hex({ expectedVersion, nextState: next, authorizationId, idempotencyKey });

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const current = await ensureRecord();
      const replay = current.replays.find(entry => entry.key === idempotencyKey);
      if (replay) {
        if (replay.payloadHash !== payloadHash) fail('PACT_CANONICAL_IDEMPOTENCY_CONFLICT');
        return clone(replay.snapshot);
      }
      if (current.version !== expectedVersion) fail('PACT_CANONICAL_STALE_VERSION');

      const candidate = {
        version: next.version,
        canonical: clone(next),
        replays: [
          ...clone(current.replays),
          { key: idempotencyKey, payloadHash, snapshot: clone(next) }
        ]
      };
      if (await store.compareAndSwap(key, current.version, candidate)) return clone(next);
    }
    fail('PACT_CANONICAL_CONTENTION');
  }

  return { read, commit };
}
