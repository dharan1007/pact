import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactEngine } from '../src/engine.js';
import { createPactOrchestrator } from '../src/orchestrator.js';

test('begin automatically prepares exact plan and stops at human approval', async () => {
  const engine = createPactEngine();
  const persisted = [];
  const flow = createPactOrchestrator({ engine, persist: async s => persisted.push(s) });
  const result = await flow.begin();
  assert.equal(result.phase, 'AWAITING_APPROVAL');
  assert.equal(engine.inspect().transaction.state, 'PREVIEWED');
  assert.equal(persisted.length, 1);
  assert.ok(engine.inspect().transaction.planHash);
});

test('orchestrator cannot synthesize human approval', async () => {
  const engine = createPactEngine();
  const flow = createPactOrchestrator({ engine, persist: async () => {} });
  await flow.begin();
  await assert.rejects(() => flow.approveAndFinish({ trusted: false }), /TRUSTED_GESTURE_REQUIRED/);
  assert.equal(engine.inspect().transaction.state, 'PREVIEWED');
});

test('trusted approval automatically commits verifies and returns receipt', async () => {
  const engine = createPactEngine();
  let writes = 0;
  const flow = createPactOrchestrator({ engine, persist: async () => { writes++; } });
  await flow.begin();
  const result = await flow.approveAndFinish({ trusted: true });
  assert.equal(result.phase, 'VERIFIED');
  assert.equal(engine.inspect().transaction.state, 'VERIFIED');
  assert.match(result.receipt.receiptHash, /^[a-f0-9]{64}$/);
  assert.equal(writes, 4);
});

test('concurrent canonical change stops autopilot before commit', async () => {
  const engine = createPactEngine();
  const flow = createPactOrchestrator({ engine, persist: async () => {} });
  await flow.begin();
  await engine.approve({ trusted: true });
  engine.simulateConcurrentEdit();
  await assert.rejects(() => flow.finishApproved(), /STALE_PLAN/);
  assert.equal(engine.inspect().transaction.state, 'STALE');
});

test('persistence failure restores the pre-action snapshot', async () => {
  const engine = createPactEngine();
  const before = engine.exportSnapshot();
  const flow = createPactOrchestrator({ engine, persist: async () => { throw new Error('WRITE_FAILED'); } });
  await assert.rejects(() => flow.begin(), /WRITE_FAILED/);
  assert.deepEqual(engine.exportSnapshot(), before);
});

test('committed recovery resumes verification without another approval', async () => {
  const engine = createPactEngine();
  engine.startIntent();
  await engine.preview();
  await engine.approve({ trusted: true });
  await engine.commit();
  const writes = [];
  const flow = createPactOrchestrator({ engine, persist: async s => writes.push(s) });
  const result = await flow.resumeCommitted();
  assert.equal(result.phase, 'VERIFIED');
  assert.equal(engine.inspect().transaction.state, 'VERIFIED');
  assert.equal(writes.length, 1);
  assert.match(result.receipt.receiptHash, /^[a-f0-9]{64}$/);
});

test('committed recovery refuses to run from non-committed state', async () => {
  const engine = createPactEngine();
  const flow = createPactOrchestrator({ engine, persist: async () => {} });
  await assert.rejects(() => flow.resumeCommitted(), /NOT_COMMITTED/);
});

test('committed recovery is idempotent and does not create a second commit', async () => {
  const engine = createPactEngine({ now: (() => { let t = 1000; return () => ++t; })() });
  engine.startIntent();
  await engine.preview();
  await engine.approve({ trusted: true });
  await engine.commit();
  const before = engine.inspect();
  const commitEventsBefore = before.audit.filter(e => e.type === 'COMMITTED').length;
  const flow = createPactOrchestrator({ engine, persist: async () => {} });
  const result = await flow.resumeCommitted();
  const after = engine.inspect();
  assert.equal(result.phase, 'VERIFIED');
  assert.equal(after.audit.filter(e => e.type === 'COMMITTED').length, commitEventsBefore);
  assert.equal(after.audit.filter(e => e.type === 'RECEIPT').length, 1);
});

test('resume approved converts expired authority into a safe re-approval checkpoint', async () => {
  let t = 1000;
  const engine = createPactEngine({ now: () => t, leaseMs: 50 });
  engine.startIntent(); await engine.preview(); await engine.approve({ trusted: true });
  t = 1100;
  const writes=[];
  const flow=createPactOrchestrator({engine,persist:async s=>writes.push(s)});
  const result=await flow.resumeApproved();
  assert.equal(result.phase,'AWAITING_APPROVAL');
  assert.equal(result.expired,true);
  assert.equal(engine.inspect().transaction.state,'PREVIEWED');
  assert.equal(writes.length,1);
});
