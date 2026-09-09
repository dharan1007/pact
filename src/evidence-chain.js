import { sha256Hex } from './engine.js';

const HASH_RE = /^[a-f0-9]{64}$/;
const GENESIS_TYPE = 'SAGA_PLAN_FROZEN';
const NAMESPACE = 'pact-evidence-chain-v1';
const MAX_EVENTS = 4096;

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };

function nonEmpty(value, code, max = 256) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  const normalized = value.trim();
  if (normalized.length > max) fail(code);
  return normalized;
}

function json(value, code) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail(code);
    return JSON.parse(encoded);
  } catch (error) {
    if (error?.message === code) throw error;
    fail(code);
  }
}

function timestamp(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function assertHash(value, code) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) fail(code);
  return value;
}

function normalizeEventInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('PACT_EVIDENCE_EVENT_REQUIRED');
  return {
    type: nonEmpty(raw.type, 'PACT_EVIDENCE_TYPE_REQUIRED', 96),
    occurredAt: timestamp(raw.occurredAt, 'PACT_EVIDENCE_OCCURRED_AT_REQUIRED'),
    stepId: raw.stepId == null ? null : nonEmpty(raw.stepId, 'PACT_EVIDENCE_STEP_ID_INVALID', 256),
    actor: raw.actor == null ? null : json(raw.actor, 'PACT_EVIDENCE_ACTOR_MUST_BE_JSON'),
    payload: json(raw.payload ?? null, 'PACT_EVIDENCE_PAYLOAD_MUST_BE_JSON')
  };
}

async function eventHash({ sagaId, planHash, sequence, previousHash, type, occurredAt, stepId, actor, payload }) {
  return sha256Hex({
    namespace: NAMESPACE,
    sagaId,
    planHash,
    sequence,
    previousHash,
    type,
    occurredAt,
    stepId,
    actor,
    payload
  });
}

function validateChainShape(chain) {
  if (!chain || typeof chain !== 'object' || Array.isArray(chain)) fail('PACT_EVIDENCE_CHAIN_REQUIRED');
  const sagaId = nonEmpty(chain.sagaId, 'PACT_EVIDENCE_SAGA_ID_REQUIRED', 256);
  const planHash = assertHash(chain.planHash, 'PACT_EVIDENCE_PLAN_HASH_INVALID');
  if (!Array.isArray(chain.events) || chain.events.length < 1 || chain.events.length > MAX_EVENTS) fail('PACT_EVIDENCE_EVENT_COUNT_INVALID');
  const headHash = assertHash(chain.headHash, 'PACT_EVIDENCE_HEAD_HASH_INVALID');
  return { sagaId, planHash, events: clone(chain.events), headHash };
}

export async function verifyEvidenceChain(chain) {
  const normalized = validateChainShape(chain);
  let previousHash = null;
  for (let index = 0; index < normalized.events.length; index += 1) {
    const event = normalized.events[index];
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail('PACT_EVIDENCE_EVENT_CORRUPT');
    if (event.sequence !== index) fail('PACT_EVIDENCE_SEQUENCE_MISMATCH');
    if (index === 0) {
      if (event.previousHash !== null) fail('PACT_EVIDENCE_PREVIOUS_HASH_MISMATCH');
      if (event.type !== GENESIS_TYPE) fail('PACT_EVIDENCE_GENESIS_TYPE_INVALID');
    } else if (event.previousHash !== previousHash) {
      fail('PACT_EVIDENCE_PREVIOUS_HASH_MISMATCH');
    }
    const input = normalizeEventInput(event);
    const expected = await eventHash({
      sagaId: normalized.sagaId,
      planHash: normalized.planHash,
      sequence: index,
      previousHash: event.previousHash,
      ...input
    });
    if (event.eventHash !== expected) fail('PACT_EVIDENCE_HASH_MISMATCH');
    previousHash = event.eventHash;
  }
  if (normalized.headHash !== previousHash) fail('PACT_EVIDENCE_HEAD_HASH_MISMATCH');
  return Object.freeze({ valid: true, eventCount: normalized.events.length, headHash: normalized.headHash });
}

export async function createEvidenceGenesis({ sagaId, planHash, createdAt, plan } = {}) {
  sagaId = nonEmpty(sagaId, 'PACT_EVIDENCE_SAGA_ID_REQUIRED', 256);
  planHash = assertHash(planHash, 'PACT_EVIDENCE_PLAN_HASH_INVALID');
  const input = normalizeEventInput({
    type: GENESIS_TYPE,
    occurredAt: createdAt,
    payload: { plan: json(plan, 'PACT_EVIDENCE_PLAN_MUST_BE_JSON') }
  });
  const event = {
    sequence: 0,
    previousHash: null,
    ...input
  };
  event.eventHash = await eventHash({ sagaId, planHash, ...event });
  return { sagaId, planHash, events: [event], headHash: event.eventHash };
}

