import { sha256Hex } from './engine.js';
import { createPactAuthority } from './authority.js';
import { createPactSagaCoordinator } from './saga.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const TERMINAL = new Set(['COMMITTED', 'COMPENSATED', 'PARTIALLY_COMMITTED']);
const ADAPTER = Object.freeze({ id: 'pact.saga', version: '1.0.0' });
const BOOLEAN_REQUIREMENTS = Object.freeze(['conditionalWrite', 'idempotency', 'reconciliation', 'compensation', 'reversible', 'remoteFencing']);

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

function assertStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.create !== 'function' || typeof store.compareAndSwap !== 'function') {
    fail('PACT_SAGA_PROTOCOL_ATOMIC_STORE_REQUIRED');
  }
}

function normalizeRequirements(value) {
  if (value == null) return {};
  if (!isPlainObject(value)) fail('PACT_SAGA_PROTOCOL_INVALID_REQUIREMENTS');
  const allowed = new Set([...BOOLEAN_REQUIREMENTS, 'mutation']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`PACT_SAGA_PROTOCOL_UNKNOWN_REQUIREMENT:${key}`);
  const out = {};
  for (const key of BOOLEAN_REQUIREMENTS) {
    if (value[key] == null) continue;
    if (value[key] !== true) fail(`PACT_SAGA_PROTOCOL_INVALID_REQUIREMENT:${key}`);
    out[key] = true;
  }
  if (value.mutation != null) out.mutation = nonEmpty(value.mutation, 'PACT_SAGA_PROTOCOL_INVALID_REQUIREMENT:mutation', 64).toUpperCase();
  return out;
}

function negotiateHandler({ handlerName, resourceKey, atomicDomain, requirements, handlers }) {
  const handler = handlers[handlerName];
  if (!isPlainObject(handler)) fail(`PACT_SAGA_PROTOCOL_HANDLER_NOT_REGISTERED:${handlerName}`);
  const capabilities = isPlainObject(handler.capabilities) ? handler.capabilities : {};
  if (capabilities.atomicDomain != null && capabilities.atomicDomain !== atomicDomain) fail('PACT_SAGA_PROTOCOL_ATOMIC_DOMAIN_MISMATCH');
  if (capabilities.resourceKey != null && capabilities.resourceKey !== resourceKey) fail('PACT_SAGA_PROTOCOL_RESOURCE_MISMATCH');
  for (const key of BOOLEAN_REQUIREMENTS) {
    if (requirements[key] !== true) continue;
    if (key === 'conditionalWrite') {
      if (typeof capabilities.conditionalWrite !== 'string' || !capabilities.conditionalWrite) fail(`PACT_SAGA_PROTOCOL_CAPABILITY_UNSATISFIED:${key}`);
      continue;
    }
    if (key === 'idempotency') {
      if (typeof capabilities.idempotency !== 'string' || !capabilities.idempotency) fail(`PACT_SAGA_PROTOCOL_CAPABILITY_UNSATISFIED:${key}`);
      continue;
    }
    if (key === 'remoteFencing') {
      if (typeof capabilities.remoteFencing !== 'string' || !capabilities.remoteFencing) fail(`PACT_SAGA_PROTOCOL_CAPABILITY_UNSATISFIED:${key}`);
      continue;
    }
    if (capabilities[key] !== true) fail(`PACT_SAGA_PROTOCOL_CAPABILITY_UNSATISFIED:${key}`);
  }
  if (requirements.mutation != null && String(capabilities.mutation ?? '').toUpperCase() !== requirements.mutation) {
    fail('PACT_SAGA_PROTOCOL_CAPABILITY_UNSATISFIED:mutation');
  }
}

