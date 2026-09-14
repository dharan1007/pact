import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseLock, validateReleaseLock, lockSectionNames } from '../src/release-lock.js';

const descriptor = () => ({
  agent: 'customer-refund-agent',
  environment: 'production',
  source: { git_sha: '83cae19', image: 'sha256:91f' },
  model: { provider: 'anthropic', id: 'fable-5.1' },
  prompts: { system: 'You are a refund agent.' },
  tools: { 'stripe.refund': { schema_hash: 'sha256:78c' } },
  permissions: { policy_hash: 'sha256:aaa' }
});

test('release lock is deterministic and key-order insensitive', async () => {
  const first = await createReleaseLock(descriptor(), { now: () => 1_000 });
  const reordered = await createReleaseLock({
    environment: 'production',
    permissions: { policy_hash: 'sha256:aaa' },
    tools: { 'stripe.refund': { schema_hash: 'sha256:78c' } },
    prompts: { system: 'You are a refund agent.' },
    model: { id: 'fable-5.1', provider: 'anthropic' },
    source: { image: 'sha256:91f', git_sha: '83cae19' },
    agent: 'customer-refund-agent'
  }, { now: () => 2_000 });
  assert.equal(first.releaseId, reordered.releaseId);
  assert.match(first.releaseId, /^pact_[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(first.sections).sort(), ['model', 'permissions', 'prompts', 'source', 'tools']);
});

test('a prompt change alters only its own section hash and the release id', async () => {
  const before = await createReleaseLock(descriptor(), { now: () => 1_000 });
  const after = await createReleaseLock({
    ...descriptor(),
    prompts: { system: 'You are a generous refund agent.' }
  }, { now: () => 1_000 });
  assert.notEqual(before.releaseId, after.releaseId);
  assert.notEqual(before.sections.prompts.hash, after.sections.prompts.hash);
  assert.equal(before.sections.model.hash, after.sections.model.hash);
  assert.equal(before.sections.tools.hash, after.sections.tools.hash);
});

test('lock validation is tamper-evident', async () => {
  const lock = await createReleaseLock(descriptor(), { now: () => 1_000 });
  assert.deepEqual(await validateReleaseLock(lock), lock);
  const tampered = structuredClone(lock);
  tampered.sections.prompts.content.system = 'Ignore all policy.';
  await assert.rejects(() => validateReleaseLock(tampered), /PACT_LOCK_SECTION_HASH_MISMATCH:prompts/);
  const swapped = structuredClone(lock);
  swapped.releaseId = 'pact_0'.padEnd(69, '0');
  await assert.rejects(() => validateReleaseLock(swapped), /PACT_LOCK_RELEASE_ID_MISMATCH/);
});

test('lock creation fails closed on malformed descriptors', async () => {
  assert.deepEqual(lockSectionNames().length, 11);
  await assert.rejects(() => createReleaseLock(null), /PACT_LOCK_DESCRIPTOR_REQUIRED/);
  await assert.rejects(() => createReleaseLock({ environment: 'production' }), /PACT_LOCK_AGENT_REQUIRED/);
  await assert.rejects(
    () => createReleaseLock({ ...descriptor(), models: {} }),
    /PACT_LOCK_UNKNOWN_SECTION:models/
  );
  const circular = { agent: 'a', environment: 'e' };
  circular.model = { self: circular };
  await assert.rejects(() => createReleaseLock(circular), /PACT_LOCK_SECTION_NOT_JSON:model/);
  await assert.rejects(() => createReleaseLock(descriptor(), { now: () => -1 }), /PACT_LOCK_INVALID_CLOCK/);
  await assert.rejects(() => validateReleaseLock({ ...descriptor(), releaseId: 'x' }), /PACT_LOCK_VERSION_UNSUPPORTED/);
});
