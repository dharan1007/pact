import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { MemoryAuthorityStore } from '../src/authority.js';
import { canonicalStringify } from '../src/engine.js';
import { createPactRestResourceBridge, createPactJsonResourceAdapter } from '../src/rest-resource.js';
import { createPactServerRuntime, createPactServerRuntimeFromEnv } from '../src/server-runtime.js';

function signApproval({ secret, transaction, now, humanPrincipal = 'human:test', agentSession = 'agent:test' }) {
  const claims = {
    humanPrincipal,
    agentSession,
    expiresAt: now + 60_000,
    nonce: 'nonce_test_1'
  };
  const message = canonicalStringify({
    txId: transaction.id,
    planHash: transaction.planHash,
    baseVersion: transaction.baseVersion,
    adapter: transaction.adapter,
    claims
  });
  return {
    ...claims,
    signature: createHmac('sha256', secret).update(message).digest('hex')
  };
}

test('server runtime composes generic adapter, durable authority, canonical state, verification and receipt', async () => {
  const store = new MemoryAuthorityStore();
  const secret = 's'.repeat(32);
  const nowValue = 1_800_000_000_000;
  const runtime = createPactServerRuntime({
    store,
    approvalSecret: secret,
    releaseSha: 'a'.repeat(40),
    now: () => nowValue
  });

  const preview = await runtime.service.preview({
    adapter: { id: 'pact.generic', version: '1.0.0' },
    intent: { value: { enabled: true, label: 'verified' } }
  });
  assert.equal(preview.transaction.state, 'PREVIEWED');
  assert.deepEqual(preview.transaction.effects, [{
    path: 'document.value',
    before: null,
    after: { enabled: true, label: 'verified' }
  }]);

  const approval = signApproval({ secret, transaction: preview.transaction, now: nowValue });
  const approved = await runtime.service.approve({ transactionId: preview.transaction.id, approval });
  assert.equal(approved.transaction.state, 'APPROVED');
  assert.equal(typeof approved.capability.token, 'string');

  const committed = await runtime.service.commit({
    transactionId: preview.transaction.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'commit_runtime_1'
  });
  assert.equal(committed.transaction.state, 'COMMITTED');

  const verified = await runtime.service.verify({ transactionId: preview.transaction.id });
  assert.equal(verified.receipt.txId, preview.transaction.id);
  assert.equal(verified.receipt.commitVersion, 1);
  assert.equal(typeof verified.receipt.receiptHash, 'string');

  const receipt = await runtime.service.receipt({ transactionId: preview.transaction.id });
  assert.deepEqual(receipt.receipt, verified.receipt);

  const canonical = await runtime.canonical.read();
  assert.deepEqual(canonical, {
    version: 1,
    document: { kind: 'pact-generic-v1', value: { enabled: true, label: 'verified' } }
  });
});

