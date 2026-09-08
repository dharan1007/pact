import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactRestResourceBridge } from '../src/rest-resource.js';

const clone = value => value === undefined ? undefined : structuredClone(value);

function versionOnlyCasStore() {
  const data = new Map();
  let sameVersionArrivals = 0;
  let releaseSameVersionWriters;
  const sameVersionGate = new Promise(resolve => {
    releaseSameVersionWriters = resolve;
  });

  return {
    async get(key) {
      return clone(data.get(key) ?? null);
    },
    async create(key, value) {
      if (data.has(key)) return false;
      data.set(key, clone(value));
      return true;
    },
    async compareAndSwap(key, expectedVersion, value) {
      const current = data.get(key);
      if (!current || current.version !== expectedVersion) return false;

      // The production Redis store accepts a CAS whenever current.version
      // equals expectedVersion. A metadata-only update that keeps version
      // unchanged therefore allows two writers to overwrite one another.
      // Force both such writers to arrive before either persists its value.
      if (value.version === expectedVersion) {
        sameVersionArrivals += 1;
        if (sameVersionArrivals === 2) releaseSameVersionWriters();
        await sameVersionGate;
      }

      const afterGate = data.get(key);
      if (!afterGate || afterGate.version !== expectedVersion) return false;
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

  return {
    async fetchImpl(_url, options = {}) {
      if ((options.method ?? 'GET') !== 'GET') {
        throw new Error('provider write should not be needed in this regression');
      }
      return response(200, resource, etag);
    },
    drift(next) {
      resource = clone(next);
      etag = `"r${Number(etag.replace(/\D/g, '')) + 1}"`;
    }
  };
}

test('concurrent recovered commits preserve every idempotency replay across later provider drift', async () => {
  const store = versionOnlyCasStore();
  const provider = providerHarness();
  const bridge = createPactRestResourceBridge({
    store,
    key: 'account:42',
    baseUrl: 'https://api.example.test',
    resourcePath: '/v1/account/42',
    fetchImpl: provider.fetchImpl
  });

  await bridge.read();

  const target = { profile: { name: 'Maya' }, enabled: false };
  provider.drift(target);
  assert.deepEqual(await bridge.read(), { version: 1, resource: target });

  const nextState = { version: 1, resource: target };
  const commit = idempotencyKey => bridge.commit({
    expectedVersion: 0,
    nextState,
    authorization: { authorizationId: idempotencyKey },
    idempotencyKey
  });

  await Promise.all([commit('pact_auth_a'), commit('pact_auth_b')]);

  // Once the provider moves on, only the durable replay ledger can prove both
  // already-resolved commits. Losing either replay turns its retry into stale.
  provider.drift({ profile: { name: 'Grace' }, enabled: false });

  assert.deepEqual(await commit('pact_auth_a'), nextState);
  assert.deepEqual(await commit('pact_auth_b'), nextState);
});
