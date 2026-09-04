import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthorityStore } from '../src/authority.js';
import { createPactDurableStateStore } from '../src/durable-state.js';

const base = () => ({
  canonical: { version: 7, account: { owner: 'alice' } },
  transaction: { id: 'tx_1', state: 'PREVIEWED', planHash: 'plan_abc', baseVersion: 7 },
  receipt: null
});

test('durable state persists a journaled transition and survives store recreation', async () => {
  const atomic = new MemoryAuthorityStore();
  const first = createPactDurableStateStore({ store: atomic, now: () => 1000 });
  await first.create('tx_1', base());
  const committed = await first.transition({
    txId: 'tx_1',
    expectedState: 'PREVIEWED',
    nextState: 'COMMITTED',
    idempotencyKey: 'commit-1',
    payloadHash: 'payload-a',
    data: { commitVersion: 8 }
  });
  assert.equal(committed.state.transaction.state, 'COMMITTED');
  assert.equal(committed.version, 1);
  assert.equal(committed.journal.at(-1).type, 'COMMITTED');

  const recovered = createPactDurableStateStore({ store: atomic, now: () => 2000 });
  const loaded = await recovered.load('tx_1');
  assert.equal(loaded.version, 1);
  assert.equal(loaded.state.transaction.state, 'COMMITTED');
  assert.equal(loaded.journal.length, 2);
});

test('same idempotency key and payload replays the original durable result', async () => {
  const durable = createPactDurableStateStore({ store: new MemoryAuthorityStore(), now: () => 1000 });
  await durable.create('tx_1', base());
  const first = await durable.transition({
    txId: 'tx_1', expectedState: 'PREVIEWED', nextState: 'COMMITTED',
    idempotencyKey: 'commit-1', payloadHash: 'payload-a', data: { commitVersion: 8 }
  });
  const replay = await durable.transition({
    txId: 'tx_1', expectedState: 'PREVIEWED', nextState: 'COMMITTED',
    idempotencyKey: 'commit-1', payloadHash: 'payload-a', data: { commitVersion: 8 }
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.version, first.version);
  assert.deepEqual(replay.state, first.state);
});

test('prototype-shaped idempotency keys are treated as ordinary owned keys', async () => {
  const durable = createPactDurableStateStore({ store: new MemoryAuthorityStore(), now: () => 1000 });
  await durable.create('tx_1', base());
  const first = await durable.transition({
    txId: 'tx_1', expectedState: 'PREVIEWED', nextState: 'COMMITTED',
    idempotencyKey: 'toString', payloadHash: 'payload-a'
  });
  assert.equal(first.idempotentReplay, false);
  const replay = await durable.transition({
    txId: 'tx_1', expectedState: 'PREVIEWED', nextState: 'COMMITTED',
    idempotencyKey: 'toString', payloadHash: 'payload-a'
  });
  assert.equal(replay.idempotentReplay, true);
});

test('idempotency key reuse with a different payload fails closed', async () => {
  const durable = createPactDurableStateStore({ store: new MemoryAuthorityStore() });
  await durable.create('tx_1', base());
  await durable.transition({
    txId: 'tx_1', expectedState: 'PREVIEWED', nextState: 'COMMITTED',
    idempotencyKey: 'commit-1', payloadHash: 'payload-a'
  });
  await assert.rejects(() => durable.transition({
    txId: 'tx_1', expectedState: 'PREVIEWED', nextState: 'COMMITTED',
    idempotencyKey: 'commit-1', payloadHash: 'payload-b'
  }), /PACT_DURABLE_IDEMPOTENCY_CONFLICT/);
});

test('concurrent competing transitions allow only one winner', async () => {
  const durable = createPactDurableStateStore({ store: new MemoryAuthorityStore() });
  await durable.create('tx_1', base());
  const results = await Promise.allSettled([
    durable.transition({ txId: 'tx_1', expectedState: 'PREVIEWED', nextState: 'COMMITTED', idempotencyKey: 'a', payloadHash: 'a' }),
    durable.transition({ txId: 'tx_1', expectedState: 'PREVIEWED', nextState: 'CANCELLED', idempotencyKey: 'b', payloadHash: 'b' })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /PACT_DURABLE_STATE_CONFLICT/);
  const loaded = await durable.load('tx_1');
  assert.equal(loaded.version, 1);
  assert.equal(loaded.journal.length, 2);
});

test('corrupt or non-monotonic persisted records are rejected during recovery', async () => {
  const atomic = new MemoryAuthorityStore();
  await atomic.create('pact:tx:tx_1', {
    version: 2,
    state: base(),
    journal: [{ seq: 0, type: 'CREATED', at: 1 }, { seq: 2, type: 'COMMITTED', at: 2 }],
    replays: {}
  });
  const durable = createPactDurableStateStore({ store: atomic });
  await assert.rejects(() => durable.load('tx_1'), /PACT_DURABLE_CORRUPT_RECORD/);
});
