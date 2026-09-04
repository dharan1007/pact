import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactAuthority, MemoryAuthorityStore } from '../src/authority.js';

function approvalVerifier({ approval }) {
  if (approval !== 'signed-ok') return false;
  return { humanPrincipal: 'human:maya', agentSession: 'agent:session-7' };
}

test('authority issues opaque capabilities bound to transaction, plan, version and identity', async () => {
  let now = 1_000;
  const authority = createPactAuthority({
    store: new MemoryAuthorityStore(),
    verifyApproval: approvalVerifier,
    now: () => now,
    ttlMs: 5_000
  });

  const issued = await authority.issue({
    approval: 'signed-ok',
    txId: 'tx_1',
    planHash: 'plan_abc',
    baseVersion: 7,
    adapter: { id: 'example.flags', version: '1.0.0' }
  });

  assert.match(issued.token, /^pact_cap_/);
  assert.equal(issued.expiresAt, 6_000);
  assert.deepEqual(issued.claims, {
    humanPrincipal: 'human:maya',
    agentSession: 'agent:session-7'
  });

  const inspected = await authority.inspect(issued.token);
  assert.equal(inspected.txId, 'tx_1');
  assert.equal(inspected.planHash, 'plan_abc');
  assert.equal(inspected.baseVersion, 7);
  assert.deepEqual(inspected.adapter, { id: 'example.flags', version: '1.0.0' });
  assert.equal(inspected.consumed, false);

  now = 6_001;
  await assert.rejects(() => authority.authorizeCommit({
    token: issued.token,
    txId: 'tx_1',
    planHash: 'plan_abc',
    baseVersion: 7,
    idempotencyKey: 'commit-1'
  }), /PACT_AUTHORITY_CAPABILITY_EXPIRED/);
});

test('commit authorization is atomic, replay-safe and reports same-key replay explicitly', async () => {
  const authority = createPactAuthority({
    store: new MemoryAuthorityStore(),
    verifyApproval: approvalVerifier,
    now: () => 10_000,
    ttlMs: 5_000
  });
  const issued = await authority.issue({ approval: 'signed-ok', txId: 'tx_2', planHash: 'plan_xyz', baseVersion: 4 });

  const first = await authority.authorizeCommit({ token: issued.token, txId: 'tx_2', planHash: 'plan_xyz', baseVersion: 4, idempotencyKey: 'idem-A' });
  const replay = await authority.authorizeCommit({ token: issued.token, txId: 'tx_2', planHash: 'plan_xyz', baseVersion: 4, idempotencyKey: 'idem-A' });
  assert.equal(first.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.authorizationId, first.authorizationId);
  assert.equal(replay.idempotencyKey, first.idempotencyKey);

  await assert.rejects(() => authority.authorizeCommit({ token: issued.token, txId: 'tx_2', planHash: 'plan_xyz', baseVersion: 4, idempotencyKey: 'idem-B' }), /PACT_AUTHORITY_CAPABILITY_ALREADY_CONSUMED/);
  await assert.rejects(() => authority.authorizeCommit({ token: issued.token, txId: 'tx_other', planHash: 'plan_xyz', baseVersion: 4, idempotencyKey: 'idem-A' }), /PACT_AUTHORITY_BINDING_MISMATCH/);
});

test('authority rejects invalid approvals and malformed consequential requests', async () => {
  const authority = createPactAuthority({ store: new MemoryAuthorityStore(), verifyApproval: approvalVerifier });
  await assert.rejects(() => authority.issue({ approval: 'no', txId: 'tx', planHash: 'hash', baseVersion: 0 }), /PACT_AUTHORITY_APPROVAL_REJECTED/);

  const issued = await authority.issue({ approval: 'signed-ok', txId: 'tx', planHash: 'hash', baseVersion: 0 });
  await assert.rejects(() => authority.authorizeCommit({ token: issued.token, txId: 'tx', planHash: 'hash', baseVersion: 0 }), /PACT_AUTHORITY_IDEMPOTENCY_KEY_REQUIRED/);
});
