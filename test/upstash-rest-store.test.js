import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstashRestAtomicStore } from '../src/upstash-rest-store.js';

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const command = JSON.parse(init.body);
    calls.push({ url, init, command });
    const result = await handler(command, calls.length - 1);
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      async json() { return result.body; }
    };
  };
  return { fetchImpl, calls };
}

test('Upstash atomic store uses GET, SET NX, and one Lua EVAL CAS command', async () => {
  const { fetchImpl, calls } = mockFetch(async (command) => {
    if (command[0] === 'GET') return { body: { result: JSON.stringify({ version: 3, value: 'old' }) } };
    if (command[0] === 'SET') return { body: { result: 'OK' } };
    if (command[0] === 'EVAL') return { body: { result: 1 } };
    throw new Error('unexpected command');
  });
  const store = createUpstashRestAtomicStore({
    url: 'https://example.upstash.io',
    token: 'secret',
    fetchImpl
  });

  assert.deepEqual(await store.get('pact:key'), { version: 3, value: 'old' });
  assert.equal(await store.create('pact:key', { version: 0, value: 'new' }), true);
  assert.equal(await store.compareAndSwap('pact:key', 3, { version: 4, value: 'next' }), true);

  assert.deepEqual(calls[0].command, ['GET', 'pact:key']);
  assert.deepEqual(calls[1].command.slice(0, 2), ['SET', 'pact:key']);
  assert.equal(calls[1].command.at(-1), 'NX');
  assert.equal(calls[2].command[0], 'EVAL');
  assert.equal(calls[2].command[2], 1);
  assert.equal(calls[2].command[3], 'pact:key');
  assert.equal(calls[2].command[4], 3);
  assert.match(calls[2].command[1], /cjson\.decode/);
  assert.match(calls[2].command[1], /redis\.call\('SET'/);
  for (const call of calls) {
    assert.equal(call.url, 'https://example.upstash.io');
    assert.equal(call.init.headers.authorization, 'Bearer secret');
    assert.equal(call.init.headers['content-type'], 'application/json');
  }
});

test('Upstash atomic store maps NX/CAS misses to false and missing GET to null', async () => {
  const { fetchImpl } = mockFetch(async (command) => {
    if (command[0] === 'GET') return { body: { result: null } };
    if (command[0] === 'SET') return { body: { result: null } };
    if (command[0] === 'EVAL') return { body: { result: 0 } };
    throw new Error('unexpected command');
  });
  const store = createUpstashRestAtomicStore({ url: 'https://example.upstash.io/', token: 'secret', fetchImpl });
  assert.equal(await store.get('missing'), null);
  assert.equal(await store.create('k', { version: 0 }), false);
  assert.equal(await store.compareAndSwap('k', 0, { version: 1 }), false);
});

test('Upstash atomic store fails closed on insecure config, malformed records, and Redis errors', async () => {
  assert.throws(() => createUpstashRestAtomicStore({ url: 'http://example.upstash.io', token: 'secret', fetchImpl: fetch }), /PACT_UPSTASH_HTTPS_REQUIRED/);
  assert.throws(() => createUpstashRestAtomicStore({ url: 'https://example.upstash.io', token: '', fetchImpl: fetch }), /PACT_UPSTASH_TOKEN_REQUIRED/);

  const malformed = createUpstashRestAtomicStore({
    url: 'https://example.upstash.io', token: 'secret',
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { result: '{bad json' }; } })
  });
  await assert.rejects(() => malformed.get('k'), /PACT_UPSTASH_CORRUPT_JSON/);

  const redisError = createUpstashRestAtomicStore({
    url: 'https://example.upstash.io', token: 'secret',
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { error: 'ERR failure' }; } })
  });
  await assert.rejects(() => redisError.get('k'), /PACT_UPSTASH_COMMAND_FAILED/);
});
