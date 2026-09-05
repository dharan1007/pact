import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHmacApprovalVerifier } from '../src/server-approval.js';
import { canonicalStringify } from '../src/engine.js';

const secret = 'test-secret-with-sufficient-entropy-0123456789';

function signApproval({ txId, planHash, baseVersion, adapter, humanPrincipal = 'human:maya', agentSession = 'agent:7', expiresAt = 20_000, nonce = 'nonce-1' }) {
  const claims = { humanPrincipal, agentSession, expiresAt, nonce };
  const message = canonicalStringify({ txId, planHash, baseVersion, adapter, claims });
  const signature = createHmac('sha256', secret).update(message).digest('hex');
  return { ...claims, signature };
}

test('HMAC approval verifier authenticates claims bound to exact transaction plan/version/adapter', async () => {
  const verifyApproval = createHmacApprovalVerifier({ secret, now: () => 10_000 });
  const context = {
    txId: 'tx_1',
    planHash: 'a'.repeat(64),
    baseVersion: 4,
    adapter: { id: 'example.flags', version: '1.0.0' }
  };
  const approval = signApproval({ ...context });

  assert.deepEqual(await verifyApproval({ approval, ...context }), {
    humanPrincipal: 'human:maya',
    agentSession: 'agent:7'
  });

  assert.equal(await verifyApproval({ approval, ...context, planHash: 'b'.repeat(64) }), false);
  assert.equal(await verifyApproval({ approval, ...context, baseVersion: 5 }), false);
  assert.equal(await verifyApproval({ approval, ...context, adapter: { id: 'example.flags', version: '2.0.0' } }), false);
});

test('HMAC approval verifier rejects expired, malformed and forged approvals without throwing secrets', async () => {
  const verifyApproval = createHmacApprovalVerifier({ secret, now: () => 10_000, maxFutureMs: 120_000 });
  const context = {
    txId: 'tx_1',
    planHash: 'a'.repeat(64),
    baseVersion: 4,
    adapter: { id: 'example.flags', version: '1.0.0' }
  };

  assert.equal(await verifyApproval({ approval: signApproval({ ...context, expiresAt: 9_999 }), ...context }), false);
  assert.equal(await verifyApproval({ approval: signApproval({ ...context, expiresAt: 200_001 }), ...context }), false);
  assert.equal(await verifyApproval({ approval: { humanPrincipal: 'x' }, ...context }), false);
  const forged = signApproval({ ...context });
  forged.signature = '0'.repeat(64);
  assert.equal(await verifyApproval({ approval: forged, ...context }), false);
});

test('HMAC approval verifier fails closed on weak configuration', () => {
  assert.throws(() => createHmacApprovalVerifier({ secret: 'short' }), /PACT_APPROVAL_SECRET_TOO_SHORT/);
  assert.throws(() => createHmacApprovalVerifier({ secret, maxFutureMs: 0 }), /PACT_APPROVAL_INVALID_MAX_FUTURE/);
});