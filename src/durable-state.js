const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const nonEmpty = (value, code) => {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  return value.trim();
};
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function assertAtomicStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.create !== 'function' || typeof store.compareAndSwap !== 'function') {
    fail('PACT_DURABLE_ATOMIC_STORE_REQUIRED');
  }
}

function validateRecord(record) {
  if (!isPlainObject(record) || !Number.isSafeInteger(record.version) || record.version < 0 || !isPlainObject(record.state) || !Array.isArray(record.journal) || !isPlainObject(record.replays)) {
    fail('PACT_DURABLE_CORRUPT_RECORD');
  }
  if (record.journal.length < 1) fail('PACT_DURABLE_CORRUPT_RECORD');
  for (let index = 0; index < record.journal.length; index += 1) {
    const event = record.journal[index];
    if (!isPlainObject(event) || event.seq !== index || typeof event.type !== 'string' || !Number.isFinite(event.at)) fail('PACT_DURABLE_CORRUPT_RECORD');
  }
  if (record.version !== record.journal.length - 1) fail('PACT_DURABLE_CORRUPT_RECORD');
  return clone(record);
}

export function createPactDurableStateStore({ store, now = () => Date.now(), prefix = 'pact:tx:', maxRetries = 12 } = {}) {
  assertAtomicStore(store);
  if (typeof prefix !== 'string' || prefix.length < 1 || prefix.length > 128) fail('PACT_DURABLE_INVALID_PREFIX');
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 1 || maxRetries > 64) fail('PACT_DURABLE_INVALID_RETRY_LIMIT');

  const keyFor = txId => `${prefix}${nonEmpty(txId, 'PACT_DURABLE_TX_ID_REQUIRED')}`;
  const timestamp = () => {
    const value = now();
    if (!Number.isFinite(value)) fail('PACT_DURABLE_INVALID_CLOCK');
    return value;
  };

  async function load(txId) {
    const record = await store.get(keyFor(txId));
    if (!record) return null;
    return validateRecord(record);
  }

  async function create(txId, state) {
    txId = nonEmpty(txId, 'PACT_DURABLE_TX_ID_REQUIRED');
    if (!isPlainObject(state)) fail('PACT_DURABLE_STATE_REQUIRED');
    const record = {
      version: 0,
      state: clone(state),
      journal: [{ seq: 0, type: 'CREATED', at: timestamp(), data: { txId } }],
      replays: {}
    };
    if (!await store.create(keyFor(txId), record)) fail('PACT_DURABLE_TRANSACTION_EXISTS');
    return clone(record);
  }

  async function transition({ txId, expectedState, nextState, idempotencyKey, payloadHash, data = null, mutate } = {}) {
    txId = nonEmpty(txId, 'PACT_DURABLE_TX_ID_REQUIRED');
    expectedState = nonEmpty(expectedState, 'PACT_DURABLE_EXPECTED_STATE_REQUIRED');
    nextState = nonEmpty(nextState, 'PACT_DURABLE_NEXT_STATE_REQUIRED');
    idempotencyKey = nonEmpty(idempotencyKey, 'PACT_DURABLE_IDEMPOTENCY_KEY_REQUIRED');
    payloadHash = nonEmpty(payloadHash, 'PACT_DURABLE_PAYLOAD_HASH_REQUIRED');
    if (idempotencyKey.length > 256) fail('PACT_DURABLE_INVALID_IDEMPOTENCY_KEY');
    if (typeof mutate !== 'undefined' && typeof mutate !== 'function') fail('PACT_DURABLE_INVALID_MUTATOR');

    const key = keyFor(txId);
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const currentRaw = await store.get(key);
      if (!currentRaw) fail('PACT_DURABLE_TRANSACTION_NOT_FOUND');
      const current = validateRecord(currentRaw);
      if (hasOwn(current.replays, idempotencyKey)) {
        const replay = current.replays[idempotencyKey];
        if (!isPlainObject(replay) || replay.payloadHash !== payloadHash || replay.nextState !== nextState) fail('PACT_DURABLE_IDEMPOTENCY_CONFLICT');
        return { ...clone(replay.result), idempotentReplay: true };
      }

      const actualState = current.state?.transaction?.state;
      if (actualState !== expectedState) fail('PACT_DURABLE_STATE_CONFLICT');

      const nextStateDocument = clone(current.state);
      if (typeof mutate === 'function') {
        const returned = await mutate(clone(nextStateDocument));
        if (typeof returned !== 'undefined') {
          if (!isPlainObject(returned)) fail('PACT_DURABLE_MUTATOR_MUST_RETURN_STATE');
          Object.keys(nextStateDocument).forEach(keyName => delete nextStateDocument[keyName]);
          Object.assign(nextStateDocument, clone(returned));
        }
      }
      if (!isPlainObject(nextStateDocument.transaction)) fail('PACT_DURABLE_TRANSACTION_STATE_REQUIRED');
      nextStateDocument.transaction.state = nextState;

      const version = current.version + 1;
      const journalEvent = { seq: version, type: nextState, at: timestamp(), data: clone(data) };
      const result = {
        version,
        state: clone(nextStateDocument),
        journal: [...clone(current.journal), clone(journalEvent)],
        idempotentReplay: false
      };
      const next = {
        version,
        state: clone(nextStateDocument),
        journal: result.journal,
        replays: {
          ...clone(current.replays),
          [idempotencyKey]: { payloadHash, nextState, result: clone(result) }
        }
      };
      if (await store.compareAndSwap(key, current.version, next)) return result;
    }
    fail('PACT_DURABLE_CONTENTION');
  }

  async function recover(txId) {
    const record = await load(txId);
    if (!record) fail('PACT_DURABLE_TRANSACTION_NOT_FOUND');
    return {
      txId: nonEmpty(txId, 'PACT_DURABLE_TX_ID_REQUIRED'),
      version: record.version,
      state: clone(record.state),
      journal: clone(record.journal),
      replayKeys: Object.keys(record.replays).sort()
    };
  }

  return { create, load, transition, recover };
}
