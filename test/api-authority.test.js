import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthorityStore } from '../src/authority.js';
import { createPactApiAuthorityService } from '../src/api-authority.js';

function verifier({ approval }) {
  if (approval !== 'signed-ok') return false;
  return { humanPrincipal: 'human:maya', agentSession: 'agent:session-7' };
}

const adapter = {
  id: 'example.flags',
  version: '1.0.0',
  async plan({ intent, state }) {
    return {
      effects: [{ path: `flags.${intent.key}`, before: state.flags[intent.key], after: intent.value }],
      invariants: [{ path: 'tenant.id', equals: state.tenant.id }],
      metadata: { operation: 'set_flag' }
    };
  },
  async verify({ state, plan }) {
    return plan.effects.every(effect => effect.path.split('.').reduce((node, key) => node?.[key], state) === effect.after);
  }
};

function makeService() {
  const canonical = { version: 4, tenant: { id: 'acme' }, flags: { beta: false } };
  const writes = [];
  const store = new MemoryAuthorityStore();
  const service = createPactApiAuthorityService({
    store,
    verifyApproval: verifier,
    adapters: [adapter],
    readCanonical: async () => structuredClone(canonical),
    commitCanonical: async ({ expectedVersion, nextState, authorization }) => {
      assert.equal(expectedVersion, canonical.version);
      assert.equal(authorization.claims.humanPrincipal, 'human:maya');
      Object.keys(canonical).forEach(key => delete canonical[key]);
      Object.assign(canonical, structuredClone(nextState));
      writes.push(structuredClone(authorization));
      return structuredClone(canonical);
    },
    now: () => 10_000
  });
  return { service, canonical, writes };
}

function makeRecoverableHarness() {
  const canonical = { version: 4, tenant: { id: 'acme' }, flags: { beta: false } };
  const store = new MemoryAuthorityStore();
  const committedByAuthorization = new Map();
  let physicalWrites = 0;
  let crashAfterFirstWrite = false;

  const readCanonical = async () => structuredClone(canonical);
  const commitCanonical = async ({ expectedVersion, nextState, authorization, idempotencyKey }) => {
    assert.equal(idempotencyKey, authorization.authorizationId);
    const previous = committedByAuthorization.get(idempotencyKey);
    if (previous) return structuredClone(previous);
    if (canonical.version !== expectedVersion) throw new Error('PACT_API_STALE_CANONICAL_STATE');

    Object.keys(canonical).forEach(key => delete canonical[key]);
    Object.assign(canonical, structuredClone(nextState));
    physicalWrites += 1;
    committedByAuthorization.set(idempotencyKey, structuredClone(canonical));

    if (crashAfterFirstWrite) {
      crashAfterFirstWrite = false;
      throw new Error('SIMULATED_CRASH_AFTER_CANONICAL_WRITE');
    }
    return structuredClone(canonical);
  };

  const createService = () => createPactApiAuthorityService({
    store,
    verifyApproval: verifier,
    adapters: [adapter],
    readCanonical,
    commitCanonical,
    now: () => 10_000
  });

  return {
    canonical,
    createService,
    get physicalWrites() { return physicalWrites; },
    crashOnNextWrite() { crashAfterFirstWrite = true; }
  };
}

