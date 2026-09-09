import { canonicalStringify, sha256Hex } from './engine.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value, code, max = 512) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  const normalized = value.trim();
  if (normalized.length > max) fail(code);
  return normalized;
}

function assertStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.create !== 'function' || typeof store.compareAndSwap !== 'function') {
    fail('PACT_PROVIDER_QUALIFICATION_ATOMIC_STORE_REQUIRED');
  }
}

function assertClock(now) {
  if (typeof now !== 'function') fail('PACT_PROVIDER_QUALIFICATION_CLOCK_REQUIRED');
  const value = now();
  if (!Number.isFinite(value)) fail('PACT_PROVIDER_QUALIFICATION_INVALID_CLOCK');
  return value;
}

function normalizeProvider(provider) {
  if (!isPlainObject(provider)) fail('PACT_PROVIDER_QUALIFICATION_PROVIDER_REQUIRED');
  return Object.freeze({
    id: nonEmpty(provider.id, 'PACT_PROVIDER_QUALIFICATION_PROVIDER_ID_REQUIRED', 256),
    resourceKey: nonEmpty(provider.resourceKey, 'PACT_PROVIDER_QUALIFICATION_RESOURCE_KEY_REQUIRED'),
    atomicDomain: nonEmpty(provider.atomicDomain, 'PACT_PROVIDER_QUALIFICATION_ATOMIC_DOMAIN_REQUIRED', 256)
  });
}

function normalizeObservation(value, code) {
  if (!isPlainObject(value)) fail(code);
  const revision = nonEmpty(value.revision, code, 512);
  if (!Object.prototype.hasOwnProperty.call(value, 'state')) fail(code);
  try {
    JSON.stringify(value.state);
  } catch {
    fail(code);
  }
  return { revision, state: clone(value.state) };
}

function same(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

async function stateHash(state) {
  return sha256Hex({ namespace: 'pact-provider-qualification-state-v1', state });
}

function validateProbeResult(value, code) {
  if (!isPlainObject(value) || typeof value.accepted !== 'boolean') fail(code);
  if (value.status != null && (!Number.isSafeInteger(value.status) || value.status < 100 || value.status > 599)) fail(code);
  return { accepted: value.accepted, status: value.status ?? null };
}

function evidenceBody(record) {
  const { version, evidenceHash, ...body } = record;
  return body;
}

async function validateStoredEvidence(record, expectedProvider, expectedProbeType) {
  if (!isPlainObject(record) || record.version !== 0 || record.status !== 'provider-verified' ||
      record.providerId !== expectedProvider.id || record.resourceKey !== expectedProvider.resourceKey ||
      record.atomicDomain !== expectedProvider.atomicDomain || record.probeType !== expectedProbeType ||
      typeof record.evidenceHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.evidenceHash)) {
    fail('PACT_PROVIDER_QUALIFICATION_CORRUPT_EVIDENCE');
  }
  const expectedHash = await sha256Hex({ namespace: 'pact-provider-qualification-evidence-v1', evidence: evidenceBody(record) });
  if (expectedHash !== record.evidenceHash) fail('PACT_PROVIDER_QUALIFICATION_CORRUPT_EVIDENCE');
  const { version, ...publicEvidence } = record;
  return clone(publicEvidence);
}

