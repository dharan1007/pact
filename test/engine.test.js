import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactEngine, makeReferenceState, canonicalStringify, sha256Hex } from '../src/engine.js';

async function approved(engine) {
  engine.startIntent();
  await engine.preview();
  await engine.approve({ trusted: true });
}

test('human approval requires a trusted gesture', async () => {
  const e = createPactEngine({ now: () => 1000 });
  e.startIntent();
  await e.preview();
  await assert.rejects(() => e.approve({ trusted: false }), /TRUSTED_GESTURE_REQUIRED/);
});

test('commit is bound to the exact approved plan', async () => {
  const e = createPactEngine({ now: () => 1000 });
  await approved(e);
  e.__unsafeMutateForTest(tx => { tx.effects[0].after = 'mallory'; });
  await assert.rejects(() => e.commit(), /PLAN_TAMPERED/);
  assert.equal(e.inspect().canonical.projects.helios.owner, 'acme-a');
});

test('stale canonical state invalidates commit authority', async () => {
  const e = createPactEngine({ now: () => 1000 });
  await approved(e);
  e.simulateConcurrentEdit();
  await assert.rejects(() => e.commit(), /STALE_PLAN/);
});

test('expired approval lease rejects commit', async () => {
  let now = 1000;
  const e = createPactEngine({ now: () => now, leaseMs: 100 });
  await approved(e);
  now = 1200;
  await assert.rejects(() => e.commit(), /INVALID_OR_EXPIRED_LEASE/);
});

test('commit applies all effects atomically and is idempotent', async () => {
  const e = createPactEngine({ now: () => 1000 });
  await approved(e);
  const first = await e.commit();
  const second = await e.commit();
  assert.equal(first.commitVersion, 43);
  assert.equal(second.commitVersion, 43);
  const s = e.inspect().canonical;
  assert.equal(s.projects.helios.owner, 'maya');
  assert.equal(s.people['acme-a'].prod, false);
  assert.equal(s.people['acme-b'].repo, 'read:7d');
  assert.equal(s.billing.plan, 'team');
  assert.equal(s.deletedRecords, 0);
});

test('verification detects postcondition drift and negative invariants', async () => {
  const e = createPactEngine({ now: () => 1000 });
  await approved(e);
  await e.commit();
  e.__unsafeMutateCanonicalForTest(s => { s.billing.plan = 'enterprise'; });
  await assert.rejects(() => e.verify(), /NEGATIVE_INVARIANT_FAILED/);
});

test('verified receipt is hash-bound and audit-anchored', async () => {
  const e = createPactEngine({ now: () => 1000 });
  await approved(e);
  await e.commit();
  const receipt = await e.verify();
  assert.match(receipt.receiptHash, /^[a-f0-9]{64}$/);
  assert.equal((await e.getReceipt()).receiptHash, receipt.receiptHash);
  e.__unsafeMutateForTest(tx => { tx.receipt.effects[0].after = 'tampered'; });
  await assert.rejects(() => e.getReceipt(), /RECEIPT_TAMPERED/);
});

test('audit-chain tampering fails closed', async () => {
  const e = createPactEngine({ now: () => 1000 });
  e.startIntent();
  await e.preview();
  e.__unsafeMutateAuditForTest(a => { a[0].type = 'FORGED'; });
  await assert.rejects(() => e.approve({ trusted: true }), /AUDIT_CHAIN_TAMPERED/);
});

test('cancel revokes transaction authority', async () => {
  const e = createPactEngine({ now: () => 1000 });
  await approved(e);
  e.cancel();
  await assert.rejects(() => e.commit(), /CANCELLED/);
});

test('rollback compensates a verified transaction once and rejects intervening drift', async () => {
  const e = createPactEngine({ now: () => 1000 });
  await approved(e); await e.commit(); await e.verify();
  const rb = await e.rollback();
  assert.equal(rb.rollbackVersion, 44);
  assert.equal(e.inspect().canonical.projects.helios.owner, 'acme-a');
  await assert.rejects(() => e.rollback(), /ALREADY_ROLLED_BACK/);

  const e2 = createPactEngine({ now: () => 1000 });
  await approved(e2); await e2.commit(); await e2.verify();
  e2.__unsafeMutateCanonicalForTest(s => { s.version++; s.tasks.t2.note = 'later edit'; });
  await assert.rejects(() => e2.rollback(), /ROLLBACK_CONFLICT/);
});

test('canonical stringify and sha256 are deterministic', async () => {
  assert.equal(canonicalStringify({b:1,a:2}), canonicalStringify({a:2,b:1}));
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('reference state returns a fresh independent object', () => {
  const a = makeReferenceState(); const b = makeReferenceState();
  a.people.maya.prod = false;
  assert.equal(b.people.maya.prod, true);
});

test('engine snapshot survives reload with verified receipt integrity', async () => {
  const e = createPactEngine({ now: () => 1000 });
  await approved(e); await e.commit(); const receipt = await e.verify();
  const restored = createPactEngine({ now: () => 2000, snapshot: e.exportSnapshot() });
  assert.equal((await restored.getReceipt()).receiptHash, receipt.receiptHash);
  assert.equal(restored.inspect().canonical.version, 43);
});

test('tampered persisted audit fails closed after reload', async () => {
  const e = createPactEngine({ now: () => 1000 });
  e.startIntent(); await e.preview();
  const snapshot = e.exportSnapshot();
  snapshot.audit[0].type = 'FORGED';
  const restored = createPactEngine({ snapshot });
  await assert.rejects(() => restored.approve({ trusted: true }), /AUDIT_CHAIN_TAMPERED/);
});

test('integrity validation rejects a tampered plan before recovered state can be used', async () => {
  const engine = createPactEngine();
  engine.startIntent();
  await engine.preview();
  const snapshot = engine.exportSnapshot();
  snapshot.transaction.effects[0].after = 'attacker';
  const restored = createPactEngine({ snapshot });
  await assert.rejects(() => restored.validateIntegrity(), /PLAN_TAMPERED/);
});

test('integrity validation accepts a valid verified snapshot and its receipt', async () => {
  const engine = createPactEngine();
  engine.startIntent(); await engine.preview(); await engine.approve({ trusted: true }); await engine.commit(); await engine.verify();
  const restored = createPactEngine({ snapshot: engine.exportSnapshot() });
  const result = await restored.validateIntegrity();
  assert.equal(result.ok, true);
  assert.equal(result.state, 'VERIFIED');
});

test('expired approval can be reconciled back to preview without changing the plan', async () => {
  let t = 1000;
  const engine = createPactEngine({ now: () => t, leaseMs: 50 });
  engine.startIntent(); await engine.preview(); await engine.approve({ trusted: true });
  const approved = engine.inspect().transaction;
  t = 1100;
  const result = await engine.reconcileExpiredApproval();
  const state = engine.inspect();
  assert.equal(result.expired, true);
  assert.equal(state.transaction.state, 'PREVIEWED');
  assert.equal(state.transaction.planHash, approved.planHash);
  assert.equal(state.lease, null);
  assert.equal(state.audit.at(-1).type, 'APPROVAL_EXPIRED');
});

test('valid approval is not reconciled or revoked early', async () => {
  let t = 1000;
  const engine = createPactEngine({ now: () => t, leaseMs: 500 });
  engine.startIntent(); await engine.preview(); await engine.approve({ trusted: true });
  const result = await engine.reconcileExpiredApproval();
  assert.equal(result.expired, false);
  assert.equal(engine.inspect().transaction.state, 'APPROVED');
  assert.ok(engine.inspect().lease);
});
