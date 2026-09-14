import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseLock } from '../src/release-lock.js';
import { diffReleaseLocks } from '../src/release-diff.js';

const base = () => ({
  agent: 'support-agent',
  environment: 'production',
  source: { git_sha: 'aaa' },
  model: { provider: 'acme', id: 'm-1' },
  prompts: { system: 'Be helpful.' },
  tools: { 'crm.search': { schema_hash: 'sha256:1' } },
  permissions: { scopes: ['read'] }
});
const lock = (d, now = 1_000) => createReleaseLock(d, { now: () => now });

test('identical locks produce no findings', async () => {
  const diff = await diffReleaseLocks(await lock(base()), await lock(base()));
  assert.equal(diff.unchanged, true);
  assert.deepEqual(diff.findings, []);
  assert.deepEqual(diff.summary, { high: 0, medium: 0, low: 0 });
  assert.equal(diff.beforeReleaseId, diff.afterReleaseId);
});

test('tool removal is breaking and permission change is high severity', async () => {
  const before = await lock(base());
  const after = await lock({ ...base(), tools: {}, permissions: { scopes: ['read', 'write'] } });
  const diff = await diffReleaseLocks(before, after);
  assert.equal(diff.unchanged, false);
  const kinds = Object.fromEntries(diff.findings.map(finding => [finding.section, finding]));
  assert.equal(kinds.tools.kind, 'breaking');
  assert.equal(kinds.tools.severity, 'high');
  assert.deepEqual(kinds.tools.removed, ['crm.search']);
  assert.equal(kinds.permissions.kind, 'permission-changed');
  assert.equal(kinds.permissions.severity, 'high');
  assert.equal(diff.summary.high, 2);
});

test('model and prompt changes are behavioral with leaf-level paths', async () => {
  const before = await lock(base());
  const after = await lock({
    ...base(),
    model: { provider: 'acme', id: 'm-2' },
    prompts: { system: 'Be terse.' }
  });
  const diff = await diffReleaseLocks(before, after);
  const kinds = Object.fromEntries(diff.findings.map(finding => [finding.section, finding]));
  assert.equal(kinds.model.kind, 'model-changed');
  assert.equal(kinds.model.severity, 'medium');
  assert.equal(kinds.prompts.kind, 'behavioral');
  const modelPath = kinds.model.paths.find(entry => entry.path === 'id');
  assert.equal(modelPath.before, 'm-1');
  assert.equal(modelPath.after, 'm-2');
});

test('diff fails closed on mismatched agents and tampered locks', async () => {
  const before = await lock(base());
  const otherAgent = await lock({ ...base(), agent: 'other-agent' });
  await assert.rejects(() => diffReleaseLocks(before, otherAgent), /PACT_DIFF_AGENT_MISMATCH/);
  const tampered = structuredClone(await lock(base()));
  tampered.sections.model.content.id = 'm-evil';
  await assert.rejects(() => diffReleaseLocks(before, tampered), /PACT_LOCK_SECTION_HASH_MISMATCH:model/);
});
