import test from 'node:test';
import assert from 'node:assert/strict';
import * as serviceModule from '../src/service.js';
import { createPactJournal } from '../src/journal.js';

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function atomicStore() {
  const data = new Map();
  return {
    async get(key) { return clone(data.get(key) ?? null); },
    async create(key, value) { if (data.has(key)) return false; data.set(key, clone(value)); return true; },
    async compareAndSwap(key, expectedVersion, value) {
      const current = data.get(key);
      if (!current || current.version !== expectedVersion) return false;
      data.set(key, clone(value));
      return true;
    }
  };
}

function providerHarness() {
  let revision = 'r1';
  let state = { project: { owner: 'ada', plan: 'pro' } };
  let applyCalls = 0;
  const integration = {
    id: 'projects.real', version: '1.0.0',
    async read() { return { revision, state: clone(state) }; },
    async plan({ intent, state: current }) {
      return {
        effects: [{ path: 'project.owner', before: current.project.owner, after: intent.newOwner }],
        invariants: [{ path: 'project.plan', equals: current.project.plan }]
      };
    },
    async apply({ plan, idempotencyKey }) {
      applyCalls += 1;
      assert.equal(idempotencyKey, 'commit:tx');
      state.project.owner = plan.effects[0].after;
      revision = 'r2';
      return { providerRequestId: 'provider_1' };
    },
    async verify({ state: current, plan }) { return current.project.owner === plan.effects[0].after; }
  };
  return { integration, applyCalls: () => applyCalls, state: () => clone(state) };
}

const verifyApproval = async ({ approval }) => approval?.signature === 'valid'
  ? { humanPrincipal: 'user:42', agentSession: 'agent:abc' }
  : false;

function serviceWith({ integration, journal }) {
  return serviceModule.createPactTransactionService({ integration, journal, verifyApproval });
}

test('exports canonical transaction service and Fetch API handler', () => {
  assert.equal(typeof serviceModule.createPactTransactionService, 'function');
  assert.equal(typeof serviceModule.createPactApiHandler, 'function');
});

test('real transaction survives independent serverless service instances from preview through verification', async () => {
  const { integration, state } = providerHarness();
  const journal = createPactJournal({ store: atomicStore() });
  const previewed = await serviceWith({ integration, journal }).execute('preview', { intent: { type: 'transfer_owner', newOwner: 'maya' } });
  assert.match(previewed.transactionId, /^tx_/);
  assert.equal(previewed.transaction.state, 'PREVIEWED');

  const approved = await serviceWith({ integration, journal }).execute('approve', {
    transactionId: previewed.transactionId,
    approval: { signature: 'valid' }
  });
  assert.equal(approved.transaction.state, 'APPROVED');

  const committed = await serviceWith({ integration, journal }).execute('commit', { transactionId: previewed.transactionId }, { idempotencyKey: 'commit:tx' });
  assert.equal(committed.status, 'committed');
  assert.equal(state().project.owner, 'maya');

  const verified = await serviceWith({ integration, journal }).execute('verify', { transactionId: previewed.transactionId });
  assert.equal(verified.receipt.verifiedRevision, 'r2');
  assert.equal(verified.receipt.approvalClaims.humanPrincipal, 'user:42');

  const receipt = await serviceWith({ integration, journal }).execute('receipt', { transactionId: previewed.transactionId });
  assert.equal(receipt.receipt.receiptHash, verified.receipt.receiptHash);
});

test('commit replay is persisted across service instances and does not call the provider twice', async () => {
  const { integration, applyCalls } = providerHarness();
  const journal = createPactJournal({ store: atomicStore() });
  const service = serviceWith({ integration, journal });
  const preview = await service.execute('preview', { intent: { newOwner: 'maya' } });
  await service.execute('approve', { transactionId: preview.transactionId, approval: { signature: 'valid' } });
  const first = await service.execute('commit', { transactionId: preview.transactionId }, { idempotencyKey: 'commit:tx' });
  const replay = await serviceWith({ integration, journal }).execute('commit', { transactionId: preview.transactionId }, { idempotencyKey: 'commit:tx' });
  assert.deepEqual(replay, first);
  assert.equal(applyCalls(), 1);
});

test('concurrent commit requests do not dispatch two provider effects', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let revision = 'r1';
  let state = { flag: { enabled: false } };
  let calls = 0;
  const integration = {
    id: 'flags.real', version: '1.0.0',
    async read() { return { revision, state: clone(state) }; },
    async plan() { return { effects: [{ path: 'flag.enabled', before: false, after: true }], invariants: [] }; },
    async apply() { calls += 1; await gate; state.flag.enabled = true; revision = 'r2'; return { ok: true }; },
    async verify({ state: current }) { return current.flag.enabled; }
  };
  const journal = createPactJournal({ store: atomicStore(), claimTtlMs: 10_000 });
  const service = serviceWith({ integration, journal });
  const preview = await service.execute('preview', { intent: { type: 'enable' } });
  await service.execute('approve', { transactionId: preview.transactionId, approval: { signature: 'valid' } });

  const first = service.execute('commit', { transactionId: preview.transactionId }, { idempotencyKey: 'commit:tx' });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await serviceWith({ integration, journal }).execute('commit', { transactionId: preview.transactionId }, { idempotencyKey: 'commit:tx' });
  assert.equal(second.status, 'in_progress');
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(calls, 1);
});

test('Fetch handler requires application authentication and forwards consequential idempotency', async () => {
  const calls = [];
  const service = { async execute(operation, payload, options) { calls.push({ operation, payload, options }); return { ok: true }; } };
  const handler = serviceModule.createPactApiHandler({
    service,
    authenticate: async request => request.headers.get('authorization') === 'Bearer valid' ? { principal: 'user:42' } : null
  });

  const unauthorized = await handler(new Request('https://app.example/api/pact', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'inspect', payload: { transactionId: 'tx_1' } })
  }));
  assert.equal(unauthorized.status, 401);

  const response = await handler(new Request('https://app.example/api/pact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer valid', 'idempotency-key': 'commit:1' },
    body: JSON.stringify({ operation: 'commit', payload: { transactionId: 'tx_1' } })
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls[0].options.idempotencyKey, 'commit:1');
  assert.equal(calls[0].options.auth.principal, 'user:42');
});

test('Fetch handler fails closed on malformed envelopes and never exposes internal stack traces', async () => {
  const service = { async execute() { throw new Error('PACT_JOURNAL_IDEMPOTENCY_CONFLICT'); } };
  const handler = serviceModule.createPactApiHandler({ service, authenticate: async () => ({ principal: 'user:1' }) });
  const malformed = await handler(new Request('https://app.example/api/pact', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: '../admin', payload: {} })
  }));
  assert.equal(malformed.status, 400);

  const conflict = await handler(new Request('https://app.example/api/pact', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'commit', payload: { transactionId: 'tx_1' } })
  }));
  assert.equal(conflict.status, 409);
  const body = await conflict.json();
  assert.equal(body.error.code, 'PACT_JOURNAL_IDEMPOTENCY_CONFLICT');
  assert.equal('stack' in body.error, false);
});
