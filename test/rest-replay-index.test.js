import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactRestResourceBridge } from '../src/rest-resource.js';

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
    },
    snapshot() { return new Map([...data.entries()].map(([key, value]) => [key, clone(value)])); }
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
  let revision = 1;
  let resource = { counter: 0 };
  let writes = 0;
  return {
    async fetchImpl(_url, options = {}) {
      if ((options.method ?? 'GET') === 'GET') return response(200, resource, `\"r${revision}\"`);
      const ifMatch = options.headers?.['if-match'];
      if (ifMatch !== `\"r${revision}\"`) return response(412, { error: 'stale' }, `\"r${revision}\"`);
      writes += 1;
      resource = JSON.parse(options.body);
      revision += 1;
      return response(200, resource, `\"r${revision}\"`);
    },
    writes() { return writes; }
  };
}

test('REST replay evidence is durable without unbounded growth of the hot resource CAS record', async () => {
  const store = atomicStore();
  const provider = providerHarness();
  const bridge = createPactRestResourceBridge({
    store,
    key: 'high-volume-account',
    baseUrl: 'https://api.example.test',
    resourcePath: '/v1/account/42',
    fetchImpl: provider.fetchImpl
  });

  await bridge.read();
  const commits = 96;
  for (let index = 0; index < commits; index += 1) {
    const nextState = { version: index + 1, resource: { counter: index + 1 } };
    const authorization = { authorizationId: `auth-${index}` };
    assert.deepEqual(await bridge.commit({
      expectedVersion: index,
      nextState,
      authorization,
      idempotencyKey: `auth-${index}`
    }), nextState);
  }

  const snapshot = store.snapshot();
  const hot = snapshot.get('rest:high-volume-account');
  assert.ok(hot, 'canonical resource record must remain durable');
  assert.ok(Array.isArray(hot.replays), 'legacy replay field remains readable during migration');
  assert.equal(hot.replays.length, 0, 'new replay evidence must not accumulate in the hot CAS record');

  const replayRecords = [...snapshot.keys()].filter(key => key.startsWith('rest-replay:high-volume-account:'));
  assert.equal(replayRecords.length, commits, 'every idempotency decision remains durably replayable outside the hot record');

  const writesBeforeReplay = provider.writes();
  assert.deepEqual(await bridge.commit({
    expectedVersion: 0,
    nextState: { version: 1, resource: { counter: 1 } },
    authorization: { authorizationId: 'auth-0' },
    idempotencyKey: 'auth-0'
  }), { version: 1, resource: { counter: 1 } });
  assert.equal(provider.writes(), writesBeforeReplay, 'old replay must not trigger another provider mutation');
});

test('legacy inline replay evidence migrates to the detached replay index without weakening replay semantics', async () => {
  const store = atomicStore();
  const provider = providerHarness();
  await store.create('rest:legacy-account', {
    version: 1,
    canonicalVersion: 1,
    etag: '\"r1\"',
    resource: { counter: 0 },
    replays: [{
      key: 'legacy-auth',
      payloadHash: 'legacy-payload-hash',
      snapshot: { version: 1, resource: { counter: 1 } }
    }]
  });

  const bridge = createPactRestResourceBridge({
    store,
    key: 'legacy-account',
    baseUrl: 'https://api.example.test',
    resourcePath: '/v1/account/42',
    fetchImpl: provider.fetchImpl
  });

  await bridge.read();
  const snapshot = store.snapshot();
  assert.equal(snapshot.get('rest:legacy-account').replays.length, 0);
  assert.equal([...snapshot.keys()].filter(key => key.startsWith('rest-replay:legacy-account:')).length, 1);
});
