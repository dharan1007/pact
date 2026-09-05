import { canonicalStringify, sha256Hex } from './engine.js';
import { validateAdapterPlan } from './adapter.js';
import { createPactAuthority } from './authority.js';
import { createPactDurableStateStore } from './durable-state.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

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

function pathSegments(path) {
  const segments = String(path).split('.');
  if (segments.some(segment => !segment || FORBIDDEN_PATH_SEGMENTS.has(segment))) fail('PACT_API_UNSAFE_PATH');
  return segments;
}

function getPath(object, path) {
  return pathSegments(path).reduce((node, key) => node?.[key], object);
}

function setPath(object, path, value) {
  const segments = pathSegments(path);
  let cursor = object;
  for (const key of segments.slice(0, -1)) {
    if (!isPlainObject(cursor[key])) fail(`PACT_API_PATH_NOT_OBJECT:${path}`);
    cursor = cursor[key];
  }
  cursor[segments.at(-1)] = clone(value);
}

function same(a, b) {
  return canonicalStringify(a) === canonicalStringify(b);
}

function sanitizeTransaction(transaction) {
  if (!transaction) return null;
  const copy = clone(transaction);
  delete copy._capabilityToken;
  delete copy._approvalHash;
  return copy;
}

function assertCanonical(value) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.version) || value.version < 0) fail('PACT_API_INVALID_CANONICAL_STATE');
  assertJson(value, 'PACT_API_INVALID_CANONICAL_STATE');
  return clone(value);
}

function applyPlan(canonical, plan) {
  const next = clone(canonical);
  for (const effect of plan.effects) {
    if (!same(getPath(canonical, effect.path), effect.before)) fail(`PACT_API_PRECONDITION_FAILED:${effect.path}`);
    setPath(next, effect.path, effect.after);
  }
  for (const invariant of plan.invariants) {
    if (!same(getPath(next, invariant.path), invariant.equals)) fail(`PACT_API_INVARIANT_FAILED:${invariant.path}`);
  }
  next.version = canonical.version + 1;
  return next;
}

function assertCommittedShape(canonical, transaction) {
  if (canonical.version !== transaction.baseVersion + 1) fail('PACT_API_STALE_CANONICAL_STATE');
  for (const effect of transaction.effects) {
    if (!same(getPath(canonical, effect.path), effect.after)) fail(`PACT_API_RECOVERY_POSTCONDITION_FAILED:${effect.path}`);
  }
  for (const invariant of transaction.invariants) {
    if (!same(getPath(canonical, invariant.path), invariant.equals)) fail(`PACT_API_RECOVERY_INVARIANT_FAILED:${invariant.path}`);
  }
  return clone(canonical);
}

function adapterKey(adapter) {
  if (!isPlainObject(adapter)) fail('PACT_API_ADAPTER_REQUIRED');
  return `${nonEmpty(adapter.id, 'PACT_API_ADAPTER_ID_REQUIRED')}@${nonEmpty(adapter.version, 'PACT_API_ADAPTER_VERSION_REQUIRED')}`;
}

function normalizeAdapters(adapters) {
  if (!Array.isArray(adapters) || adapters.length < 1) fail('PACT_API_ADAPTERS_REQUIRED');
  const registry = new Map();
  for (const adapter of adapters) {
    if (!adapter || typeof adapter.plan !== 'function' || typeof adapter.verify !== 'function') fail('PACT_API_INVALID_ADAPTER');
    const key = adapterKey(adapter);
    if (registry.has(key)) fail('PACT_API_DUPLICATE_ADAPTER');
    registry.set(key, adapter);
  }
  return registry;
}

function txFromRecord(record) {
  const transaction = record?.state?.transaction;
  if (!isPlainObject(transaction)) fail('PACT_API_CORRUPT_TRANSACTION');
  return transaction;
}

async function payloadHash(value) {
  return sha256Hex(value);
}

