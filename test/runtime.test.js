import test from 'node:test';
import assert from 'node:assert/strict';
import { definePactAdapter } from '../src/adapter.js';
import { createPactRuntime } from '../src/runtime.js';

test('generic runtime previews adapter-produced effects instead of reference-domain effects', async () => {
  const adapter = definePactAdapter({
    id: 'example.flags',
    version: '1.0.0',
    describe() { return { name: 'Flags' }; },
    async plan({ intent, state }) {
      assert.equal(intent.flag, 'beta');
      assert.equal(state.flags.beta, false);
      return {
        effects: [{ path: 'flags.beta', before: false, after: true }],
        invariants: [{ path: 'billing.plan', equals: 'free' }]
      };
    },
    async verify({ intent, state, plan }) {
      return intent.flag === 'beta' && state.flags.beta === true && plan.effects.length === 1;
    }
  });

  const runtime = createPactRuntime({
    adapter,
    initialState: { version: 7, flags: { beta: false }, billing: { plan: 'free' } }
  });

  const draft = runtime.startIntent({ flag: 'beta' });
  assert.equal(draft.state, 'DRAFT');

  const preview = await runtime.preview();
  assert.equal(preview.adapter.id, 'example.flags');
  assert.equal(preview.baseVersion, 7);
  assert.deepEqual(preview.effects, [{ path: 'flags.beta', before: false, after: true }]);
  assert.deepEqual(preview.invariants, [{ path: 'billing.plan', equals: 'free' }]);
});
