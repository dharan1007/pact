import test from 'node:test';
import assert from 'node:assert/strict';
import * as httpModule from '../src/http.js';

const { createPactHttpConnector } = httpModule;

test('HTTP connector requires HTTPS outside localhost', () => {
  assert.throws(() => createPactHttpConnector({ baseUrl: 'http://example.com', fetchImpl: async () => {} }), /PACT_HTTP_REQUIRES_HTTPS/);
  assert.doesNotThrow(() => createPactHttpConnector({ baseUrl: 'http://localhost:3000', fetchImpl: async () => {} }));
});

test('HTTP connector sends stable operation envelope and idempotency key', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, transaction: { id: 'tx_1' } }) };
  };
  const connector = createPactHttpConnector({ baseUrl: 'https://pact.example/', fetchImpl });
  const out = await connector.commit({ txId: 'tx_1' }, 'tx_1');
  assert.equal(out.ok, true);
  assert.equal(calls[0].url, 'https://pact.example/api/pact');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.headers['idempotency-key'], 'tx_1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { operation: 'commit', payload: { txId: 'tx_1' } });
});

test('HTTP connector rejects consequential operations without a non-empty idempotency key before network I/O', async () => {
  let calls = 0;
  const connector = createPactHttpConnector({
    baseUrl: 'https://pact.example',
    fetchImpl: async () => { calls++; return { ok: true, status: 200, text: async () => '{}' }; }
  });
  await assert.rejects(() => connector.commit({ txId: 'tx_1' }), /PACT_HTTP_IDEMPOTENCY_KEY_REQUIRED/);
  await assert.rejects(() => connector.rollback({ txId: 'tx_1' }, '   '), /PACT_HTTP_IDEMPOTENCY_KEY_REQUIRED/);
  assert.equal(calls, 0);
});

test('HTTP connector rejects invalid operation names before network I/O', async () => {
  let calls = 0;
  const connector = createPactHttpConnector({ baseUrl: 'https://pact.example', fetchImpl: async () => { calls++; } });
  await assert.rejects(() => connector.request('../admin', {}), /PACT_HTTP_INVALID_OPERATION/);
  assert.equal(calls, 0);
});

test('HTTP connector surfaces structured HTTP failures', async () => {
  const connector = createPactHttpConnector({
    baseUrl: 'https://pact.example',
    fetchImpl: async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ error: { code: 'STALE_PLAN' } }) })
  });
  await assert.rejects(async () => {
    try { await connector.commit({ txId: 'tx_1' }, 'commit:tx_1'); }
    catch (error) { assert.equal(error.status, 409); throw error; }
  }, /STALE_PLAN/);
});

test('HTTP connector fails closed on non-object success bodies', async () => {
  const connector = createPactHttpConnector({
    baseUrl: 'https://pact.example',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'null' })
  });
  await assert.rejects(() => connector.inspect({}), /PACT_HTTP_INVALID_RESPONSE/);
});

test('HTTP connector propagates caller cancellation without misreporting it as a timeout', async () => {
  const caller = new AbortController();
  const connector = createPactHttpConnector({
    baseUrl: 'https://pact.example',
    timeoutMs: 10_000,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    })
  });

  const pending = connector.request('inspect', {}, { signal: caller.signal });
  caller.abort(new Error('user cancelled'));

  await assert.rejects(pending, error => {
    assert.equal(error.message, 'PACT_HTTP_ABORTED');
    assert.equal(error.cause?.message, 'user cancelled');
    return true;
  });
});

test('HTTP connector keeps timeout failures distinct from caller cancellation', async () => {
  const connector = createPactHttpConnector({
    baseUrl: 'https://pact.example',
    timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    })
  });

  await assert.rejects(connector.inspect({}), /PACT_HTTP_TIMEOUT/);
});

test('exports a secure REST integration for real external systems', () => {
  assert.equal(typeof httpModule.createPactRestIntegration, 'function');
});

test('REST integration binds remote reads and writes to revision plus idempotency', async () => {
  const calls = [];
  const responses = [
    {
      ok: true,
      status: 200,
      headers: { get: name => name.toLowerCase() === 'etag' ? '"7"' : null },
      text: async () => JSON.stringify({ projects: { helios: { owner: 'ada' } }, billing: { plan: 'pro' } })
    },
    {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ requestId: 'provider_123' })
    }
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responses.shift();
  };
  const integration = httpModule.createPactRestIntegration({
    id: 'projects.rest',
    version: '1.0.0',
    baseUrl: 'https://api.example',
    fetchImpl,
    headers: { authorization: 'Bearer server-secret' },
    resourcePath: ({ intent }) => `/projects/${intent.projectId}`,
    plan: async ({ intent, state }) => ({
      effects: [{ path: 'projects.helios.owner', before: state.projects.helios.owner, after: intent.newOwner }],
      invariants: [{ path: 'billing.plan', equals: state.billing.plan }]
    }),
    buildApply: ({ plan }) => ({ method: 'PATCH', body: { owner: plan.effects[0].after } }),
    verify: async ({ state, plan }) => state.projects.helios.owner === plan.effects[0].after
  });

  const snapshot = await integration.read({ intent: { projectId: 'helios' } });
  assert.equal(snapshot.revision, '"7"');
  assert.equal(snapshot.state.projects.helios.owner, 'ada');
  await integration.apply({
    intent: { projectId: 'helios' },
    state: snapshot.state,
    revision: snapshot.revision,
    plan: { effects: [{ path: 'projects.helios.owner', before: 'ada', after: 'maya' }], invariants: [] },
    approvalClaims: { humanPrincipal: 'user:1', agentSession: 'agent:1' },
    transaction: { id: 'tx_1', planHash: 'hash', baseRevision: '"7"' },
    idempotencyKey: 'commit:helios'
  });

  assert.equal(calls[0].url, 'https://api.example/projects/helios');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].url, 'https://api.example/projects/helios');
  assert.equal(calls[1].init.method, 'PATCH');
  assert.equal(calls[1].init.headers['if-match'], '"7"');
  assert.equal(calls[1].init.headers['idempotency-key'], 'commit:helios');
  assert.equal(calls[1].init.headers.authorization, 'Bearer server-secret');
  assert.deepEqual(JSON.parse(calls[1].init.body), { owner: 'maya' });
});

test('REST integration rejects insecure origins and cross-origin resource paths before I/O', async () => {
  assert.throws(() => httpModule.createPactRestIntegration({
    id: 'unsafe.rest', version: '1.0.0', baseUrl: 'http://api.example', fetchImpl: async () => {},
    resourcePath: () => '/x', plan: async () => ({ effects: [], invariants: [] }), buildApply: () => ({ method: 'PATCH' }), verify: async () => true
  }), /PACT_HTTP_REQUIRES_HTTPS/);

  let calls = 0;
  const integration = httpModule.createPactRestIntegration({
    id: 'safe.rest', version: '1.0.0', baseUrl: 'https://api.example', fetchImpl: async () => { calls++; },
    resourcePath: () => 'https://evil.example/steal', plan: async () => ({ effects: [], invariants: [] }), buildApply: () => ({ method: 'PATCH' }), verify: async () => true
  });
  await assert.rejects(() => integration.read({ intent: {} }), /PACT_REST_INVALID_RESOURCE_PATH/);
  assert.equal(calls, 0);
});