function normalizePreviewSteps(steps, handlers) {
  if (!Array.isArray(steps) || steps.length < 1) fail('PACT_SAGA_PROTOCOL_STEPS_REQUIRED');
  if (steps.length > 64) fail('PACT_SAGA_PROTOCOL_TOO_MANY_STEPS');
  const ids = new Set();
  const resources = new Set();
  return steps.map(raw => {
    if (!isPlainObject(raw)) fail('PACT_SAGA_PROTOCOL_INVALID_STEP');
    const id = nonEmpty(raw.id, 'PACT_SAGA_PROTOCOL_STEP_ID_REQUIRED');
    const handler = nonEmpty(raw.handler, 'PACT_SAGA_PROTOCOL_HANDLER_REQUIRED');
    const resourceKey = nonEmpty(raw.resourceKey, 'PACT_SAGA_PROTOCOL_RESOURCE_REQUIRED', 512);
    const atomicDomain = nonEmpty(raw.atomicDomain, 'PACT_SAGA_PROTOCOL_ATOMIC_DOMAIN_REQUIRED');
    if (ids.has(id)) fail('PACT_SAGA_PROTOCOL_DUPLICATE_STEP_ID');
    if (resources.has(resourceKey)) fail('PACT_SAGA_PROTOCOL_DUPLICATE_RESOURCE');
    ids.add(id);
    resources.add(resourceKey);
    const requirements = normalizeRequirements(raw.requirements);
    negotiateHandler({ handlerName: handler, resourceKey, atomicDomain, requirements, handlers });
    return {
      id,
      handler,
      resourceKey,
      atomicDomain,
      requirements,
      input: assertJson(raw.input, 'PACT_SAGA_PROTOCOL_INPUT_MUST_BE_JSON')
    };
  });
}

function validateProtocolRecord(value) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.version) || value.version < 0 || typeof value.id !== 'string' ||
      typeof value.planHash !== 'string' || typeof value.state !== 'string' || !Array.isArray(value.steps)) {
    fail('PACT_SAGA_PROTOCOL_CORRUPT_RECORD');
  }
  return clone(value);
}

function publicSaga(protocol, coordinatorRecord = null) {
  const coordinatorState = coordinatorRecord?.state;
  const visibleState = protocol.state === 'APPROVED' && coordinatorState === 'PLANNED'
    ? 'APPROVED'
    : (coordinatorState ?? protocol.state);
  const out = {
    id: protocol.id,
    state: visibleState,
    planHash: protocol.planHash,
    steps: coordinatorRecord?.steps ?? clone(protocol.steps),
    createdAt: protocol.createdAt,
    approvedAt: protocol.approvedAt ?? null,
    approvalClaims: clone(protocol.approvalClaims ?? null),
    executionAuthorizedAt: protocol.executionAuthorizedAt ?? null,
    failure: clone(coordinatorRecord?.failure ?? null)
  };
  if (coordinatorRecord?.updatedAt != null) out.updatedAt = coordinatorRecord.updatedAt;
  if (coordinatorRecord?.committedAt != null) out.committedAt = coordinatorRecord.committedAt;
  return out;
}

