import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthorityStore } from '../src/authority.js';
import {
  normalizeTraceEvent,
  fromOtelSpan,
  redactEvent,
  createTraceCorpus,
  mulberry32
} from '../src/trace-corpus.js';

const event = () => ({
  traceId: 'tr-1',
  agent: 'support-agent',
  releaseId: `pact_${'a'.repeat(64)}`,
  model: 'm-1',
  promptHash: 'sha256:abc',
  toolCalls: [{ tool: 'crm.search', args: { q: 'acme', token: 's3cret' } }],
  output: { answer: 'ok' },
  latencyMs: 1200,
  costUsd: 0.02,
  outcome: 'success',
  ts: 1720000000000
});

test('corpus normalizes events and fails closed on malformed input', () => {
  const normalized = normalizeTraceEvent(event());
  assert.equal(normalized.outcome, 'success');
  assert.equal(normalizeTraceEvent({ traceId: 't', agent: 'a' }).outcome, 'unknown');
  assert.throws(() => normalizeTraceEvent({ agent: 'a' }), /PACT_CORPUS_TRACE_ID_REQUIRED/);
  assert.throws(() => normalizeTraceEvent({ traceId: 't', agent: 'a', outcome: 'maybe' }), /PACT_CORPUS_OUTCOME_INVALID/);
  assert.throws(
    () => normalizeTraceEvent({ traceId: 't', agent: 'a', releaseId: 'nope' }),
    /PACT_CORPUS_RELEASE_ID_INVALID/
  );
});

test('otel spans map through the pact attribute namespace', () => {
  const normalized = fromOtelSpan({
    traceId: 'ignored-root-field',
    attributes: {
      'pact.trace_id': 'tr-otel',
      'pact.agent': 'support-agent',
      'pact.release_id': `pact_${'b'.repeat(64)}`,
      'pact.model': 'm-2',
      'pact.tool.calls': JSON.stringify([{ tool: 'crm.search', args: { q: 'x' } }]),
      'pact.cost_usd': 0.05
    },
    startTimeUnixNano: '1720000000000000000',
    endTimeUnixNano: '1720000001500000000',
    status: { code: 1 }
  });
  assert.equal(normalized.traceId, 'tr-otel');
  assert.equal(normalized.latencyMs, 1500);
  assert.equal(normalized.toolCalls.length, 1);
  const failed = fromOtelSpan({
    attributes: { 'pact.trace_id': 'tr-err', 'pact.agent': 'a' },
    status: { code: 2 }
  });
  assert.equal(failed.outcome, 'failure');
  assert.throws(() => fromOtelSpan({ attributes: {} }), /PACT_CORPUS_TRACE_ID_REQUIRED/);
});

test('redaction removes paths and sensitive keys with an audit list', () => {
  const { event: redacted, redacted: fired } = redactEvent(event(), { paths: ['output.answer', 'toolCalls.*.args.q'] });
  assert.equal(redacted.output.answer, '[REDACTED]');
  assert.equal(redacted.toolCalls[0].args.q, '[REDACTED]');
  assert.equal(redacted.toolCalls[0].args.token, '[REDACTED]');
  assert.ok(fired.includes('output.answer'));
  assert.ok(fired.includes('toolCalls[0].args.q'));
  assert.ok(fired.includes('toolCalls[0].args.token'));
  assert.throws(() => redactEvent(event(), { paths: [''] }), /PACT_CORPUS_REDACT_PATH_INVALID/);
});

test('corpus appends idempotently, rejects conflicts, samples deterministically', async () => {
  const corpus = createTraceCorpus({ store: new MemoryAuthorityStore() });
  const first = await corpus.append(event());
  assert.equal(first.idempotentReplay, false);
  const replay = await corpus.append(structuredClone(event()));
  assert.equal(replay.idempotentReplay, true);
  const changed = { ...structuredClone(event()), outcome: 'failure' };
  await assert.rejects(() => corpus.append(changed), /PACT_CORPUS_CONFLICT/);
  assert.deepEqual(await corpus.list('support-agent'), ['tr-1']);
  assert.deepEqual(await corpus.list('unknown-agent'), []);
  await assert.rejects(() => corpus.get('missing'), /PACT_CORPUS_NOT_FOUND/);

  for (let index = 2; index <= 6; index += 1) {
    await corpus.append({ traceId: `tr-${index}`, agent: 'support-agent' });
  }
  const firstSample = await corpus.sample('support-agent', { n: 3, seed: 42 });
  const secondSample = await corpus.sample('support-agent', { n: 3, seed: 42 });
  assert.deepEqual(firstSample.map(entry => entry.traceId), secondSample.map(entry => entry.traceId));
  assert.equal(firstSample.length, 3);
  const otherSeed = await corpus.sample('support-agent', { n: 3, seed: 7 });
  assert.notDeepEqual(
    firstSample.map(entry => entry.traceId),
    otherSeed.map(entry => entry.traceId)
  );
  assert.throws(() => mulberry32(1.5), /PACT_CORPUS_SEED_INVALID/);
});
