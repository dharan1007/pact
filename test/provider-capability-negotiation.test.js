import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthorityStore } from '../src/authority.js';
import { createPactProviderQualifier } from '../src/provider-qualification.js';
import { createPactProviderRegistry } from '../src/provider-registry.js';
import { createPactSagaAuthorityService } from '../src/saga-protocol.js';

function response(status, body, etag = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return String(name).toLowerCase() === 'etag' ? etag : null; } },
    async text() { return JSON.stringify(body); }
  };
}

function registryConfig() {
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
        conditionalWrite: 'strong-validator',
        remoteFencing: { mode: 'monotonic-header', header: 'x-pact-fence' },
        compensation: false,
        reversible: false
      }
    }]
  };
}

function fetchHarness() {
  let etag = '"r1"';
  let resource = { account: { role: 'admin' } };
  return async (_url, options = {}) => {
    if ((options.method ?? 'GET') === 'GET') return response(200, resource, etag);
    resource = JSON.parse(options.body);
    etag = '"r2"';
    return response(200, resource, etag);
  };
}

async function qualifyAll(store) {
  const qualifier = createPactProviderQualifier({ store, now: () => 1000 });
  const provider = { id: 'identity.account', resourceKey: 'identity:account:42', atomicDomain: 'identity/account/42' };
  let revision = 1;
  let state = { marker: 'before' };
  await qualifier.qualifyConditionalWrite({
    provider,
    probe: {
      async read() { return { revision: `r${revision}`, state }; },
      async advance() { revision = 2; state = { marker: 'qualified' }; return { revision: 'r2', state }; },
      async attemptStaleWrite() { return { accepted: false, status: 412 }; }
    }
  });
  let highestFence = 0;
  let fenced = { generation: 0 };
  await qualifier.qualifyRemoteFencing({
    provider,
    generation: 11,
    probe: {
      async apply({ generation }) {
        if (generation <= highestFence) return { accepted: false, status: 409 };
        highestFence = generation;
        fenced = { generation };
        return { accepted: true, status: 200 };
      },
      async read() { return { revision: `f${highestFence}`, state: fenced }; }
    }
  });
}

test('provider capability discovery distinguishes local enforcement from durable provider verification', async () => {
  const store = new MemoryAuthorityStore();
  const registry = createPactProviderRegistry({ store, config: registryConfig(), fetchImpl: fetchHarness() });

  assert.equal(typeof registry.handlers['identity.account'].getCapabilities, 'function');
  let capabilities = await registry.handlers['identity.account'].getCapabilities();
  assert.equal(capabilities.qualification.conditionalWrite, 'locally-enforced');
  assert.equal(capabilities.qualification.remoteFencing, 'declared');

  await qualifyAll(store);
  capabilities = await registry.handlers['identity.account'].getCapabilities();
  assert.equal(capabilities.qualification.conditionalWrite, 'provider-verified');
  assert.equal(capabilities.qualification.remoteFencing, 'provider-verified');

  const providers = await registry.inspectProviders();
  assert.equal(providers[0].capabilities.qualification.conditionalWrite, 'provider-verified');
  assert.equal(providers[0].capabilities.qualification.remoteFencing, 'provider-verified');
});

test('saga preview fails before approval unless requested provider guarantee strength is currently satisfied', async () => {
  const store = new MemoryAuthorityStore();
  const registry = createPactProviderRegistry({ store, config: registryConfig(), fetchImpl: fetchHarness() });
  const service = createPactSagaAuthorityService({
    store,
    handlers: registry.handlers,
    now: () => 2000,
    verifyApproval: async () => ({ humanPrincipal: 'human:ops', agentSession: 'agent:ops' })
  });
  const step = {
    id: 'change-role',
    handler: 'identity.account',
    resourceKey: 'identity:account:42',
    atomicDomain: 'identity/account/42',
    requirements: {
      conditionalWrite: true,
      conditionalWriteStrength: 'provider-verified',
      remoteFencing: true,
      remoteFencingStrength: 'provider-verified'
    },
    input: { intent: { path: ['account', 'role'], value: 'read' } }
  };

  await assert.rejects(() => service.sagaPreview({ steps: [step] }), /PACT_SAGA_PROTOCOL_CAPABILITY_UNSATISFIED:conditionalWriteStrength/);
  await qualifyAll(store);
  const preview = await service.sagaPreview({ steps: [step] });
  assert.equal(preview.saga.steps[0].requirements.conditionalWriteStrength, 'provider-verified');
  assert.equal(preview.saga.steps[0].requirements.remoteFencingStrength, 'provider-verified');

  const weaker = structuredClone(step);
  weaker.requirements.conditionalWriteStrength = 'strong-validator';
  const weakerPreview = await service.sagaPreview({ steps: [weaker] });
  assert.notEqual(weakerPreview.saga.planHash, preview.saga.planHash, 'changing guarantee strength must change the frozen approved plan');
});
