import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAgainstSchema,
  decisionCompatReplay,
  createReplayToolClient,
  runExperiment,
  wilson,
  percentile,
  buildProveReport
} from '../src/replay.js';
import { createReleaseLock } from '../src/release-lock.js';

test('subset schema validator accepts, rejects and declares unknowns', () => {
  const schema = {
    type: 'object',
    properties: { q: { type: 'string' }, limit: { type: 'integer', enum: [5, 10] } },
    required: ['q'],
    additionalProperties: false
  };
  assert.equal(validateAgainstSchema({ q: 'x' }, schema).verdict, 'compatible');
  assert.equal(validateAgainstSchema({}, schema).verdict, 'incompatible');
  assert.equal(validateAgainstSchema({ q: 'x', extra: 1 }, schema).verdict, 'incompatible');
  assert.equal(validateAgainstSchema({ q: 'x', limit: 7 }, schema).verdict, 'incompatible');
  assert.equal(validateAgainstSchema({ q: 4 }, schema).verdict, 'incompatible');
  assert.equal(validateAgainstSchema('anything', true).verdict, 'compatible');
  assert.equal(validateAgainstSchema('anything', false).verdict, 'incompatible');
  assert.equal(validateAgainstSchema({ q: 'x' }, { type: 'object', pattern: '^x' }).verdict, 'unknown');
  assert.equal(validateAgainstSchema([1, 'a'], { items: { type: 'integer' } }).verdict, 'incompatible');
});

test('decision compat distinguishes removed, changed and opaque contracts', async () => {
  const baseline = await createReleaseLock({
    agent: 'a',
    environment: 'production',
    tools: {
      'crm.search': { schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
      'crm.delete': { schema_hash: 'sha256:1' },
      legacy: { schema_hash: 'sha256:9' }
    }
  }, { now: () => 1_000 });
  const candidate = await createReleaseLock({
    agent: 'a',
    environment: 'production',
    tools: {
      'crm.search': { schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
      'crm.delete': { schema_hash: 'sha256:2' }
    }
  }, { now: () => 2_000 });
  const traces = [{ traceId: 't1', agent: 'a', toolCalls: [
    { tool: 'crm.search', args: { q: 'acme' } },
    { tool: 'crm.delete', args: { id: '1' } },
    { tool: 'legacy', args: {} }
  ] }];
  const report = await decisionCompatReplay({ traces, baselineLock: baseline, candidateLock: candidate });
  const byTool = Object.fromEntries(report.details.map(detail => [detail.tool, detail.verdict]));
  assert.equal(byTool['crm.search'], 'compatible');
  assert.equal(byTool['crm.delete'], 'unknown');
  assert.equal(byTool.legacy, 'broken');
  assert.deepEqual(report.totals, { calls: 3, compatible: 1, broken: 1, incompatible: 0, unknown: 1 });

  const withContracts = await decisionCompatReplay({
    traces,
    baselineLock: baseline,
    candidateLock: candidate,
    contracts: { tools: { 'crm.delete': { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } }
  });
  assert.equal(withContracts.details.find(detail => detail.tool === 'crm.delete').verdict, 'compatible');
  await assert.rejects(() => decisionCompatReplay({ traces: [] }), /PACT_REPLAY_TRACES_REQUIRED/);
});

test('replay tool client never executes and flags unmatched proposals', async () => {
  let sideEffects = 0;
  const client = createReplayToolClient({
    recorded: [{ tool: 'crm.search', args: { q: 'x' }, result: { rows: 1 } }],
    onPropose: async () => { sideEffects += 1; }
  });
  const hit = await client.invoke('crm.search', { q: 'x' });
  assert.equal(hit.executed, false);
  assert.equal(hit.matched, true);
  assert.deepEqual(hit.result, { rows: 1 });
  const miss = await client.invoke('crm.delete', { id: '9' });
  assert.equal(miss.executed, false);
  assert.equal(miss.unmatched, true);
  assert.equal(sideEffects, 2);
  assert.equal(client.proposals().length, 2);
});

test('experiment compares runners with deterministic sampling and wilson math', async () => {
  const traces = [
    { traceId: 't1', agent: 'a', toolCalls: [{ tool: 'search', args: {} }] },
    { traceId: 't2', agent: 'a', toolCalls: [{ tool: 'search', args: {} }] },
    { traceId: 't3', agent: 'a', toolCalls: [{ tool: 'search', args: {} }] }
  ];
  const baseline = async () => ({ toolCalls: [{ tool: 'search', args: {} }], output: 'same', latencyMs: 100 });
  const candidate = async ({ traceId }) => traceId === 't2'
    ? { toolCalls: [{ tool: 'refund', args: {} }], output: 'same', latencyMs: 200 }
    : { toolCalls: [{ tool: 'search', args: {} }], output: 'same', latencyMs: 100 };
  const first = await runExperiment({
    traces,
    seed: 5,
    baseline,
    candidate,
    isConsequential: name => name === 'refund',
    isDestructive: name => name === 'refund'
  });
  const second = await runExperiment({
    traces,
    seed: 5,
    baseline,
    candidate,
    isConsequential: name => name === 'refund',
    isDestructive: name => name === 'refund'
  });
  assert.deepEqual(first.perTrace.map(entry => entry.traceId), second.perTrace.map(entry => entry.traceId));
  const changed = first.perTrace.find(entry => entry.traceId === 't2');
  assert.equal(changed.callsMatch, false);
  assert.deepEqual(changed.changedConsequential, ['refund']);
  assert.deepEqual(changed.destructive, ['refund']);

  const zero = wilson(0, 10);
  assert.equal(zero.rate, 0);
  assert.equal(zero.lower, 0);
  assert.ok(zero.upper > 0);
  const full = wilson(10, 10);
  assert.ok(full.lower < 1);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([5], 0.95), 5);

  const report = buildProveReport({ experiment: first, baselineReleaseId: 'b', candidateReleaseId: 'c', generatedAt: 7_000 });
  assert.equal(report.sample.evaluated, 3);
  assert.equal(report.outcomes.changed.count, 1);
  assert.deepEqual(report.toolDecisions.destructiveProposed, ['refund']);
  assert.equal(report.latency.candidate.p95, 190);
  assert.equal(report.generatedAt, 7_000);
  await assert.rejects(() => runExperiment({ traces: [] }), /PACT_REPLAY_TRACES_REQUIRED/);
});
