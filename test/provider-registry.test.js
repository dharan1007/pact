import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthorityStore } from '../src/authority.js';
import { createPactSagaAuthorityService } from '../src/saga-protocol.js';
import { createPactProviderRegistry } from '../src/provider-registry.js';

function providerHarness() {
  const providers = new Map([
    ['identity.example', { etag: '"identity-1"', resource: { account: { status: 'active', role: 'admin' } }, writes: 0 }],
    ['billing.example', { etag: '"billing-1"', resource: { subscription: { state: 'active', plan: 'pro' } }, writes: 0 }]
  ]);
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const provider = providers.get(parsed.hostname);
    assert.ok(provider, `unexpected provider ${parsed.hostname}`);
    const method = options.method ?? 'GET';
    if (method === 'GET') {
      return {
        ok: true,
        status: 200,
        headers: { get(name) { return String(name).toLowerCase() === 'etag' ? provider.etag : null; } },
        async text() { return JSON.stringify(provider.resource); }
      };
    }
    provider.writes += 1;
    assert.equal(options.headers['if-match'], provider.etag);
    assert.equal(typeof options.headers['idempotency-key'], 'string');
    provider.resource = JSON.parse(options.body);
    provider.etag = `"${parsed.hostname}-${provider.writes + 1}"`;
    return {
      ok: true,
      status: 200,
      headers: { get(name) { return String(name).toLowerCase() === 'etag' ? provider.etag : null; } },
      async text() { return JSON.stringify(provider.resource); }
    };
  };
  return { providers, fetchImpl };
}

function config() {
  return {
    version: 1,
    providers: [
      {
        id: 'identity.account',
        type: 'rest-json',
        baseUrl: 'https://identity.example',
        resourcePath: '/v1/accounts/42',
        resourceKey: 'identity:account:42',
        atomicDomain: 'identity/account/42',
        method: 'PUT',
        bearerTokenEnv: 'PACT_PROVIDER_IDENTITY_TOKEN',
        capabilities: { compensation: true, reversible: true }
      },
      {
        id: 'billing.subscription',
        type: 'rest-json',
        baseUrl: 'https://billing.example',
        resourcePath: '/v1/subscriptions/42',
        resourceKey: 'billing:subscription:42',
        atomicDomain: 'billing/subscription/42',
        method: 'PUT',
        capabilities: { compensation: false, reversible: false }
      }
    ]
  };
}

test('provider registry turns server-only configuration into isolated real-provider saga handlers with machine-readable guarantees', async () => {
  const store = new MemoryAuthorityStore();
  const { providers, fetchImpl } = providerHarness();
  const registry = createPactProviderRegistry({
    store,
    config: config(),
    env: { PACT_PROVIDER_IDENTITY_TOKEN: 'identity-secret' },
    fetchImpl
  });

  assert.deepEqual(Object.keys(registry.handlers).sort(), ['billing.subscription', 'identity.account']);
  assert.equal(registry.providers.length, 2);
  assert.equal(registry.providers[0].secretConfigured, true);
  assert.equal(registry.providers[0].capabilities.conditionalWrite, 'strong-etag');
  assert.equal(registry.providers[0].capabilities.idempotency, 'provider-key+durable-replay');
  assert.equal(registry.providers[0].capabilities.reconciliation, true);
  assert.equal(registry.providers[0].capabilities.compensation, true);
  assert.equal(registry.providers[1].capabilities.compensation, false);
  assert.equal(Object.prototype.hasOwnProperty.call(registry.providers[0], 'bearerToken'), false, 'public registry metadata must never expose credentials');

  const service = createPactSagaAuthorityService({
    store,
    handlers: registry.handlers,
    now: () => 2_000,
    verifyApproval: async () => ({ humanPrincipal: 'human:ops', agentSession: 'agent:ops' })
  });

  await assert.rejects(() => service.sagaPreview({ steps: [{
    id: 'unsafe-billing-rollback',
    handler: 'billing.subscription',
    resourceKey: 'billing:subscription:42',
    atomicDomain: 'billing/subscription/42',
    requirements: { compensation: true, reversible: true },
    input: { intent: { path: ['subscription', 'state'], value: 'paused' } }
  }] }), /PACT_SAGA_PROTOCOL_CAPABILITY_UNSATISFIED:compensation/);

  await assert.rejects(() => service.sagaPreview({ steps: [{
    id: 'wrong-domain',
    handler: 'identity.account',
    resourceKey: 'identity:account:42',
    atomicDomain: 'billing/subscription/42',
    input: { intent: { path: ['account', 'role'], value: 'read' } }
  }] }), /PACT_SAGA_PROTOCOL_ATOMIC_DOMAIN_MISMATCH/);

  const preview = await service.sagaPreview({ steps: [
    {
      id: 'lock-identity',
      handler: 'identity.account',
      resourceKey: 'identity:account:42',
      atomicDomain: 'identity/account/42',
      requirements: { conditionalWrite: true, idempotency: true, reconciliation: true, compensation: true, reversible: true, mutation: 'PUT' },
      input: { intent: { operations: [
        { path: ['account', 'status'], value: 'suspended' },
        { path: ['account', 'role'], value: 'read' }
      ] } }
    },
    {
      id: 'pause-billing',
      handler: 'billing.subscription',
      resourceKey: 'billing:subscription:42',
      atomicDomain: 'billing/subscription/42',
      requirements: { conditionalWrite: true, idempotency: true, reconciliation: true, mutation: 'PUT' },
      input: { intent: { path: ['subscription', 'state'], value: 'paused' } }
    }
  ] });
  const approved = await service.sagaApprove({ sagaId: preview.saga.id, approval: { signed: true } });
  const executed = await service.sagaExecute({
    sagaId: preview.saga.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'provider-registry-exec-1'
  });

  assert.equal(executed.saga.state, 'COMMITTED');
  assert.equal(providers.get('identity.example').writes, 1);
  assert.equal(providers.get('billing.example').writes, 1);
  assert.deepEqual(providers.get('identity.example').resource, { account: { status: 'suspended', role: 'read' } });
  assert.deepEqual(providers.get('billing.example').resource, { subscription: { state: 'paused', plan: 'pro' } });
});

test('provider registry rejects duplicate identities, missing credential references and unsupported guarantee claims before runtime creation', () => {
  const store = new MemoryAuthorityStore();
  const { fetchImpl } = providerHarness();
  const duplicate = config();
  duplicate.providers[1].id = duplicate.providers[0].id;
  assert.throws(() => createPactProviderRegistry({ store, config: duplicate, env: { PACT_PROVIDER_IDENTITY_TOKEN: 'x' }, fetchImpl }), /PACT_PROVIDER_REGISTRY_DUPLICATE_PROVIDER/);

  assert.throws(() => createPactProviderRegistry({ store, config: config(), env: {}, fetchImpl }), /PACT_PROVIDER_REGISTRY_SECRET_REQUIRED:PACT_PROVIDER_IDENTITY_TOKEN/);

  const impossible = config();
  impossible.providers[0].capabilities = { compensation: true, reversible: false };
  assert.throws(() => createPactProviderRegistry({ store, config: impossible, env: { PACT_PROVIDER_IDENTITY_TOKEN: 'x' }, fetchImpl }), /PACT_PROVIDER_REGISTRY_INVALID_REVERSIBILITY/);
});
