import test from 'node:test';
import assert from 'node:assert/strict';
import * as journalModule from '../src/journal.js';

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
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

const snapshot = state => ({ schema: 1, transaction: { id: 'tx_1', state } });

test('exports a durable transaction journal', () => {
  assert.equal(typeof journalModule.createPactJournal, 'function');
});

test('journal creates and retrieves isolated transaction snapshots', async () => {
  const journal = journalModule.createPactJournal({ store: atomicStore(), now: () => 1000 });
  const created = await journal.createTransaction({ transactionId: 'tx_1', snapshot: snapshot('PREVIEWED') });
  assert.equal(created.version, 0);
  const loaded = await journal.getTransaction('tx_1');
  loaded.snapshot.transaction.state = 'tampered';
  assert.equal((await journal.getTransaction('tx_1')).snapshot.transaction.state, 'PREVIEWED');
});

test('concurrent consequential claims permit one owner and expose in-progress state to the other caller', async () => {
  const journal = journalModule.createPactJournal({ store: atomicStore(), now: () => 1000, claimTtlMs: 10_000 });
  await journal.createTransaction({ transactionId: 'tx_1', snapshot: snapshot('APPROVED') });
  const [a, b] = await Promise.all([
    journal.claimOperation({ transactionId: 'tx_1', operation: 'commit', idempotencyKey: 'commit:1', request: { planHash: 'p1' } }),
    journal.claimOperation({ transactionId: 'tx_1', operation: 'commit', idempotencyKey: 'commit:1', request: { planHash: 'p1' } })
  ]);
  assert.equal([a.status, b.status].filter(x => x === 'claimed').length, 1);
  assert.equal([a.status, b.status].filter(x => x === 'in_progress').length, 1);
  assert.equal(a.claimId, b.claimId);
});

test('different idempotency key cannot take over an active consequential claim', async () => {
  const journal = journalModule.createPactJournal({ store: atomicStore(), now: () => 1000 });
  await journal.createTransaction({ transactionId: 'tx_1', snapshot: snapshot('APPROVED') });
  await journal.claimOperation({ transactionId: 'tx_1', operation: 'commit', idempotencyKey: 'commit:1', request: { planHash: 'p1' } });
  await assert.rejects(
    () => journal.claimOperation({ transactionId: 'tx_1', operation: 'commit', idempotencyKey: 'commit:2', request: { planHash: 'p1' } }),
    /PACT_JOURNAL_OPERATION_ALREADY_CLAIMED/
  );
});

test('same idempotency key with a different request is rejected as an idempotency conflict', async () => {
  const journal = journalModule.createPactJournal({ store: atomicStore(), now: () => 1000 });
  await journal.createTransaction({ transactionId: 'tx_1', snapshot: snapshot('APPROVED') });
  await journal.claimOperation({ transactionId: 'tx_1', operation: 'commit', idempotencyKey: 'commit:1', request: { planHash: 'p1' } });
  await assert.rejects(
    () => journal.claimOperation({ transactionId: 'tx_1', operation: 'commit', idempotencyKey: 'commit:1', request: { planHash: 'changed' } }),
    /PACT_JOURNAL_IDEMPOTENCY_CONFLICT/
  );
});

test('completed consequential operation replays the exact stored response without a new claim', async () => {
  const journal = journalModule.createPactJournal({ store: atomicStore(), now: () => 1000 });
  await journal.createTransaction({ transactionId: 'tx_1', snapshot: snapshot('APPROVED') });
  const claim = await journal.claimOperation({ transactionId: 'tx_1', operation: 'commit', idempotencyKey: 'commit:1', request: { planHash: 'p1' } });
  await journal.completeOperation({
    transactionId: 'tx_1', operation: 'commit', claimId: claim.claimId,
    snapshot: snapshot('COMMITTED'), response: { state: 'COMMITTED', providerRequestId: 'r1' }
  });
  const replay = await journal.claimOperation({ transactionId: 'tx_1', operation: 'commit', idempotencyKey: 'commit:1', request: { planHash: 'p1' } });
  assert.equal(replay.status, 'replay');
  assert.deepEqual(replay.response, { state: 'COMMITTED', providerRequestId: 'r1' });
  assert.equal(replay.claimId, claim.claimId);
});

test('expired same-key claim can be reclaimed, but uncertain commit requires recovery instead of blind retry', async () => {
  let time = 1000;
  const journal = journalModule.createPactJournal({ store: atomicStore(), now: () => time, claimTtlMs: 100 });
  await journal.createTransaction({ transactionId: 'tx_1', snapshot: snapshot('APPROVED') });
  const first = await journal.claimOperation({ transactionId: 'tx_1', operation: 'commit', idempotencyKey: 'commit:1', request: { planHash: 'p1' } });
  time = 1200;
  const reclaimed = await journal.claimOperation({ transactionId: 'tx_1', operation: 'commit', idempotencyKey: 'commit:1', request: { planHash: 'p1' } });
  assert.equal(reclaimed.status, 'claimed');
  assert.notEqual(reclaimed.claimId, first.claimId);
  assert.equal(reclaimed.attempt, 2);
  await journal.markUncertain({ transactionId: 'tx_1', operation: 'commit', claimId: reclaimed.claimId, snapshot: snapshot('COMMIT_UNCERTAIN') });
  const uncertain = await journal.claimOperation({ transactionId: 'tx_1', operation: 'commit', idempotencyKey: 'commit:1', request: { planHash: 'p1' } });
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.claimId, reclaimed.claimId);
});

test('ordinary snapshot mutation is blocked while a consequential operation is claimed or uncertain', async () => {
  const journal = journalModule.createPactJournal({ store: atomicStore(), now: () => 1000 });
  await journal.createTransaction({ transactionId: 'tx_1', snapshot: snapshot('APPROVED') });
  const claim = await journal.claimOperation({ transactionId: 'tx_1', operation: 'commit', idempotencyKey: 'commit:1', request: { planHash: 'p1' } });
  const record = await journal.getTransaction('tx_1');
  await assert.rejects(
    () => journal.updateSnapshot({ transactionId: 'tx_1', expectedVersion: record.version, snapshot: snapshot('CANCELLED') }),
    /PACT_JOURNAL_CONSEQUENCE_IN_PROGRESS/
  );
  await journal.markUncertain({ transactionId: 'tx_1', operation: 'commit', claimId: claim.claimId, snapshot: snapshot('COMMIT_UNCERTAIN') });
  const uncertain = await journal.getTransaction('tx_1');
  await assert.rejects(
    () => journal.updateSnapshot({ transactionId: 'tx_1', expectedVersion: uncertain.version, snapshot: snapshot('CANCELLED') }),
    /PACT_JOURNAL_CONSEQUENCE_IN_PROGRESS/
  );
});
