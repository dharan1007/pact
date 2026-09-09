import { canonicalStringify, sha256Hex } from './engine.js';
import { createPactRestResourceBridge, createPactJsonResourceAdapter } from './rest-resource.js';
import { createPactProviderQualifier } from './provider-qualification.js';

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

function same(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function assertStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.create !== 'function' || typeof store.compareAndSwap !== 'function') {
    fail('PACT_PROVIDER_REGISTRY_ATOMIC_STORE_REQUIRED');
  }
}

function normalizeRemoteFencing(value) {
  if (value == null) return null;
  if (!isPlainObject(value)) fail('PACT_PROVIDER_REGISTRY_INVALID_REMOTE_FENCING');
  const mode = nonEmpty(value.mode, 'PACT_PROVIDER_REGISTRY_REMOTE_FENCING_MODE_REQUIRED', 64);
  if (mode !== 'monotonic-header') fail('PACT_PROVIDER_REGISTRY_REMOTE_FENCING_MODE_UNSUPPORTED');
  const header = nonEmpty(value.header, 'PACT_PROVIDER_REGISTRY_REMOTE_FENCING_HEADER_REQUIRED', 64).toLowerCase();
  if (!/^x-[a-z0-9][a-z0-9-]{0,62}$/.test(header)) fail('PACT_PROVIDER_REGISTRY_UNSAFE_REMOTE_FENCING_HEADER');
  if (['x-pact-idempotency-key', 'x-pact-authorization'].includes(header)) fail('PACT_PROVIDER_REGISTRY_UNSAFE_REMOTE_FENCING_HEADER');
  return Object.freeze({ mode, header });
}

function normalizeConditionalWrite(value) {
  if (value == null) return 'conditional-write-unknown-strength';
  if (value === 'conditional-write-unknown-strength' || value === 'strong-validator') return value;
  fail('PACT_PROVIDER_REGISTRY_UNSUPPORTED_CONDITIONAL_WRITE');
}

function isStrongEntityTag(value) {
  if (typeof value !== 'string') return false;
  const tag = value.trim();
  if (tag.startsWith('W/')) return false;
  if (tag.length < 2 || tag[0] !== '"' || tag.at(-1) !== '"') return false;
  for (let index = 1; index < tag.length - 1; index += 1) {
    const code = tag.charCodeAt(index);
    if (code === 0x22 || code <= 0x20 || code === 0x7f) return false;
  }
  return true;
}

function normalizeProviderConfig(raw, env) {
  if (!isPlainObject(raw)) fail('PACT_PROVIDER_REGISTRY_INVALID_PROVIDER');
  const id = nonEmpty(raw.id, 'PACT_PROVIDER_REGISTRY_PROVIDER_ID_REQUIRED', 256);
  const type = nonEmpty(raw.type, 'PACT_PROVIDER_REGISTRY_PROVIDER_TYPE_REQUIRED', 64);
  if (type !== 'rest-json') fail(`PACT_PROVIDER_REGISTRY_PROVIDER_TYPE_UNSUPPORTED:${type}`);
  const baseUrl = nonEmpty(raw.baseUrl, 'PACT_PROVIDER_REGISTRY_BASE_URL_REQUIRED', 2048);
  const resourcePath = nonEmpty(raw.resourcePath, 'PACT_PROVIDER_REGISTRY_RESOURCE_PATH_REQUIRED', 2048);
  const resourceKey = nonEmpty(raw.resourceKey, 'PACT_PROVIDER_REGISTRY_RESOURCE_KEY_REQUIRED', 512);
  const atomicDomain = nonEmpty(raw.atomicDomain, 'PACT_PROVIDER_REGISTRY_ATOMIC_DOMAIN_REQUIRED', 256);
  const method = (typeof raw.method === 'string' && raw.method.trim() ? raw.method.trim() : 'PUT').toUpperCase();
  if (method !== 'PUT') fail('PACT_PROVIDER_REGISTRY_UNSAFE_MUTATION_SEMANTICS');

  const requested = isPlainObject(raw.capabilities) ? raw.capabilities : {};
  const compensation = requested.compensation === true;
  const reversible = requested.reversible === true;
  if (compensation && !reversible) fail('PACT_PROVIDER_REGISTRY_INVALID_REVERSIBILITY');
  const remoteFencing = normalizeRemoteFencing(requested.remoteFencing);
  const conditionalWrite = normalizeConditionalWrite(requested.conditionalWrite);

  let bearerToken = '';
  let secretConfigured = false;
  if (raw.bearerTokenEnv != null) {
    const secretName = nonEmpty(raw.bearerTokenEnv, 'PACT_PROVIDER_REGISTRY_SECRET_ENV_REQUIRED', 256);
    bearerToken = typeof env?.[secretName] === 'string' ? env[secretName].trim() : '';
    if (!bearerToken) fail(`PACT_PROVIDER_REGISTRY_SECRET_REQUIRED:${secretName}`);
    secretConfigured = true;
  }

  return {
    id,
    type,
    baseUrl,
    resourcePath,
    resourceKey,
    atomicDomain,
    method,
    bearerToken,
    secretConfigured,
    remoteFencing,
    capabilities: Object.freeze({
      atomicDomain,
      resourceKey,
      conditionalWrite,
      idempotency: 'provider-key+durable-replay',
      mutation: method,
      readAfterWrite: 'strong-response+canonical-reread',
      reconciliation: true,
      compensation,
      reversible,
      ...(remoteFencing ? { remoteFencing: remoteFencing.mode, fenceHeader: remoteFencing.header } : {})
    })
  };
}

