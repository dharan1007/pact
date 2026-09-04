import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthorityStore } from '../src/authority.js';
import { createCanonicalStateRepository } from '../src/canonical-store.js';

function authorization(id = 'auth_1') {
  return { authorizationId: id, claims: { humanPrincipal: 'human:maya', agentSession: 'agent:7' } };
}

test('canonical repository initializes once and commits by atomic version CAS', async () => {
  const store = new MemoryAuthorityStore();
  const repoA = createCanonicalStateRepository({ store, key: 'playground', initialState: { version: 0, flags: { beta: false } } });
  const repoB = createCanonicalStateRepository({ store, key: 'playground', initialState: { version: 0, flags: { beta: false } } });

  assert.deepEqual(await repoA.read(), { version: 0, flags: { beta: false } });
  const committed = await repoA.commit({
    expectedVersion: 0,
    nextState: { version: 1, flags: { beta: true } },
    authorization: authorization('auth_1'),
    idempotencyKey: 'auth_1'
  });
  assert.deepEqual(committed, { version: 1, flags: { beta: true } });
  assert.deepEqual(await repoB.read(), committed);
});

test('canonical repository persistently replays the exact committed snapshot after restart and later writes', async () => {
  const store = new MemoryAuthorityStore();
  const repo = createCanonicalStateRepository({ store, key: 'playground', initialState: { version: 0, value: 'zero' } });
  await repo.read();
  const first = await repo.commit({ expectedVersion: 0, nextState: { version: 1, value: 'one' }, authorization: authorization('auth_1'), idempotencyKey: 'auth_1' });
  await repo.commit({ expectedVersion: 1, nextState: { version: 2, value: 'two' }, authorization: authorization('auth_2'), idempotencyKey: 'auth_2' });

  const restarted = createCanonicalStateRepository({ store, key: 'playground', initialState: { version: 0, value: 'ignored' } });
  const replay = await restarted.commit({ expectedVersion: 0, nextState: { version: 1, value: 'one' }, authorization: authorization('auth_1'), idempotencyKey: 'auth_1' });
  assert.deepEqual(replay, first);
  assert.deepEqual(await restarted.read(), { version: 2, value: 'two' });
});

test('canonical repository rejects stale writes and replay-key payload conflicts', async () => {
  const store = new MemoryAuthorityStore();
  const repo = createCanonicalStateRepository({ store, key: 'playground', initialState: { version: 0, value: 'zero' } });
  await repo.read();
  await repo.commit({ expectedVersion: 0, nextState: { version: 1, value: 'one' }, authorization: authorization('auth_1'), idempotencyKey: 'auth_1' });

  await assert.rejects(() => repo.commit({ expectedVersion: 0, nextState: { version: 1, value: 'different' }, authorization: authorization('auth_1'), idempotencyKey: 'auth_1' }), /PACT_CANONICAL_IDEMPOTENCY_CONFLICT/);
  await assert.rejects(() => repo.commit({ expectedVersion: 0, nextState: { version: 1, value: 'other' }, authorization: authorization('auth_2'), idempotencyKey: 'auth_2' }), /PACT_CANONICAL_STALE_VERSION/);
});

test('concurrent canonical commits permit one winner for a base version', async () => {
  const store = new MemoryAuthorityStore();
  const repoA = createCanonicalStateRepository({ store, key: 'playground', initialState: { version: 0, value: 'zero' } });
  const repoB = createCanonicalStateRepository({ store, key: 'playground', initialState: { version: 0, value: 'zero' } });
  await repoA.read();

  const settled = await Promise.allSettled([
    repoA.commit({ expectedVersion: 0, nextState: { version: 1, value: 'a' }, authorization: authorization('auth_a'), idempotencyKey: 'auth_a' }),
    repoB.commit({ expectedVersion: 0, nextState: { version: 1, value: 'b' }, authorization: authorization('auth_b'), idempotencyKey: 'auth_b' })
  ]);
  assert.equal(settled.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(x => x.status === 'rejected').length, 1);
  assert.equal((await repoA.read()).version, 1);
});