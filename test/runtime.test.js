import test from 'node:test';
import assert from 'node:assert/strict';
import { definePactAdapter } from '../src/adapter.js';
import { createPactRuntime } from '../src/runtime.js';

function makeFlagsAdapter() {
  return definePactAdapter({
    id: 'example.flags',
    version: '1.0.0',
    describe() { return { name: 'Flags' }; },
    async plan({ intent, state }) {
      return {
        effects: [{ path: `flags.${intent.flag}`, before: state.flags[intent.flag], after: true }],
        invariants: [{ path: 'billing.plan', equals: state.billing.plan }]
      };
    },
    async verify({ intent, state, plan }) {
      return state.flags[intent.flag] === true && plan.effects.length === 1;
    }
  });
}

test('generic runtime previews adapter-produced effects instead of reference-domain effects', async () => {
  const runtime = createPactRuntime({
    adapter: makeFlagsAdapter(),
    initialState: { version: 7, flags: { beta: false }, billing: { plan: 'free' } },
    verifyApproval: async () => ({ humanPrincipal: 'user_1', agentSession: 'agent_1' })
  });

  const draft = runtime.startIntent({ flag: 'beta' });
  assert.equal(draft.state, 'DRAFT');

  const preview = await runtime.preview();
  assert.equal(preview.adapter.id, 'example.flags');
  assert.equal(preview.baseVersion, 7);
  assert.deepEqual(preview.effects, [{ path: 'flags.beta', before: false, after: true }]);
  assert.deepEqual(preview.invariants, [{ path: 'billing.plan', equals: 'free' }]);
});

test('approval is accepted only through an authority verifier and identity claims are bound into the transaction and receipt', async () => {
  const observed = [];
  const runtime = createPactRuntime({
    adapter: makeFlagsAdapter(),
    initialState: { version: 3, flags: { beta: false }, billing: { plan: 'free' } },
    verifyApproval: async request => {
      observed.push(request);
      if (request.approval !== 'signed-approval') return false;
      return { humanPrincipal: 'human:maya', agentSession: 'agent:chatgpt:7' };
    }
  });

  runtime.startIntent({ flag: 'beta' });
  const preview = await runtime.preview();

  await assert.rejects(() => runtime.approve({ trusted: true }), /PACT_RUNTIME_APPROVAL_REJECTED/);
  const approved = await runtime.approve({ approval: 'signed-approval' });
  assert.deepEqual(approved.approvalClaims, { humanPrincipal: 'human:maya', agentSession: 'agent:chatgpt:7' });
  assert.equal(observed.at(-1).txId, preview.id);
  assert.equal(observed.at(-1).planHash, preview.planHash);

  await runtime.commit();
  const receipt = await runtime.verify();
  assert.deepEqual(receipt.approvalClaims, { humanPrincipal: 'human:maya', agentSession: 'agent:chatgpt:7' });
});

test('a verified transaction is terminal and the runtime can begin a new transaction against the new canonical version', async () => {
  const runtime = createPactRuntime({
    adapter: makeFlagsAdapter(),
    initialState: { version: 0, flags: { beta: false, gamma: false }, billing: { plan: 'free' } },
    verifyApproval: async () => ({ humanPrincipal: 'human:maya', agentSession: 'agent:session-1' })
  });

  runtime.startIntent({ flag: 'beta' });
  await runtime.preview();
  await runtime.approve({ approval: 'ok' });
  await runtime.commit();
  await runtime.verify();

  const second = runtime.startIntent({ flag: 'gamma' });
  assert.equal(second.state, 'DRAFT');
  const preview = await runtime.preview();
  assert.equal(preview.baseVersion, 1);
  assert.deepEqual(preview.effects, [{ path: 'flags.gamma', before: false, after: true }]);
});
