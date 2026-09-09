import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendEvidence,
  createEvidenceGenesis,
  verifyEvidenceChain
} from '../src/evidence-chain.js';

const baseContext = Object.freeze({
  sagaId: 'saga_evidence_test',
  planHash: 'a'.repeat(64)
});

test('evidence chain is deterministic, ordered, and independently verifiable', async () => {
  let chain = await createEvidenceGenesis({
    ...baseContext,
    createdAt: 1_000,
    plan: { steps: [{ id: 'identity', resourceKey: 'identity:42' }] }
  });

  chain = await appendEvidence(chain, {
    type: 'APPROVAL_BOUND',
    occurredAt: 1_100,
    actor: { humanPrincipal: 'human:ada', agentSession: 'agent:7' },
    payload: { approvalBinding: 'b'.repeat(64) }
  });
  chain = await appendEvidence(chain, {
    type: 'PROVIDER_MUTATION_VERIFIED',
    occurredAt: 1_200,
    stepId: 'identity',
    payload: { beforeVersion: 4, afterVersion: 5, providerRevision: 'etag-5' }
  });

  const verified = await verifyEvidenceChain(chain);
  assert.equal(verified.valid, true);
  assert.equal(verified.eventCount, 3);
  assert.equal(verified.headHash, chain.headHash);
  assert.equal(chain.events[0].sequence, 0);
  assert.equal(chain.events[1].sequence, 1);
  assert.equal(chain.events[2].sequence, 2);
  assert.equal(chain.events[1].previousHash, chain.events[0].eventHash);
  assert.equal(chain.events[2].previousHash, chain.events[1].eventHash);

  const replay = await createEvidenceGenesis({
    ...baseContext,
    createdAt: 1_000,
    plan: { steps: [{ id: 'identity', resourceKey: 'identity:42' }] }
  });
  const replay2 = await appendEvidence(replay, {
    type: 'APPROVAL_BOUND',
    occurredAt: 1_100,
    actor: { humanPrincipal: 'human:ada', agentSession: 'agent:7' },
    payload: { approvalBinding: 'b'.repeat(64) }
  });
  const replay3 = await appendEvidence(replay2, {
    type: 'PROVIDER_MUTATION_VERIFIED',
    occurredAt: 1_200,
    stepId: 'identity',
    payload: { beforeVersion: 4, afterVersion: 5, providerRevision: 'etag-5' }
  });
  assert.equal(replay3.headHash, chain.headHash);
});

test('evidence verification fails closed on payload tampering, reordering, deletion, or broken linkage', async () => {
  let chain = await createEvidenceGenesis({ ...baseContext, createdAt: 2_000, plan: { steps: [{ id: 'one' }] } });
  chain = await appendEvidence(chain, { type: 'STEP_STARTED', occurredAt: 2_100, stepId: 'one', payload: { fence: 3 } });
  chain = await appendEvidence(chain, { type: 'STEP_COMMITTED', occurredAt: 2_200, stepId: 'one', payload: { revision: 9 } });

  const tampered = structuredClone(chain);
  tampered.events[1].payload.fence = 99;
  await assert.rejects(() => verifyEvidenceChain(tampered), /PACT_EVIDENCE_HASH_MISMATCH/);

  const reordered = structuredClone(chain);
  [reordered.events[1], reordered.events[2]] = [reordered.events[2], reordered.events[1]];
  await assert.rejects(() => verifyEvidenceChain(reordered), /PACT_EVIDENCE_SEQUENCE_MISMATCH/);

  const deleted = structuredClone(chain);
  deleted.events.splice(1, 1);
  await assert.rejects(() => verifyEvidenceChain(deleted), /PACT_EVIDENCE_SEQUENCE_MISMATCH|PACT_EVIDENCE_PREVIOUS_HASH_MISMATCH/);

  const broken = structuredClone(chain);
  broken.events[2].previousHash = 'f'.repeat(64);
  await assert.rejects(() => verifyEvidenceChain(broken), /PACT_EVIDENCE_PREVIOUS_HASH_MISMATCH/);
});

test('evidence append refuses a corrupt existing chain and non-JSON evidence', async () => {
  let chain = await createEvidenceGenesis({ ...baseContext, createdAt: 3_000, plan: { steps: [] } });
  chain = await appendEvidence(chain, { type: 'APPROVED', occurredAt: 3_100, payload: { ok: true } });

  const corrupt = structuredClone(chain);
  corrupt.headHash = '0'.repeat(64);
  await assert.rejects(
    () => appendEvidence(corrupt, { type: 'SHOULD_NOT_APPEND', occurredAt: 3_200, payload: {} }),
    /PACT_EVIDENCE_HEAD_HASH_MISMATCH/
  );

  await assert.rejects(
    () => appendEvidence(chain, { type: 'INVALID', occurredAt: 3_200, payload: { value: BigInt(1) } }),
    /PACT_EVIDENCE_PAYLOAD_MUST_BE_JSON/
  );
});
