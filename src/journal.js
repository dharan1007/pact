import { sha256Hex } from './engine.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const CONSEQUENTIAL = new Set(['commit', 'rollback']);
const ACTIVE_OPERATION_STATES = new Set(['CLAIMED', 'UNCERTAIN']);

function fail(code) { throw new Error(code); }
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function assertStore(store) {
  if (!plainObject(store)) fail('PACT_JOURNAL_STORE_REQUIRED');
  for (const method of ['get', 'create', 'compareAndSwap']) {
    if (typeof store[method] !== 'function') fail(`PACT_JOURNAL_STORE_METHOD_REQUIRED:${method}`);
  }
}
function nonEmptyString(value, code, max = 256) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  const normalized = value.trim();
  if (normalized.length > max) fail(code);
  return normalized;
}
function jsonClone(value, code) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail(code);
    return JSON.parse(encoded);
  } catch (error) {
    if (error?.message === code) throw error;
    fail(code);
  }
}
function assertSnapshot(value) {
  if (!plainObject(value)) fail('PACT_JOURNAL_INVALID_SNAPSHOT');
  return jsonClone(value, 'PACT_JOURNAL_INVALID_SNAPSHOT');
}
function assertRecord(value, transactionId) {
  if (!plainObject(value) || !Number.isSafeInteger(value.version) || value.version < 0) fail('PACT_JOURNAL_CORRUPT_RECORD');
  if (value.transactionId !== transactionId || !plainObject(value.snapshot) || !plainObject(value.operations)) fail('PACT_JOURNAL_CORRUPT_RECORD');
  return clone(value);
}
function recordKey(transactionId) {
  return `transaction:${nonEmptyString(transactionId, 'PACT_JOURNAL_TRANSACTION_ID_REQUIRED')}`;
}
function operationName(value) {
  const operation = nonEmptyString(value, 'PACT_JOURNAL_OPERATION_REQUIRED', 64);
  if (!CONSEQUENTIAL.has(operation)) fail('PACT_JOURNAL_UNSUPPORTED_OPERATION');
  return operation;
}
function hasActiveConsequence(record) {
  return Object.values(record.operations).some(entry => plainObject(entry) && ACTIVE_OPERATION_STATES.has(entry.state));
}

