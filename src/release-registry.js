import { canonicalStringify } from './engine.js';
import { validateReleaseLock } from './release-lock.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const MAX_HISTORY = 512;

function nonEmpty(value, code, max = 256) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  const normalized = value.trim();
  if (normalized.length > max) fail(code);
  return normalized;
}

function assertStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.create !== 'function' || typeof store.compareAndSwap !== 'function') {
    fail('PACT_RELEASE_REGISTRY_ATOMIC_STORE_REQUIRED');
  }
}

function releaseKey(releaseId) {
  releaseId = nonEmpty(releaseId, 'PACT_RELEASE_ID_REQUIRED', 128);
  if (!/^pact_[a-f0-9]{64}$/.test(releaseId)) fail('PACT_RELEASE_ID_INVALID');
  return `release:${releaseId}`;
}

function historyKey(agent, environment) {
  agent = nonEmpty(agent, 'PACT_RELEASE_AGENT_REQUIRED');
  environment = nonEmpty(environment, 'PACT_RELEASE_ENVIRONMENT_REQUIRED', 64);
  return `releases:${agent}:${environment}`;
}

export function createReleaseRegistry({ store, prefix = 'pact:releases:' } = {}) {
  assertStore(store);
  prefix = nonEmpty(prefix, 'PACT_RELEASE_REGISTRY_PREFIX_REQUIRED', 128);
  const namespaced = key => `${prefix}${key}`;

  async function pin(lock) {
    const valid = await validateReleaseLock(lock);
    const key = namespaced(releaseKey(valid.releaseId));
    const record = { version: 0, lock: clone(valid) };
    if (await store.create(key, record)) {
      await appendHistory(valid);
      const { version, ...publicRecord } = record;
      return clone(publicRecord);
    }
    const existing = await store.get(key);
    if (!existing || canonicalStringify(existing.lock) !== canonicalStringify(valid)) {
      fail('PACT_RELEASE_CONFLICT');
    }
    const { version, ...publicRecord } = existing;
    return clone(publicRecord);
  }

  async function appendHistory(valid) {
    const key = namespaced(historyKey(valid.agent, valid.environment));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const raw = await store.get(key);
      if (!raw) {
        const initial = { version: 0, ids: [valid.releaseId] };
        if (await store.create(key, initial)) return;
        continue;
      }
      if (!Number.isSafeInteger(raw.version) || !Array.isArray(raw.ids)) fail('PACT_RELEASE_HISTORY_CORRUPT');
      if (raw.ids.includes(valid.releaseId)) return;
      if (raw.ids.length >= MAX_HISTORY) fail('PACT_RELEASE_HISTORY_FULL');
      const next = { version: raw.version + 1, ids: [...raw.ids, valid.releaseId] };
      if (await store.compareAndSwap(key, raw.version, next)) return;
    }
    fail('PACT_RELEASE_HISTORY_CONTENTION');
  }

  async function get(releaseId) {
    const raw = await store.get(namespaced(releaseKey(releaseId)));
    if (!raw) fail('PACT_RELEASE_NOT_FOUND');
    if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(raw.version)) fail('PACT_RELEASE_CORRUPT_RECORD');
    return clone(await validateReleaseLock(raw.lock));
  }

  async function history({ agent, environment } = {}) {
    const raw = await store.get(namespaced(historyKey(agent, environment)));
    if (!raw) return [];
    if (!Number.isSafeInteger(raw.version) || !Array.isArray(raw.ids)) fail('PACT_RELEASE_HISTORY_CORRUPT');
    return [...raw.ids];
  }

  return Object.freeze({ pin, get, history });
}
