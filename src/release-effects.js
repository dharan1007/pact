import { canonicalStringify } from './engine.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const MAX_EFFECTS = 2048;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value, code, max = 1024) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  const normalized = value.trim();
  if (normalized.length > max) fail(code);
  return normalized;
}

function validReleaseId(value) {
  return typeof value === 'string' && /^pact_[a-f0-9]{64}$/.test(value);
}

function releaseKey(releaseId) {
  releaseId = nonEmpty(releaseId, 'PACT_EFFECTS_RELEASE_ID_REQUIRED', 128);
  if (!/^pact_[a-f0-9]{64}$/.test(releaseId)) fail('PACT_RELEASE_ID_INVALID');
  return `release:${releaseId}`;
}

function assertStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.create !== 'function' || typeof store.compareAndSwap !== 'function') {
    fail('PACT_EFFECTS_ATOMIC_STORE_REQUIRED');
  }
}

function normalizeReceipt(receipt) {
  if (!isPlainObject(receipt)) fail('PACT_EFFECTS_RECEIPT_REQUIRED');
  const txId = nonEmpty(receipt.txId, 'PACT_EFFECTS_TX_ID_REQUIRED', 256);
  const receiptHash = nonEmpty(receipt.receiptHash, 'PACT_EFFECTS_RECEIPT_HASH_REQUIRED', 128);
  if (!/^[a-f0-9]{64}$/i.test(receiptHash)) fail('PACT_EFFECTS_RECEIPT_HASH_INVALID');
  if (!validReleaseId(receipt.releaseId)) fail('PACT_EFFECTS_RELEASE_REQUIRED');
  if (!Number.isSafeInteger(receipt.commitVersion)) fail('PACT_EFFECTS_COMMIT_VERSION_INVALID');
  return {
    txId,
    releaseId: receipt.releaseId,
    receiptHash: receiptHash.toLowerCase(),
    commitVersion: receipt.commitVersion,
    adapter: isPlainObject(receipt.adapter) ? clone(receipt.adapter) : null,
    verifiedAt: Number.isSafeInteger(receipt.verifiedAt) ? receipt.verifiedAt : null
  };
}

export function createReleaseEffectIndex({ store, prefix = 'pact:effects:' } = {}) {
  assertStore(store);
  if (typeof prefix !== 'string' || !prefix) fail('PACT_EFFECTS_PREFIX_REQUIRED');
  const keyFor = releaseId => `${prefix}${releaseKey(releaseId)}`;

  async function indexReceipt(receipt) {
    const entry = normalizeReceipt(receipt);
    const key = keyFor(entry.releaseId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const raw = await store.get(key);
      if (!raw) {
        if (await store.create(key, { version: 0, effects: [entry] })) return clone(entry);
        continue;
      }
      if (!Number.isSafeInteger(raw.version) || !Array.isArray(raw.effects)) fail('PACT_EFFECTS_INDEX_CORRUPT');
      const existing = raw.effects.find(candidate => candidate.txId === entry.txId);
      if (existing) {
        if (canonicalStringify(existing) !== canonicalStringify(entry)) fail('PACT_EFFECTS_CONFLICT');
        return clone(existing);
      }
      if (raw.effects.length >= MAX_EFFECTS) fail('PACT_EFFECTS_INDEX_FULL');
      const next = { version: raw.version + 1, effects: [...raw.effects, entry] };
      if (await store.compareAndSwap(key, raw.version, next)) return clone(entry);
    }
    fail('PACT_EFFECTS_INDEX_CONTENTION');
  }

  async function listEffects(releaseId) {
    const raw = await store.get(keyFor(releaseId));
    if (!raw) return [];
    if (!Number.isSafeInteger(raw.version) || !Array.isArray(raw.effects)) fail('PACT_EFFECTS_INDEX_CORRUPT');
    return clone(raw.effects);
  }

  async function summarizeEffects(releaseId) {
    const effects = await listEffects(releaseId);
    const adapters = {};
    let minCommit = null;
    let maxCommit = null;
    for (const effect of effects) {
      const name = effect.adapter ? `${effect.adapter.id}@${effect.adapter.version}` : 'unknown';
      adapters[name] = (adapters[name] ?? 0) + 1;
      minCommit = minCommit == null ? effect.commitVersion : Math.min(minCommit, effect.commitVersion);
      maxCommit = maxCommit == null ? effect.commitVersion : Math.max(maxCommit, effect.commitVersion);
    }
    return { releaseId, effects: effects.length, adapters, minCommitVersion: minCommit, maxCommitVersion: maxCommit };
  }

  return Object.freeze({ indexReceipt, listEffects, summarizeEffects });
}