export function createPactJournal({ store, now = () => Date.now(), claimTtlMs = 30_000, maxCasRetries = 16 } = {}) {
  assertStore(store);
  if (typeof now !== 'function') fail('PACT_JOURNAL_CLOCK_REQUIRED');
  if (!Number.isSafeInteger(claimTtlMs) || claimTtlMs < 100 || claimTtlMs > 300_000) fail('PACT_JOURNAL_INVALID_CLAIM_TTL');
  if (!Number.isSafeInteger(maxCasRetries) || maxCasRetries < 1 || maxCasRetries > 64) fail('PACT_JOURNAL_INVALID_CAS_RETRIES');

  async function load(transactionId) {
    const normalizedId = nonEmptyString(transactionId, 'PACT_JOURNAL_TRANSACTION_ID_REQUIRED');
    const value = await store.get(recordKey(normalizedId));
    if (value == null) fail('PACT_JOURNAL_TRANSACTION_NOT_FOUND');
    return assertRecord(value, normalizedId);
  }

  async function createTransaction({ transactionId, snapshot } = {}) {
    const normalizedId = nonEmptyString(transactionId, 'PACT_JOURNAL_TRANSACTION_ID_REQUIRED');
    const timestamp = now();
    const record = {
      version: 0,
      transactionId: normalizedId,
      snapshot: assertSnapshot(snapshot),
      operations: {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    if (!await store.create(recordKey(normalizedId), record)) fail('PACT_JOURNAL_TRANSACTION_EXISTS');
    return clone(record);
  }

  async function getTransaction(transactionId) {
    return clone(await load(transactionId));
  }

  async function claimOperation({ transactionId, operation, idempotencyKey, request = {} } = {}) {
    const normalizedId = nonEmptyString(transactionId, 'PACT_JOURNAL_TRANSACTION_ID_REQUIRED');
    const normalizedOperation = operationName(operation);
    const normalizedIdempotencyKey = nonEmptyString(idempotencyKey, 'PACT_JOURNAL_IDEMPOTENCY_KEY_REQUIRED');
    const requestValue = jsonClone(request, 'PACT_JOURNAL_INVALID_REQUEST');
    const idempotencyKeyHash = await sha256Hex(normalizedIdempotencyKey);
    const requestHash = await sha256Hex(requestValue);

    for (let retry = 0; retry < maxCasRetries; retry += 1) {
      const current = await load(normalizedId);
      const existing = current.operations[normalizedOperation];
      const timestamp = now();

      if (existing) {
        if (!plainObject(existing) || typeof existing.state !== 'string' || typeof existing.claimId !== 'string') fail('PACT_JOURNAL_CORRUPT_RECORD');
        if (existing.idempotencyKeyHash !== idempotencyKeyHash) fail('PACT_JOURNAL_OPERATION_ALREADY_CLAIMED');
        if (existing.requestHash !== requestHash) fail('PACT_JOURNAL_IDEMPOTENCY_CONFLICT');
        if (existing.state === 'COMPLETED') {
          return { status: 'replay', claimId: existing.claimId, attempt: existing.attempt, response: clone(existing.response) };
        }
        if (existing.state === 'UNCERTAIN') {
          return { status: 'uncertain', claimId: existing.claimId, attempt: existing.attempt };
        }
        if (existing.state !== 'CLAIMED') fail('PACT_JOURNAL_CORRUPT_RECORD');
        if (Number.isFinite(existing.expiresAt) && existing.expiresAt > timestamp) {
          return { status: 'in_progress', claimId: existing.claimId, attempt: existing.attempt };
        }
      }

      const attempt = existing ? (Number.isSafeInteger(existing.attempt) ? existing.attempt + 1 : fail('PACT_JOURNAL_CORRUPT_RECORD')) : 1;
      const claimId = `claim_${globalThis.crypto.randomUUID()}`;
      const next = clone(current);
      next.version = current.version + 1;
      next.updatedAt = timestamp;
      next.operations[normalizedOperation] = {
        state: 'CLAIMED',
        claimId,
        attempt,
        idempotencyKeyHash,
        requestHash,
        claimedAt: timestamp,
        expiresAt: timestamp + claimTtlMs
      };
      if (await store.compareAndSwap(recordKey(normalizedId), current.version, next)) {
        return { status: 'claimed', claimId, attempt, expiresAt: timestamp + claimTtlMs };
      }
    }
    fail('PACT_JOURNAL_CONCURRENCY_EXHAUSTED');
  }

  async function completeOperation({ transactionId, operation, claimId, snapshot, response } = {}) {
    const normalizedId = nonEmptyString(transactionId, 'PACT_JOURNAL_TRANSACTION_ID_REQUIRED');
    const normalizedOperation = operationName(operation);
    const normalizedClaimId = nonEmptyString(claimId, 'PACT_JOURNAL_CLAIM_ID_REQUIRED');
    const nextSnapshot = assertSnapshot(snapshot);
    const nextResponse = jsonClone(response, 'PACT_JOURNAL_INVALID_RESPONSE');

    for (let retry = 0; retry < maxCasRetries; retry += 1) {
      const current = await load(normalizedId);
      const existing = current.operations[normalizedOperation];
      if (!plainObject(existing) || existing.claimId !== normalizedClaimId) fail('PACT_JOURNAL_CLAIM_MISMATCH');
      if (existing.state === 'COMPLETED') return clone(current);
      if (!['CLAIMED', 'UNCERTAIN'].includes(existing.state)) fail('PACT_JOURNAL_OPERATION_NOT_COMPLETABLE');
      const timestamp = now();
      const next = clone(current);
      next.version = current.version + 1;
      next.snapshot = nextSnapshot;
      next.updatedAt = timestamp;
      next.operations[normalizedOperation] = {
        ...clone(existing),
        state: 'COMPLETED',
        response: nextResponse,
        completedAt: timestamp
      };
      delete next.operations[normalizedOperation].expiresAt;
      if (await store.compareAndSwap(recordKey(normalizedId), current.version, next)) return clone(next);
    }
    fail('PACT_JOURNAL_CONCURRENCY_EXHAUSTED');
  }

  async function markUncertain({ transactionId, operation, claimId, snapshot } = {}) {
    const normalizedId = nonEmptyString(transactionId, 'PACT_JOURNAL_TRANSACTION_ID_REQUIRED');
    const normalizedOperation = operationName(operation);
    const normalizedClaimId = nonEmptyString(claimId, 'PACT_JOURNAL_CLAIM_ID_REQUIRED');
    const nextSnapshot = assertSnapshot(snapshot);

    for (let retry = 0; retry < maxCasRetries; retry += 1) {
      const current = await load(normalizedId);
      const existing = current.operations[normalizedOperation];
      if (!plainObject(existing) || existing.claimId !== normalizedClaimId) fail('PACT_JOURNAL_CLAIM_MISMATCH');
      if (existing.state === 'UNCERTAIN') return clone(current);
      if (existing.state !== 'CLAIMED') fail('PACT_JOURNAL_OPERATION_NOT_CLAIMED');
      const timestamp = now();
      const next = clone(current);
      next.version = current.version + 1;
      next.snapshot = nextSnapshot;
      next.updatedAt = timestamp;
      next.operations[normalizedOperation] = {
        ...clone(existing),
        state: 'UNCERTAIN',
        uncertainAt: timestamp
      };
      delete next.operations[normalizedOperation].expiresAt;
      if (await store.compareAndSwap(recordKey(normalizedId), current.version, next)) return clone(next);
    }
    fail('PACT_JOURNAL_CONCURRENCY_EXHAUSTED');
  }

  async function updateSnapshot({ transactionId, expectedVersion, snapshot } = {}) {
    const normalizedId = nonEmptyString(transactionId, 'PACT_JOURNAL_TRANSACTION_ID_REQUIRED');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail('PACT_JOURNAL_INVALID_EXPECTED_VERSION');
    const nextSnapshot = assertSnapshot(snapshot);
    const current = await load(normalizedId);
    if (current.version !== expectedVersion) fail('PACT_JOURNAL_VERSION_CONFLICT');
    if (hasActiveConsequence(current)) fail('PACT_JOURNAL_CONSEQUENCE_IN_PROGRESS');
    const next = clone(current);
    next.version = current.version + 1;
    next.snapshot = nextSnapshot;
    next.updatedAt = now();
    if (!await store.compareAndSwap(recordKey(normalizedId), current.version, next)) fail('PACT_JOURNAL_VERSION_CONFLICT');
    return clone(next);
  }

  return Object.freeze({
    createTransaction,
    getTransaction,
    claimOperation,
    completeOperation,
    markUncertain,
    updateSnapshot
  });
}
