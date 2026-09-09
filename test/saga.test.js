import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactSagaCoordinator } from '../src/saga.js';

const clone = value => value === undefined ? undefined : structuredClone(value);

function atomicStore() {
  const data = new Map();
  return {
    async get(key) { return clone(data.get(key) ?? null); },
    async create(key, value) {
      if (data.has(key)) return false;
      data.set(key, clone(value));
      return true;
    },
    async compareAndSwap(key, expectedVersion, value) {
      const current = data.get(key);
      if (!current || current.version !== expectedVersion) return false;
      data.set(key, clone(value));
      return true;
    }
  };
}

function step(id, handler, resourceKey = id) {
  return { id, handler, resourceKey, atomicDomain: handler, input: { id } };
}

test('multi-resource saga commits all resources with stable per-step idempotency keys', async () => {
  const calls = [];
  const external = new Map();
  const handlers = {
    account: {
      async execute({ input, idempotencyKey }) { calls.push(['execute', input.id, idempotencyKey]); external.set(input.id, 'committed'); return { revision: 1 }; },
      async verify({ input }) { return external.get(input.id) === 'committed'; },
      async compensate({ input, idempotencyKey }) { calls.push(['compensate', input.id, idempotencyKey]); external.set(input.id, 'rolled-back'); return { revision: 2 }; },
      async verifyCompensation({ input }) { return external.get(input.id) === 'rolled-back'; },
      async reconcile({ input }) { return external.get(input.id) === 'committed' ? 'committed' : 'not_committed'; }
    }
  };
  const saga = createPactSagaCoordinator({ store: atomicStore(), handlers, now: () => 1000 });
  await saga.create({ sagaId: 'saga_1', planHash: 'plan_1', approvalBinding: 'approval_1', steps: [step('a', 'account'), step('b', 'account'), step('c', 'account')] });
  const result = await saga.execute({ sagaId: 'saga_1' });
  assert.equal(result.state, 'COMMITTED');
  assert.deepEqual(result.steps.map(item => item.state), ['COMMITTED', 'COMMITTED', 'COMMITTED']);
  assert.deepEqual(calls.map(item => item[2]), ['saga_1:a:forward', 'saga_1:b:forward', 'saga_1:c:forward']);
});

test('definite downstream failure compensates already committed resources in reverse order', async () => {
  const calls = [];
  const external = new Map();
  const handlers = {
    ok: {
      async execute({ input }) { calls.push(`execute:${input.id}`); external.set(input.id, 'committed'); return {}; },
      async verify({ input }) { return external.get(input.id) === 'committed'; },
      async compensate({ input }) { calls.push(`compensate:${input.id}`); external.set(input.id, 'rolled-back'); return {}; },
      async verifyCompensation({ input }) { return external.get(input.id) === 'rolled-back'; },
      async reconcile() { return 'not_committed'; }
    },
    fail: {
      async execute() { calls.push('execute:fail'); throw new Error('PROVIDER_REJECTED'); },
      async verify() { return false; },
      async reconcile() { return 'not_committed'; }
    }
  };
  const saga = createPactSagaCoordinator({ store: atomicStore(), handlers, now: () => 2000 });
  await saga.create({ sagaId: 'saga_2', planHash: 'plan_2', approvalBinding: 'approval_2', steps: [step('a', 'ok'), step('b', 'ok'), step('fail', 'fail')] });
  const result = await saga.execute({ sagaId: 'saga_2' });
  assert.equal(result.state, 'COMPENSATED');
  assert.deepEqual(calls, ['execute:a', 'execute:b', 'execute:fail', 'compensate:b', 'compensate:a']);
});

test('uncertain provider outcome never triggers blind compensation and requires reconciliation', async () => {
  let compensations = 0;
  const handlers = {
    uncertain: {
      async execute() { const error = new Error('NETWORK_RESPONSE_LOST'); error.uncertain = true; throw error; },
      async verify() { return false; },
      async compensate() { compensations += 1; },
      async verifyCompensation() { return true; },
      async reconcile() { return 'uncertain'; }
    }
  };
  const saga = createPactSagaCoordinator({ store: atomicStore(), handlers, now: () => 3000 });
  await saga.create({ sagaId: 'saga_3', planHash: 'plan_3', approvalBinding: 'approval_3', steps: [step('a', 'uncertain')] });
  const result = await saga.execute({ sagaId: 'saga_3' });
  assert.equal(result.state, 'RECONCILIATION_REQUIRED');
  assert.equal(compensations, 0);
});

test('crash recovery reconciles an externally committed in-flight step before continuing', async () => {
  const store = atomicStore();
  const external = new Map();
  let executions = 0;
  let crash = true;
  const handlers = {
    provider: {
      async execute({ input }) {
        executions += 1;
        external.set(input.id, 'committed');
        if (crash) { crash = false; const error = new Error('PROCESS_CRASH_AFTER_PROVIDER_COMMIT'); error.uncertain = true; throw error; }
        return {};
      },
      async verify({ input }) { return external.get(input.id) === 'committed'; },
      async compensate({ input }) { external.set(input.id, 'rolled-back'); return {}; },
      async verifyCompensation({ input }) { return external.get(input.id) === 'rolled-back'; },
      async reconcile({ input }) { return external.get(input.id) === 'committed' ? 'committed' : 'not_committed'; }
    }
  };
  const saga = createPactSagaCoordinator({ store, handlers, now: () => 4000 });
  await saga.create({ sagaId: 'saga_4', planHash: 'plan_4', approvalBinding: 'approval_4', steps: [step('a', 'provider'), step('b', 'provider')] });
  const uncertain = await saga.execute({ sagaId: 'saga_4' });
  assert.equal(uncertain.state, 'RECONCILIATION_REQUIRED');
  const recovered = await saga.reconcile({ sagaId: 'saga_4' });
  assert.equal(recovered.state, 'COMMITTED');
  assert.equal(executions, 2, 'reconciliation must not re-execute the already committed first step');
});

