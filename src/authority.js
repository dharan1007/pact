import { sha256Hex } from './engine.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const nonEmpty = (value, code) => {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  return value.trim();
};
const safeVersion = value => {
  if (!Number.isSafeInteger(value) || value < 0) fail('PACT_AUTHORITY_INVALID_BASE_VERSION');
  return value;
};
const validateClaims = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PACT_AUTHORITY_APPROVAL_REJECTED');
  return {
    humanPrincipal: nonEmpty(value.humanPrincipal, 'PACT_AUTHORITY_INVALID_PRINCIPAL'),
    agentSession: nonEmpty(value.agentSession, 'PACT_AUTHORITY_INVALID_AGENT_SESSION')
  };
};

export class MemoryAuthorityStore {
  #records = new Map();

  async get(key) {
    return clone(this.#records.get(key) ?? null);
  }

  async create(key, value) {
    if (this.#records.has(key)) return false;
    this.#records.set(key, clone(value));
    return true;
  }

  async compareAndSwap(key, expectedVersion, value) {
    const current = this.#records.get(key);
    if (!current || current.version !== expectedVersion) return false;
    this.#records.set(key, clone(value));
    return true;
  }
}

function assertStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.create !== 'function' || typeof store.compareAndSwap !== 'function') {
    fail('PACT_AUTHORITY_ATOMIC_STORE_REQUIRED');
  }
}

export function createPactAuthority({ store, verifyApproval, now = () => Date.now(), ttlMs = 120_000 } = {}) {
  assertStore(store);
  if (typeof verifyApproval !== 'function') fail('PACT_AUTHORITY_APPROVAL_VERIFIER_REQUIRED');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 15 * 60_000) fail('PACT_AUTHORITY_INVALID_TTL');
  if (typeof globalThis.crypto?.randomUUID !== 'function') fail('PACT_AUTHORITY_SECURE_RANDOM_REQUIRED');

  const keyFor = async token => `cap:${await sha256Hex(nonEmpty(token, 'PACT_AUTHORITY_TOKEN_REQUIRED'))}`;

  async function issue({ approval, txId, planHash, baseVersion, adapter = null } = {}) {
    txId = nonEmpty(txId, 'PACT_AUTHORITY_TX_ID_REQUIRED');
    planHash = nonEmpty(planHash, 'PACT_AUTHORITY_PLAN_HASH_REQUIRED');
    baseVersion = safeVersion(baseVersion);
    const issuedAt = now();
    if (!Number.isFinite(issuedAt)) fail('PACT_AUTHORITY_INVALID_CLOCK');

    const verified = await verifyApproval({ approval: clone(approval), txId, planHash, baseVersion, adapter: clone(adapter) });
    if (!verified) fail('PACT_AUTHORITY_APPROVAL_REJECTED');
    const claims = validateClaims(verified);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = `pact_cap_${globalThis.crypto.randomUUID()}`;
      const key = await keyFor(token);
      const record = {
        version: 0,
        txId,
        planHash,
        baseVersion,
        adapter: clone(adapter),
        claims,
        issuedAt,
        expiresAt: issuedAt + ttlMs,
        consumed: false,
        idempotencyKey: null,
        authorization: null
      };
      if (await store.create(key, record)) return { token, expiresAt: record.expiresAt, claims: clone(claims) };
    }
    fail('PACT_AUTHORITY_TOKEN_COLLISION');
  }

  async function load(token) {
    const record = await store.get(await keyFor(token));
    if (!record) fail('PACT_AUTHORITY_CAPABILITY_NOT_FOUND');
    return record;
  }

  function assertBinding(record, { txId, planHash, baseVersion }) {
    if (record.txId !== nonEmpty(txId, 'PACT_AUTHORITY_TX_ID_REQUIRED') ||
        record.planHash !== nonEmpty(planHash, 'PACT_AUTHORITY_PLAN_HASH_REQUIRED') ||
        record.baseVersion !== safeVersion(baseVersion)) {
      fail('PACT_AUTHORITY_BINDING_MISMATCH');
    }
  }

  async function inspect(token) {
    const record = await load(token);
    const { version, idempotencyKey, authorization, ...publicRecord } = record;
    return clone(publicRecord);
  }

  async function authorizeCommit({ token, txId, planHash, baseVersion, idempotencyKey } = {}) {
    const key = await keyFor(token);
    idempotencyKey = nonEmpty(idempotencyKey, 'PACT_AUTHORITY_IDEMPOTENCY_KEY_REQUIRED');
    if (idempotencyKey.length > 256) fail('PACT_AUTHORITY_INVALID_IDEMPOTENCY_KEY');

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const record = await store.get(key);
      if (!record) fail('PACT_AUTHORITY_CAPABILITY_NOT_FOUND');
      assertBinding(record, { txId, planHash, baseVersion });
      if (now() > record.expiresAt) fail('PACT_AUTHORITY_CAPABILITY_EXPIRED');

      if (record.consumed) {
        if (record.idempotencyKey === idempotencyKey) return clone(record.authorization);
        fail('PACT_AUTHORITY_CAPABILITY_ALREADY_CONSUMED');
      }

      const authorization = {
        authorizationId: `pact_auth_${globalThis.crypto.randomUUID()}`,
        txId: record.txId,
        planHash: record.planHash,
        baseVersion: record.baseVersion,
        claims: clone(record.claims),
        authorizedAt: now(),
        idempotencyKey,
        idempotentReplay: false
      };
      const next = {
        ...record,
        version: record.version + 1,
        consumed: true,
        consumedAt: authorization.authorizedAt,
        idempotencyKey,
        authorization
      };
      if (await store.compareAndSwap(key, record.version, next)) return clone(authorization);
    }
    fail('PACT_AUTHORITY_CONTENTION');
  }

  return { issue, inspect, authorizeCommit };
}
