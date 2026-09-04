import test from 'node:test';
import assert from 'node:assert/strict';
import { definePactAdapter, validateAdapterPlan } from '../src/adapter.js';

const validAdapter = {
  id: 'tasks.v1',
  version: '1.0.0',
  describe() {
    return { name: 'Task ownership', operations: ['transfer_owner'] };
  },
  async plan({ intent, state }) {
    return {
      effects: [{ path: `tasks.${intent.taskId}.owner`, before: state.tasks[intent.taskId].owner, after: intent.newOwner }],
      invariants: [{ path: 'billing.plan', equals: state.billing.plan }]
    };
  },
  async verify({ state, plan }) {
    return plan.effects.every(effect => effect.path.split('.').reduce((node, key) => node?.[key], state) === effect.after);
  }
};

test('definePactAdapter accepts a complete reusable adapter contract', () => {
  const adapter = definePactAdapter(validAdapter);
  assert.equal(adapter.id, 'tasks.v1');
  assert.deepEqual(adapter.describe().operations, ['transfer_owner']);
});

test('definePactAdapter rejects missing required lifecycle methods and invalid identifiers', () => {
  assert.throws(() => definePactAdapter({ ...validAdapter, id: '../admin' }), /PACT_ADAPTER_INVALID_ID/);
  assert.throws(() => definePactAdapter({ ...validAdapter, plan: undefined }), /PACT_ADAPTER_PLAN_REQUIRED/);
  assert.throws(() => definePactAdapter({ ...validAdapter, verify: undefined }), /PACT_ADAPTER_VERIFY_REQUIRED/);
});

test('validateAdapterPlan rejects duplicate paths, invalid effects, and unbounded plans', () => {
  assert.throws(() => validateAdapterPlan({ effects: [] }), /PACT_ADAPTER_EFFECTS_REQUIRED/);
  assert.throws(() => validateAdapterPlan({ effects: [{ path: '__proto__.polluted', before: false, after: true }] }), /PACT_ADAPTER_UNSAFE_PATH/);
  assert.throws(() => validateAdapterPlan({ effects: [
    { path: 'tasks.t1.owner', before: 'a', after: 'b' },
    { path: 'tasks.t1.owner', before: 'a', after: 'c' }
  ] }), /PACT_ADAPTER_DUPLICATE_EFFECT_PATH/);
});

test('validateAdapterPlan normalizes a finite declarative plan without mutating caller data', () => {
  const input = {
    effects: [{ path: 'tasks.t1.owner', before: 'a', after: 'b' }],
    invariants: [{ path: 'billing.plan', equals: 'team' }],
    metadata: { reason: 'handoff' }
  };
  const plan = validateAdapterPlan(input);
  plan.effects[0].after = 'mallory';
  assert.equal(input.effects[0].after, 'b');
  assert.deepEqual(Object.keys(plan).sort(), ['effects', 'invariants', 'metadata']);
});
