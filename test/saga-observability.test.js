import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactSagaTelemetry } from '../src/saga-observability.js';

test('saga telemetry emits bounded structured events without leaking approval, capability, bearer, or authorization secrets', async () => {
  const captured = [];
  const telemetry = createPactSagaTelemetry({
    sink: async event => captured.push(event),
    now: () => 50_000,
    reconciliationSlaMs: 30_000
  });

  const delivered = await telemetry.emit({
    type: 'SAGA_STEP_STARTED',
    sagaId: 'saga-1',
    stepId: 'identity',
    handler: 'identity.account',
    providerLatencyMs: 12,
    approval: { signature: 'approval-secret' },
    capabilityToken: 'pact_cap_super_secret',
    authorization: { token: 'auth-secret', authorizationId: 'auth-id-safe' },
    provider: { bearerToken: 'provider-secret', resourceKey: 'identity:42' },
    nested: { accessToken: 'nested-secret', safe: 'visible' }
  });

  assert.deepEqual(delivered, { delivered: true });
  assert.equal(captured.length, 1);
  const encoded = JSON.stringify(captured[0]);
  for (const forbidden of ['approval-secret', 'pact_cap_super_secret', 'auth-secret', 'provider-secret', 'nested-secret']) {
    assert.equal(encoded.includes(forbidden), false, `telemetry leaked ${forbidden}`);
  }
  assert.equal(captured[0].type, 'SAGA_STEP_STARTED');
  assert.equal(captured[0].sagaId, 'saga-1');
  assert.equal(captured[0].authorization.authorizationId, 'auth-id-safe');
  assert.equal(captured[0].provider.resourceKey, 'identity:42');
  assert.equal(captured[0].nested.safe, 'visible');
  assert.equal(captured[0].at, 50_000);
});

test('operational status exposes lease, takeover, uncertainty age, compensation attempts, and SLA attention without mutating saga state', () => {
  const telemetry = createPactSagaTelemetry({
    sink: async () => {},
    now: () => 100_000,
    reconciliationSlaMs: 30_000
  });
  const saga = {
    sagaId: 'saga-ops',
    state: 'RECONCILIATION_REQUIRED',
    createdAt: 10_000,
    updatedAt: 60_000,
    leaseGeneration: 4,
    lease: { ownerId: 'worker-b', generation: 4, expiresAt: 110_000 },
    steps: [
      { id: 'one', handler: 'identity', state: 'COMMITTED', compensationAttempts: 1 },
      { id: 'two', handler: 'billing', state: 'UNCERTAIN', compensationAttempts: 2, executionFence: { generation: 3 } }
    ]
  };
  const before = structuredClone(saga);

  const status = telemetry.deriveOperationalStatus(saga);
  assert.equal(status.sagaAgeMs, 90_000);
  assert.equal(status.currentStep.id, 'two');
  assert.equal(status.currentStep.handler, 'billing');
  assert.equal(status.lease.ownerId, 'worker-b');
  assert.equal(status.lease.generation, 4);
  assert.equal(status.lease.remainingMs, 10_000);
  assert.equal(status.takeoverCount, 3);
  assert.equal(status.reconciliationAgeMs, 40_000);
  assert.equal(status.compensationAttempts, 3);
  assert.equal(status.attentionRequired, true);
  assert.deepEqual(saga, before, 'deriving operational status must never mutate durable saga state');
});

test('telemetry sink failure is explicit but cannot change transaction semantics by throwing through emit', async () => {
  const telemetry = createPactSagaTelemetry({
    sink: async () => { throw new Error('collector unavailable'); },
    now: () => 5,
    reconciliationSlaMs: 10_000
  });
  assert.deepEqual(await telemetry.emit({ type: 'SAGA_CREATED', sagaId: 's1' }), {
    delivered: false,
    errorCode: 'PACT_SAGA_TELEMETRY_SINK_FAILED'
  });
});
