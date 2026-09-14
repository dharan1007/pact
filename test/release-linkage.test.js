import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { MemoryAuthorityStore } from '../src/authority.js';
import { canonicalStringify } from '../src/engine.js';
import { createPactApiAuthorityService } from '../src/api-authority.js';
import { createHmacApprovalVerifier } from '../src/server-approval.js';
import { createReleaseEffectIndex } from '../src/release-effects.js';
import { executeReleaseRecovery, summarizeRecovery } from '../src/release-recovery.js';
import { createReleaseLock } from '../src/release-lock.js';

const SECRET = 'r'.repeat(48);
const RELEASE = `pact_${'c'.repeat(64)}`;

const adapter = {
  id: 'example.flags',
  version: '1.0.0',
  async plan({ intent, state }) {
    return {
      effects: [{ path: `flags.${intent.key}`, before: state.flags[intent.key], after: intent.value }],
      invariants: []
    };
  },
  async verify({ state, plan }) {
    return plan.effects.every(effect => effect.path.split('.').reduce((node, key) => node?.[key], state) === effect.after);
  }
};

function makeService() {
  const canonical = { version: 0, flags: { beta: false } };
  const service = createPactApiAuthorityService({
    store: new MemoryAuthorityStore(),
    verifyApproval: createHmacApprovalVerifier({ secret: SECRET, now: () => 50_000 }),
    adapters: [adapter],
    readCanonical: async () => structuredClone(canonical),
    commitCanonical: async ({ expectedVersion, nextState }) => {
      if (canonical.version !== expectedVersion) throw new Error('PACT_API_STALE_CANONICAL_STATE');
      Object.keys(canonical).forEach(key => delete canonical[key]);
      Object.assign(canonical, structuredClone(nextState));
      return structuredClone(canonical);
    },
    now: () => 50_000
  });
  return service;
}

function signApproval({ transaction, releaseId = undefined, secret = SECRET }) {
  const claims = { humanPrincipal: 'human:ops', agentSession: 'agent:release', expiresAt: 100_000, nonce: `n-${transaction.id}` };
  if (releaseId !== undefined) claims.releaseId = releaseId;
  const message = canonicalStringify({
    txId: transaction.id,
    planHash: transaction.planHash,
    baseVersion: transaction.baseVersion,
    adapter: transaction.adapter,
    claims
  });
  return { ...claims, signature: createHmac('sha256', secret).update(message).digest('hex') };
}

async function fullCycle(service, { releaseId = undefined, approvalReleaseId = undefined } = {}) {
  const preview = await service.preview({
    adapter: { id: adapter.id, version: adapter.version },
    intent: { key: 'beta', value: true },
    ...(releaseId === undefined ? {} : { releaseId })
  });
  const approved = await service.approve({
    transactionId: preview.transaction.id,
    approval: signApproval({ transaction: preview.transaction, releaseId: approvalReleaseId })
  });
  const key = `cycle-${preview.transaction.id}`;
  await service.commit({ transactionId: preview.transaction.id, capabilityToken: approved.capability.token, idempotencyKey: key });
  return service.verify({ transactionId: preview.transaction.id });
}

test('approval-bound release id flows to the receipt', async () => {
  const service = makeService();
  const { receipt } = await fullCycle(service, { approvalReleaseId: RELEASE });
  assert.equal(receipt.releaseId, RELEASE);
  assert.equal(receipt.approvalClaims.releaseId, RELEASE);
});

test('preview-supplied release id flows to the receipt without approval binding', async () => {
  const service = makeService();
  const { receipt } = await fullCycle(service, { releaseId: RELEASE });
  assert.equal(receipt.releaseId, RELEASE);
  assert.ok(!('releaseId' in receipt.approvalClaims));
});

test('receipts without any release stay unchanged', async () => {
  const service = makeService();
  const { receipt } = await fullCycle(service, {});
  assert.ok(!('releaseId' in receipt));
  assert.ok(!('releaseId' in receipt.approvalClaims));
});

