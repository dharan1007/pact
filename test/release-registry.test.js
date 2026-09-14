import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthorityStore } from '../src/authority.js';
import { createReleaseLock } from '../src/release-lock.js';
import { createReleaseRegistry } from '../src/release-registry.js';

const descriptor = (model = 'm-1') => ({
  agent: 'support-agent',
  environment: 'production',
  model: { provider: 'acme', id: model }
});

test('registry pins locks immutably with idempotent same-payload replay', async () => {
  const registry = createReleaseRegistry({ store: new MemoryAuthorityStore() });
  const lock = await createReleaseLock(descriptor(), { now: () => 1_000 });
  const first = await registry.pin(lock);
  assert.equal(first.lock.releaseId, lock.releaseId);
  const second = await registry.pin(structuredClone(lock));
  assert.deepEqual(second, first);
  assert.deepEqual(await registry.get(lock.releaseId), lock);
  assert.deepEqual(await registry.history({ agent: 'support-agent', environment: 'production' }), [lock.releaseId]);
});

test('registry rejects same-key different-payload replay and unknown ids', async () => {
  const registry = createReleaseRegistry({ store: new MemoryAuthorityStore() });
  const lock = await createReleaseLock(descriptor(), { now: () => 1_000 });
  await registry.pin(lock);
  const tampered = structuredClone(lock);
  tampered.sections.model.content.id = 'm-evil';
  tampered.sections.model.hash = 'sha256:0'.padEnd(71, '0');
  await assert.rejects(() => registry.pin(tampered), /PACT_RELEASE_CONFLICT|PACT_LOCK_SECTION_HASH_MISMATCH/);
  await assert.rejects(() => registry.get('pact_1'.padEnd(69, '1')), /PACT_RELEASE_NOT_FOUND/);
  await assert.rejects(() => registry.get('not-a-release'), /PACT_RELEASE_ID_INVALID/);
  assert.deepEqual(await registry.history({ agent: 'unknown', environment: 'production' }), []);

  const other = await createReleaseLock(descriptor('m-9'), { now: () => 9_000 });
  const divergentStore = {
    get: async () => ({ version: 0, lock: structuredClone(other) }),
    create: async () => false,
    compareAndSwap: async () => true
  };
  await assert.rejects(
    () => createReleaseRegistry({ store: divergentStore }).pin(lock),
    /PACT_RELEASE_CONFLICT/
  );
  assert.throws(() => createReleaseRegistry({}), /PACT_RELEASE_REGISTRY_ATOMIC_STORE_REQUIRED/);
});

test('registry history appends in pin order across releases', async () => {
  const registry = createReleaseRegistry({ store: new MemoryAuthorityStore() });
  const first = await createReleaseLock(descriptor('m-1'), { now: () => 1_000 });
  const second = await createReleaseLock(descriptor('m-2'), { now: () => 2_000 });
  await registry.pin(first);
  await registry.pin(second);
  assert.deepEqual(await registry.history({ agent: 'support-agent', environment: 'production' }), [
    first.releaseId,
    second.releaseId
  ]);
});