test('server runtime can transact against a real REST provider through a supplied canonical bridge', async () => {
  const store = new MemoryAuthorityStore();
  const secret = 'r'.repeat(32);
  const nowValue = 1_800_000_100_000;
  let etag = '"provider-r1"';
  let resource = { account: { owner: 'Ada' }, plan: 'pro' };
  let writes = 0;
  const requests = [];
  const fetchImpl = async (_url, options = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ method, headers: { ...(options.headers ?? {}) } });
    if (method === 'GET') {
      return {
        ok: true, status: 200,
        headers: { get(name) { return String(name).toLowerCase() === 'etag' ? etag : null; } },
        async text() { return JSON.stringify(resource); }
      };
    }
    writes += 1;
    assert.equal(options.headers['if-match'], etag);
    assert.match(options.headers['idempotency-key'], /^pact_auth_/);
    resource = JSON.parse(options.body);
    etag = '"provider-r2"';
    return {
      ok: true, status: 200,
      headers: { get(name) { return String(name).toLowerCase() === 'etag' ? etag : null; } },
      async text() { return JSON.stringify(resource); }
    };
  };
  const canonical = createPactRestResourceBridge({
    store,
    key: 'provider:account-42',
    baseUrl: 'https://provider.example',
    resourcePath: '/v1/accounts/42',
    fetchImpl
  });
  const adapter = createPactJsonResourceAdapter({ id: 'provider.account', version: '1.0.0' });
  const runtime = createPactServerRuntime({
    store,
    approvalSecret: secret,
    releaseSha: 'c'.repeat(40),
    adapter,
    canonical,
    now: () => nowValue
  });

  const preview = await runtime.service.preview({
    adapter: { id: 'provider.account', version: '1.0.0' },
    intent: { path: ['account', 'owner'], value: 'Maya' }
  });
  assert.equal(preview.transaction.baseVersion, 0);
  assert.deepEqual(preview.transaction.effects, [{ path: 'resource.account.owner', before: 'Ada', after: 'Maya' }]);

  const approval = signApproval({ secret, transaction: preview.transaction, now: nowValue });
  const approved = await runtime.service.approve({ transactionId: preview.transaction.id, approval });
  await runtime.service.commit({
    transactionId: preview.transaction.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'real-provider-commit-1'
  });
  const verified = await runtime.service.verify({ transactionId: preview.transaction.id });

  assert.equal(writes, 1);
  assert.equal(resource.account.owner, 'Maya');
  assert.equal(verified.receipt.verifiedVersion, 1);
  assert.deepEqual(await runtime.canonical.read(), { version: 1, resource: { account: { owner: 'Maya' }, plan: 'pro' } });
  assert.equal(requests.some(request => request.method === 'PUT'), true);
});

test('server runtime rejects malformed generic intents before creating a transaction', async () => {
  const runtime = createPactServerRuntime({
    store: new MemoryAuthorityStore(),
    approvalSecret: 's'.repeat(32),
    releaseSha: 'b'.repeat(40)
  });
  await assert.rejects(() => runtime.service.preview({
    adapter: { id: 'pact.generic', version: '1.0.0' },
    intent: {}
  }), /PACT_GENERIC_VALUE_REQUIRED/);
});

test('server runtime from environment fails closed unless durable storage, approval secret, and exact release SHA exist', () => {
  assert.throws(() => createPactServerRuntimeFromEnv({ env: {} }), /PACT_RUNTIME_REDIS_URL_REQUIRED/);
  assert.throws(() => createPactServerRuntimeFromEnv({ env: {
    UPSTASH_REDIS_REST_URL: 'https://redis.example',
    UPSTASH_REDIS_REST_TOKEN: 'token'
  } }), /PACT_RUNTIME_APPROVAL_SECRET_REQUIRED/);
  assert.throws(() => createPactServerRuntimeFromEnv({ env: {
    UPSTASH_REDIS_REST_URL: 'https://redis.example',
    UPSTASH_REDIS_REST_TOKEN: 'token',
    PACT_APPROVAL_SECRET: 's'.repeat(32)
  } }), /PACT_RUNTIME_RELEASE_SHA_REQUIRED/);
  assert.throws(() => createPactServerRuntimeFromEnv({ env: {
    UPSTASH_REDIS_REST_URL: 'https://redis.example',
    UPSTASH_REDIS_REST_TOKEN: 'token',
    PACT_APPROVAL_SECRET: 's'.repeat(32),
    PACT_SOURCE_COMMIT: 'not-a-sha'
  } }), /PACT_RUNTIME_INVALID_RELEASE_SHA/);
  assert.throws(() => createPactServerRuntimeFromEnv({ env: {
    UPSTASH_REDIS_REST_URL: 'https://redis.example',
    UPSTASH_REDIS_REST_TOKEN: 'token',
    PACT_APPROVAL_SECRET: 's'.repeat(32),
    PACT_SOURCE_COMMIT: 'a'.repeat(40),
    VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40)
  } }), /PACT_RUNTIME_RELEASE_SHA_CONFLICT/);
});
