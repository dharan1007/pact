import test from 'node:test';
import assert from 'node:assert/strict';
import * as restModule from '../src/rest-resource.js';

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

function response(status, body, etag) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return String(name).toLowerCase() === 'etag' ? etag ?? null : null; } },
    async text() { return body == null ? '' : JSON.stringify(body); }
  };
}

function providerHarness() {
  let etag = '"r1"';
  let resource = { profile: { name: 'Ada' }, enabled: false };
  let writes = 0;
  let loseNextResponse = false;
  const requests = [];

  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? 'GET', headers: { ...(options.headers ?? {}) }, body: options.body });
    if ((options.method ?? 'GET') === 'GET') return response(200, resource, etag);
    writes += 1;
    const ifMatch = options.headers?.['if-match'];
    if (ifMatch !== etag) return response(412, { error: 'stale' }, etag);
    resource = JSON.parse(options.body);
    etag = `"r${Number(etag.replace(/\D/g, '')) + 1}"`;
    if (loseNextResponse) {
      loseNextResponse = false;
      throw new Error('NETWORK_RESPONSE_LOST');
    }
    return response(200, resource, etag);
  };

  return {
    fetchImpl,
    requests,
    writes: () => writes,
    current: () => ({ etag, resource: clone(resource) }),
    drift(next) { resource = clone(next); etag = `"r${Number(etag.replace(/\D/g, '')) + 1}"`; },
    loseResponseOnce() { loseNextResponse = true; }
  };
}

test('exports a real REST canonical bridge and JSON resource adapter', () => {
  assert.equal(typeof restModule.createPactRestResourceBridge, 'function');
  assert.equal(typeof restModule.createPactJsonResourceAdapter, 'function');
});

test('REST bridge initializes from provider ETag and turns out-of-band provider drift into a local canonical version change', async () => {
  const provider = providerHarness();
  const bridge = restModule.createPactRestResourceBridge({
    store: atomicStore(),
    key: 'account:42',
    baseUrl: 'https://api.example.test',
    resourcePath: '/v1/account/42',
    fetchImpl: provider.fetchImpl
  });

  assert.deepEqual(await bridge.read(), {
    version: 0,
    resource: { profile: { name: 'Ada' }, enabled: false }
  });

  provider.drift({ profile: { name: 'Grace' }, enabled: false });
  assert.deepEqual(await bridge.read(), {
    version: 1,
    resource: { profile: { name: 'Grace' }, enabled: false }
  });
});

test('REST bridge commits a real provider write with If-Match and Idempotency-Key and replays without another provider write', async () => {
  const provider = providerHarness();
  const bridge = restModule.createPactRestResourceBridge({
    store: atomicStore(), key: 'account:42', baseUrl: 'https://api.example.test', resourcePath: '/v1/account/42', fetchImpl: provider.fetchImpl
  });
  await bridge.read();
  const nextState = { version: 1, resource: { profile: { name: 'Maya' }, enabled: false } };
  const authorization = { authorizationId: 'pact_auth_1' };

  const committed = await bridge.commit({ expectedVersion: 0, nextState, authorization, idempotencyKey: 'pact_auth_1' });
  assert.deepEqual(committed, nextState);
  assert.equal(provider.writes(), 1);
  const write = provider.requests.find(entry => entry.method === 'PUT');
  assert.equal(write.headers['if-match'], '"r1"');
  assert.equal(write.headers['idempotency-key'], 'pact_auth_1');

  assert.deepEqual(await bridge.commit({ expectedVersion: 0, nextState, authorization, idempotencyKey: 'pact_auth_1' }), nextState);
  assert.equal(provider.writes(), 1);
});

test('REST bridge recovers a lost provider response by observing the new ETag and does not write twice', async () => {
  const provider = providerHarness();
  const bridge = restModule.createPactRestResourceBridge({
    store: atomicStore(), key: 'account:42', baseUrl: 'https://api.example.test', resourcePath: '/v1/account/42', fetchImpl: provider.fetchImpl
  });
  await bridge.read();
  const nextState = { version: 1, resource: { profile: { name: 'Ada' }, enabled: true } };
  const authorization = { authorizationId: 'pact_auth_2' };
  provider.loseResponseOnce();

  await assert.rejects(
    () => bridge.commit({ expectedVersion: 0, nextState, authorization, idempotencyKey: 'pact_auth_2' }),
    /PACT_REST_COMMIT_UNCERTAIN/
  );
  assert.equal(provider.writes(), 1);
  assert.deepEqual(await bridge.read(), nextState);
  assert.deepEqual(await bridge.commit({ expectedVersion: 0, nextState, authorization, idempotencyKey: 'pact_auth_2' }), nextState);
  assert.equal(provider.writes(), 1);
});

test('REST bridge refuses a stale write after out-of-band provider drift', async () => {
  const provider = providerHarness();
  const bridge = restModule.createPactRestResourceBridge({
    store: atomicStore(), key: 'account:42', baseUrl: 'https://api.example.test', resourcePath: '/v1/account/42', fetchImpl: provider.fetchImpl
  });
  await bridge.read();
  provider.drift({ profile: { name: 'Lin' }, enabled: false });

  await assert.rejects(
    () => bridge.commit({
      expectedVersion: 0,
      nextState: { version: 1, resource: { profile: { name: 'Ada' }, enabled: true } },
      authorization: { authorizationId: 'pact_auth_3' },
      idempotencyKey: 'pact_auth_3'
    }),
    /PACT_REST_STALE_PROVIDER_STATE/
  );
  assert.equal(provider.writes(), 0);
});

test('JSON resource adapter produces declarative nested effects and rejects prototype-pollution paths', async () => {
  const adapter = restModule.createPactJsonResourceAdapter({ id: 'account.profile', version: '1.0.0' });
  const state = { version: 7, resource: { profile: { name: 'Ada' } } };
  const plan = await adapter.plan({ intent: { path: ['profile', 'name'], value: 'Maya' }, state });
  assert.deepEqual(plan.effects, [{ path: 'resource.profile.name', before: 'Ada', after: 'Maya' }]);
  assert.equal(await adapter.verify({ intent: { path: ['profile', 'name'], value: 'Maya' }, state: { version: 8, resource: { profile: { name: 'Maya' } } } }), true);
  await assert.rejects(
    () => adapter.plan({ intent: { path: ['__proto__', 'polluted'], value: true }, state }),
    /PACT_REST_UNSAFE_PATH/
  );
});

test('REST bridge rejects insecure or cross-origin provider configuration and provider reads without ETag', async () => {
  assert.throws(() => restModule.createPactRestResourceBridge({
    store: atomicStore(), key: 'x', baseUrl: 'http://api.example.test', resourcePath: '/v1/x', fetchImpl: async () => response(200, {}, '"r1"')
  }), /PACT_REST_REQUIRES_HTTPS/);
  assert.throws(() => restModule.createPactRestResourceBridge({
    store: atomicStore(), key: 'x', baseUrl: 'https://api.example.test', resourcePath: 'https://evil.example/x', fetchImpl: async () => response(200, {}, '"r1"')
  }), /PACT_REST_CROSS_ORIGIN_RESOURCE/);

  const bridge = restModule.createPactRestResourceBridge({
    store: atomicStore(), key: 'x', baseUrl: 'https://api.example.test', resourcePath: '/v1/x', fetchImpl: async () => response(200, { ok: true }, null)
  });
  await assert.rejects(() => bridge.read(), /PACT_REST_ETAG_REQUIRED/);
});