export async function appendEvidence(chain, rawEvent) {
  await verifyEvidenceChain(chain);
  if (chain.events.length >= MAX_EVENTS) fail('PACT_EVIDENCE_CHAIN_FULL');
  const normalized = validateChainShape(chain);
  const input = normalizeEventInput(rawEvent);
  const event = {
    sequence: normalized.events.length,
    previousHash: normalized.headHash,
    ...input
  };
  event.eventHash = await eventHash({ sagaId: normalized.sagaId, planHash: normalized.planHash, ...event });
  const next = {
    sagaId: normalized.sagaId,
    planHash: normalized.planHash,
    events: [...normalized.events, event],
    headHash: event.eventHash
  };
  await verifyEvidenceChain(next);
  return next;
}

export async function buildSagaEvidenceChain({
  sagaId,
  planHash,
  createdAt,
  planSteps,
  approvalBinding,
  approvalClaims,
  approvedAt,
  executionAuthorization,
  executionAuthorizedAt,
  recoveryDecisions = [],
  execution
} = {}) {
  if (!execution || typeof execution !== 'object' || !Array.isArray(execution.steps)) fail('PACT_EVIDENCE_EXECUTION_REQUIRED');
  let chain = await createEvidenceGenesis({
    sagaId,
    planHash,
    createdAt,
    plan: { steps: json(planSteps, 'PACT_EVIDENCE_PLAN_MUST_BE_JSON') }
  });

  if (approvalBinding != null) {
    chain = await appendEvidence(chain, {
      type: 'APPROVAL_BOUND',
      occurredAt: timestamp(approvedAt, 'PACT_EVIDENCE_APPROVED_AT_REQUIRED'),
      actor: approvalClaims ?? null,
      payload: { approvalBinding: assertHash(approvalBinding, 'PACT_EVIDENCE_APPROVAL_BINDING_INVALID') }
    });
  }

  if (executionAuthorization != null) {
    const authorization = json(executionAuthorization, 'PACT_EVIDENCE_EXECUTION_AUTHORIZATION_MUST_BE_JSON');
    chain = await appendEvidence(chain, {
      type: 'EXECUTION_AUTHORIZED',
      occurredAt: timestamp(executionAuthorizedAt, 'PACT_EVIDENCE_EXECUTION_AUTHORIZED_AT_REQUIRED'),
      actor: approvalClaims ?? null,
      payload: {
        authorizationId: authorization.authorizationId ?? null,
        idempotencyKey: authorization.idempotencyKey ?? null,
        authorizedAt: authorization.authorizedAt ?? executionAuthorizedAt
      }
    });
  }

  for (const rawStep of execution.steps) {
    const step = json(rawStep, 'PACT_EVIDENCE_STEP_MUST_BE_JSON');
    chain = await appendEvidence(chain, {
      type: 'STEP_OUTCOME',
      occurredAt: timestamp(step.completedAt ?? step.updatedAt ?? execution.committedAt ?? execution.updatedAt, 'PACT_EVIDENCE_STEP_TIME_REQUIRED'),
      stepId: step.id,
      payload: {
        handler: step.handler ?? null,
        resourceKey: step.resourceKey ?? null,
        atomicDomain: step.atomicDomain ?? null,
        state: step.state,
        attempts: step.attempts ?? 0,
        compensationAttempts: step.compensationAttempts ?? 0,
        executionFence: step.executionFence ?? null,
        result: step.result ?? null,
        compensationResult: step.compensationResult ?? null,
        failure: step.failure ?? null
      }
    });
  }

  for (const rawDecision of recoveryDecisions) {
    const decision = json(rawDecision, 'PACT_EVIDENCE_RECOVERY_DECISION_MUST_BE_JSON');
    chain = await appendEvidence(chain, {
      type: 'RECOVERY_DECISION',
      occurredAt: timestamp(decision.completedAt ?? decision.createdAt, 'PACT_EVIDENCE_RECOVERY_TIME_REQUIRED'),
      actor: decision.claims ?? null,
      payload: {
        recoveryHash: decision.recoveryHash,
        action: decision.action,
        decisionHash: decision.decisionHash,
        status: decision.status,
        resultState: decision.resultState ?? null,
        resultHash: decision.resultHash ?? null,
        resolutionReceiptHash: decision.resolutionReceiptHash ?? null
      }
    });
  }

  chain = await appendEvidence(chain, {
    type: 'SAGA_TERMINAL',
    occurredAt: timestamp(execution.committedAt ?? execution.updatedAt, 'PACT_EVIDENCE_TERMINAL_TIME_REQUIRED'),
    payload: {
      state: execution.state,
      leaseGeneration: execution.leaseGeneration ?? 0,
      failure: execution.failure ?? null
    }
  });

  await verifyEvidenceChain(chain);
  return chain;
}

export const EVIDENCE_CHAIN_MAX_EVENTS = MAX_EVENTS;
