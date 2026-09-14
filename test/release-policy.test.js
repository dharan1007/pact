import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthorityStore } from '../src/authority.js';
import { createReleaseLock } from '../src/release-lock.js';
import { createReleaseRegistry } from '../src/release-registry.js';
import { diffReleaseLocks } from '../src/release-diff.js';
import { evaluateDrift } from '../src/release-drift.js';
import { evaluateGate } from '../src/release-gate.js';
import { attributeRegression } from '../src/release-attribution.js';

const base = () => ({
  agent: 'support-agent',
  environment: 'production',
  model: { provider: 'acme', id: 'm-1' },
  prompts: { system: 'Be helpful.' },
  tools: { 'crm.search': { schema_hash: 'sha256:1' } }
});
const lock = (d, now = 1_000) => createReleaseLock(d, { now: () => now });

test('drift flags undeclared live changes and ignores unobserved sections', async () => {
  const pinned = await lock(base());
  const drifted = await evaluateDrift(pinned, {
    model: { provider: 'acme', id: 'm-1' },
    tools: { 'crm.search': { schema_hash: 'sha256:2' } }
  });
  assert.equal(drifted.drifted, true);
  const kinds = Object.fromEntries(drifted.findings.map(finding => [finding.section, finding.kind]));
  assert.equal(kinds.tools, 'drifted');
  assert.equal(kinds.prompts, 'unobserved');
  const clean = await evaluateDrift(pinned, {
    model: { provider: 'acme', id: 'm-1' },
    prompts: { system: 'Be helpful.' },
    tools: { 'crm.search': { schema_hash: 'sha256:1' } }
  });
  assert.equal(clean.drifted, false);
});

test('drift rejects identity mismatches and unknown sections', async () => {
  const pinned = await lock(base());
  await assert.rejects(() => evaluateDrift(pinned, { agent: 'other', model: {} }), /PACT_DRIFT_IDENTITY_MISMATCH/);
  await assert.rejects(() => evaluateDrift(pinned, { model: {}, bogus: {} }), /PACT_LOCK_UNKNOWN_SECTION:bogus/);
});

test('gate blocks high severity, warns medium, allows clean, honors policy', async () => {
  const before = await lock(base());
  const breaking = await lock({ ...base(), tools: {} });
  const diff = await diffReleaseLocks(before, breaking);
  assert.equal(evaluateGate({ diff }).decision, 'BLOCK');
  assert.ok(evaluateGate({ diff }).reasons.some(reason => reason.startsWith('block:tools:breaking')));

  const behavioral = await lock({ ...base(), prompts: { system: 'Be terse.' } });
  const warnDiff = await diffReleaseLocks(before, behavioral);
  assert.equal(evaluateGate({ diff: warnDiff }).decision, 'WARN');
  assert.equal(evaluateGate({ diff: warnDiff, policy: { warnOnSeverities: [] } }).decision, 'ALLOW');
  assert.equal(
    evaluateGate({ diff: warnDiff, policy: { blockOnKinds: ['behavioral'] } }).decision,
    'BLOCK'
  );

  const clean = await diffReleaseLocks(before, before);
  assert.equal(evaluateGate({ diff: clean }).decision, 'ALLOW');
  assert.throws(() => evaluateGate({ diff: clean, policy: { unknown: true } }), /PACT_GATE_POLICY_UNKNOWN_KEY:unknown/);
});

test('gate blocks on live drift unless the policy opts out', async () => {
  const pinned = await lock(base());
  const drift = await evaluateDrift(pinned, { tools: { 'crm.search': { schema_hash: 'sha256:9' } } });
  const clean = await diffReleaseLocks(pinned, pinned);
  assert.equal(evaluateGate({ diff: clean, drift }).decision, 'BLOCK');
  assert.equal(evaluateGate({ diff: clean, drift, policy: { blockOnDrift: false } }).decision, 'ALLOW');
});

