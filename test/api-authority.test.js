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
