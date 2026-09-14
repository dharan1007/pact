import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const EXPECTED = {
  '../src/release-lock.js': ['lockSectionNames', 'createReleaseLock', 'validateReleaseLock'],
  '../src/release-diff.js': ['classifySectionChange', 'diffReleaseLocks'],
  '../src/release-registry.js': ['createReleaseRegistry'],
  '../src/release-drift.js': ['evaluateDrift'],
  '../src/release-gate.js': ['evaluateGate'],
  '../src/release-discover.js': ['discoverGit', 'discoverPackage', 'discoverMcpServer', 'discoverOpenaiModel', 'discoverAnthropicModel', 'composeDescriptor'],
  '../src/trace-corpus.js': ['normalizeTraceEvent', 'fromOtelSpan', 'redactEvent', 'mulberry32', 'createTraceCorpus', 'corpusEventHash'],
  '../src/replay.js': ['validateAgainstSchema', 'decisionCompatReplay', 'createReplayToolClient', 'runExperiment', 'wilson', 'percentile', 'buildProveReport'],
  '../src/release-bisect.js': ['isolateRegression'],
  '../src/release-canary.js': ['validateCanaryPlan', 'evaluateCanaryStep'],
  '../src/release-effects.js': ['createReleaseEffectIndex'],
  '../src/release-recovery.js': ['executeReleaseRecovery', 'summarizeRecovery'],
  '../src/fleet-graph.js': ['buildFleetGraph', 'blastRadius', 'releasesUsing']
};

test('release-integrity modules export exactly the documented public surface', async () => {
  const declared = readFileSync('types/release-integrity.d.ts', 'utf8');
  for (const [module, names] of Object.entries(EXPECTED)) {
    const namespace = await import(module);
    for (const name of names) {
      assert.equal(typeof namespace[name], 'function', `${module} must export function ${name}`);
      assert.ok(declared.includes(name), `types/release-integrity.d.ts must declare ${name}`);
    }
  }
});
