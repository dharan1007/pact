import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseLock } from '../src/release-lock.js';
import { isolateRegression } from '../src/release-bisect.js';
import { validateCanaryPlan, evaluateCanaryStep } from '../src/release-canary.js';

const base = () => ({
  agent: 'support-agent',
  environment: 'production',
  model: { provider: 'acme', id: 'm-1' },
  prompts: { system: 'Be helpful.' },
  tools: { 'crm.search': { schema_hash: 'sha256:1' } }
});
const lock = (d, now = 1_000) => createReleaseLock(d, { now: () => now });

test('bisect isolates the single reproducing section with hybrid evidence', async () => {
  const baseline = await lock(base());
  const candidate = await lock({ ...base(), tools: { 'crm.search': { schema_hash: 'sha256:2' } } }, 2_000);
  const evaluate = async subject => subject.sections.tools.content['crm.search'].schema_hash === 'sha256:2' ? 'fail' : 'pass';
  const result = await isolateRegression({ baselineLock: baseline, candidateLock: candidate, evaluate, now: () => 4_000 });
  assert.equal(result.conclusion, 'isolated');
  assert.equal(result.section, 'tools');
  assert.deepEqual(Object.keys(result.evidence.hybrids).sort(), ['tools']);
  assert.equal(result.evidence.hybrids.tools, 'fail');
});

test('bisect reports inconclusive and multi-candidate outcomes honestly', async () => {
  const baseline = await lock(base());
  const candidate = await lock({ ...base(), model: { provider: 'acme', id: 'm-2' } }, 2_000);
  const passing = await isolateRegression({
    baselineLock: baseline,
    candidateLock: candidate,
    evaluate: async () => 'pass'
  });
  assert.equal(passing.conclusion, 'not-reproduced');
  const twoChange = await lock({ ...base(), prompts: { system: 'Other.' }, model: { provider: 'acme', id: 'm-2' } }, 2_000);
  const none = await isolateRegression({
    baselineLock: baseline,
    candidateLock: twoChange,
    evaluate: async subject => (subject.releaseId === twoChange.releaseId ? 'fail' : 'pass')
  });
  assert.equal(none.conclusion, 'inconclusive');
  const uncertain = await isolateRegression({
    baselineLock: baseline,
    candidateLock: candidate,
    evaluate: async () => 'uncertain'
  });
  assert.equal(uncertain.conclusion, 'inconclusive');
  await assert.rejects(
    isolateRegression({ baselineLock: baseline, candidateLock: baseline, evaluate: async () => 'pass' }),
    /PACT_BISECT_SAME_RELEASE/
  );
  await assert.rejects(
    isolateRegression({ baselineLock: baseline, candidateLock: candidate, evaluate: async () => 'maybe' }),
    /PACT_BISECT_VERDICT_INVALID/
  );
});

test('canary plans validate and steps evaluate deterministically', () => {
  const plan = validateCanaryPlan({ steps: [{ percent: 5, bakeMs: 600_000 }, { percent: 100, bakeMs: 3_600_000 }] });
  assert.equal(plan.length, 2);
  assert.throws(() => validateCanaryPlan({ steps: [{ percent: 100, bakeMs: 1_000 }] }), /PACT_CANARY_BAKE_INVALID:0/);
  assert.throws(() => validateCanaryPlan({ steps: [{ percent: 50, bakeMs: 600_000 }] }), /PACT_CANARY_MUST_REACH_100/);
  assert.throws(
    () => validateCanaryPlan({ steps: [{ percent: 50, bakeMs: 600_000 }, { percent: 25, bakeMs: 600_000 }, { percent: 100, bakeMs: 600_000 }] }),
    /PACT_CANARY_PERCENT_NOT_ASCENDING:1/
  );

  assert.deepEqual(
    evaluateCanaryStep({ metrics: { failureRate: 0.001 }, thresholds: { maxFailureRate: 0.01 } }).decision,
    'promote'
  );
  const rollback = evaluateCanaryStep({
    metrics: { failureRate: 0.05, destructiveProposed: 2 },
    thresholds: { maxFailureRate: 0.01, maxDestructiveCount: 0 }
  });
  assert.equal(rollback.decision, 'rollback');
  assert.ok(rollback.reasons.includes('rollback:failure-rate:0.05'));
  const hold = evaluateCanaryStep({
    metrics: { failureRate: 0, uncertainTraces: 3 },
    thresholds: { maxFailureRate: 0.01 }
  });
  assert.equal(hold.decision, 'hold');
  assert.throws(
    () => evaluateCanaryStep({ metrics: {}, thresholds: { bogus: 1 } }),
    /PACT_CANARY_THRESHOLD_UNKNOWN:bogus/
  );
});