test('release linkage fails closed on forgery and malformed ids', async () => {
  const service = makeService();
  const preview = await service.preview({ adapter: { id: adapter.id, version: adapter.version }, intent: { key: 'beta', value: true } });
  const forged = signApproval({ transaction: preview.transaction });
  forged.releaseId = RELEASE;
  await assert.rejects(
    service.approve({ transactionId: preview.transaction.id, approval: forged }),
    /PACT_API_APPROVAL_REJECTED|PACT_AUTHORITY_APPROVAL_REJECTED/
  );
  await assert.rejects(
    service.preview({ adapter: { id: adapter.id, version: adapter.version }, intent: { key: 'beta', value: true }, releaseId: 'nope' }),
    /PACT_API_RELEASE_ID_INVALID/
  );
  const badFormat = signApproval({ transaction: preview.transaction, releaseId: 'nope' });
  await assert.rejects(
    service.approve({ transactionId: preview.transaction.id, approval: badFormat }),
    /PACT_API_APPROVAL_REJECTED|PACT_AUTHORITY_APPROVAL_REJECTED/
  );
});

test('release effect index enumerates exactly the linked receipts', async () => {
  const service = makeService();
  const first = await fullCycle(service, { approvalReleaseId: RELEASE });
  const second = await fullCycle(service, { approvalReleaseId: RELEASE });
  const index = createReleaseEffectIndex({ store: new MemoryAuthorityStore() });
  await index.indexReceipt(first.receipt);
  await index.indexReceipt(second.receipt);
  const replay = await index.indexReceipt(structuredClone(first.receipt));
  assert.equal(replay.txId, first.receipt.txId);
  const effects = await index.listEffects(RELEASE);
  assert.equal(effects.length, 2);
  const summary = await summarizeEffectsOf(index, RELEASE);
  assert.equal(summary.effects, 2);
  assert.deepEqual(summary.adapters, { 'example.flags@1.0.0': 2 });
  const unlinked = structuredClone(second.receipt);
  delete unlinked.releaseId;
  await assert.rejects(() => index.indexReceipt(unlinked), /PACT_EFFECTS_RELEASE_REQUIRED/);
  await assert.rejects(() => index.listEffects('bogus'), /PACT_EFFECTS_RELEASE_ID_REQUIRED|PACT_RELEASE_ID_INVALID/);
  assert.deepEqual(await index.listEffects(`pact_${'f'.repeat(64)}`), []);
});

async function summarizeEffectsOf(index, releaseId) {
  return index.summarizeEffects(releaseId);
}

test('release recovery executes caller resolvers with deterministic evidence', async () => {
  const lock = await createReleaseLock({ agent: 'a', environment: 'e', tools: { t: {} } }, { now: () => 1 });
  void lock;
  const calls = [];
  const evidence = await executeReleaseRecovery({
    effects: [
      { txId: 'tx-1', releaseId: RELEASE, adapter: { id: 'crm', version: '1' } },
      { txId: 'tx-2', releaseId: RELEASE, adapter: { id: 'billing', version: '1' } },
      { txId: 'tx-3', releaseId: RELEASE, adapter: { id: 'unknown', version: '1' } },
      { txId: 'tx-4', releaseId: RELEASE, adapter: { id: 'flaky', version: '1' } }
    ],
    resolvers: {
      crm: async ({ effect, idempotencyKey }) => {
        calls.push(idempotencyKey);
        assert.equal(effect.txId, 'tx-1');
        return { status: 'reversed', detail: 'restored prior owner' };
      },
      billing: async () => ({ status: 'irreversible', detail: 'settled funds' }),
      flaky: async () => { throw new Error('provider timeout'); }
    },
    idempotencyPrefix: 'rec-1',
    now: () => 9_000
  });
  assert.deepEqual(evidence.map(entry => entry.status), ['reversed', 'irreversible', 'unresolved', 'uncertain']);
  assert.deepEqual(calls, ['rec-1:tx-1:crm']);
  assert.deepEqual(summarizeRecovery(evidence), {
    effects: 4,
    byStatus: { reversed: 1, irreversible: 1, unresolved: 1, uncertain: 1 }
  });
  await assert.rejects(() => executeReleaseRecovery({ effects: [], resolvers: {} }), /PACT_RECOVERY_EFFECTS_REQUIRED/);
  await assert.rejects(
    () => executeReleaseRecovery({
      effects: [{ txId: 'x', adapter: { id: 'a', version: '1' } }],
      resolvers: { a: async () => ({ status: 'bogus' }) }
    }),
    /PACT_RECOVERY_RESOLUTION_INVALID/
  );
  await assert.rejects(
    () => executeReleaseRecovery({ effects: [{ adapter: { id: 'a' } }], resolvers: { a: async () => ({ status: 'reversed' }) } }),
    /PACT_RECOVERY_TX_ID_REQUIRED/
  );
});
