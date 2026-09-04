import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtimeModule from '../src/runtime.js';

function integrationHarness() {
  let revision = 'r1';
  let state = { projects: { helios: { owner: 'ada' } }, billing: { plan: 'pro' } };
  let applyCalls = 0;
  const integration = {
    id: 'projects.remote',
    version: '1.0.0',
    async read() { return { revision, state: structuredClone(state) }; },
    async plan({ intent, state: current }) {
      return {
        effects: [{ path: `projects.${intent.projectId}.owner`, before: current.projects[intent.projectId].owner, after: intent.newOwner }],
        invariants: [{ path: 'billing.plan', equals: current.billing.plan }]
      };
    },
    async apply({ plan, idempotencyKey }) {
      applyCalls += 1;
      assert.equal(idempotencyKey, 'commit:helios');
      state.projects.helios.owner = plan.effects[0].after;
      revision = 'r2';
      return { providerRequestId: 'req_1' };
    },
    async verify({ state: current, plan }) {
      return current.projects.helios.owner === plan.effects[0].after;
    }
  };
  return {
    integration,
    mutateExternally() { state.projects.helios.owner = 'grace'; revision = 'r-stale'; },
    applyCalls: () => applyCalls
  };
}

const verifyApproval = async () => ({ humanPrincipal: 'user:42', agentSession: 'agent:abc' });

test('exports a runtime for real external integrations', () => {
  assert.equal(typeof runtimeModule.createPactExternalRuntime, 'function');
});

test('external runtime reads canonical remote state and applies the exact approved plan', async () => {
  const { integration, applyCalls } = integrationHarness();
  const runtime = runtimeModule.createPactExternalRuntime({ integration, verifyApproval });
  runtime.startIntent({ type: 'transfer_owner', projectId: 'helios', newOwner: 'maya' });
  const preview = await runtime.preview();
  assert.equal(preview.baseRevision, 'r1');
  assert.equal(preview.effects[0].before, 'ada');
  assert.equal(preview.effects[0].after, 'maya');
  await runtime.approve({ approval: { proof: 'signed' } });
  await assert.rejects(() => runtime.commit(), /PACT_EXTERNAL_IDEMPOTENCY_KEY_REQUIRED/);
  const committed = await runtime.commit({ idempotencyKey: 'commit:helios' });
  assert.equal(committed.state, 'COMMITTED');
  assert.equal(applyCalls(), 1);
  const receipt = await runtime.verify();
  assert.equal(receipt.baseRevision, 'r1');
  assert.equal(receipt.verifiedRevision, 'r2');
  assert.equal(receipt.approvalClaims.humanPrincipal, 'user:42');
  assert.equal(typeof receipt.receiptHash, 'string');
});

test('external runtime rejects stale remote state before calling the provider', async () => {
  const { integration, mutateExternally, applyCalls } = integrationHarness();
  const runtime = runtimeModule.createPactExternalRuntime({ integration, verifyApproval });
  runtime.startIntent({ type: 'transfer_owner', projectId: 'helios', newOwner: 'maya' });
  await runtime.preview();
  await runtime.approve({ approval: { proof: 'signed' } });
  mutateExternally();
  await assert.rejects(() => runtime.commit({ idempotencyKey: 'commit:helios' }), /PACT_EXTERNAL_STALE_REMOTE_STATE/);
  assert.equal(applyCalls(), 0);
});

test('external runtime can verify a lost-response commit without applying it twice', async () => {
  let revision = 'r1';
  let state = { flags: { enabled: false } };
  let calls = 0;
  const integration = {
    id: 'flags.remote', version: '1.0.0',
    async read() { return { revision, state: structuredClone(state) }; },
    async plan() { return { effects: [{ path: 'flags.enabled', before: false, after: true }], invariants: [] }; },
    async apply() {
      calls += 1;
      state.flags.enabled = true;
      revision = 'r2';
      throw new Error('NETWORK_RESPONSE_LOST');
    },
    async verify({ state: current }) { return current.flags.enabled === true; }
  };
  const runtime = runtimeModule.createPactExternalRuntime({ integration, verifyApproval });
  runtime.startIntent({ type: 'enable_flag' });
  await runtime.preview();
  await runtime.approve({ approval: { proof: 'signed' } });
  await assert.rejects(() => runtime.commit({ idempotencyKey: 'commit:flag' }), /PACT_EXTERNAL_COMMIT_UNCERTAIN/);
  assert.equal(runtime.inspect().transaction.state, 'COMMIT_UNCERTAIN');
  const receipt = await runtime.verify();
  assert.equal(receipt.recoveredFromUncertainCommit, true);
  assert.equal(calls, 1);
});

test('external runtime survives a process restart between approval and commit', async () => {
  const { integration, applyCalls } = integrationHarness();
  const first = runtimeModule.createPactExternalRuntime({ integration, verifyApproval });
  first.startIntent({ type: 'transfer_owner', projectId: 'helios', newOwner: 'maya' });
  await first.preview();
  await first.approve({ approval: { proof: 'signed' } });
  assert.equal(typeof first.exportSnapshot, 'function');
  const snapshot = first.exportSnapshot();

  const restarted = runtimeModule.createPactExternalRuntime({ integration, verifyApproval });
  assert.equal(typeof restarted.restoreSnapshot, 'function');
  await restarted.restoreSnapshot(snapshot);
  assert.equal(restarted.inspect().transaction.state, 'APPROVED');
  await restarted.commit({ idempotencyKey: 'commit:helios' });
  const receipt = await restarted.verify();
  assert.equal(receipt.verifiedRevision, 'r2');
  assert.equal(applyCalls(), 1);
});

test('external runtime restoration rejects tampered plan and a different integration identity', async () => {
  const { integration } = integrationHarness();
  const first = runtimeModule.createPactExternalRuntime({ integration, verifyApproval });
  first.startIntent({ type: 'transfer_owner', projectId: 'helios', newOwner: 'maya' });
  await first.preview();
  const snapshot = first.exportSnapshot();
  snapshot.transaction.effects[0].after = 'attacker';
  const restarted = runtimeModule.createPactExternalRuntime({ integration, verifyApproval });
  await assert.rejects(() => restarted.restoreSnapshot(snapshot), /PACT_EXTERNAL_SNAPSHOT_PLAN_TAMPERED/);

  const other = { ...integration, id: 'other.remote' };
  const wrongRuntime = runtimeModule.createPactExternalRuntime({ integration: other, verifyApproval });
  const clean = first.exportSnapshot();
  await assert.rejects(() => wrongRuntime.restoreSnapshot(clean), /PACT_EXTERNAL_SNAPSHOT_INTEGRATION_MISMATCH/);
});
