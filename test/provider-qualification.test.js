import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthorityStore } from '../src/authority.js';
import { createPactProviderQualifier } from '../src/provider-qualification.js';

const clone = value => value === undefined ? undefined : structuredClone(value);

function providerDescriptor() {
  return {
    id: 'identity.account',
    resourceKey: 'identity:account:42',
    atomicDomain: 'identity/account/42'
  };
}

test('conditional-write qualification proves stale rejection and unchanged canonical state before marking provider verified', async () => {
  const store = new MemoryAuthorityStore();
  let revision = 1;
  let state = { role: 'admin', marker: 'baseline' };
  let staleAttempts = 0;
  const qualifier = createPactProviderQualifier({ store, now: () => 10_000 });

  const evidence = await qualifier.qualifyConditionalWrite({
    provider: providerDescriptor(),
    probe: {
      async read() { return { revision: `r${revision}`, state: clone(state) }; },
      async advance() {
        revision += 1;
        state = { role: 'admin', marker: 'qualified' };
        return { revision: `r${revision}`, state: clone(state) };
      },
      async attemptStaleWrite({ staleRevision }) {
        staleAttempts += 1;
        assert.equal(staleRevision, 'r1');
        return { accepted: false, status: 412 };
      }
    }
  });

  assert.equal(staleAttempts, 1);
  assert.equal(evidence.status, 'provider-verified');
  assert.equal(evidence.probeType, 'conditional-write');
  assert.equal(evidence.beforeRevision, 'r1');
  assert.equal(evidence.qualifiedRevision, 'r2');
  assert.equal(evidence.staleProbeAccepted, false);
  assert.equal(evidence.canonicalUnchanged, true);
  assert.match(evidence.evidenceHash, /^[a-f0-9]{64}$/);

  const inspected = await qualifier.inspectQualification('identity.account', 'conditional-write');
  assert.deepEqual(inspected, evidence);
});

test('conditional-write qualification fails closed when stale mutation is accepted or changes canonical state', async () => {
  const store = new MemoryAuthorityStore();
  const qualifier = createPactProviderQualifier({ store, now: () => 20_000 });
  let state = { version: 1 };

  await assert.rejects(() => qualifier.qualifyConditionalWrite({
    provider: providerDescriptor(),
    probe: {
      async read() { return { revision: `r${state.version}`, state: clone(state) }; },
      async advance() { state = { version: 2 }; return { revision: 'r2', state: clone(state) }; },
      async attemptStaleWrite() { state = { version: 999 }; return { accepted: true, status: 200 }; }
    }
  }), /PACT_PROVIDER_QUALIFICATION_STALE_WRITE_ACCEPTED/);

  assert.equal(await qualifier.inspectQualification('identity.account', 'conditional-write'), null);
});

test('remote-fencing qualification proves newer generation wins and stale generation cannot mutate canonical state', async () => {
  const store = new MemoryAuthorityStore();
  const qualifier = createPactProviderQualifier({ store, now: () => 30_000 });
  let highestFence = 0;
  let state = { fence: 0, value: 'before' };

  const evidence = await qualifier.qualifyRemoteFencing({
    provider: providerDescriptor(),
    generation: 41,
    probe: {
      async apply({ generation }) {
        if (generation <= highestFence) return { accepted: false, status: 409 };
        highestFence = generation;
        state = { fence: generation, value: 'newer' };
        return { accepted: true, status: 200 };
      },
      async read() { return { revision: `f${highestFence}`, state: clone(state) }; }
    }
  });

  assert.equal(evidence.status, 'provider-verified');
  assert.equal(evidence.probeType, 'remote-fencing');
  assert.equal(evidence.qualifiedGeneration, 42);
  assert.equal(evidence.staleGeneration, 41);
  assert.equal(evidence.staleProbeAccepted, false);
  assert.equal(evidence.canonicalUnchanged, true);
  assert.deepEqual(state, { fence: 42, value: 'newer' });
  assert.deepEqual(await qualifier.inspectQualification('identity.account', 'remote-fencing'), evidence);
});
