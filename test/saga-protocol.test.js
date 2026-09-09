import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactSagaAuthorityService } from '../src/saga-protocol.js';
import { createPactHttpHandler } from '../src/http-handler.js';
import { createPactHttpConnector } from '../src/http.js';

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

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function step(id, handler, resourceKey = id) {
  return { id, handler, resourceKey, atomicDomain: handler, input: { id } };
}

test('one approved saga plan executes multiple resources and emits a hash-bound aggregate receipt', async () => {
  const external = new Map();
  const executions = [];
  const handlers = {
    provider: {
      async execute({ input, idempotencyKey }) {
        executions.push(idempotencyKey);
        external.set(input.id, 'committed');
        return { providerRevision: `${input.id}:1` };
      },
      async verify({ input }) { return external.get(input.id) === 'committed'; },
      async compensate({ input }) { external.set(input.id, 'rolled-back'); return { providerRevision: `${input.id}:2` }; },
      async verifyCompensation({ input }) { return external.get(input.id) === 'rolled-back'; },
      async reconcile({ input }) { return external.get(input.id) === 'committed' ? 'committed' : 'not_committed'; }
    }
  };
  const service = createPactSagaAuthorityService({
    store: atomicStore(),
    handlers,
    now: () => 1_000,
    verifyApproval: async ({ txId, planHash, baseVersion, adapter }) => {
      assert.match(txId, /^saga_/);
      assert.match(planHash, /^[a-f0-9]{64}$/);
      assert.equal(baseVersion, 0);
      assert.deepEqual(adapter, { id: 'pact.saga', version: '1.0.0' });
      return { humanPrincipal: 'human:ada', agentSession: 'agent:session-1' };
    }
  });

  const preview = await service.sagaPreview({ steps: [step('account', 'provider'), step('billing', 'provider')] });
  assert.equal(preview.saga.state, 'PREVIEWED');
  assert.equal(preview.saga.steps.length, 2);
  assert.match(preview.saga.planHash, /^[a-f0-9]{64}$/);

  const approved = await service.sagaApprove({ sagaId: preview.saga.id, approval: { signed: true } });
  assert.equal(approved.saga.state, 'APPROVED');
  assert.equal(typeof approved.capability.token, 'string');
  assert.equal(approved.saga.approvalClaims.humanPrincipal, 'human:ada');

  const executed = await service.sagaExecute({
    sagaId: preview.saga.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'execute-1'
  });
  assert.equal(executed.saga.state, 'COMMITTED');
  assert.deepEqual(executions, [
    `${preview.saga.id}:account:forward`,
    `${preview.saga.id}:billing:forward`
  ]);

  const replay = await service.sagaExecute({
    sagaId: preview.saga.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'execute-1'
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(executions.length, 2, 'execution replay must not call providers again');

  const receipt = await service.sagaReceipt({ sagaId: preview.saga.id });
  assert.equal(receipt.receipt.state, 'COMMITTED');
  assert.equal(receipt.receipt.planHash, preview.saga.planHash);
  assert.equal(receipt.receipt.approvalClaims.humanPrincipal, 'human:ada');
  assert.equal(receipt.receipt.steps.length, 2);
  assert.match(receipt.receipt.receiptHash, /^[a-f0-9]{64}$/);
});

test('uncertain saga execution is inspectable and can only reconcile under the original approved capability', async () => {
  let uncertain = true;
  let committed = false;
  const handlers = {
    provider: {
      async execute() {
        committed = true;
        if (uncertain) {
          uncertain = false;
          const error = new Error('NETWORK_RESPONSE_LOST');
          error.uncertain = true;
          throw error;
        }
        return {};
      },
      async verify() { return committed; },
      async reconcile() { return committed ? 'committed' : 'not_committed'; }
    }
  };
  const service = createPactSagaAuthorityService({
    store: atomicStore(), handlers, now: () => 2_000,
    verifyApproval: async () => ({ humanPrincipal: 'human:ops', agentSession: 'agent:ops' })
  });
  const preview = await service.sagaPreview({ steps: [step('access', 'provider')] });
  const approved = await service.sagaApprove({ sagaId: preview.saga.id, approval: { signed: true } });
  const first = await service.sagaExecute({ sagaId: preview.saga.id, capabilityToken: approved.capability.token, idempotencyKey: 'exec-uncertain' });
  assert.equal(first.saga.state, 'RECONCILIATION_REQUIRED');
  const inspected = await service.sagaInspect({ sagaId: preview.saga.id });
  assert.equal(inspected.saga.state, 'RECONCILIATION_REQUIRED');
  await assert.rejects(() => service.sagaReconcile({ sagaId: preview.saga.id, capabilityToken: 'wrong', idempotencyKey: 'exec-uncertain' }), /PACT_AUTHORITY_CAPABILITY_NOT_FOUND|PACT_SAGA_PROTOCOL_CAPABILITY_MISMATCH/);
  const reconciled = await service.sagaReconcile({ sagaId: preview.saga.id, capabilityToken: approved.capability.token, idempotencyKey: 'exec-uncertain' });
  assert.equal(reconciled.saga.state, 'COMMITTED');
});

test('HTTP authority surface exposes saga lifecycle and binds idempotency header to saga execution', async () => {
  const calls = [];
  const service = {
    async sagaPreview(payload) { calls.push(['preview', payload]); return { ok: 'preview' }; },
    async sagaApprove(payload) { calls.push(['approve', payload]); return { ok: 'approve' }; },
    async sagaExecute(payload) { calls.push(['execute', payload]); return { ok: 'execute' }; },
    async sagaInspect(payload) { calls.push(['inspect', payload]); return { ok: 'inspect' }; },
    async sagaReconcile(payload) { calls.push(['reconcile', payload]); return { ok: 'reconcile' }; },
    async sagaReceipt(payload) { calls.push(['receipt', payload]); return { ok: 'receipt' }; }
  };
  const handler = createPactHttpHandler({ service, releaseSha: 'a'.repeat(40) });
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'saga-exec-1' },
    body: { operation: 'saga_execute', payload: { sagaId: 'saga_1', capabilityToken: 'cap_1' } }
  };
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [['execute', { sagaId: 'saga_1', capabilityToken: 'cap_1', idempotencyKey: 'saga-exec-1' }]]);
});

test('HTTP connector exposes first-class saga operations', async () => {
  const requests = [];
  const connector = createPactHttpConnector({
    baseUrl: 'https://pact.example',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true }); } };
    }
  });
  await connector.sagaPreview({ steps: [] });
  await connector.sagaExecute({ sagaId: 'saga_1', capabilityToken: 'cap_1' }, 'saga-idempotency');
  assert.equal(JSON.parse(requests[0].init.body).operation, 'saga_preview');
  assert.equal(JSON.parse(requests[1].init.body).operation, 'saga_execute');
  assert.equal(requests[1].init.headers['idempotency-key'], 'saga-idempotency');
});
