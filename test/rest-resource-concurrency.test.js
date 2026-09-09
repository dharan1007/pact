import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactRestResourceBridge } from '../src/rest-resource.js';

const clone = value => value === undefined ? undefined : structuredClone(value);

function strictMonotonicCasStore() {
  const data = new Map();
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
      if (!Number.isSafeInteger(value?.version) || value.version <= expectedVersion) {
        throw new Error('NON_ADVANCING_CAS');
      }
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

test('concurrent recovered commits preserve every idempotency replay while CAS revisions remain monotonic', async () => {
  const store = strictMonotonicCasStore();
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
  assert.deepEqual(await bridge.read(), nextState);

  // Once the provider moves on, only the durable replay ledger can prove both
  // already-resolved commits. Both keys must still replay without a write.
  provider.drift({ profile: { name: 'Grace' }, enabled: false });

  assert.deepEqual(await commit('pact_auth_a'), nextState);
  assert.deepEqual(await commit('pact_auth_b'), nextState);
});