export function createPactApiAuthorityService({
  store,
  verifyApproval,
  adapters,
  readCanonical,
  commitCanonical,
  now = () => Date.now(),
  capabilityTtlMs = 120_000
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.create !== 'function' || typeof store.compareAndSwap !== 'function') fail('PACT_API_ATOMIC_STORE_REQUIRED');
  if (typeof verifyApproval !== 'function') fail('PACT_API_APPROVAL_VERIFIER_REQUIRED');
  if (typeof readCanonical !== 'function') fail('PACT_API_CANONICAL_READER_REQUIRED');
  if (typeof commitCanonical !== 'function') fail('PACT_API_CANONICAL_COMMITTER_REQUIRED');
  if (typeof globalThis.crypto?.randomUUID !== 'function') fail('PACT_API_SECURE_RANDOM_REQUIRED');

  const registry = normalizeAdapters(adapters);
  const durable = createPactDurableStateStore({ store, now, prefix: 'pact:tx:' });
  const authority = createPactAuthority({ store, verifyApproval, now, ttlMs: capabilityTtlMs });

  function resolveAdapter(descriptor) {
    const key = adapterKey(descriptor);
    const adapter = registry.get(key);
    if (!adapter) fail('PACT_API_ADAPTER_NOT_REGISTERED');
    return adapter;
  }

  async function preview({ adapter: descriptor, intent } = {}) {
    assertJson(intent, 'PACT_API_INTENT_MUST_BE_JSON');
    const adapter = resolveAdapter(descriptor);
    const canonical = assertCanonical(await readCanonical({ adapter: { id: adapter.id, version: adapter.version }, intent: clone(intent) }));
    const id = `tx_${globalThis.crypto.randomUUID()}`;
    const plan = validateAdapterPlan(await adapter.plan({
      intent: clone(intent),
      state: clone(canonical),
      transaction: { id, state: 'DRAFT' }
    }));
    for (const effect of plan.effects) {
      if (!same(getPath(canonical, effect.path), effect.before)) fail(`PACT_API_ADAPTER_PRECONDITION_MISMATCH:${effect.path}`);
    }
    for (const invariant of plan.invariants) {
      if (!same(getPath(canonical, invariant.path), invariant.equals)) fail(`PACT_API_INVARIANT_NOT_TRUE_AT_PREVIEW:${invariant.path}`);
    }
    const transaction = {
      id,
      state: 'PREVIEWED',
      adapter: { id: adapter.id, version: adapter.version },
      intent: clone(intent),
      baseVersion: canonical.version,
      effects: clone(plan.effects),
      invariants: clone(plan.invariants),
      metadata: clone(plan.metadata),
      createdAt: now()
    };
    transaction.planHash = await sha256Hex({
      txId: id,
      adapter: transaction.adapter,
      intent: transaction.intent,
      baseVersion: transaction.baseVersion,
      effects: transaction.effects,
      invariants: transaction.invariants
    });
    await durable.create(id, { transaction });
    return { transaction: sanitizeTransaction(transaction) };
  }

  async function approve({ transactionId, approval } = {}) {
    transactionId = nonEmpty(transactionId, 'PACT_API_TRANSACTION_ID_REQUIRED');
    const current = await durable.load(transactionId);
    if (!current) fail('PACT_API_TRANSACTION_NOT_FOUND');
    const transaction = txFromRecord(current);
    const approvalHash = await sha256Hex(approval);

    if (transaction.state === 'APPROVED') {
      if (transaction._approvalHash !== approvalHash || typeof transaction._capabilityToken !== 'string') fail('PACT_API_APPROVAL_REPLAY_CONFLICT');
      return {
        transaction: sanitizeTransaction(transaction),
        capability: {
          token: transaction._capabilityToken,
          expiresAt: transaction.capabilityExpiresAt,
          claims: clone(transaction.approvalClaims)
        },
        idempotentReplay: true
      };
    }
    if (transaction.state !== 'PREVIEWED') fail('PACT_API_NOT_PREVIEWED');

    const capability = await authority.issue({
      approval: clone(approval),
      txId: transaction.id,
      planHash: transaction.planHash,
      baseVersion: transaction.baseVersion,
      adapter: transaction.adapter
    });
    const transition = await durable.transition({
      txId: transaction.id,
      expectedState: 'PREVIEWED',
      nextState: 'APPROVED',
      idempotencyKey: `approve:${approvalHash}`,
      payloadHash: approvalHash,
      data: { planHash: transaction.planHash, humanPrincipal: capability.claims.humanPrincipal, agentSession: capability.claims.agentSession },
      mutate(state) {
        state.transaction = {
          ...state.transaction,
          approvedAt: now(),
          approvalClaims: clone(capability.claims),
          capabilityExpiresAt: capability.expiresAt,
          _approvalHash: approvalHash,
          _capabilityToken: capability.token
        };
      }
    });
    const approved = txFromRecord(transition);
    return { transaction: sanitizeTransaction(approved), capability: clone(capability), idempotentReplay: transition.idempotentReplay };
  }

  async function commit({ transactionId, capabilityToken, idempotencyKey } = {}) {
    transactionId = nonEmpty(transactionId, 'PACT_API_TRANSACTION_ID_REQUIRED');
    capabilityToken = nonEmpty(capabilityToken, 'PACT_API_CAPABILITY_REQUIRED');
    idempotencyKey = nonEmpty(idempotencyKey, 'PACT_API_IDEMPOTENCY_KEY_REQUIRED');
    if (idempotencyKey.length > 256) fail('PACT_API_INVALID_IDEMPOTENCY_KEY');

    let record = await durable.load(transactionId);
    if (!record) fail('PACT_API_TRANSACTION_NOT_FOUND');
    let transaction = txFromRecord(record);
    if (transaction.state === 'COMMITTED' || transaction.state === 'VERIFIED') {
      if (transaction.commitIdempotencyKey !== idempotencyKey) fail('PACT_API_IDEMPOTENCY_CONFLICT');
      return { transaction: sanitizeTransaction(transaction), idempotentReplay: true };
    }
    if (!['APPROVED', 'COMMIT_AUTHORIZED'].includes(transaction.state)) fail('PACT_API_NOT_APPROVED');
    if (transaction._capabilityToken !== capabilityToken) fail('PACT_API_CAPABILITY_MISMATCH');

    let canonical = assertCanonical(await readCanonical({ adapter: transaction.adapter, intent: clone(transaction.intent), transaction: sanitizeTransaction(transaction) }));
    let nextState;
    if (transaction.state === 'APPROVED') {
      if (canonical.version !== transaction.baseVersion) fail('PACT_API_STALE_CANONICAL_STATE');
      nextState = applyPlan(canonical, { effects: transaction.effects, invariants: transaction.invariants });
    } else if (canonical.version === transaction.baseVersion) {
      nextState = applyPlan(canonical, { effects: transaction.effects, invariants: transaction.invariants });
    } else {
      nextState = assertCommittedShape(canonical, transaction);
    }

    let authorization;
    if (transaction.state === 'APPROVED') {
      authorization = await authority.authorizeCommit({
        token: capabilityToken,
        txId: transaction.id,
        planHash: transaction.planHash,
        baseVersion: transaction.baseVersion,
        idempotencyKey
      });
      const authHash = await payloadHash({ idempotencyKey, authorizationId: authorization.authorizationId, planHash: transaction.planHash });
      const authorized = await durable.transition({
        txId: transaction.id,
        expectedState: 'APPROVED',
        nextState: 'COMMIT_AUTHORIZED',
        idempotencyKey: `authorize:${idempotencyKey}`,
        payloadHash: authHash,
        data: { authorizationId: authorization.authorizationId, idempotencyKey },
        mutate(state) {
          state.transaction = {
            ...state.transaction,
            commitAuthorization: clone(authorization),
            commitIdempotencyKey: idempotencyKey,
            commitAuthorizedAt: authorization.authorizedAt
          };
        }
      });
      transaction = txFromRecord(authorized);
      if (canonical.version !== transaction.baseVersion) nextState = assertCommittedShape(canonical, transaction);
    } else {
      if (transaction.commitIdempotencyKey !== idempotencyKey) fail('PACT_API_IDEMPOTENCY_CONFLICT');
      authorization = clone(transaction.commitAuthorization);
      if (!isPlainObject(authorization)) fail('PACT_API_CORRUPT_AUTHORIZATION');
    }

    const committedCanonical = assertCanonical(await commitCanonical({
      adapter: clone(transaction.adapter),
      intent: clone(transaction.intent),
      plan: { effects: clone(transaction.effects), invariants: clone(transaction.invariants), metadata: clone(transaction.metadata) },
      expectedVersion: transaction.baseVersion,
      nextState: clone(nextState),
      authorization: clone(authorization),
      idempotencyKey: authorization.authorizationId
    }));
    if (committedCanonical.version !== transaction.baseVersion + 1) fail('PACT_API_INVALID_COMMIT_VERSION');
    assertCommittedShape(committedCanonical, transaction);

    const completionHash = await payloadHash({ authorizationId: authorization.authorizationId, committedVersion: committedCanonical.version });
    const completed = await durable.transition({
      txId: transaction.id,
      expectedState: 'COMMIT_AUTHORIZED',
      nextState: 'COMMITTED',
      idempotencyKey: `complete:${idempotencyKey}`,
      payloadHash: completionHash,
      data: { authorizationId: authorization.authorizationId, commitVersion: committedCanonical.version },
      mutate(state) {
        state.transaction = {
          ...state.transaction,
          commitVersion: committedCanonical.version,
          committedAt: now()
        };
      }
    });
    return { transaction: sanitizeTransaction(txFromRecord(completed)), idempotentReplay: completed.idempotentReplay };
  }

  async function verify({ transactionId } = {}) {
    transactionId = nonEmpty(transactionId, 'PACT_API_TRANSACTION_ID_REQUIRED');
    const record = await durable.load(transactionId);
    if (!record) fail('PACT_API_TRANSACTION_NOT_FOUND');
    const transaction = txFromRecord(record);
    if (transaction.state === 'VERIFIED') return { receipt: clone(transaction.receipt), idempotentReplay: true };
    if (transaction.state !== 'COMMITTED') fail('PACT_API_NOT_COMMITTED');
    const adapter = resolveAdapter(transaction.adapter);
    const canonical = assertCanonical(await readCanonical({ adapter: transaction.adapter, intent: clone(transaction.intent), transaction: sanitizeTransaction(transaction) }));
    if (canonical.version !== transaction.commitVersion) fail('PACT_API_VERIFICATION_VERSION_MISMATCH');
    for (const effect of transaction.effects) {
      if (!same(getPath(canonical, effect.path), effect.after)) fail(`PACT_API_POSTCONDITION_FAILED:${effect.path}`);
    }
    for (const invariant of transaction.invariants) {
      if (!same(getPath(canonical, invariant.path), invariant.equals)) fail(`PACT_API_INVARIANT_FAILED:${invariant.path}`);
    }
    const verified = await adapter.verify({
      intent: clone(transaction.intent),
      state: clone(canonical),
      plan: { effects: clone(transaction.effects), invariants: clone(transaction.invariants), metadata: clone(transaction.metadata) },
      approvalClaims: clone(transaction.approvalClaims),
      transaction: {
        id: transaction.id,
        baseVersion: transaction.baseVersion,
        commitVersion: transaction.commitVersion,
        planHash: transaction.planHash
      }
    });
    if (!verified) fail('PACT_API_ADAPTER_VERIFICATION_FAILED');
    const body = {
      txId: transaction.id,
      adapter: clone(transaction.adapter),
      planHash: transaction.planHash,
      approvalClaims: clone(transaction.approvalClaims),
      baseVersion: transaction.baseVersion,
      commitVersion: transaction.commitVersion,
      verifiedVersion: canonical.version,
      effects: clone(transaction.effects),
      invariants: clone(transaction.invariants),
      verifiedAt: now()
    };
    const receipt = { ...body, receiptHash: await sha256Hex(body) };
    const verifiedTransition = await durable.transition({
      txId: transaction.id,
      expectedState: 'COMMITTED',
      nextState: 'VERIFIED',
      idempotencyKey: `verify:${transaction.id}:${transaction.commitVersion}`,
      payloadHash: receipt.receiptHash,
      data: { receiptHash: receipt.receiptHash },
      mutate(state) {
        state.transaction = { ...state.transaction, receipt: clone(receipt), verifiedAt: receipt.verifiedAt };
      }
    });
    return { receipt: clone(txFromRecord(verifiedTransition).receipt), idempotentReplay: verifiedTransition.idempotentReplay };
  }

  async function receipt({ transactionId } = {}) {
    transactionId = nonEmpty(transactionId, 'PACT_API_TRANSACTION_ID_REQUIRED');
    const record = await durable.load(transactionId);
    if (!record) fail('PACT_API_TRANSACTION_NOT_FOUND');
    const transaction = txFromRecord(record);
    if (transaction.state !== 'VERIFIED' || !isPlainObject(transaction.receipt)) fail('PACT_API_RECEIPT_NOT_AVAILABLE');
    return { receipt: clone(transaction.receipt) };
  }

  async function inspect({ transactionId } = {}) {
    transactionId = nonEmpty(transactionId, 'PACT_API_TRANSACTION_ID_REQUIRED');
    const recovered = await durable.recover(transactionId);
    return {
      transaction: sanitizeTransaction(txFromRecord(recovered)),
      journal: clone(recovered.journal),
      version: recovered.version
    };
  }

  return { preview, approve, commit, verify, receipt, inspect };
}