function normalizeRegistryConfig(config, env) {
  if (!isPlainObject(config) || config.version !== 1 || !Array.isArray(config.providers) || config.providers.length < 1) {
    fail('PACT_PROVIDER_REGISTRY_INVALID_CONFIG');
  }
  if (config.providers.length > 64) fail('PACT_PROVIDER_REGISTRY_TOO_MANY_PROVIDERS');
  const ids = new Set();
  const resources = new Set();
  return config.providers.map(raw => {
    const provider = normalizeProviderConfig(raw, env);
    if (ids.has(provider.id)) fail('PACT_PROVIDER_REGISTRY_DUPLICATE_PROVIDER');
    if (resources.has(provider.resourceKey)) fail('PACT_PROVIDER_REGISTRY_DUPLICATE_RESOURCE');
    ids.add(provider.id);
    resources.add(provider.resourceKey);
    return provider;
  });
}

function setEffect(nextState, effect) {
  if (typeof effect?.path !== 'string' || !effect.path.startsWith('resource.')) fail('PACT_PROVIDER_REGISTRY_INVALID_EFFECT');
  const parts = effect.path.split('.').slice(1);
  if (parts.length < 1) fail('PACT_PROVIDER_REGISTRY_INVALID_EFFECT');
  let cursor = nextState.resource;
  for (const key of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !Object.prototype.hasOwnProperty.call(cursor, key)) {
      fail('PACT_PROVIDER_REGISTRY_EFFECT_PATH_MISSING');
    }
    cursor = cursor[key];
  }
  const leaf = parts.at(-1);
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !Object.prototype.hasOwnProperty.call(cursor, leaf)) {
    fail('PACT_PROVIDER_REGISTRY_EFFECT_PATH_MISSING');
  }
  cursor[leaf] = clone(effect.after);
}

async function buildNext(adapter, input, current) {
  if (!isPlainObject(input) || !isPlainObject(input.intent)) fail('PACT_PROVIDER_REGISTRY_INTENT_REQUIRED');
  const planned = await adapter.plan({ intent: clone(input.intent), state: clone(current) });
  if (!Array.isArray(planned?.effects) || planned.effects.length < 1) fail('PACT_PROVIDER_REGISTRY_EMPTY_PLAN');
  const next = clone(current);
  next.version = current.version + 1;
  for (const effect of planned.effects) setEffect(next, effect);
  return next;
}

function validateExecutionPlan(value) {
  if (!isPlainObject(value) || value.version !== 0 || typeof value.idempotencyKey !== 'string' || !value.idempotencyKey ||
      typeof value.inputHash !== 'string' || !isPlainObject(value.before) || !isPlainObject(value.next)) {
    fail('PACT_PROVIDER_REGISTRY_CORRUPT_EXECUTION_PLAN');
  }
  return clone(value);
}