export function createPactProviderQualifier({ store, now = () => Date.now() } = {}) {
  assertStore(store);
  assertClock(now);

  const keyFor = async (providerId, probeType) => {
    providerId = nonEmpty(providerId, 'PACT_PROVIDER_QUALIFICATION_PROVIDER_ID_REQUIRED', 256);
    probeType = nonEmpty(probeType, 'PACT_PROVIDER_QUALIFICATION_PROBE_TYPE_REQUIRED', 64);
    const digest = await sha256Hex({ namespace: 'pact-provider-qualification-key-v1', providerId, probeType });
    return `provider-qualification:${digest}`;
  };

  async function persist(provider, probeType, body) {
    const evidenceHash = await sha256Hex({ namespace: 'pact-provider-qualification-evidence-v1', evidence: body });
    const record = { version: 0, ...clone(body), evidenceHash };
    const key = await keyFor(provider.id, probeType);
    if (await store.create(key, record)) {
      const { version, ...publicEvidence } = record;
      return clone(publicEvidence);
    }
    const existing = await store.get(key);
    const validated = await validateStoredEvidence(existing, provider, probeType);
    if (validated.status === 'provider-verified') return validated;
    fail('PACT_PROVIDER_QUALIFICATION_CONFLICT');
  }

  async function inspectQualification(providerId, probeType) {
    const provider = { id: nonEmpty(providerId, 'PACT_PROVIDER_QUALIFICATION_PROVIDER_ID_REQUIRED', 256) };
    probeType = nonEmpty(probeType, 'PACT_PROVIDER_QUALIFICATION_PROBE_TYPE_REQUIRED', 64);
    const record = await store.get(await keyFor(provider.id, probeType));
    if (!record) return null;
    const expectedProvider = {
      id: provider.id,
      resourceKey: nonEmpty(record.resourceKey, 'PACT_PROVIDER_QUALIFICATION_CORRUPT_EVIDENCE'),
      atomicDomain: nonEmpty(record.atomicDomain, 'PACT_PROVIDER_QUALIFICATION_CORRUPT_EVIDENCE')
    };
    return validateStoredEvidence(record, expectedProvider, probeType);
  }

  async function qualifyConditionalWrite({ provider: rawProvider, probe } = {}) {
    const provider = normalizeProvider(rawProvider);
    if (!isPlainObject(probe) || typeof probe.read !== 'function' || typeof probe.advance !== 'function' || typeof probe.attemptStaleWrite !== 'function') {
      fail('PACT_PROVIDER_QUALIFICATION_CONDITIONAL_PROBE_REQUIRED');
    }
    const existing = await inspectQualification(provider.id, 'conditional-write');
    if (existing) {
      if (existing.resourceKey !== provider.resourceKey || existing.atomicDomain !== provider.atomicDomain) fail('PACT_PROVIDER_QUALIFICATION_PROVIDER_BINDING_MISMATCH');
      return existing;
    }

    const startedAt = assertClock(now);
    const before = normalizeObservation(await probe.read(), 'PACT_PROVIDER_QUALIFICATION_INVALID_OBSERVATION');
    const qualified = normalizeObservation(await probe.advance({ before: clone(before) }), 'PACT_PROVIDER_QUALIFICATION_INVALID_ADVANCE');
    if (qualified.revision === before.revision) fail('PACT_PROVIDER_QUALIFICATION_REVISION_DID_NOT_ADVANCE');

    const stale = validateProbeResult(await probe.attemptStaleWrite({
      staleRevision: before.revision,
      before: clone(before),
      qualified: clone(qualified)
    }), 'PACT_PROVIDER_QUALIFICATION_INVALID_STALE_PROBE_RESULT');
    if (stale.accepted) fail('PACT_PROVIDER_QUALIFICATION_STALE_WRITE_ACCEPTED');

    const observed = normalizeObservation(await probe.read(), 'PACT_PROVIDER_QUALIFICATION_INVALID_OBSERVATION');
    const canonicalUnchanged = observed.revision === qualified.revision && same(observed.state, qualified.state);
    if (!canonicalUnchanged) fail('PACT_PROVIDER_QUALIFICATION_CANONICAL_STATE_CHANGED');

    const completedAt = assertClock(now);
    return persist(provider, 'conditional-write', {
      schema: 1,
      status: 'provider-verified',
      providerId: provider.id,
      resourceKey: provider.resourceKey,
      atomicDomain: provider.atomicDomain,
      probeType: 'conditional-write',
      startedAt,
      completedAt,
      beforeRevision: before.revision,
      qualifiedRevision: qualified.revision,
      staleProbeAccepted: stale.accepted,
      staleProbeStatus: stale.status,
      canonicalUnchanged,
      beforeStateHash: await stateHash(before.state),
      qualifiedStateHash: await stateHash(qualified.state),
      observedStateHash: await stateHash(observed.state)
    });
  }

  async function qualifyRemoteFencing({ provider: rawProvider, generation, probe } = {}) {
    const provider = normalizeProvider(rawProvider);
    if (!Number.isSafeInteger(generation) || generation < 1 || generation >= Number.MAX_SAFE_INTEGER) {
      fail('PACT_PROVIDER_QUALIFICATION_INVALID_FENCE_GENERATION');
    }
    if (!isPlainObject(probe) || typeof probe.apply !== 'function' || typeof probe.read !== 'function') {
      fail('PACT_PROVIDER_QUALIFICATION_FENCING_PROBE_REQUIRED');
    }
    const existing = await inspectQualification(provider.id, 'remote-fencing');
    if (existing) {
      if (existing.resourceKey !== provider.resourceKey || existing.atomicDomain !== provider.atomicDomain) fail('PACT_PROVIDER_QUALIFICATION_PROVIDER_BINDING_MISMATCH');
      return existing;
    }

    const startedAt = assertClock(now);
    const qualifiedGeneration = generation + 1;
    const newer = validateProbeResult(await probe.apply({ generation: qualifiedGeneration }), 'PACT_PROVIDER_QUALIFICATION_INVALID_FENCE_PROBE_RESULT');
    if (!newer.accepted) fail('PACT_PROVIDER_QUALIFICATION_NEW_FENCE_REJECTED');
    const qualified = normalizeObservation(await probe.read(), 'PACT_PROVIDER_QUALIFICATION_INVALID_OBSERVATION');

    const stale = validateProbeResult(await probe.apply({ generation }), 'PACT_PROVIDER_QUALIFICATION_INVALID_FENCE_PROBE_RESULT');
    if (stale.accepted) fail('PACT_PROVIDER_QUALIFICATION_STALE_FENCE_ACCEPTED');
    const observed = normalizeObservation(await probe.read(), 'PACT_PROVIDER_QUALIFICATION_INVALID_OBSERVATION');
    const canonicalUnchanged = observed.revision === qualified.revision && same(observed.state, qualified.state);
    if (!canonicalUnchanged) fail('PACT_PROVIDER_QUALIFICATION_CANONICAL_STATE_CHANGED');

    const completedAt = assertClock(now);
    return persist(provider, 'remote-fencing', {
      schema: 1,
      status: 'provider-verified',
      providerId: provider.id,
      resourceKey: provider.resourceKey,
      atomicDomain: provider.atomicDomain,
      probeType: 'remote-fencing',
      startedAt,
      completedAt,
      qualifiedGeneration,
      staleGeneration: generation,
      qualifiedProbeStatus: newer.status,
      staleProbeAccepted: stale.accepted,
      staleProbeStatus: stale.status,
      qualifiedRevision: qualified.revision,
      observedRevision: observed.revision,
      canonicalUnchanged,
      qualifiedStateHash: await stateHash(qualified.state),
      observedStateHash: await stateHash(observed.state)
    });
  }

  return Object.freeze({ qualifyConditionalWrite, qualifyRemoteFencing, inspectQualification });
}