export function createPactSagaAuthorityService({
  store,
  verifyApproval,
  handlers,
  now = () => Date.now(),
  capabilityTtlMs = 120_000,
  prefix = 'pact:saga-protocol:'
} = {}) {
  assertStore(store);
  if (typeof verifyApproval !== 'function') fail('PACT_SAGA_PROTOCOL_APPROVAL_VERIFIER_REQUIRED');
  if (!isPlainObject(handlers) || Object.keys(handlers).length < 1) fail('PACT_SAGA_PROTOCOL_HANDLERS_REQUIRED');
  if (typeof globalThis.crypto?.randomUUID !== 'function') fail('PACT_SAGA_PROTOCOL_SECURE_RANDOM_REQUIRED');
  prefix = nonEmpty(prefix, 'PACT_SAGA_PROTOCOL_PREFIX_REQUIRED', 512);

  const authority = createPactAuthority({ store, verifyApproval, now, ttlMs: capabilityTtlMs });
  const coordinator = createPactSagaCoordinator({ store, handlers, now, prefix: `${prefix}execution:` });
  const keyFor = sagaId => `${prefix}plan:${sagaId}`;

  async function load(sagaId) {
    sagaId = nonEmpty(sagaId, 'PACT_SAGA_PROTOCOL_ID_REQUIRED');
    const value = await store.get(keyFor(sagaId));
    return value ? validateProtocolRecord(value) : null;
  }

  async function persist(current, mutate) {
    const next = clone(current);
    mutate(next);
    next.version = current.version + 1;
    next.updatedAt = now();
    if (!await store.compareAndSwap(keyFor(current.id), current.version, next)) fail('PACT_SAGA_PROTOCOL_CONCURRENT_MODIFICATION');
    return validateProtocolRecord(next);
  }

  async function sagaPreview({ steps } = {}) {
    const normalizedSteps = normalizePreviewSteps(steps, handlers);
    const id = `saga_${globalThis.crypto.randomUUID()}`;
    const planHash = await sha256Hex({ sagaId: id, adapter: ADAPTER, baseVersion: 0, steps: normalizedSteps });
    const record = {
      version: 0,
      id,
      state: 'PREVIEWED',
      planHash,
      steps: normalizedSteps,
      createdAt: now(),
      updatedAt: now(),
      approvalClaims: null,
      approvedAt: null,
      capabilityToken: null,
      capabilityExpiresAt: null,
      approvalBinding: null,
      executionIdempotencyKey: null,
      executionAuthorization: null,
      executionAuthorizedAt: null,
      receipt: null
    };
    if (!await store.create(keyFor(id), record)) fail('PACT_SAGA_PROTOCOL_ID_COLLISION');
    return { saga: publicSaga(record) };
  }

  async function sagaApprove({ sagaId, approval } = {}) {
    let record = await load(sagaId);
    if (!record) fail('PACT_SAGA_PROTOCOL_NOT_FOUND');
    if (record.state === 'APPROVED') {
      return {
        saga: publicSaga(record, await coordinator.inspect({ sagaId: record.id })),
        capability: { token: record.capabilityToken, expiresAt: record.capabilityExpiresAt, claims: clone(record.approvalClaims) },
        idempotentReplay: true
      };
    }
    if (record.state !== 'PREVIEWED') fail('PACT_SAGA_PROTOCOL_NOT_PREVIEWED');

    const capability = await authority.issue({
      approval: clone(approval),
      txId: record.id,
      planHash: record.planHash,
      baseVersion: 0,
      adapter: ADAPTER
    });
    const approvalBinding = await sha256Hex({ planHash: record.planHash, claims: capability.claims });
    await coordinator.create({
      sagaId: record.id,
      planHash: record.planHash,
      approvalBinding,
      steps: clone(record.steps)
    });
    record = await persist(record, next => {
      next.state = 'APPROVED';
      next.approvedAt = now();
      next.approvalClaims = clone(capability.claims);
      next.capabilityToken = capability.token;
      next.capabilityExpiresAt = capability.expiresAt;
      next.approvalBinding = approvalBinding;
    });
    return {
      saga: publicSaga(record, await coordinator.inspect({ sagaId: record.id })),
      capability: clone(capability),
      idempotentReplay: false
    };
  }

  async function authorizeExecution(record, capabilityToken, idempotencyKey) {
    capabilityToken = nonEmpty(capabilityToken, 'PACT_SAGA_PROTOCOL_CAPABILITY_REQUIRED', 512);
    idempotencyKey = nonEmpty(idempotencyKey, 'PACT_SAGA_PROTOCOL_IDEMPOTENCY_KEY_REQUIRED');
    if (record.capabilityToken !== capabilityToken) fail('PACT_SAGA_PROTOCOL_CAPABILITY_MISMATCH');

    if (record.executionIdempotencyKey != null) {
      if (record.executionIdempotencyKey !== idempotencyKey) fail('PACT_SAGA_PROTOCOL_IDEMPOTENCY_CONFLICT');
      if (!isPlainObject(record.executionAuthorization) || typeof record.executionAuthorization.authorizationId !== 'string') {
        fail('PACT_SAGA_PROTOCOL_CORRUPT_EXECUTION_AUTHORIZATION');
      }
      return {
        record,
        authorization: { ...clone(record.executionAuthorization), idempotentReplay: true }
      };
    }

    const authorization = await authority.authorizeCommit({
      token: capabilityToken,
      txId: record.id,
      planHash: record.planHash,
      baseVersion: 0,
      idempotencyKey
    });
    record = await persist(record, next => {
      next.executionIdempotencyKey = idempotencyKey;
      next.executionAuthorization = clone(authorization);
      next.executionAuthorizedAt = authorization.authorizedAt;
    });
    return { record, authorization };
  }

  async function sagaExecute({ sagaId, capabilityToken, idempotencyKey } = {}) {
    let record = await load(sagaId);
    if (!record) fail('PACT_SAGA_PROTOCOL_NOT_FOUND');
    if (record.state !== 'APPROVED') fail('PACT_SAGA_PROTOCOL_NOT_APPROVED');
    const authorized = await authorizeExecution(record, capabilityToken, idempotencyKey);
    record = authorized.record;
    const before = await coordinator.inspect({ sagaId: record.id });
    const result = await coordinator.execute({ sagaId: record.id });
    return { saga: publicSaga(record, result), idempotentReplay: authorized.authorization.idempotentReplay || TERMINAL.has(before.state) };
  }

  async function sagaInspect({ sagaId } = {}) {
    const record = await load(sagaId);
    if (!record) fail('PACT_SAGA_PROTOCOL_NOT_FOUND');
    if (record.state === 'PREVIEWED') return { saga: publicSaga(record) };
    return { saga: publicSaga(record, await coordinator.inspect({ sagaId: record.id })) };
  }

  async function sagaReconcile({ sagaId, capabilityToken, idempotencyKey } = {}) {
    let record = await load(sagaId);
    if (!record) fail('PACT_SAGA_PROTOCOL_NOT_FOUND');
    if (record.state !== 'APPROVED') fail('PACT_SAGA_PROTOCOL_NOT_APPROVED');
    ({ record } = await authorizeExecution(record, capabilityToken, idempotencyKey));
    const result = await coordinator.reconcile({ sagaId: record.id });
    return { saga: publicSaga(record, result) };
  }

  async function sagaReceipt({ sagaId } = {}) {
    let record = await load(sagaId);
    if (!record) fail('PACT_SAGA_PROTOCOL_NOT_FOUND');
    if (record.receipt) return { receipt: clone(record.receipt), idempotentReplay: true };
    if (record.state !== 'APPROVED') fail('PACT_SAGA_PROTOCOL_NOT_APPROVED');
    const execution = await coordinator.inspect({ sagaId: record.id });
    if (!TERMINAL.has(execution.state)) fail('PACT_SAGA_PROTOCOL_RECEIPT_NOT_AVAILABLE');
    const body = {
      sagaId: record.id,
      state: execution.state,
      planHash: record.planHash,
      approvalBinding: record.approvalBinding,
      approvalClaims: clone(record.approvalClaims),
      executionAuthorizationId: record.executionAuthorization?.authorizationId ?? null,
      steps: clone(execution.steps),
      failure: clone(execution.failure ?? null),
      completedAt: execution.committedAt ?? execution.updatedAt,
      issuedAt: now()
    };
    const receipt = { ...body, receiptHash: await sha256Hex(body) };
    record = await persist(record, next => { next.receipt = clone(receipt); });
    return { receipt: clone(record.receipt), idempotentReplay: false };
  }

  return Object.freeze({ sagaPreview, sagaApprove, sagaExecute, sagaInspect, sagaReconcile, sagaReceipt });
}