test('canonical API binds preview, signed approval and single-use commit authority', async () => {
  const { service, canonical, writes } = makeService();
  const preview = await service.preview({
    adapter: { id: 'example.flags', version: '1.0.0' },
    intent: { key: 'beta', value: true }
  });
  assert.equal(preview.transaction.state, 'PREVIEWED');
  assert.equal(preview.transaction.baseVersion, 4);
  assert.match(preview.transaction.planHash, /^[a-f0-9]{64}$/);

  const approved = await service.approve({ transactionId: preview.transaction.id, approval: 'signed-ok' });
  assert.equal(approved.transaction.state, 'APPROVED');
  assert.match(approved.capability.token, /^pact_cap_/);
  assert.deepEqual(approved.capability.claims, { humanPrincipal: 'human:maya', agentSession: 'agent:session-7' });

  const committed = await service.commit({
    transactionId: preview.transaction.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'commit-1'
  });
  assert.equal(committed.transaction.state, 'COMMITTED');
  assert.equal(committed.transaction.commitVersion, 5);
  assert.equal(canonical.flags.beta, true);
  assert.equal(writes.length, 1);

  const replay = await service.commit({
    transactionId: preview.transaction.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'commit-1'
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.transaction.commitVersion, 5);
  assert.equal(writes.length, 1);

  await assert.rejects(() => service.commit({
    transactionId: preview.transaction.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'commit-2'
  }), /PACT_AUTHORITY_CAPABILITY_ALREADY_CONSUMED|PACT_API_IDEMPOTENCY_CONFLICT/);
});

test('canonical API fails closed on stale canonical state before commit', async () => {
  const { service, canonical, writes } = makeService();
  const preview = await service.preview({
    adapter: { id: 'example.flags', version: '1.0.0' },
    intent: { key: 'beta', value: true }
  });
  const approved = await service.approve({ transactionId: preview.transaction.id, approval: 'signed-ok' });
  canonical.version = 5;

  await assert.rejects(() => service.commit({
    transactionId: preview.transaction.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'stale-1'
  }), /PACT_API_STALE_CANONICAL_STATE/);
  assert.equal(writes.length, 0);
});

test('canonical API rejects unknown adapters, invalid approvals and mismatched capability bindings', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.preview({
    adapter: { id: 'unknown', version: '1.0.0' },
    intent: { key: 'beta', value: true }
  }), /PACT_API_ADAPTER_NOT_REGISTERED/);

  const preview = await service.preview({
    adapter: { id: 'example.flags', version: '1.0.0' },
    intent: { key: 'beta', value: true }
  });
  await assert.rejects(() => service.approve({ transactionId: preview.transaction.id, approval: 'bad' }), /PACT_AUTHORITY_APPROVAL_REJECTED/);
});

test('canonical API recovers after a crash occurring after canonical write but before journal completion', async () => {
  const harness = makeRecoverableHarness();
  const firstService = harness.createService();
  const preview = await firstService.preview({
    adapter: { id: 'example.flags', version: '1.0.0' },
    intent: { key: 'beta', value: true }
  });
  const approved = await firstService.approve({ transactionId: preview.transaction.id, approval: 'signed-ok' });

  harness.crashOnNextWrite();
  await assert.rejects(() => firstService.commit({
    transactionId: preview.transaction.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'crash-recovery-1'
  }), /SIMULATED_CRASH_AFTER_CANONICAL_WRITE/);

  assert.equal(harness.canonical.version, 5);
  assert.equal(harness.canonical.flags.beta, true);
  assert.equal(harness.physicalWrites, 1);
  assert.equal((await firstService.inspect({ transactionId: preview.transaction.id })).transaction.state, 'COMMIT_AUTHORIZED');

  const restartedService = harness.createService();
  const recovered = await restartedService.commit({
    transactionId: preview.transaction.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'crash-recovery-1'
  });

  assert.equal(recovered.transaction.state, 'COMMITTED');
  assert.equal(recovered.transaction.commitVersion, 5);
  assert.equal(harness.physicalWrites, 1);
  assert.equal((await restartedService.inspect({ transactionId: preview.transaction.id })).transaction.state, 'COMMITTED');
});

test('concurrent retries with the same commit key converge to one canonical write', async () => {
  const harness = makeRecoverableHarness();
  const serviceA = harness.createService();
  const serviceB = harness.createService();
  const preview = await serviceA.preview({
    adapter: { id: 'example.flags', version: '1.0.0' },
    intent: { key: 'beta', value: true }
  });
  const approved = await serviceA.approve({ transactionId: preview.transaction.id, approval: 'signed-ok' });

  const [left, right] = await Promise.all([
    serviceA.commit({
      transactionId: preview.transaction.id,
      capabilityToken: approved.capability.token,
      idempotencyKey: 'race-same-key'
    }),
    serviceB.commit({
      transactionId: preview.transaction.id,
      capabilityToken: approved.capability.token,
      idempotencyKey: 'race-same-key'
    })
  ]);

  assert.equal(left.transaction.state, 'COMMITTED');
  assert.equal(right.transaction.state, 'COMMITTED');
  assert.equal(left.transaction.commitVersion, 5);
  assert.equal(right.transaction.commitVersion, 5);
  assert.equal(harness.physicalWrites, 1);
});