test('a non-compensatable committed step is reported as PARTIALLY_COMMITTED rather than falsely rolled back', async () => {
  const handlers = {
    irreversible: {
      async execute() { return {}; },
      async verify() { return true; },
      async reconcile() { return 'committed'; }
    },
    fail: {
      async execute() { throw new Error('PROVIDER_REJECTED'); },
      async verify() { return false; },
      async reconcile() { return 'not_committed'; }
    }
  };
  const saga = createPactSagaCoordinator({ store: atomicStore(), handlers, now: () => 5000 });
  await saga.create({ sagaId: 'saga_5', planHash: 'plan_5', approvalBinding: 'approval_5', steps: [step('a', 'irreversible'), step('b', 'fail')] });
  const result = await saga.execute({ sagaId: 'saga_5' });
  assert.equal(result.state, 'PARTIALLY_COMMITTED');
  assert.equal(result.steps[0].state, 'COMMITTED');
});

test('saga creation is idempotent only for the exact approved plan', async () => {
  const handlers = { noop: { async execute() { return {}; }, async verify() { return true; }, async reconcile() { return 'not_committed'; } } };
  const saga = createPactSagaCoordinator({ store: atomicStore(), handlers, now: () => 6000 });
  const plan = { sagaId: 'saga_6', planHash: 'plan_6', approvalBinding: 'approval_6', steps: [step('a', 'noop')] };
  const first = await saga.create(plan);
  const replay = await saga.create(plan);
  assert.deepEqual(replay, first);
  await assert.rejects(() => saga.create({ ...plan, planHash: 'different' }), /PACT_SAGA_CREATE_CONFLICT/);
});

test('active saga lease prevents a second worker from entering the same execution', async () => {
  const store = atomicStore();
  let clock = 10_000;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const handlers = {
    provider: {
      async execute() { await blocked; return {}; },
      async verify() { return true; },
      async reconcile() { return 'not_committed'; }
    }
  };
  const first = createPactSagaCoordinator({ store, handlers, now: () => clock, workerId: 'worker-a', leaseMs: 5_000 });
  const second = createPactSagaCoordinator({ store, handlers, now: () => clock, workerId: 'worker-b', leaseMs: 5_000 });
  await first.create({ sagaId: 'saga_lease_held', planHash: 'plan', approvalBinding: 'approval', steps: [step('a', 'provider')] });
  const running = first.execute({ sagaId: 'saga_lease_held' });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => second.execute({ sagaId: 'saga_lease_held' }), /PACT_SAGA_EXECUTION_LEASE_HELD/);
  release();
  assert.equal((await running).state, 'COMMITTED');
});

test('expired lease takeover fences a stale worker and forces reconciliation before any new provider mutation', async () => {
  const store = atomicStore();
  let clock = 20_000;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const fences = [];
  let executions = 0;
  const handlers = {
    provider: {
      async execute({ fence }) {
        executions += 1;
        fences.push(clone(fence));
        await blocked;
        return { committed: true };
      },
      async verify() { return true; },
      async reconcile() { return 'uncertain'; }
    }
  };
  const stale = createPactSagaCoordinator({ store, handlers, now: () => clock, workerId: 'worker-a', leaseMs: 100 });
  const takeover = createPactSagaCoordinator({ store, handlers, now: () => clock, workerId: 'worker-b', leaseMs: 100 });
  await stale.create({ sagaId: 'saga_fenced', planHash: 'plan', approvalBinding: 'approval', steps: [step('a', 'provider'), step('b', 'provider')] });
  const staleRun = stale.execute({ sagaId: 'saga_fenced' });
  await new Promise(resolve => setImmediate(resolve));

  clock += 101;
  const taken = await takeover.execute({ sagaId: 'saga_fenced' });
  assert.equal(taken.state, 'RECONCILIATION_REQUIRED');
  assert.equal(taken.lease.ownerId, 'worker-b');
  assert.equal(taken.lease.generation, 2);
  assert.equal(executions, 1, 'takeover must reconcile the in-flight step rather than issue another mutation');

  release();
  await assert.rejects(() => staleRun, /PACT_SAGA_EXECUTION_FENCE_LOST/);
  const durable = await takeover.inspect({ sagaId: 'saga_fenced' });
  assert.equal(durable.state, 'RECONCILIATION_REQUIRED');
  assert.equal(durable.steps[0].state, 'EXECUTING');
  assert.equal(durable.steps[1].state, 'PENDING');
  assert.equal(durable.lease.ownerId, 'worker-b');
  assert.equal(durable.lease.generation, 2);
  assert.deepEqual(fences, [{ ownerId: 'worker-a', generation: 1, expiresAt: 20100 }]);
});