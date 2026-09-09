import { sha256Hex } from './engine.js';
import { createPactAuthority } from './authority.js';
import { createPactSagaCoordinator } from './saga.js';
import { buildSagaEvidenceChain } from './evidence-chain.js';
import { createPactSagaTelemetry } from './saga-observability.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const TERMINAL = new Set(['COMMITTED', 'COMPENSATED', 'PARTIALLY_COMMITTED']);
const ADAPTER = Object.freeze({ id: 'pact.saga', version: '1.0.0' });
const RECOVERY_ADAPTER = Object.freeze({ id: 'pact.saga.recovery', version: '1.0.0' });
const BOOLEAN_REQUIREMENTS = Object.freeze(['conditionalWrite', 'idempotency', 'reconciliation', 'compensation', 'reversible', 'remoteFencing']);
const CONDITIONAL_WRITE_STRENGTHS = new Set(['any', 'strong-validator', 'provider-verified']);
const REMOTE_FENCING_STRENGTHS = new Set(['declared', 'provider-verified']);
const MAX_RECOVERY_DECISIONS = 256;

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

function validateRecoveryClaims(value) {
  if (!isPlainObject(value)) fail('PACT_SAGA_PROTOCOL_RECOVERY_APPROVAL_REJECTED');
  return {
    humanPrincipal: nonEmpty(value.humanPrincipal, 'PACT_SAGA_PROTOCOL_RECOVERY_INVALID_PRINCIPAL'),
    agentSession: nonEmpty(value.agentSession, 'PACT_SAGA_PROTOCOL_RECOVERY_INVALID_AGENT_SESSION')
  };
}

function normalizeRequirements(value) {
  if (value == null) return {};
  if (!isPlainObject(value)) fail('PACT_SAGA_PROTOCOL_INVALID_REQUIREMENTS');
  const allowed = new Set([...BOOLEAN_REQUIREMENTS, 'mutation', 'conditionalWriteStrength', 'remoteFencingStrength', 'humanRecoveryRequired']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`PACT_SAGA_PROTOCOL_UNKNOWN_REQUIREMENT:${key}`);
  const out = {};
  for (const key of BOOLEAN_REQUIREMENTS) {
    if (value[key] == null) continue;
    if (value[key] !== true) fail(`PACT_SAGA_PROTOCOL_INVALID_REQUIREMENT:${key}`);
    out[key] = true;
  }
  if (value.humanRecoveryRequired != null) {
    if (value.humanRecoveryRequired !== true) fail('PACT_SAGA_PROTOCOL_INVALID_REQUIREMENT:humanRecoveryRequired');
    out.humanRecoveryRequired = true;
  }
  if (value.mutation != null) out.mutation = nonEmpty(value.mutation, 'PACT_SAGA_PROTOCOL_INVALID_REQUIREMENT:mutation', 64).toUpperCase();
  if (value.conditionalWriteStrength != null) {
    const strength = nonEmpty(value.conditionalWriteStrength, 'PACT_SAGA_PROTOCOL_INVALID_REQUIREMENT:conditionalWriteStrength', 64).toLowerCase();
    if (!CONDITIONAL_WRITE_STRENGTHS.has(strength)) fail('PACT_SAGA_PROTOCOL_INVALID_REQUIREMENT:conditionalWriteStrength');
    out.conditionalWriteStrength = strength;
    out.conditionalWrite = true;
  }
  if (value.remoteFencingStrength != null) {
    const strength = nonEmpty(value.remoteFencingStrength, 'PACT_SAGA_PROTOCOL_INVALID_REQUIREMENT:remoteFencingStrength', 64).toLowerCase();
    if (!REMOTE_FENCING_STRENGTHS.has(strength)) fail('PACT_SAGA_PROTOCOL_INVALID_REQUIREMENT:remoteFencingStrength');
    out.remoteFencingStrength = strength;
    out.remoteFencing = true;
  }
  return out;
}

async function handlerCapabilities(handler) {
  if (typeof handler?.getCapabilities === 'function') {
    const resolved = await handler.getCapabilities();
    if (!isPlainObject(resolved)) fail('PACT_SAGA_PROTOCOL_INVALID_HANDLER_CAPABILITIES');
    return resolved;
  }
  return isPlainObject(handler?.capabilities) ? handler.capabilities : {};
}