test('gate enforces replay ceilings from empirical reports', async () => {
  const { runExperiment, buildProveReport } = await import('../src/replay.js');
  const traces = [
    { traceId: 't1', agent: 'a', toolCalls: [{ tool: 'search', args: {} }] },
    { traceId: 't2', agent: 'a', toolCalls: [{ tool: 'search', args: {} }] }
  ];
  const experiment = await runExperiment({
    traces,
    seed: 3,
    baseline: async () => ({ toolCalls: [{ tool: 'search', args: {} }], output: 'ok', latencyMs: 100, costUsd: 0.01 }),
    candidate: async ({ traceId }) => traceId === 't2'
      ? { toolCalls: [{ tool: 'refund', args: {} }], output: 'ok', latencyMs: 400, costUsd: 0.05 }
      : { toolCalls: [{ tool: 'search', args: {} }], output: 'ok', latencyMs: 100, costUsd: 0.01 },
    isConsequential: name => name === 'refund',
    isDestructive: name => name === 'refund'
  });
  const report = buildProveReport({ experiment, protectedTraceIds: ['t2'] });
  const blocked = evaluateGate({
    replay: report,
    policy: { replayCeilings: { maxChangedOutcomeRate: 0.9, maxCostRisePct: 10, maxP95LatencyRisePct: 10 } }
  });
  assert.equal(blocked.decision, 'BLOCK');
  assert.ok(blocked.reasons.some(reason => reason.startsWith('block:replay:destructive-proposed')));
  assert.ok(blocked.reasons.some(reason => reason.startsWith('block:replay:changed-consequential:refund')));
  assert.ok(blocked.reasons.some(reason => reason.startsWith('block:replay:cost-rise-pct')));
  assert.ok(blocked.reasons.some(reason => reason.startsWith('block:replay:protected-trace:t2')));

  const lenient = evaluateGate({
    replay: report,
    policy: { replayCeilings: { blockOnChangedConsequential: false, maxCostRisePct: 1000, maxP95LatencyRisePct: 1000, maxChangedOutcomeRate: 1, maxDestructiveCount: 99 } }
  });
  assert.equal(lenient.decision, 'BLOCK');
  assert.deepEqual(lenient.reasons.filter(reason => reason.startsWith('block:replay:protected-trace')), ['block:replay:protected-trace:t2']);

  const clean = evaluateGate({ replay: buildProveReport({ experiment: await runExperiment({
    traces,
    seed: 3,
    baseline: async () => ({ toolCalls: [{ tool: 'search', args: {} }], output: 'ok' }),
    candidate: async () => ({ toolCalls: [{ tool: 'search', args: {} }], output: 'ok' })
  }) }), policy: { replayCeilings: {} } });
  assert.equal(clean.decision, 'ALLOW');

  assert.throws(
    () => evaluateGate({ policy: { replayCeilings: { maxChangedOutcomeRate: 2 } } }),
    /PACT_GATE_POLICY_REPLAY_RATE_INVALID/
  );
  assert.throws(
    () => evaluateGate({ policy: { replayCeilings: { unknownKey: 1 } } }),
    /PACT_GATE_POLICY_REPLAY_KEY_UNKNOWN:unknownKey/
  );
});

test('attribution orders changed dependencies deterministically without probabilities', async () => {
  const store = new MemoryAuthorityStore();
  const registry = createReleaseRegistry({ store });
  const good = await lock(base(), 1_000);
  const bad = await lock({
    ...base(),
    model: { provider: 'acme', id: 'm-2' },
    tools: {},
    prompts: { system: 'Be terse.' }
  }, 2_000);
  await registry.pin(good);
  await registry.pin(bad);
  const history = await registry.history({ agent: 'support-agent', environment: 'production' });
  const result = await attributeRegression({ getLock: id => registry.get(id), historyIds: history, badReleaseId: bad.releaseId });
  assert.equal(result.baselineReleaseId, good.releaseId);
  assert.deepEqual(result.candidates.map(candidate => candidate.section), ['tools', 'model', 'prompts']);
  for (const candidate of result.candidates) {
    assert.ok(!('probability' in candidate) && !('confidence' in candidate));
    assert.ok(['high', 'medium', 'low'].includes(candidate.severity));
  }
  const explicit = await attributeRegression({
    getLock: id => registry.get(id),
    badReleaseId: bad.releaseId,
    goodReleaseId: good.releaseId
  });
  assert.equal(explicit.baselineReleaseId, good.releaseId);
  await assert.rejects(
    attributeRegression({ getLock: id => registry.get(id), historyIds: [bad.releaseId], badReleaseId: bad.releaseId }),
    /PACT_ATTRIBUTION_NO_BASELINE/
  );
});
