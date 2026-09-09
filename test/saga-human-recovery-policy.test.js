import test from 'node:test';
import assert from 'node:assert/strict';
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

test('humanRecoveryRequired is frozen into the approved plan, blocks autonomous reconciliation, and permits evidence-bound human resolution', async () => {
  let providerCommitted = false;
  let reconcileCalls = 0;
  let approvalCalls = 0;
  const service = createPactSagaAuthorityService({
    store: atomicStore(),
    handlers: {
      identity: {
        capabilities: { resourceKey: 'identity:42', atomicDomain: 'identity', reconciliation: true },
        async execute() {
          providerCommitted = true;
          const error = new Error('NETWORK_RESPONSE_LOST');
          error.uncertain = true;
          throw error;
        },
        async verify() { return providerCommitted; },
        async reconcile() { reconcileCalls += 1; return providerCommitted ? 'committed' : 'not_committed'; },
        async recoveryEvidence() {
          return { provider: 'identity', before: { role: 'admin' }, intended: { role: 'read' }, observed: { role: 'read' }, classification: 'committed' };
        }
      }
    },
    now: () => 10_000,
    verifyApproval: async ({ adapter }) => {
      approvalCalls += 1;
      return adapter?.id === 'pact.saga.recovery'
        ? { humanPrincipal: 'human:incident-operator', agentSession: 'agent:recovery' }
        : { humanPrincipal: 'human:owner', agentSession: 'agent:transaction' };
    }
  });

  const preview = await service.sagaPreview({
    steps: [{
      id: 'privileged-access',
      handler: 'identity',
      resourceKey: 'identity:42',
      atomicDomain: 'identity',
      requirements: { reconciliation: true, humanRecoveryRequired: true },
      input: { role: 'read' }
    }]
  });
  assert.equal(preview.saga.steps[0].requirements.humanRecoveryRequired, true);
  const withoutPolicy = await service.sagaPreview({
    steps: [{
      id: 'privileged-access', handler: 'identity', resourceKey: 'identity:43', atomicDomain: 'identity',
      requirements: { reconciliation: true }, input: { role: 'read' }
    }]
  });
  assert.notEqual(preview.saga.planHash, withoutPolicy.saga.planHash, 'recovery policy must be frozen into the approved plan hash');

  const approved = await service.sagaApprove({ sagaId: preview.saga.id, approval: { signed: 'transaction' } });
  const uncertain = await service.sagaExecute({
    sagaId: preview.saga.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'execute-privileged-access'
  });
  assert.equal(uncertain.saga.state, 'RECONCILIATION_REQUIRED');

  await assert.rejects(
    () => service.sagaReconcile({
      sagaId: preview.saga.id,
      capabilityToken: approved.capability.token,
      idempotencyKey: 'execute-privileged-access'
    }),
    /PACT_SAGA_HUMAN_RECOVERY_REQUIRED/
  );
  assert.equal(reconcileCalls, 0, 'policy must fail before any provider reconciliation call');
  assert.equal(approvalCalls, 1, 'programmatic reconcile must not synthesize a recovery approval');

  const recovery = await service.sagaRecoveryInspect({ sagaId: preview.saga.id });
  assert.equal(recovery.recovery.humanRecoveryRequired, true);
  assert.deepEqual(recovery.recovery.allowedActions, ['reconcile']);

  const resolved = await service.sagaRecoveryResolve({
    sagaId: preview.saga.id,
    recoveryHash: recovery.recoveryHash,
    action: 'reconcile',
    approval: { signed: 'operator' },
    idempotencyKey: 'human-resolve-privileged-access'
  });
  assert.equal(resolved.saga.state, 'COMMITTED');
  assert.equal(resolved.recoveryDecision.claims.humanPrincipal, 'human:incident-operator');
  assert.equal(reconcileCalls, 1);
  assert.equal(approvalCalls, 2, 'human resolution must require a fresh recovery approval');
});

test('existing saga steps remain programmatically reconcilable when human recovery policy is absent', async () => {
  let committed = false;
  let reconcileCalls = 0;
  const service = createPactSagaAuthorityService({
    store: atomicStore(),
    handlers: {
      provider: {
        async execute() { committed = true; const error = new Error('LOST'); error.uncertain = true; throw error; },
        async verify() { return committed; },
        async reconcile() { reconcileCalls += 1; return 'committed'; }
      }
    },
    now: () => 20_000,
    verifyApproval: async () => ({ humanPrincipal: 'human:owner', agentSession: 'agent:legacy' })
  });
  const preview = await service.sagaPreview({
    steps: [{ id: 'legacy', handler: 'provider', resourceKey: 'legacy:1', atomicDomain: 'legacy', input: {} }]
  });
  const approved = await service.sagaApprove({ sagaId: preview.saga.id, approval: { signed: true } });
  await service.sagaExecute({ sagaId: preview.saga.id, capabilityToken: approved.capability.token, idempotencyKey: 'legacy-exec' });
  const reconciled = await service.sagaReconcile({ sagaId: preview.saga.id, capabilityToken: approved.capability.token, idempotencyKey: 'legacy-exec' });
  assert.equal(reconciled.saga.state, 'COMMITTED');
  assert.equal(reconcileCalls, 1);
});
