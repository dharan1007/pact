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

test('saga authority exposes operational status and emits secret-safe lifecycle events', async () => {
  let clock = 1_000;
  const events = [];
  const service = createPactSagaAuthorityService({
    store: atomicStore(),
    handlers: {
      provider: {
        async execute() {
          const error = new Error('NETWORK_RESPONSE_LOST');
          error.uncertain = true;
          throw error;
        },
        async verify() { return false; },
        async reconcile() { return 'uncertain'; }
      }
    },
    now: () => clock,
    reconciliationSlaMs: 5_000,
    telemetrySink: async event => events.push(event),
    verifyApproval: async () => ({ humanPrincipal: 'human:ops', agentSession: 'agent:ops' })
  });

  const preview = await service.sagaPreview({
    steps: [{ id: 'access', handler: 'provider', resourceKey: 'access:1', atomicDomain: 'access', input: { secret: 'input-secret' } }]
  });
  const approved = await service.sagaApprove({
    sagaId: preview.saga.id,
    approval: { signed: true, signature: 'approval-secret' }
  });
  const executed = await service.sagaExecute({
    sagaId: preview.saga.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'exec-observability'
  });
  assert.equal(executed.saga.state, 'RECONCILIATION_REQUIRED');

  clock = 8_000;
  const inspected = await service.sagaInspect({ sagaId: preview.saga.id });
  assert.equal(inspected.saga.operational.attentionRequired, true);
  assert.equal(inspected.saga.operational.reconciliationAgeMs >= 5_000, true);
  assert.equal(inspected.saga.operational.currentStep.id, 'access');
  assert.equal(inspected.saga.operational.takeoverCount >= 0, true);

  const recovery = await service.sagaRecoveryInspect({ sagaId: preview.saga.id });
  assert.equal(recovery.recovery.operational.attentionRequired, true);
  assert.equal(recovery.recovery.operational.currentStep.id, 'access');

  assert.equal(events.some(event => event.type === 'SAGA_APPROVED'), true);
  assert.equal(events.some(event => event.type === 'SAGA_EXECUTION_AUTHORIZED'), true);
  assert.equal(events.some(event => event.type === 'SAGA_RECONCILIATION_REQUIRED'), true);

  const encoded = JSON.stringify(events);
  assert.equal(encoded.includes('approval-secret'), false);
  assert.equal(encoded.includes(approved.capability.token), false);
});