function validateFence(fence) {
  if (!isPlainObject(fence) || !Number.isSafeInteger(fence.generation) || fence.generation < 1 ||
      typeof fence.ownerId !== 'string' || !fence.ownerId) fail('PACT_PROVIDER_REGISTRY_REMOTE_FENCE_REQUIRED');
  return fence.generation;
}

function markUncertain(error) {
  if (error?.message === 'PACT_REST_COMMIT_UNCERTAIN') error.uncertain = true;
  return error;
}

function localQualification(provider) {
  return Object.freeze({
    conditionalWrite: provider.capabilities.conditionalWrite === 'strong-validator' ? 'locally-enforced' : 'declared',
    ...(provider.remoteFencing ? { remoteFencing: 'declared' } : {})
  });
}

function localCapabilities(provider) {
  return Object.freeze({ ...provider.capabilities, qualification: localQualification(provider) });
}

function assertQualificationBinding(evidence, provider) {
  if (evidence == null) return;
  if (evidence.providerId !== provider.id || evidence.resourceKey !== provider.resourceKey || evidence.atomicDomain !== provider.atomicDomain) {
    fail('PACT_PROVIDER_REGISTRY_QUALIFICATION_BINDING_MISMATCH');
  }
}

async function resolvedCapabilities(provider, qualifier) {
  const qualification = { ...localQualification(provider) };
  const conditional = await qualifier.inspectQualification(provider.id, 'conditional-write');
  if (conditional) {
    assertQualificationBinding(conditional, provider);
    qualification.conditionalWrite = 'provider-verified';
  }
  if (provider.remoteFencing) {
    const fencing = await qualifier.inspectQualification(provider.id, 'remote-fencing');
    if (fencing) {
      assertQualificationBinding(fencing, provider);
      qualification.remoteFencing = 'provider-verified';
    }
  }
  return Object.freeze({ ...provider.capabilities, qualification: Object.freeze(qualification) });
}

function publicProvider(provider, capabilities = localCapabilities(provider)) {
  return Object.freeze({
    id: provider.id,
    type: provider.type,
    resourceKey: provider.resourceKey,
    atomicDomain: provider.atomicDomain,
    url: new URL(provider.resourcePath, `${provider.baseUrl.replace(/\/$/, '')}/`).toString(),
    secretConfigured: provider.secretConfigured,
    capabilities
  });
}