async function negotiateHandler({ handlerName, resourceKey, atomicDomain, requirements, handlers }) {
  const handler = handlers[handlerName];
  if (!isPlainObject(handler)) fail(`PACT_SAGA_PROTOCOL_HANDLER_NOT_REGISTERED:${handlerName}`);
  const capabilities = await handlerCapabilities(handler);
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
  if (requirements.conditionalWriteStrength != null) {
    const strength = requirements.conditionalWriteStrength;
    if (strength === 'strong-validator' && capabilities.conditionalWrite !== 'strong-validator') {
      fail('PACT_SAGA_PROTOCOL_CAPABILITY_UNSATISFIED:conditionalWriteStrength');
    }
    if (strength === 'provider-verified' && capabilities.qualification?.conditionalWrite !== 'provider-verified') {
      fail('PACT_SAGA_PROTOCOL_CAPABILITY_UNSATISFIED:conditionalWriteStrength');
    }
  }
  if (requirements.remoteFencingStrength != null) {
    const strength = requirements.remoteFencingStrength;
    if (strength === 'declared' && (typeof capabilities.remoteFencing !== 'string' || !capabilities.remoteFencing)) {
      fail('PACT_SAGA_PROTOCOL_CAPABILITY_UNSATISFIED:remoteFencingStrength');
    }
    if (strength === 'provider-verified' && capabilities.qualification?.remoteFencing !== 'provider-verified') {
      fail('PACT_SAGA_PROTOCOL_CAPABILITY_UNSATISFIED:remoteFencingStrength');
    }
  }
}

async function normalizePreviewSteps(steps, handlers) {
  if (!Array.isArray(steps) || steps.length < 1) fail('PACT_SAGA_PROTOCOL_STEPS_REQUIRED');
  if (steps.length > 64) fail('PACT_SAGA_PROTOCOL_TOO_MANY_STEPS');
  const ids = new Set();
  const resources = new Set();
  const normalized = [];
  for (const raw of steps) {
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
    await negotiateHandler({ handlerName: handler, resourceKey, atomicDomain, requirements, handlers });
    normalized.push({
      id,
      handler,
      resourceKey,
      atomicDomain,
      requirements,
      input: assertJson(raw.input, 'PACT_SAGA_PROTOCOL_INPUT_MUST_BE_JSON')
    });
  }
  return normalized;
}

function validateProtocolRecord(value) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.version) || value.version < 0 || typeof value.id !== 'string' ||
      typeof value.planHash !== 'string' || typeof value.state !== 'string' || !Array.isArray(value.steps)) {
    fail('PACT_SAGA_PROTOCOL_CORRUPT_RECORD');
  }
  const normalized = clone(value);
  if (normalized.recoveryDecisions == null) normalized.recoveryDecisions = [];
  if (!Array.isArray(normalized.recoveryDecisions) || normalized.recoveryDecisions.length > MAX_RECOVERY_DECISIONS) {
    fail('PACT_SAGA_PROTOCOL_CORRUPT_RECOVERY_HISTORY');
  }
  return normalized;
}

function publicSaga(protocol, coordinatorRecord = null, operational = null) {
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
    recoveryDecisionCount: Array.isArray(protocol.recoveryDecisions) ? protocol.recoveryDecisions.length : 0,
    failure: clone(coordinatorRecord?.failure ?? null)
  };
  if (coordinatorRecord?.updatedAt != null) out.updatedAt = coordinatorRecord.updatedAt;
  if (coordinatorRecord?.committedAt != null) out.committedAt = coordinatorRecord.committedAt;
  if (operational != null) out.operational = clone(operational);
  return out;
}

function recoveryExecutionStep(execution) {
  if (!isPlainObject(execution) || !Array.isArray(execution.steps)) return null;
  return execution.steps.find(candidate => candidate.state === 'UNCERTAIN' || candidate.state === 'EXECUTING' || candidate.state === 'COMPENSATION_UNCERTAIN') ?? null;
}

function plannedStepFor(record, executionStep) {
  if (!executionStep) return null;
  return record.steps.find(candidate => candidate.id === executionStep.id) ?? null;
}

function humanRecoveryRequired(record, execution) {
  const executionStep = recoveryExecutionStep(execution);
  const planned = plannedStepFor(record, executionStep);
  return planned?.requirements?.humanRecoveryRequired === true;
}

