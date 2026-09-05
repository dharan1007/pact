import { definePactAdapter } from './adapter.js';
import { canonicalStringify } from './engine.js';
import { createCanonicalStateRepository } from './canonical-store.js';
import { createPactApiAuthorityService } from './api-authority.js';
import { createPactHttpHandler } from './http-handler.js';
import { createRedisAuthorityStore } from './redis-store.js';
import { createHmacApprovalVerifier } from './server-approval.js';
import { resolveReleaseSha } from './provenance.js';

const fail = code => { throw new Error(code); };
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function nonEmpty(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  return value.trim();
}

function same(a, b) {
  return canonicalStringify(a) === canonicalStringify(b);
}

function createGenericAdapter() {
  return definePactAdapter({
    id: 'pact.generic',
    version: '1.0.0',
    describe() {
      return {
        name: 'PACT generic value adapter',
        intent: { type: 'object', required: ['value'] },
        target: 'document.value'
      };
    },
    async plan({ intent, state }) {
      if (!isPlainObject(intent) || !Object.prototype.hasOwnProperty.call(intent, 'value')) fail('PACT_GENERIC_VALUE_REQUIRED');
      if (!isPlainObject(state?.document) || state.document.kind !== 'pact-generic-v1') fail('PACT_GENERIC_CANONICAL_STATE_INVALID');
      return {
        effects: [{ path: 'document.value', before: state.document.value, after: intent.value }],
        invariants: [{ path: 'document.kind', equals: 'pact-generic-v1' }],
        metadata: { adapter: 'pact.generic', semantics: 'replace-value' }
      };
    },
    async verify({ intent, state }) {
      return isPlainObject(intent)
        && Object.prototype.hasOwnProperty.call(intent, 'value')
        && isPlainObject(state?.document)
        && state.document.kind === 'pact-generic-v1'
        && same(state.document.value, intent.value);
    }
  });
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) fail('PACT_RUNTIME_ADAPTER_REQUIRED');
  nonEmpty(adapter.id, 'PACT_RUNTIME_ADAPTER_ID_REQUIRED');
  nonEmpty(adapter.version, 'PACT_RUNTIME_ADAPTER_VERSION_REQUIRED');
  for (const method of ['plan', 'verify']) {
    if (typeof adapter[method] !== 'function') fail(`PACT_RUNTIME_ADAPTER_METHOD_REQUIRED:${method}`);
  }
  return adapter;
}

function validateCanonicalBridge(canonical) {
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) fail('PACT_RUNTIME_CANONICAL_BRIDGE_REQUIRED');
  if (typeof canonical.read !== 'function') fail('PACT_RUNTIME_CANONICAL_READ_REQUIRED');
  if (typeof canonical.commit !== 'function') fail('PACT_RUNTIME_CANONICAL_COMMIT_REQUIRED');
  return canonical;
}

export function createPactServerRuntime({
  store,
  approvalSecret,
  releaseSha,
  now = () => Date.now(),
  adapter: suppliedAdapter,
  canonical: suppliedCanonical
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.create !== 'function' || typeof store.compareAndSwap !== 'function') {
    fail('PACT_RUNTIME_ATOMIC_STORE_REQUIRED');
  }
  approvalSecret = nonEmpty(approvalSecret, 'PACT_RUNTIME_APPROVAL_SECRET_REQUIRED');
  releaseSha = nonEmpty(releaseSha, 'PACT_RUNTIME_RELEASE_SHA_REQUIRED').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(releaseSha)) fail('PACT_RUNTIME_INVALID_RELEASE_SHA');
  if (typeof now !== 'function') fail('PACT_RUNTIME_CLOCK_REQUIRED');
  if ((suppliedAdapter == null) !== (suppliedCanonical == null)) fail('PACT_RUNTIME_PROVIDER_PAIR_REQUIRED');

  const adapter = suppliedAdapter == null ? createGenericAdapter() : validateAdapter(suppliedAdapter);
  const canonical = suppliedCanonical == null
    ? createCanonicalStateRepository({
        store,
        key: 'pact:canonical:pact.generic@1.0.0',
        initialState: {
          version: 0,
          document: { kind: 'pact-generic-v1', value: null }
        }
      })
    : validateCanonicalBridge(suppliedCanonical);

  const verifyApproval = createHmacApprovalVerifier({ secret: approvalSecret, now });
  const service = createPactApiAuthorityService({
    store,
    verifyApproval,
    adapters: [adapter],
    readCanonical: () => canonical.read(),
    commitCanonical: ({ expectedVersion, nextState, authorization, idempotencyKey }) => canonical.commit({
      expectedVersion,
      nextState,
      authorization,
      idempotencyKey
    }),
    now
  });
  const handler = createPactHttpHandler({ service, releaseSha });

  return {
    adapter,
    canonical,
    service,
    handler,
    releaseSha
  };
}

export function createPactServerRuntimeFromEnv({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const redisUrl = nonEmpty(env?.UPSTASH_REDIS_REST_URL, 'PACT_RUNTIME_REDIS_URL_REQUIRED');
  const redisToken = nonEmpty(env?.UPSTASH_REDIS_REST_TOKEN, 'PACT_RUNTIME_REDIS_TOKEN_REQUIRED');
  const approvalSecret = nonEmpty(env?.PACT_APPROVAL_SECRET, 'PACT_RUNTIME_APPROVAL_SECRET_REQUIRED');
  const releaseSha = resolveReleaseSha(env, { required: true });

  const store = createRedisAuthorityStore({
    url: redisUrl,
    token: redisToken,
    fetchImpl,
    prefix: 'pact:v1:'
  });
  return createPactServerRuntime({ store, approvalSecret, releaseSha, now });
}