function createRestSagaHandler({ store, provider, fetchImpl, qualifier }) {
  const baseHeaders = provider.bearerToken ? { authorization: `Bearer ${provider.bearerToken}` } : {};
  const qualifiedFetchImpl = provider.capabilities.conditionalWrite === 'strong-validator'
    ? async (url, options = {}) => {
        const response = await fetchImpl(url, options);
        const method = String(options.method ?? 'GET').toUpperCase();
        if (method === 'GET' && response?.ok) {
          const headers = response.headers;
          const originalGet = typeof headers?.get === 'function' ? headers.get.bind(headers) : null;
          if (!originalGet) fail('PACT_REST_STRONG_ETAG_REQUIRED');
          const etag = originalGet('etag');
          if (!isStrongEntityTag(etag)) fail('PACT_REST_STRONG_ETAG_REQUIRED');
        }
        return response;
      }
    : fetchImpl;
  const createBridge = (extraHeaders = {}) => createPactRestResourceBridge({
    store,
    key: provider.resourceKey,
    baseUrl: provider.baseUrl,
    resourcePath: provider.resourcePath,
    fetchImpl: qualifiedFetchImpl,
    headers: { ...baseHeaders, ...extraHeaders },
    method: provider.method
  });
  const bridge = createBridge();
  const bridgeForFence = fence => {
    if (!provider.remoteFencing) return bridge;
    const generation = validateFence(fence);
    return createBridge({ [provider.remoteFencing.header]: String(generation) });
  };
  const adapter = createPactJsonResourceAdapter({ id: provider.id, version: '1.0.0' });
  const planPrefix = `provider-plan:${provider.id}:`;

  async function planKey(idempotencyKey, phase) {
    const digest = await sha256Hex({ namespace: 'pact-provider-plan-v1', provider: provider.id, phase, idempotencyKey });
    return `${planPrefix}${phase}:${digest}`;
  }

  async function prepareForward(input, idempotencyKey) {
    const inputHash = await sha256Hex({ provider: provider.id, input });
    const key = await planKey(idempotencyKey, 'forward');
    const existing = await store.get(key);
    if (existing) {
      const plan = validateExecutionPlan(existing);
      if (plan.idempotencyKey !== idempotencyKey || plan.inputHash !== inputHash) fail('PACT_PROVIDER_REGISTRY_IDEMPOTENCY_CONFLICT');
      return plan;
    }
    const before = await bridge.read();
    const next = await buildNext(adapter, input, before);
    const plan = { version: 0, idempotencyKey, inputHash, before: clone(before), next: clone(next) };
    if (await store.create(key, plan)) return clone(plan);
    const raced = validateExecutionPlan(await store.get(key));
    if (raced.idempotencyKey !== idempotencyKey || raced.inputHash !== inputHash) fail('PACT_PROVIDER_REGISTRY_IDEMPOTENCY_CONFLICT');
    return raced;
  }

  async function prepareCompensation(forwardResult, idempotencyKey) {
    if (!provider.capabilities.compensation) fail('PACT_PROVIDER_REGISTRY_COMPENSATION_UNSUPPORTED');
    if (!isPlainObject(forwardResult?.before) || !isPlainObject(forwardResult?.after)) fail('PACT_PROVIDER_REGISTRY_FORWARD_RESULT_REQUIRED');
    const inputHash = await sha256Hex({ provider: provider.id, forwardResult });
    const key = await planKey(idempotencyKey, 'compensate');
    const existing = await store.get(key);
    if (existing) {
      const plan = validateExecutionPlan(existing);
      if (plan.idempotencyKey !== idempotencyKey || plan.inputHash !== inputHash) fail('PACT_PROVIDER_REGISTRY_IDEMPOTENCY_CONFLICT');
      return plan;
    }
    const current = await bridge.read();
    if (current.version !== forwardResult.after.version || !same(current.resource, forwardResult.after.resource)) {
      fail('PACT_PROVIDER_REGISTRY_COMPENSATION_CONFLICT');
    }
    const next = { version: current.version + 1, resource: clone(forwardResult.before.resource) };
    const plan = { version: 0, idempotencyKey, inputHash, before: clone(current), next };
    if (await store.create(key, plan)) return clone(plan);
    const raced = validateExecutionPlan(await store.get(key));
    if (raced.idempotencyKey !== idempotencyKey || raced.inputHash !== inputHash) fail('PACT_PROVIDER_REGISTRY_IDEMPOTENCY_CONFLICT');
    return raced;
  }

  async function commitPlan(plan, fence) {
    return bridgeForFence(fence).commit({
      expectedVersion: plan.before.version,
      nextState: clone(plan.next),
      authorization: { authorizationId: plan.idempotencyKey },
      idempotencyKey: plan.idempotencyKey
    });
  }

  async function reconcilePlan(plan, fence) {
    try {
      await commitPlan(plan, fence);
      return 'committed';
    } catch (error) {
      if (error?.message === 'PACT_REST_COMMIT_UNCERTAIN') return 'uncertain';
      let observed;
      try { observed = await bridge.read(); } catch { return 'uncertain'; }
      if (same(observed, plan.next)) return 'committed';
      if (same(observed, plan.before)) return 'not_committed';
      return 'uncertain';
    }
  }

  async function recoveryEvidence({ phase, input, idempotencyKey, forwardResult }) {
    const plan = phase === 'compensation'
      ? await prepareCompensation(forwardResult, idempotencyKey)
      : await prepareForward(input, idempotencyKey);
    let observed = null;
    let classification = 'unavailable';
    try {
      observed = await bridge.read();
      if (same(observed, plan.next)) classification = 'committed';
      else if (same(observed, plan.before)) classification = 'not_committed';
      else classification = 'diverged';
    } catch {
      classification = 'unavailable';
    }
    return {
      provider: provider.id,
      resourceKey: provider.resourceKey,
      atomicDomain: provider.atomicDomain,
      phase,
      before: clone(plan.before),
      intended: clone(plan.next),
      observed: clone(observed),
      classification,
      capabilities: await resolvedCapabilities(provider, qualifier)
    };
  }

  const handler = {
    capabilities: localCapabilities(provider),
    async getCapabilities() {
      return resolvedCapabilities(provider, qualifier);
    },
    async execute({ input, idempotencyKey, fence }) {
      const plan = await prepareForward(input, idempotencyKey);
      try {
        const after = await commitPlan(plan, fence);
        return { provider: provider.id, resourceKey: provider.resourceKey, before: clone(plan.before), after: clone(after) };
      } catch (error) {
        throw markUncertain(error);
      }
    },
    async verify({ input, idempotencyKey, result }) {
      if (result?.after && result?.before) {
        const observed = await bridge.read();
        return same(observed, result.after);
      }
      const plan = await prepareForward(input, idempotencyKey);
      const observed = await bridge.read();
      return same(observed, plan.next);
    },
    async reconcile({ input, idempotencyKey, fence }) {
      return reconcilePlan(await prepareForward(input, idempotencyKey), fence);
    },
    recoveryEvidence
  };

  if (provider.capabilities.compensation) {
    handler.compensate = async ({ forwardResult, idempotencyKey, fence }) => {
      const plan = await prepareCompensation(forwardResult, idempotencyKey);
      try {
        const after = await commitPlan(plan, fence);
        return { provider: provider.id, resourceKey: provider.resourceKey, before: clone(plan.before), after: clone(after) };
      } catch (error) {
        throw markUncertain(error);
      }
    };
    handler.verifyCompensation = async ({ forwardResult, idempotencyKey }) => {
      const plan = await prepareCompensation(forwardResult, idempotencyKey);
      const observed = await bridge.read();
      return same(observed, plan.next);
    };
    handler.reconcileCompensation = async ({ forwardResult, idempotencyKey, fence }) => {
      return reconcilePlan(await prepareCompensation(forwardResult, idempotencyKey), fence);
    };
  }

  return Object.freeze(handler);
}

