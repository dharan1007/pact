import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthorityStore } from '../src/authority.js';
import { createPactSagaAuthorityService } from '../src/saga-protocol.js';
import { createPactProviderRegistry } from '../src/provider-registry.js';

function fencedProviderHarness() {
  const state = {
    etag: '"v1"',
    resource: { account: { role: 'admin' } },
    highestFence: 0,
    writes: 0,
    observedFences: []
  };
  const fetchImpl = async (_url, options = {}) => {
    const method = options.method ?? 'GET';
    if (method === 'GET') {
      return {
        ok: true,
        status: 200,
        headers: { get(name) { return String(name).toLowerCase() === 'etag' ? state.etag : null; } },
        async text() { return JSON.stringify(state.resource); }
      };
    }
    const fence = Number(options.headers['x-pact-fence']);
    state.observedFences.push(fence);
    if (!Number.isSafeInteger(fence) || fence < 1) {
      return { ok: false, status: 400, headers: { get() { return null; } }, async text() { return ''; } };
    }
    if (fence < state.highestFence) {
      return { ok: false, status: 409, headers: { get() { return null; } }, async text() { return ''; } };
    }
    state.highestFence = Math.max(state.highestFence, fence);
    state.writes += 1;
    state.resource = JSON.parse(options.body);
    state.etag = `"v${state.writes + 1}"`;
    return {
      ok: true,
      status: 200,
      headers: { get(name) { return String(name).toLowerCase() === 'etag' ? state.etag : null; } },
      async text() { return JSON.stringify(state.resource); }
    };
  };
  return { state, fetchImpl };
}

function config({ remoteFencing = true } = {}) {
  return {
    version: 1,
    providers: [{
      id: 'identity.account',
      type: 'rest-json',
      baseUrl: 'https://identity.example',
      resourcePath: '/v1/accounts/42',
      resourceKey: 'identity:account:42',
      atomicDomain: 'identity/account/42',
      method: 'PUT',
      capabilities: {
        compensation: true,
        reversible: true,
        ...(remoteFencing ? { remoteFencing: { mode: 'monotonic-header', header: 'x-pact-fence' } } : {})
      }
    }]
  };
}

test('provider registry negotiates remote fencing and transports the saga generation to the provider mutation boundary', async () => {
  const store = new MemoryAuthorityStore();
  const { state, fetchImpl } = fencedProviderHarness();
  const registry = createPactProviderRegistry({ store, config: config(), env: {}, fetchImpl });
  assert.equal(registry.providers[0].capabilities.remoteFencing, 'monotonic-header');
  assert.equal(registry.providers[0].capabilities.fenceHeader, 'x-pact-fence');

  const service = createPactSagaAuthorityService({
    store,
    handlers: registry.handlers,
    now: () => 10_000,
    verifyApproval: async () => ({ humanPrincipal: 'human:ops', agentSession: 'agent:ops' })
  });
  const preview = await service.sagaPreview({ steps: [{
    id: 'reduce-role',
    handler: 'identity.account',
    resourceKey: 'identity:account:42',
    atomicDomain: 'identity/account/42',
    requirements: { conditionalWrite: true, idempotency: true, reconciliation: true, remoteFencing: true },
    input: { intent: { path: ['account', 'role'], value: 'read' } }
  }] });
  const approved = await service.sagaApprove({ sagaId: preview.saga.id, approval: { signed: true } });
  const executed = await service.sagaExecute({ sagaId: preview.saga.id, capabilityToken: approved.capability.token, idempotencyKey: 'remote-fence-exec' });

  assert.equal(executed.saga.state, 'COMMITTED');
  assert.equal(state.writes, 1);
  assert.deepEqual(state.observedFences, [1]);
});

test('remote fencing requirement fails closed when a provider does not declare provider-side stale-generation enforcement', async () => {
  const store = new MemoryAuthorityStore();
  const { fetchImpl } = fencedProviderHarness();
  const registry = createPactProviderRegistry({ store, config: config({ remoteFencing: false }), env: {}, fetchImpl });
  const service = createPactSagaAuthorityService({
    store,
    handlers: registry.handlers,
    now: () => 10_000,
    verifyApproval: async () => ({ humanPrincipal: 'human:ops', agentSession: 'agent:ops' })
  });

  await assert.rejects(() => service.sagaPreview({ steps: [{
    id: 'requires-remote-fence',
    handler: 'identity.account',
    resourceKey: 'identity:account:42',
    atomicDomain: 'identity/account/42',
    requirements: { remoteFencing: true },
    input: { intent: { path: ['account', 'role'], value: 'read' } }
  }] }), /PACT_SAGA_PROTOCOL_CAPABILITY_UNSATISFIED:remoteFencing/);
});