export function createPactSagaAuthorityService({
  store,
  verifyApproval,
  handlers,
  now = () => Date.now(),
  capabilityTtlMs = 120_000,
  prefix = 'pact:saga-protocol:',
  telemetrySink = async () => {},
  reconciliationSlaMs = 15 * 60_000
} = {}) {
  assertStore(store);
  if (typeof verifyApproval !== 'function') fail('PACT_SAGA_PROTOCOL_APPROVAL_VERIFIER_REQUIRED');
  if (!isPlainObject(handlers) || Object.keys(handlers).length < 1) fail('PACT_SAGA_PROTOCOL_HANDLERS_REQUIRED');
  if (typeof globalThis.crypto?.randomUUID !== 'function') fail('PACT_SAGA_PROTOCOL_SECURE_RANDOM_REQUIRED');
  prefix = nonEmpty(prefix, 'PACT_SAGA_PROTOCOL_PREFIX_REQUIRED', 512);

  const telemetry = createPactSagaTelemetry({ sink: telemetrySink, now, reconciliationSlaMs });
  const authority = createPactAuthority({ store, verifyApproval, now, ttlMs: capabilityTtlMs });
  const coordinator = createPactSagaCoordinator({ store, handlers, now, prefix: `${prefix}execution:`, telemetry });
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

  async function approvalArtifactHash(record, approval) {
    return sha256Hex({
      sagaId: record.id,
      planHash: record.planHash,
      approval: assertJson(approval, 'PACT_SAGA_PROTOCOL_APPROVAL_MUST_BE_JSON')
    });
  }

  async function sagaPreview({ steps } = {}) {
    const normalizedSteps = await normalizePreviewSteps(steps, handlers);
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
      approvalArtifactHash: null,
      approvedAt: null,
      capabilityToken: null,
      capabilityExpiresAt: null,
      approvalBinding: null,
      executionIdempotencyKey: null,
      executionAuthorization: null,
      executionAuthorizedAt: null,
      recoveryDecisions: [],
      receipt: null
    };
    if (!await store.create(keyFor(id), record)) fail('PACT_SAGA_PROTOCOL_ID_COLLISION');
    return { saga: publicSaga(record) };
  }

  async function sagaApprove({ sagaId, approval } = {}) {
    let record = await load(sagaId);
    if (!record) fail('PACT_SAGA_PROTOCOL_NOT_FOUND');
    const artifactHash = await approvalArtifactHash(record, approval);
    if (record.state === 'APPROVED') {
      if (typeof record.approvalArtifactHash !== 'string' || record.approvalArtifactHash.length !== 64) {
        fail('PACT_SAGA_PROTOCOL_APPROVAL_REPLAY_UNBOUND');
      }
      if (record.approvalArtifactHash !== artifactHash) fail('PACT_SAGA_PROTOCOL_APPROVAL_REPLAY_CONFLICT');
      const execution = await coordinator.inspect({ sagaId: record.id });
      return {
        saga: publicSaga(record, execution, telemetry.deriveOperationalStatus(execution)),
        capability: { token: record.capabilityToken, expiresAt: record.capabilityExpiresAt, claims: clone(record.approvalClaims) },
        idempotentReplay: true
      };
    }
    if (record.state !== 'PREVIEWED') fail('PACT_SAGA_PROTOCOL_NOT_PREVIEWED');

    const normalizedApproval = assertJson(approval, 'PACT_SAGA_PROTOCOL_APPROVAL_MUST_BE_JSON');
    const capability = await authority.issue({
      approval: normalizedApproval,
      txId: record.id,
      planHash: record.planHash,
      baseVersion: 0,
      adapter: ADAPTER
    });
    const approvalBinding = await sha256Hex({ planHash: record.planHash, claims: capability.claims, approvalArtifactHash: artifactHash });
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
      next.approvalArtifactHash = artifactHash;
      next.capabilityToken = capability.token;
      next.capabilityExpiresAt = capability.expiresAt;
      next.approvalBinding = approvalBinding;
    });
    await telemetry.emit({
      type: 'SAGA_APPROVED',
      sagaId: record.id,
      planHash: record.planHash,
      humanPrincipal: capability.claims?.humanPrincipal ?? null,
      agentSession: capability.claims?.agentSession ?? null
    });
    const execution = await coordinator.inspect({ sagaId: record.id });
    return {
      saga: publicSaga(record, execution, telemetry.deriveOperationalStatus(execution)),
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
    await telemetry.emit({
      type: 'SAGA_EXECUTION_AUTHORIZED',
      sagaId: record.id,
      planHash: record.planHash,
      authorizationId: authorization.authorizationId,
      humanPrincipal: authorization.claims?.humanPrincipal ?? record.approvalClaims?.humanPrincipal ?? null,
      agentSession: authorization.claims?.agentSession ?? record.approvalClaims?.agentSession ?? null
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
    return {
      saga: publicSaga(record, result, telemetry.deriveOperationalStatus(result)),
      idempotentReplay: authorized.authorization.idempotentReplay || TERMINAL.has(before.state)
    };
  }

  async function sagaInspect({ sagaId } = {}) {
    const record = await load(sagaId);
    if (!record) fail('PACT_SAGA_PROTOCOL_NOT_FOUND');
    if (record.state === 'PREVIEWED') return { saga: publicSaga(record) };
    const execution = await coordinator.inspect({ sagaId: record.id });
    return { saga: publicSaga(record, execution, telemetry.deriveOperationalStatus(execution)) };
  }

  async function sagaReconcile({ sagaId, capabilityToken, idempotencyKey } = {}) {
    let record = await load(sagaId);
    if (!record) fail('PACT_SAGA_PROTOCOL_NOT_FOUND');
    if (record.state !== 'APPROVED') fail('PACT_SAGA_PROTOCOL_NOT_APPROVED');
    const executionBefore = await coordinator.inspect({ sagaId: record.id });
    if (executionBefore.state === 'RECONCILIATION_REQUIRED' && humanRecoveryRequired(record, executionBefore)) {
      fail('PACT_SAGA_HUMAN_RECOVERY_REQUIRED');
    }
    ({ record } = await authorizeExecution(record, capabilityToken, idempotencyKey));
    const result = await coordinator.reconcile({ sagaId: record.id });
    return { saga: publicSaga(record, result, telemetry.deriveOperationalStatus(result)) };
  }

  async function buildRecovery(record) {
    const execution = await coordinator.inspect({ sagaId: record.id });
    if (execution.state !== 'RECONCILIATION_REQUIRED') fail(`PACT_SAGA_PROTOCOL_RECOVERY_NOT_REQUIRED:${execution.state}`);

    let phase = 'forward';
    let step = execution.steps.find(candidate => candidate.state === 'UNCERTAIN' || candidate.state === 'EXECUTING');
    if (!step) {
      phase = 'compensation';
      step = execution.steps.find(candidate => candidate.state === 'COMPENSATION_UNCERTAIN');
    }
    if (!step) fail('PACT_SAGA_PROTOCOL_CORRUPT_RECOVERY_STATE');
    const plannedStep = plannedStepFor(record, step);
    const requiresHuman = plannedStep?.requirements?.humanRecoveryRequired === true;

    const handler = handlers[step.handler];
    let providerEvidence = null;
    if (typeof handler?.recoveryEvidence === 'function') {
      providerEvidence = assertJson(await handler.recoveryEvidence({
        sagaId: record.id,
        planHash: record.planHash,
        approvalBinding: record.approvalBinding,
        phase,
        step: clone(step),
        input: clone(step.input),
        forwardResult: clone(step.result),
        idempotencyKey: `${record.id}:${step.id}:${phase === 'compensation' ? 'compensate' : 'forward'}`,
        failure: clone(execution.failure ?? null)
      }), 'PACT_SAGA_PROTOCOL_RECOVERY_EVIDENCE_MUST_BE_JSON');
    }

    const recoveryEvidence = {
      sagaId: record.id,
      state: execution.state,
      recoveryVersion: execution.version,
      planHash: record.planHash,
      phase,
      step: {
        id: step.id,
        handler: step.handler,
        resourceKey: step.resourceKey,
        atomicDomain: step.atomicDomain,
        state: step.state,
        attempts: step.attempts,
        compensationAttempts: step.compensationAttempts,
        executionFence: clone(step.executionFence ?? null)
      },
      failure: clone(execution.failure ?? null),
      leaseGeneration: execution.leaseGeneration ?? 0,
      providerEvidence,
      humanRecoveryRequired: requiresHuman,
      allowedActions: ['reconcile']
    };
    const recoveryHash = await sha256Hex({ namespace: 'pact-saga-recovery-v1', sagaId: record.id, planHash: record.planHash, recovery: recoveryEvidence });
    const recovery = { ...recoveryEvidence, operational: telemetry.deriveOperationalStatus(execution) };
    return { recovery, recoveryHash };
  }

  async function sagaRecoveryInspect({ sagaId } = {}) {
    const record = await load(sagaId);
    if (!record) fail('PACT_SAGA_PROTOCOL_NOT_FOUND');
    if (record.state !== 'APPROVED') fail('PACT_SAGA_PROTOCOL_NOT_APPROVED');
    return buildRecovery(record);
  }

  async function sagaRecoveryResolve({ sagaId, recoveryHash, action, approval, idempotencyKey } = {}) {
    let record = await load(sagaId);
    if (!record) fail('PACT_SAGA_PROTOCOL_NOT_FOUND');
    if (record.state !== 'APPROVED') fail('PACT_SAGA_PROTOCOL_NOT_APPROVED');
    recoveryHash = nonEmpty(recoveryHash, 'PACT_SAGA_PROTOCOL_RECOVERY_HASH_REQUIRED', 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(recoveryHash)) fail('PACT_SAGA_PROTOCOL_INVALID_RECOVERY_HASH');
    action = nonEmpty(action, 'PACT_SAGA_PROTOCOL_RECOVERY_ACTION_REQUIRED', 64).toLowerCase();
    if (action !== 'reconcile') fail('PACT_SAGA_PROTOCOL_RECOVERY_ACTION_UNSUPPORTED');
    idempotencyKey = nonEmpty(idempotencyKey, 'PACT_SAGA_PROTOCOL_RECOVERY_IDEMPOTENCY_KEY_REQUIRED');
    const normalizedApproval = assertJson(approval, 'PACT_SAGA_PROTOCOL_RECOVERY_APPROVAL_MUST_BE_JSON');
    const approvalArtifactHash = await sha256Hex({ sagaId: record.id, recoveryHash, action, approval: normalizedApproval });
    const decisionHash = await sha256Hex({ sagaId: record.id, recoveryHash, action, approvalArtifactHash });

    let decision = record.recoveryDecisions.find(candidate => candidate.idempotencyKey === idempotencyKey) ?? null;
    if (decision) {
      if (decision.decisionHash !== decisionHash) fail('PACT_SAGA_PROTOCOL_RECOVERY_REPLAY_CONFLICT');
      if (decision.status === 'COMPLETED') {
        const execution = await coordinator.inspect({ sagaId: record.id });
        return {
          saga: publicSaga(record, execution, telemetry.deriveOperationalStatus(execution)),
          recoveryDecision: clone(decision),
          idempotentReplay: true
        };
      }
      if (decision.status !== 'PENDING') fail('PACT_SAGA_PROTOCOL_CORRUPT_RECOVERY_DECISION');
    } else {
      const currentRecovery = await buildRecovery(record);
      if (currentRecovery.recoveryHash !== recoveryHash) fail('PACT_SAGA_PROTOCOL_RECOVERY_STALE');
      if (record.recoveryDecisions.length >= MAX_RECOVERY_DECISIONS) fail('PACT_SAGA_PROTOCOL_RECOVERY_HISTORY_FULL');

      const verified = await verifyApproval({
        approval: clone(normalizedApproval),
        txId: `${record.id}:recovery`,
        planHash: recoveryHash,
        baseVersion: currentRecovery.recovery.recoveryVersion,
        adapter: clone(RECOVERY_ADAPTER)
      });
      const claims = validateRecoveryClaims(verified);
      decision = {
        idempotencyKey,
        recoveryHash,
        action,
        approvalArtifactHash,
        decisionHash,
        claims,
        status: 'PENDING',
        createdAt: now(),
        completedAt: null,
        resultState: null,
        resultHash: null,
        resolutionReceiptHash: null
      };
      record = await persist(record, next => { next.recoveryDecisions.push(clone(decision)); });
      await telemetry.emit({
        type: 'SAGA_OPERATOR_RECOVERY_AUTHORIZED',
        sagaId: record.id,
        recoveryHash,
        action,
        humanPrincipal: claims.humanPrincipal,
        agentSession: claims.agentSession,
        decisionHash
      });
    }

    let execution = await coordinator.inspect({ sagaId: record.id });
    if (!TERMINAL.has(execution.state)) {
      if (execution.state !== 'RECONCILIATION_REQUIRED') fail(`PACT_SAGA_PROTOCOL_RECOVERY_STATE_CHANGED:${execution.state}`);
      execution = await coordinator.reconcile({ sagaId: record.id });
    }

    const resultHash = await sha256Hex({
      sagaId: record.id,
      planHash: record.planHash,
      state: execution.state,
      steps: execution.steps,
      failure: execution.failure ?? null
    });
    const completedAt = now();
    const resolutionReceiptHash = await sha256Hex({
      namespace: 'pact-saga-recovery-resolution-v1',
      decisionHash,
      resultHash,
      resultState: execution.state,
      completedAt
    });
    record = await persist(record, next => {
      const index = next.recoveryDecisions.findIndex(candidate => candidate.idempotencyKey === idempotencyKey);
      if (index < 0) fail('PACT_SAGA_PROTOCOL_CORRUPT_RECOVERY_DECISION');
      next.recoveryDecisions[index] = {
        ...next.recoveryDecisions[index],
        status: 'COMPLETED',
        completedAt,
        resultState: execution.state,
        resultHash,
        resolutionReceiptHash
      };
    });
    decision = record.recoveryDecisions.find(candidate => candidate.idempotencyKey === idempotencyKey);
    await telemetry.emit({
      type: 'SAGA_OPERATOR_RECOVERY_RESOLVED',
      sagaId: record.id,
      recoveryHash,
      action,
      decisionHash,
      resultState: execution.state,
      resolutionReceiptHash
    });
    return {
      saga: publicSaga(record, execution, telemetry.deriveOperationalStatus(execution)),
      recoveryDecision: clone(decision),
      idempotentReplay: false
    };
  }

  async function sagaReceipt({ sagaId } = {}) {
    let record = await load(sagaId);
    if (!record) fail('PACT_SAGA_PROTOCOL_NOT_FOUND');
    if (record.receipt) return { receipt: clone(record.receipt), idempotentReplay: true };
    if (record.state !== 'APPROVED') fail('PACT_SAGA_PROTOCOL_NOT_APPROVED');
    const execution = await coordinator.inspect({ sagaId: record.id });
    if (!TERMINAL.has(execution.state)) fail('PACT_SAGA_PROTOCOL_RECEIPT_NOT_AVAILABLE');
    const evidenceChain = await buildSagaEvidenceChain({
      sagaId: record.id,
      planHash: record.planHash,
      createdAt: record.createdAt,
      planSteps: record.steps,
      approvalBinding: record.approvalBinding,
      approvalClaims: clone(record.approvalClaims),
      approvedAt: record.approvedAt,
      executionAuthorization: clone(record.executionAuthorization),
      executionAuthorizedAt: record.executionAuthorizedAt,
      recoveryDecisions: clone(record.recoveryDecisions),
      execution: clone(execution)
    });
    const body = {
      sagaId: record.id,
      state: execution.state,
      planHash: record.planHash,
      approvalBinding: record.approvalBinding,
      approvalClaims: clone(record.approvalClaims),
      executionAuthorizationId: record.executionAuthorization?.authorizationId ?? null,
      recoveryDecisions: clone(record.recoveryDecisions),
      steps: clone(execution.steps),
      failure: clone(execution.failure ?? null),
      completedAt: execution.committedAt ?? execution.updatedAt,
      issuedAt: now(),
      evidenceHeadHash: evidenceChain.headHash,
      evidenceEventCount: evidenceChain.events.length,
      evidenceChain
    };
    const receipt = { ...body, receiptHash: await sha256Hex(body) };
    record = await persist(record, next => { next.receipt = clone(receipt); });
    return { receipt: clone(record.receipt), idempotentReplay: false };
  }

  return Object.freeze({
    sagaPreview,
    sagaApprove,
    sagaExecute,
    sagaInspect,
    sagaReconcile,
    sagaRecoveryInspect,
    sagaRecoveryResolve,
    sagaReceipt
  });
}