export function createPactProviderRegistry({ store, config, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  assertStore(store);
  if (typeof fetchImpl !== 'function') fail('PACT_PROVIDER_REGISTRY_FETCH_REQUIRED');
  const providers = normalizeRegistryConfig(config, env);
  const qualifier = createPactProviderQualifier({ store });
  const byId = new Map(providers.map(provider => [provider.id, provider]));
  const handlers = {};
  for (const provider of providers) handlers[provider.id] = createRestSagaHandler({ store, provider, fetchImpl, qualifier });

  const providerFor = providerId => {
    providerId = nonEmpty(providerId, 'PACT_PROVIDER_REGISTRY_PROVIDER_ID_REQUIRED', 256);
    const provider = byId.get(providerId);
    if (!provider) fail(`PACT_PROVIDER_REGISTRY_PROVIDER_NOT_FOUND:${providerId}`);
    return provider;
  };

  async function inspectProviders() {
    const out = [];
    for (const provider of providers) out.push(publicProvider(provider, await resolvedCapabilities(provider, qualifier)));
    return Object.freeze(out);
  }

  async function qualifyConditionalWrite(providerId, probe) {
    const provider = providerFor(providerId);
    return qualifier.qualifyConditionalWrite({
      provider: { id: provider.id, resourceKey: provider.resourceKey, atomicDomain: provider.atomicDomain },
      probe
    });
  }

  async function qualifyRemoteFencing(providerId, generation, probe) {
    const provider = providerFor(providerId);
    if (!provider.remoteFencing) fail('PACT_PROVIDER_REGISTRY_REMOTE_FENCING_UNSUPPORTED');
    return qualifier.qualifyRemoteFencing({
      provider: { id: provider.id, resourceKey: provider.resourceKey, atomicDomain: provider.atomicDomain },
      generation,
      probe
    });
  }

  return Object.freeze({
    handlers: Object.freeze(handlers),
    providers: Object.freeze(providers.map(provider => publicProvider(provider))),
    inspectProviders,
    qualifyConditionalWrite,
    qualifyRemoteFencing
  });
}

export function parsePactProviderRegistryConfig(value) {
  if (typeof value !== 'string' || value.trim() === '') fail('PACT_PROVIDER_REGISTRY_JSON_REQUIRED');
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail('PACT_PROVIDER_REGISTRY_JSON_INVALID'); }
  if (!isPlainObject(parsed)) fail('PACT_PROVIDER_REGISTRY_INVALID_CONFIG');
  return parsed;
}