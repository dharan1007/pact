import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedisAuthorityStore } from '../src/redis-store.js';

function createFakeRedis() {
  const data = new Map();
  const calls = [];
  async function fetchImpl(_url, options) {
    const args = JSON.parse(options.body);
    calls.push(args);
    const [command, ...rest] = args;
    let result = null;
    if (command === 'GET') {
      result = data.get(rest[0]) ?? null;
    } else if (command === 'SET') {
      const [key, value, mode] = rest;
      if (mode === 'NX' && data.has(key)) result = null;
      else { data.set(key, value); result = 'OK'; }
    } else if (command === 'EVAL') {
      const [, keyCount, key, expectedVersion, nextJson] = rest;
      assert.equal(keyCount, '1');
      const current = data.get(key);
      if (!current) result = 0;
      else {
        const parsed = JSON.parse(current);
        if (parsed.version !== Number(expectedVersion)) result = 0;
        else { data.set(key, nextJson); result = 1; }
      }
    } else {
      throw new Error(`unexpected command ${command}`);
    }
    return { ok: true, status: 200, async json() { return { result }; } };
  }
  return { data, calls, fetchImpl };
}

test('Redis authority store requires HTTPS and credentials', () => {
  assert.throws(() => createRedisAuthorityStore({ url: 'http://redis.example', token: 'x', fetchImpl() {} }), /PACT_REDIS_REQUIRES_HTTPS/);
  assert.throws(() => createRedisAuthorityStore({ url: 'https://redis.example', token: '', fetchImpl() {} }), /PACT_REDIS_TOKEN_REQUIRED/);
});

test('Redis authority store supports durable get/create/CAS semantics', async () => {
  const fake = createFakeRedis();
  const store = createRedisAuthorityStore({ url: 'https://redis.example', token: 'secret', fetchImpl: fake.fetchImpl });
  assert.equal(await store.get('cap:a'), null);
  assert.equal(await store.create('cap:a', { version: 0, value: 'one' }), true);
  assert.equal(await store.create('cap:a', { version: 0, value: 'duplicate' }), false);
  assert.deepEqual(await store.get('cap:a'), { version: 0, value: 'one' });
  assert.equal(await store.compareAndSwap('cap:a', 0, { version: 1, value: 'two' }), true);
  assert.equal(await store.compareAndSwap('cap:a', 0, { version: 1, value: 'stale' }), false);
  assert.deepEqual(await store.get('cap:a'), { version: 1, value: 'two' });
});

test('concurrent CAS attempts permit one winner only', async () => {
  const fake = createFakeRedis();
  const storeA = createRedisAuthorityStore({ url: 'https://redis.example', token: 'secret', fetchImpl: fake.fetchImpl });
  const storeB = createRedisAuthorityStore({ url: 'https://redis.example', token: 'secret', fetchImpl: fake.fetchImpl });
  await storeA.create('cap:race', { version: 0, owner: null });
  const outcomes = await Promise.all([
    storeA.compareAndSwap('cap:race', 0, { version: 1, owner: 'a' }),
    storeB.compareAndSwap('cap:race', 0, { version: 1, owner: 'b' })
  ]);
  assert.deepEqual(outcomes.sort(), [false, true]);
  const final = await storeA.get('cap:race');
  assert.equal(final.version, 1);
  assert.ok(final.owner === 'a' || final.owner === 'b');
});

test('corrupt durable records fail closed', async () => {
  const fake = createFakeRedis();
  fake.data.set('pact:authority:bad', '{"version":"wrong"}');
  const store = createRedisAuthorityStore({ url: 'https://redis.example', token: 'secret', fetchImpl: fake.fetchImpl });
  await assert.rejects(() => store.get('bad'), /PACT_REDIS_CORRUPT_RECORD/);
});

test('store uses bearer auth and never places credentials in command payload', async () => {
  let seen;
  const fetchImpl = async (_url, options) => {
    seen = options;
    return { ok: true, status: 200, async json() { return { result: null }; } };
  };
  const store = createRedisAuthorityStore({ url: 'https://redis.example', token: 'top-secret', fetchImpl });
  await store.get('x');
  assert.equal(seen.headers.authorization, 'Bearer top-secret');
  assert.doesNotMatch(seen.body, /top-secret/);
});
