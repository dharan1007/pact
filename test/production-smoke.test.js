import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { canonicalStringify } from '../src/engine.js';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); }
  };
}

test('production smoke executes preview approve commit verify receipt with a bound HMAC approval', async () => {
  const { runProductionTransactionSmoke } = await import('../src/production-smoke.js');
  const secret = 's'.repeat(64);
  const calls = [];
  const tx = {
    id: 'tx_smoke',
    state: 'PREVIEWED',
    adapter: { id: 'provider.account', version: '1.0.0' },
    baseVersion: 7,
    planHash: 'a'.repeat(64)
  };
  const receipt = {
    txId: tx.id,
    adapter: tx.adapter,
    planHash: tx.planHash,
    baseVersion: 7,
    commitVersion: 8,
    verifiedVersion: 8,
    receiptHash: 'b'.repeat(64)
  };

  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ operation: body.operation, payload: body.payload, headers: options.headers });
    switch (body.operation) {
      case 'preview':
        return response(200, { transaction: tx });
      case 'approve': {
        const approval = body.payload.approval;
        const claims = {
          humanPrincipal: approval.humanPrincipal,
          agentSession: approval.agentSession,
          expiresAt: approval.expiresAt,
          nonce: approval.nonce
        };
        const message = canonicalStringify({
          txId: tx.id,
          planHash: tx.planHash,
          baseVersion: tx.baseVersion,
          adapter: tx.adapter,
          claims
        });
        assert.equal(approval.signature, createHmac('sha256', secret).update(message).digest('hex'));
        return response(200, {
          transaction: { ...tx, state: 'APPROVED' },
          capability: { token: 'pact_cap_smoke', expiresAt: approval.expiresAt, claims }
        });
      }
      case 'commit':
        assert.equal(options.headers['idempotency-key'], 'smoke-commit-key');
        assert.equal(body.payload.capabilityToken, 'pact_cap_smoke');
        return response(200, { transaction: { ...tx, state: 'COMMITTED', commitVersion: 8 } });
      case 'verify':
        return response(200, { receipt });
      case 'receipt':
        return response(200, { receipt });
      default:
        return response(400, { error: { code: 'UNEXPECTED_OPERATION' } });
    }
  };

  const result = await runProductionTransactionSmoke({
    baseUrl: 'https://pact.example.test',
    adapter: tx.adapter,
    intent: { path: ['verification', 'nonce'], value: 'release-123' },
    approvalSecret: secret,
    humanPrincipal: 'release:human',
    agentSession: 'release:agent',
    idempotencyKey: 'smoke-commit-key',
    now: () => 1_000_000,
    nonce: 'approval-nonce',
    fetchImpl
  });

  assert.deepEqual(calls.map(call => call.operation), ['preview', 'approve', 'commit', 'verify', 'receipt']);
  assert.equal(result.transactionId, tx.id);
  assert.equal(result.receiptHash, receipt.receiptHash);
  assert.equal(result.commitVersion, 8);
});

test('smoke config defaults to the shipped generic runtime without requiring provider env', async () => {
  const { resolveSmokeConfig } = await import('../src/production-smoke.js');
  assert.deepEqual(resolveSmokeConfig({}), {
    mode: 'generic',
    adapter: { id: 'pact.generic', version: '1.0.0' },
    intent: { value: { smoke: 'pact-production-smoke' } }
  });
  assert.deepEqual(resolveSmokeConfig({ PACT_RUNTIME_MODE: 'generic' }).adapter, {
    id: 'pact.generic',
    version: '1.0.0'
  });
});

test('smoke config honors an explicit generic intent and the rest-json provider contract', async () => {
  const { resolveSmokeConfig } = await import('../src/production-smoke.js');
  assert.deepEqual(
    resolveSmokeConfig({ PACT_SMOKE_INTENT_JSON: '{"value":{"smoke":"custom"}}' }).intent,
    { value: { smoke: 'custom' } }
  );
  assert.deepEqual(
    resolveSmokeConfig({
      PACT_RUNTIME_MODE: 'rest-json',
      PACT_REST_ADAPTER_ID: 'provider.account',
      PACT_SMOKE_INTENT_JSON: '{"path":["verification","nonce"],"value":"release-123"}'
    }),
    {
      mode: 'rest-json',
      adapter: { id: 'provider.account', version: '1.0.0' },
      intent: { path: ['verification', 'nonce'], value: 'release-123' }
    }
  );
});

test('smoke config fails closed on unknown modes and malformed provider env', async () => {
  const { resolveSmokeConfig } = await import('../src/production-smoke.js');
  assert.throws(() => resolveSmokeConfig({ PACT_RUNTIME_MODE: 'direct' }), /PACT_SMOKE_RUNTIME_MODE_UNSUPPORTED/);
  assert.throws(
    () => resolveSmokeConfig({ PACT_RUNTIME_MODE: 'rest-json', PACT_SMOKE_INTENT_JSON: '{}' }),
    /PACT_SMOKE_ENV_REQUIRED:PACT_REST_ADAPTER_ID/
  );
  assert.throws(
    () => resolveSmokeConfig({
      PACT_RUNTIME_MODE: 'rest-json',
      PACT_REST_ADAPTER_ID: 'provider.account',
      PACT_SMOKE_INTENT_JSON: 'not-json'
    }),
    /PACT_SMOKE_INTENT_JSON_INVALID/
  );
  assert.throws(
    () => resolveSmokeConfig({ PACT_SMOKE_INTENT_JSON: '[1,2]' }),
    /PACT_SMOKE_INTENT_JSON_INVALID/
  );
});

test('production smoke fails closed on weak secrets and receipt mismatch', async () => {
  const { runProductionTransactionSmoke } = await import('../src/production-smoke.js');
  await assert.rejects(() => runProductionTransactionSmoke({
    baseUrl: 'https://pact.example.test',
    adapter: { id: 'provider.account', version: '1.0.0' },
    intent: { path: ['x'], value: true },
    approvalSecret: 'short',
    fetchImpl: async () => response(500, {})
  }), /PACT_SMOKE_APPROVAL_SECRET_TOO_SHORT/);
});
