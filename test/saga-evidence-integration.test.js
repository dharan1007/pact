import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyEvidenceChain } from '../src/evidence-chain.js';
import { createPactSagaAuthorityService } from '../src/saga-protocol.js';

const clone = value => value === undefined ? undefined : structuredClone(value);

function atomicStore() {
  const data = new Map();
  return {
    async get(key) { return clone(data.get(key) ?? null); },
    async create(key, value) {
      if (data.has(key)) return false;
      data.set(key, clone(value));
      return true;
    },
    async compareAndSwap(key, expectedVersion, value) {
      const current = data.get(key);
      if (!current || current.version !== expectedVersion) return false;
      data.set(key, clone(value));
      return true;
    }
  };
}

function step(id) {
  return { id, handler: 'provider', resourceKey: `resource:${id}`, atomicDomain: 'provider', input: { id } };
}

test('terminal saga receipt carries a deterministic hash-linked event for every committed step', async () => {
  let clock = 10_000;
  const state = new Map();
  const service = createPactSagaAuthorityService({
    store: atomicStore(),
    now: () => clock,
    verifyApproval: async () => ({ humanPrincipal: 'human:evidence', agentSession: 'agent:evidence' }),
    handlers: {
      provider: {
        async execute({ input, fence }) {
          state.set(input.id, { committed: true, fence });
          return { providerRevision: `${input.id}:rev:1`, observedVersion: 1 };
        },
        async verify({ input }) { return state.get(input.id)?.committed === true; },
        async reconcile({ input }) { return state.get(input.id)?.committed ? 'committed' : 'not_committed'; }
      }
    }
  });

  const preview = await service.sagaPreview({ steps: [step('identity'), step('billing')] });
  clock += 10;
  const approved = await service.sagaApprove({ sagaId: preview.saga.id, approval: { signed: true, method: 'webauthn' } });
  clock += 10;
  await service.sagaExecute({ sagaId: preview.saga.id, capabilityToken: approved.capability.token, idempotencyKey: 'evidence-exec-1' });
  clock += 10;
  const first = await service.sagaReceipt({ sagaId: preview.saga.id });

  assert.ok(first.receipt.evidenceChain, 'receipt must include cryptographic evidence chain');
  assert.equal(first.receipt.evidenceHeadHash, first.receipt.evidenceChain.headHash);
  assert.match(first.receipt.evidenceHeadHash, /^[a-f0-9]{64}$/);
  const verified = await verifyEvidenceChain(first.receipt.evidenceChain);
  assert.equal(verified.valid, true);

  const types = first.receipt.evidenceChain.events.map(event => event.type);
  assert.deepEqual(types, [
    'SAGA_PLAN_FROZEN',
    'APPROVAL_BOUND',
    'EXECUTION_AUTHORIZED',
    'STEP_OUTCOME',
    'STEP_OUTCOME',
    'SAGA_TERMINAL'
  ]);
  const stepEvents = first.receipt.evidenceChain.events.filter(event => event.type === 'STEP_OUTCOME');
  assert.deepEqual(stepEvents.map(event => event.stepId), ['identity', 'billing']);
  assert.equal(stepEvents[0].payload.state, 'COMMITTED');
  assert.equal(stepEvents[0].payload.result.providerRevision, 'identity:rev:1');
  assert.ok(stepEvents[0].payload.executionFence, 'step evidence must bind worker fencing context');

  const replay = await service.sagaReceipt({ sagaId: preview.saga.id });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.receipt.evidenceHeadHash, first.receipt.evidenceHeadHash, 'receipt replay must preserve exact evidence head');
  assert.equal(replay.receipt.receiptHash, first.receipt.receiptHash);
});

test('operator recovery decisions are individually committed into terminal saga evidence', async () => {
  let clock = 20_000;
  let committed = false;
  let loseResponse = true;
  const service = createPactSagaAuthorityService({
    store: atomicStore(),
    now: () => clock,
    verifyApproval: async ({ adapter }) => adapter.id === 'pact.saga.recovery'
      ? { humanPrincipal: 'human:operator', agentSession: 'agent:recovery' }
      : { humanPrincipal: 'human:requester', agentSession: 'agent:request' },
    handlers: {
      provider: {
        async execute() {
          committed = true;
          if (loseResponse) {
            loseResponse = false;
            const error = new Error('RESPONSE_LOST');
            error.uncertain = true;
            throw error;
          }
          return { providerRevision: 'rev:1' };
        },
        async verify() { return committed; },
        async reconcile() { return committed ? 'committed' : 'not_committed'; },
        async recoveryEvidence() { return { classification: committed ? 'committed' : 'not_committed', observed: { committed } }; }
      }
    }
  });

  const preview = await service.sagaPreview({ steps: [step('identity')] });
  const approved = await service.sagaApprove({ sagaId: preview.saga.id, approval: { signed: true } });
  const uncertain = await service.sagaExecute({ sagaId: preview.saga.id, capabilityToken: approved.capability.token, idempotencyKey: 'recover-exec-1' });
  assert.equal(uncertain.saga.state, 'RECONCILIATION_REQUIRED');

  const recovery = await service.sagaRecoveryInspect({ sagaId: preview.saga.id });
  clock += 10;
  const resolved = await service.sagaRecoveryResolve({
    sagaId: preview.saga.id,
    recoveryHash: recovery.recoveryHash,
    action: 'reconcile',
    approval: { signed: true, ticket: 'INC-77' },
    idempotencyKey: 'recovery-decision-1'
  });
  assert.equal(resolved.saga.state, 'COMMITTED');

  const receipt = await service.sagaReceipt({ sagaId: preview.saga.id });
  const recoveryEvents = receipt.receipt.evidenceChain.events.filter(event => event.type === 'RECOVERY_DECISION');
  assert.equal(recoveryEvents.length, 1);
  assert.equal(recoveryEvents[0].payload.recoveryHash, recovery.recoveryHash);
  assert.equal(recoveryEvents[0].payload.status, 'COMPLETED');
  assert.equal(recoveryEvents[0].actor.humanPrincipal, 'human:operator');
  assert.match(recoveryEvents[0].payload.resolutionReceiptHash, /^[a-f0-9]{64}$/);
  assert.equal((await verifyEvidenceChain(receipt.receipt.evidenceChain)).valid, true);
});
