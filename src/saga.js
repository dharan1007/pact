import { canonicalStringify, sha256Hex } from './engine.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const MAX_STEPS = 64;
const DEFAULT_LEASE_MS = 30_000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const TERMINAL = new Set(['COMMITTED', 'COMPENSATED', 'PARTIALLY_COMMITTED']);

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

function same(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function assertStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.create !== 'function' || typeof store.compareAndSwap !== 'function') {
    fail('PACT_SAGA_ATOMIC_STORE_REQUIRED');
  }
}

function normalizeLeaseMs(value) {
  if (value == null) return DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LEASE_MS) fail('PACT_SAGA_INVALID_LEASE_MS');
  return value;
}

function defaultWorkerId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `worker-${uuid}`;
  return `worker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeHandlers(handlers) {
  if (!isPlainObject(handlers) || Object.keys(handlers).length < 1) fail('PACT_SAGA_HANDLERS_REQUIRED');
  const registry = new Map();
  for (const [name, handler] of Object.entries(handlers)) {
    const id = nonEmpty(name, 'PACT_SAGA_HANDLER_ID_REQUIRED');
    if (!isPlainObject(handler) || typeof handler.execute !== 'function' || typeof handler.verify !== 'function' || typeof handler.reconcile !== 'function') {
      fail(`PACT_SAGA_INVALID_HANDLER:${id}`);
    }
    if (handler.compensate != null && typeof handler.compensate !== 'function') fail(`PACT_SAGA_INVALID_COMPENSATOR:${id}`);
    if (handler.verifyCompensation != null && typeof handler.verifyCompensation !== 'function') fail(`PACT_SAGA_INVALID_COMPENSATION_VERIFIER:${id}`);
    if (handler.reconcileCompensation != null && typeof handler.reconcileCompensation !== 'function') fail(`PACT_SAGA_INVALID_COMPENSATION_RECONCILER:${id}`);
    registry.set(id, handler);
  }
  return registry;
}

function normalizeSteps(steps, registry) {
  if (!Array.isArray(steps) || steps.length < 1) fail('PACT_SAGA_STEPS_REQUIRED');
  if (steps.length > MAX_STEPS) fail('PACT_SAGA_TOO_MANY_STEPS');
  const ids = new Set();
  const resources = new Set();
  return steps.map((raw, index) => {
    if (!isPlainObject(raw)) fail('PACT_SAGA_INVALID_STEP');
    const id = nonEmpty(raw.id, 'PACT_SAGA_STEP_ID_REQUIRED');
    if (ids.has(id)) fail('PACT_SAGA_DUPLICATE_STEP_ID');
    ids.add(id);
    const handler = nonEmpty(raw.handler, 'PACT_SAGA_STEP_HANDLER_REQUIRED');
    if (!registry.has(handler)) fail(`PACT_SAGA_HANDLER_NOT_REGISTERED:${handler}`);
    const resourceKey = nonEmpty(raw.resourceKey, 'PACT_SAGA_RESOURCE_KEY_REQUIRED', 512);
    if (resources.has(resourceKey)) fail('PACT_SAGA_DUPLICATE_RESOURCE');
    resources.add(resourceKey);
    const atomicDomain = nonEmpty(raw.atomicDomain, 'PACT_SAGA_ATOMIC_DOMAIN_REQUIRED', 256);
    const input = assertJson(raw.input, 'PACT_SAGA_STEP_INPUT_MUST_BE_JSON');
    return {
      index,
      id,
      handler,
      resourceKey,
      atomicDomain,
      input,
      state: 'PENDING',
      attempts: 0,
      compensationAttempts: 0
    };
  });
}

function validateRecord(value) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.version) || value.version < 0 || typeof value.sagaId !== 'string' ||
      typeof value.planHash !== 'string' || typeof value.approvalBinding !== 'string' || typeof value.definitionHash !== 'string' ||
      typeof value.state !== 'string' || !Array.isArray(value.steps)) fail('PACT_SAGA_CORRUPT_RECORD');
  if (value.steps.length < 1 || value.steps.length > MAX_STEPS) fail('PACT_SAGA_CORRUPT_RECORD');
  const normalized = clone(value);
  if (normalized.leaseGeneration == null) normalized.leaseGeneration = 0;
  if (!Number.isSafeInteger(normalized.leaseGeneration) || normalized.leaseGeneration < 0) fail('PACT_SAGA_CORRUPT_RECORD');
  if (normalized.lease == null) normalized.lease = null;
  if (normalized.lease != null) {
    if (!isPlainObject(normalized.lease) || typeof normalized.lease.ownerId !== 'string' || !normalized.lease.ownerId ||
        !Number.isSafeInteger(normalized.lease.generation) || normalized.lease.generation < 1 ||
        !Number.isFinite(normalized.lease.expiresAt)) fail('PACT_SAGA_CORRUPT_RECORD');
  }
  return normalized;
}

function publicRecord(record) {
  const copy = clone(record);
  delete copy.definitionHash;
  return copy;
}

function errorInfo(error) {
  return {
    code: typeof error?.message === 'string' && error.message ? error.message : 'PACT_SAGA_HANDLER_FAILED',
    uncertain: error?.uncertain === true
  };
}

function outcome(value, code) {
  if (!['committed', 'not_committed', 'uncertain'].includes(value)) fail(code);
  return value;
}

function isFenceLost(error) {
  return error?.message === 'PACT_SAGA_EXECUTION_FENCE_LOST' || error?.message === 'PACT_SAGA_EXECUTION_LEASE_HELD';
}

export function createPactSagaCoordinator({
  store,
  handlers,
  now = () => Date.now(),
  prefix = 'pact:saga:',
  workerId = defaultWorkerId(),
  leaseMs = DEFAULT_LEASE_MS,
  telemetry = null
} = {}) {
  assertStore(store);
  const registry = normalizeHandlers(handlers);
  prefix = nonEmpty(prefix, 'PACT_SAGA_PREFIX_REQUIRED', 512);
  workerId = nonEmpty(workerId, 'PACT_SAGA_WORKER_ID_REQUIRED', 256);
  leaseMs = normalizeLeaseMs(leaseMs);
  if (telemetry != null && (typeof telemetry !== 'object' || typeof telemetry.emit !== 'function')) fail('PACT_SAGA_INVALID_TELEMETRY');

  const emit = async (type, fields = {}) => {
    if (!telemetry) return;
    await telemetry.emit({ type, ...fields });
  };
  const keyFor = sagaId => `${prefix}${sagaId}`;

  async function load(sagaId) {
    sagaId = nonEmpty(sagaId, 'PACT_SAGA_ID_REQUIRED');
    const raw = await store.get(keyFor(sagaId));
    return raw ? validateRecord(raw) : null;
  }

  async function persist(current, mutate) {
    const next = clone(current);
    mutate(next);
    next.version = current.version + 1;
    next.updatedAt = now();
    if (!await store.compareAndSwap(keyFor(current.sagaId), current.version, next)) fail('PACT_SAGA_CONCURRENT_MODIFICATION');
    return validateRecord(next);
  }

  function fenceOf(record) {
    if (!record.lease) fail('PACT_SAGA_EXECUTION_FENCE_LOST');
    return clone(record.lease);
  }

  function leaseMatches(record, fence, at = now()) {
    return Boolean(record.lease) && record.lease.ownerId === fence.ownerId && record.lease.generation === fence.generation &&
      record.lease.expiresAt > at;
  }

  async function requireFence(sagaId, fence) {
    const latest = await load(sagaId);
    if (!latest || !leaseMatches(latest, fence)) {
      await emit('SAGA_FENCE_LOST', { sagaId, workerId: fence?.ownerId ?? workerId, leaseGeneration: fence?.generation ?? null });
      fail('PACT_SAGA_EXECUTION_FENCE_LOST');
    }
    return latest;
  }

  async function persistFenced(current, fence, mutate) {
    const latest = await requireFence(current.sagaId, fence);
    return persist(latest, mutate);
  }

  async function acquireLease(record) {
    const at = now();
    const existing = record.lease;
    if (existing && existing.expiresAt > at && existing.ownerId !== workerId) fail('PACT_SAGA_EXECUTION_LEASE_HELD');
    const sameLiveOwner = existing && existing.expiresAt > at && existing.ownerId === workerId;
    const generation = sameLiveOwner ? existing.generation : record.leaseGeneration + 1;
    const takeover = Boolean(existing && !sameLiveOwner);
    const next = await persist(record, candidate => {
      candidate.leaseGeneration = Math.max(candidate.leaseGeneration ?? 0, generation);
      candidate.lease = { ownerId: workerId, generation, expiresAt: at + leaseMs };
    });
    await emit(takeover ? 'SAGA_LEASE_TAKEN_OVER' : 'SAGA_LEASE_ACQUIRED', {
      sagaId: record.sagaId,
      workerId,
      leaseGeneration: generation,
      leaseExpiresAt: at + leaseMs
    });
    return next;
  }

  async function renewLease(record, fence) {
    const latest = await requireFence(record.sagaId, fence);
    const at = now();
    return persist(latest, next => {
      next.lease = { ownerId: fence.ownerId, generation: fence.generation, expiresAt: at + leaseMs };
    });
  }

  async function create({ sagaId, planHash, approvalBinding, steps } = {}) {
    sagaId = nonEmpty(sagaId, 'PACT_SAGA_ID_REQUIRED');
    planHash = nonEmpty(planHash, 'PACT_SAGA_PLAN_HASH_REQUIRED', 512);
    approvalBinding = nonEmpty(approvalBinding, 'PACT_SAGA_APPROVAL_BINDING_REQUIRED', 2048);
    const normalizedSteps = normalizeSteps(steps, registry);
    const definitionHash = await sha256Hex({ sagaId, planHash, approvalBinding, steps: normalizedSteps.map(({ state, attempts, compensationAttempts, ...step }) => step) });
    const record = {
      version: 0,
      sagaId,
      planHash,
      approvalBinding,
      definitionHash,
      state: 'PLANNED',
      steps: normalizedSteps,
      createdAt: now(),
      updatedAt: now(),
      failure: null,
      leaseGeneration: 0,
      lease: null
    };
    if (await store.create(keyFor(sagaId), record)) {
      await emit('SAGA_CREATED', { sagaId, stepCount: normalizedSteps.length });
      return publicRecord(record);
    }
    const existing = await load(sagaId);
    if (!existing || existing.definitionHash !== definitionHash) fail('PACT_SAGA_CREATE_CONFLICT');
    return publicRecord(existing);
  }

  async function compensate(record, failure, fence) {
    let current = await persistFenced(record, fence, next => {
      next.state = 'COMPENSATING';
      next.failure = clone(failure);
    });
    await emit('SAGA_COMPENSATION_STARTED', { sagaId: current.sagaId, leaseGeneration: fence.generation });
    let incomplete = false;

    for (let index = current.steps.length - 1; index >= 0; index -= 1) {
      let stepRecord = current.steps[index];
      if (stepRecord.state === 'COMPENSATED') continue;
      if (stepRecord.state !== 'COMMITTED') continue;
      const handler = registry.get(stepRecord.handler);
      if (typeof handler.compensate !== 'function') {
        incomplete = true;
        continue;
      }

      current = await renewLease(current, fence);
      fence = fenceOf(current);
      current = await persistFenced(current, fence, next => {
        const step = next.steps[index];
        step.state = 'COMPENSATING';
        step.compensationAttempts += 1;
        step.compensationStartedAt = now();
      });
      stepRecord = current.steps[index];
      const context = {
        sagaId: current.sagaId,
        planHash: current.planHash,
        approvalBinding: current.approvalBinding,
        step: clone(stepRecord),
        input: clone(stepRecord.input),
        forwardResult: clone(stepRecord.result),
        idempotencyKey: `${current.sagaId}:${stepRecord.id}:compensate`,
        fence: clone(fence)
      };
      const providerStartedAt = now();
      await emit('SAGA_COMPENSATION_STEP_STARTED', { sagaId: current.sagaId, stepId: stepRecord.id, handler: stepRecord.handler, leaseGeneration: fence.generation });

      try {
        const result = await handler.compensate(context);
        current = await requireFence(current.sagaId, fence);
        const verified = typeof handler.verifyCompensation === 'function' ? await handler.verifyCompensation({ ...context, result: clone(result) }) : true;
        current = await requireFence(current.sagaId, fence);
        if (!verified) throw new Error('PACT_SAGA_COMPENSATION_VERIFICATION_FAILED');
        current = await persistFenced(current, fence, next => {
          const step = next.steps[index];
          step.state = 'COMPENSATED';
          step.compensationResult = clone(result);
          step.compensatedAt = now();
        });
        await emit('SAGA_COMPENSATION_STEP_FINISHED', { sagaId: current.sagaId, stepId: stepRecord.id, handler: stepRecord.handler, providerLatencyMs: Math.max(0, now() - providerStartedAt), outcome: 'compensated' });
      } catch (error) {
        if (isFenceLost(error)) throw error;
        const info = errorInfo(error);
        if (info.uncertain) {
          const uncertain = await persistFenced(current, fence, next => {
            next.state = 'RECONCILIATION_REQUIRED';
            next.failure = { ...info, phase: 'compensation', stepId: stepRecord.id };
            next.steps[index].state = 'COMPENSATION_UNCERTAIN';
          });
          await emit('SAGA_RECONCILIATION_REQUIRED', { sagaId: current.sagaId, stepId: stepRecord.id, handler: stepRecord.handler, phase: 'compensation', leaseGeneration: fence.generation });
          return publicRecord(uncertain);
        }
        incomplete = true;
        current = await persistFenced(current, fence, next => {
          next.steps[index].state = 'COMPENSATION_FAILED';
          next.steps[index].compensationFailure = info;
        });
        await emit('SAGA_COMPENSATION_STEP_FINISHED', { sagaId: current.sagaId, stepId: stepRecord.id, handler: stepRecord.handler, providerLatencyMs: Math.max(0, now() - providerStartedAt), outcome: 'failed', errorCode: info.code });
      }
    }

    current = await persistFenced(current, fence, next => {
      next.state = incomplete ? 'PARTIALLY_COMMITTED' : 'COMPENSATED';
      next.lease = null;
    });
    await emit('SAGA_TERMINAL', { sagaId: current.sagaId, state: current.state });
    return publicRecord(current);
  }

  async function execute({ sagaId } = {}) {
    let current = await load(sagaId);
    if (!current) fail('PACT_SAGA_NOT_FOUND');
    if (TERMINAL.has(current.state)) return publicRecord(current);
    if (current.state === 'RECONCILIATION_REQUIRED') return publicRecord(current);
    if (!['PLANNED', 'EXECUTING'].includes(current.state)) fail(`PACT_SAGA_NOT_EXECUTABLE:${current.state}`);

    current = await acquireLease(current);
    let fence = fenceOf(current);

    if (current.state === 'EXECUTING' && current.steps.some(step => step.state === 'EXECUTING')) {
      current = await persistFenced(current, fence, next => { next.state = 'RECONCILIATION_REQUIRED'; });
      await emit('SAGA_RECONCILIATION_REQUIRED', { sagaId: current.sagaId, phase: 'forward', leaseGeneration: fence.generation, cause: 'lease-takeover-inflight-step' });
      return publicRecord(current);
    }

    if (current.state === 'PLANNED') current = await persistFenced(current, fence, next => { next.state = 'EXECUTING'; });

    for (let index = 0; index < current.steps.length; index += 1) {
      let stepRecord = current.steps[index];
      if (stepRecord.state === 'COMMITTED') continue;
      if (stepRecord.state !== 'PENDING') fail(`PACT_SAGA_INVALID_STEP_STATE:${stepRecord.state}`);
      const handler = registry.get(stepRecord.handler);

      current = await renewLease(current, fence);
      fence = fenceOf(current);
      current = await persistFenced(current, fence, next => {
        const step = next.steps[index];
        step.state = 'EXECUTING';
        step.attempts += 1;
        step.startedAt = now();
        step.executionFence = { ownerId: fence.ownerId, generation: fence.generation };
      });
      stepRecord = current.steps[index];
      const context = {
        sagaId: current.sagaId,
        planHash: current.planHash,
        approvalBinding: current.approvalBinding,
        step: clone(stepRecord),
        input: clone(stepRecord.input),
        idempotencyKey: `${current.sagaId}:${stepRecord.id}:forward`,
        fence: clone(fence)
      };
      const providerStartedAt = now();
      await emit('SAGA_STEP_STARTED', { sagaId: current.sagaId, stepId: stepRecord.id, handler: stepRecord.handler, resourceKey: stepRecord.resourceKey, leaseGeneration: fence.generation });

      try {
        const result = await handler.execute(context);
        current = await requireFence(current.sagaId, fence);
        if (!await handler.verify({ ...context, result: clone(result) })) throw new Error('PACT_SAGA_STEP_VERIFICATION_FAILED');
        current = await requireFence(current.sagaId, fence);
        current = await persistFenced(current, fence, next => {
          const step = next.steps[index];
          step.state = 'COMMITTED';
          step.result = clone(result);
          step.committedAt = now();
        });
        await emit('SAGA_STEP_FINISHED', { sagaId: current.sagaId, stepId: stepRecord.id, handler: stepRecord.handler, providerLatencyMs: Math.max(0, now() - providerStartedAt), outcome: 'committed' });
      } catch (error) {
        if (isFenceLost(error)) throw error;
        const info = errorInfo(error);
        if (info.uncertain) {
          current = await persistFenced(current, fence, next => {
            next.state = 'RECONCILIATION_REQUIRED';
            next.failure = { ...info, phase: 'forward', stepId: stepRecord.id };
            next.steps[index].state = 'UNCERTAIN';
          });
          await emit('SAGA_RECONCILIATION_REQUIRED', { sagaId: current.sagaId, stepId: stepRecord.id, handler: stepRecord.handler, phase: 'forward', leaseGeneration: fence.generation, providerLatencyMs: Math.max(0, now() - providerStartedAt), errorCode: info.code });
          return publicRecord(current);
        }
        current = await persistFenced(current, fence, next => {
          next.failure = { ...info, phase: 'forward', stepId: stepRecord.id };
          next.steps[index].state = 'FAILED';
          next.steps[index].failure = info;
        });
        await emit('SAGA_STEP_FINISHED', { sagaId: current.sagaId, stepId: stepRecord.id, handler: stepRecord.handler, providerLatencyMs: Math.max(0, now() - providerStartedAt), outcome: 'failed', errorCode: info.code });
        return compensate(current, current.failure, fence);
      }
    }

    current = await persistFenced(current, fence, next => {
      next.state = 'COMMITTED';
      next.committedAt = now();
      next.failure = null;
      next.lease = null;
    });
    await emit('SAGA_TERMINAL', { sagaId: current.sagaId, state: current.state });
    return publicRecord(current);
  }

  async function reconcile({ sagaId } = {}) {
    let current = await load(sagaId);
    if (!current) fail('PACT_SAGA_NOT_FOUND');
    if (TERMINAL.has(current.state)) return publicRecord(current);
    if (current.state !== 'RECONCILIATION_REQUIRED') fail(`PACT_SAGA_RECONCILIATION_NOT_REQUIRED:${current.state}`);

    current = await acquireLease(current);
    let fence = fenceOf(current);
    await emit('SAGA_RECONCILIATION_STARTED', { sagaId: current.sagaId, leaseGeneration: fence.generation });

    const forwardIndex = current.steps.findIndex(step => step.state === 'UNCERTAIN' || step.state === 'EXECUTING');
    if (forwardIndex >= 0) {
      const stepRecord = current.steps[forwardIndex];
      const handler = registry.get(stepRecord.handler);
      current = await renewLease(current, fence);
      fence = fenceOf(current);
      const context = {
        sagaId: current.sagaId,
        planHash: current.planHash,
        approvalBinding: current.approvalBinding,
        step: clone(stepRecord),
        input: clone(stepRecord.input),
        idempotencyKey: `${current.sagaId}:${stepRecord.id}:forward`,
        fence: clone(fence)
      };
      const resolved = outcome(await handler.reconcile(context), 'PACT_SAGA_INVALID_RECONCILIATION_RESULT');
      current = await requireFence(current.sagaId, fence);
      if (resolved === 'uncertain') return publicRecord(current);
      if (resolved === 'committed') {
        if (!await handler.verify(context)) fail('PACT_SAGA_RECONCILIATION_VERIFICATION_FAILED');
        current = await requireFence(current.sagaId, fence);
        current = await persistFenced(current, fence, next => {
          next.state = 'EXECUTING';
          next.failure = null;
          next.steps[forwardIndex].state = 'COMMITTED';
          next.steps[forwardIndex].reconciledAt = now();
        });
        await emit('SAGA_RECONCILIATION_FINISHED', { sagaId: current.sagaId, stepId: stepRecord.id, outcome: 'committed' });
        return execute({ sagaId: current.sagaId });
      }
      current = await persistFenced(current, fence, next => {
        next.steps[forwardIndex].state = 'FAILED';
        next.steps[forwardIndex].failure = { code: 'PACT_SAGA_RECONCILED_NOT_COMMITTED', uncertain: false };
        next.failure = { code: 'PACT_SAGA_RECONCILED_NOT_COMMITTED', uncertain: false, phase: 'forward', stepId: stepRecord.id };
      });
      await emit('SAGA_RECONCILIATION_FINISHED', { sagaId: current.sagaId, stepId: stepRecord.id, outcome: 'not_committed' });
      return compensate(current, current.failure, fence);
    }

    const compensationIndex = current.steps.findIndex(step => step.state === 'COMPENSATION_UNCERTAIN');
    if (compensationIndex >= 0) {
      const stepRecord = current.steps[compensationIndex];
      const handler = registry.get(stepRecord.handler);
      if (typeof handler.reconcileCompensation !== 'function') return publicRecord(current);
      current = await renewLease(current, fence);
      fence = fenceOf(current);
      const context = {
        sagaId: current.sagaId,
        planHash: current.planHash,
        approvalBinding: current.approvalBinding,
        step: clone(stepRecord),
        input: clone(stepRecord.input),
        forwardResult: clone(stepRecord.result),
        idempotencyKey: `${current.sagaId}:${stepRecord.id}:compensate`,
        fence: clone(fence)
      };
      const resolved = outcome(await handler.reconcileCompensation(context), 'PACT_SAGA_INVALID_COMPENSATION_RECONCILIATION_RESULT');
      current = await requireFence(current.sagaId, fence);
      if (resolved === 'uncertain') return publicRecord(current);
      if (resolved === 'committed') {
        if (typeof handler.verifyCompensation === 'function' && !await handler.verifyCompensation(context)) fail('PACT_SAGA_COMPENSATION_RECONCILIATION_VERIFICATION_FAILED');
        current = await requireFence(current.sagaId, fence);
        current = await persistFenced(current, fence, next => {
          next.steps[compensationIndex].state = 'COMPENSATED';
          next.steps[compensationIndex].reconciledAt = now();
          next.state = 'COMPENSATING';
        });
        await emit('SAGA_RECONCILIATION_FINISHED', { sagaId: current.sagaId, stepId: stepRecord.id, phase: 'compensation', outcome: 'committed' });
        return compensate(current, current.failure, fence);
      }
      current = await persistFenced(current, fence, next => {
        next.steps[compensationIndex].state = 'COMMITTED';
        next.state = 'COMPENSATING';
      });
      await emit('SAGA_RECONCILIATION_FINISHED', { sagaId: current.sagaId, stepId: stepRecord.id, phase: 'compensation', outcome: 'not_committed' });
      return compensate(current, current.failure, fence);
    }

    fail('PACT_SAGA_CORRUPT_RECONCILIATION_STATE');
  }

  async function inspect({ sagaId } = {}) {
    const record = await load(sagaId);
    if (!record) fail('PACT_SAGA_NOT_FOUND');
    return publicRecord(record);
  }

  return Object.freeze({ create, execute, reconcile, inspect });
}