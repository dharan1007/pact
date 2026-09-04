import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { MemoryAuthorityStore } from '../src/authority.js';
import { canonicalStringify } from '../src/engine.js';
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
});
