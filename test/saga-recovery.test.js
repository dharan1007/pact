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

test('operator recovery is evidence-bound, human-approved, durable, and idempotent', async () => {
  let verifierCalls = 0;
  let providerCommitted = false;
  const handler = {
    capabilities: {
      resourceKey: 'account:42',
      atomicDomain: 'identity',
      reconciliation: true
    },
    async execute() {
      providerCommitted = true;
      const error = new Error('NETWORK_RESPONSE_LOST');
      error.uncertain = true;
      throw error;
    },
    async verify() { return providerCommitted; },
    async reconcile() { return providerCommitted ? 'committed' : 'not_committed'; },
    async recoveryEvidence({ phase, step }) {
      return {
        provider: 'identity',
        resourceKey: step.resourceKey,
        phase,
        before: { version: 7, role: 'admin' },
        intended: { version: 8, role: 'reader' },
        observed: { version: 8, role: 'reader' },
        classification: 'committed'
      };
    }
  };
  const service = createPactSagaAuthorityService({
    store: atomicStore(),
    handlers: { identity: handler },
    now: () => 10_000,
    verifyApproval: async ({ adapter }) => {
      verifierCalls += 1;
      if (adapter?.id === 'pact.saga.recovery') {
        return { humanPrincipal: 'human:operator', agentSession: 'agent:recovery' };
      }
      return { humanPrincipal: 'human:owner', agentSession: 'agent:transaction' };
    }
  });

  const preview = await service.sagaPreview({
    steps: [{
      id: 'access',
      handler: 'identity',
      resourceKey: 'account:42',
      atomicDomain: 'identity',
      requirements: { reconciliation: true },
      input: { intent: { operation: 'set-role', value: 'reader' } }
    }]
  });
  const approved = await service.sagaApprove({ sagaId: preview.saga.id, approval: { signed: 'transaction' } });
  const uncertain = await service.sagaExecute({
    sagaId: preview.saga.id,
    capabilityToken: approved.capability.token,
    idempotencyKey: 'execute-access-42'
  });
  assert.equal(uncertain.saga.state, 'RECONCILIATION_REQUIRED');

  const recovery = await service.sagaRecoveryInspect({ sagaId: preview.saga.id });
  assert.equal(recovery.recovery.phase, 'forward');
  assert.equal(recovery.recovery.step.id, 'access');
  assert.equal(recovery.recovery.step.resourceKey, 'account:42');
  assert.equal(recovery.recovery.failure.code, 'NETWORK_RESPONSE_LOST');
  assert.equal(recovery.recovery.providerEvidence.classification, 'committed');
  assert.deepEqual(recovery.recovery.allowedActions, ['reconcile']);
  assert.match(recovery.recoveryHash, /^[a-f0-9]{64}$/);

  await assert.rejects(
    () => service.sagaRecoveryResolve({
      sagaId: preview.saga.id,
      recoveryHash: '0'.repeat(64),
      action: 'reconcile',
      approval: { signed: 'operator' },
      idempotencyKey: 'resolve-access-42'
    }),
    /PACT_SAGA_PROTOCOL_RECOVERY_STALE/
  );
  assert.equal(verifierCalls, 1, 'stale evidence must fail before operator approval verification');

  const resolved = await service.sagaRecoveryResolve({
    sagaId: preview.saga.id,
    recoveryHash: recovery.recoveryHash,
    action: 'reconcile',
    approval: { signed: 'operator' },
    idempotencyKey: 'resolve-access-42'
  });
  assert.equal(resolved.saga.state, 'COMMITTED');
  assert.equal(resolved.recoveryDecision.action, 'reconcile');
  assert.equal(resolved.recoveryDecision.claims.humanPrincipal, 'human:operator');
  assert.equal(resolved.recoveryDecision.recoveryHash, recovery.recoveryHash);
  assert.match(resolved.recoveryDecision.decisionHash, /^[a-f0-9]{64}$/);
  assert.equal(resolved.idempotentReplay, false);
  assert.equal(verifierCalls, 2);

  const replay = await service.sagaRecoveryResolve({
    sagaId: preview.saga.id,
    recoveryHash: recovery.recoveryHash,
    action: 'reconcile',
    approval: { signed: 'operator' },
    idempotencyKey: 'resolve-access-42'
  });
  assert.equal(replay.saga.state, 'COMMITTED');
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.recoveryDecision.decisionHash, resolved.recoveryDecision.decisionHash);
  assert.equal(verifierCalls, 2, 'exact recovery replay must not re-run human verification');
});

test('HTTP authority and connector expose operator recovery inspection and resolution', async () => {
  const calls = [];
  const service = {
    async sagaRecoveryInspect(payload) { calls.push(['inspect', payload]); return { recovery: { state: 'RECONCILIATION_REQUIRED' } }; },
    async sagaRecoveryResolve(payload) { calls.push(['resolve', payload]); return { saga: { state: 'COMMITTED' } }; }
  };
  const handler = createPactHttpHandler({ service, releaseSha: 'a'.repeat(40) });
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'recovery-1' },
    body: {
      operation: 'saga_recovery_resolve',
      payload: { sagaId: 'saga_1', recoveryHash: 'b'.repeat(64), action: 'reconcile', approval: { signed: true } }
    }
  };
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [[
    'resolve',
    { sagaId: 'saga_1', recoveryHash: 'b'.repeat(64), action: 'reconcile', approval: { signed: true }, idempotencyKey: 'recovery-1' }
  ]]);

  const requests = [];
  const connector = createPactHttpConnector({
    baseUrl: 'https://pact.example',
    fetchImpl: async (_url, init) => {
      requests.push(init);
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true }); } };
    }
  });
  await connector.sagaRecoveryInspect({ sagaId: 'saga_1' });
  await connector.sagaRecoveryResolve({ sagaId: 'saga_1', recoveryHash: 'b'.repeat(64), action: 'reconcile', approval: { signed: true } }, 'recovery-1');
  assert.equal(JSON.parse(requests[0].body).operation, 'saga_recovery_inspect');
  assert.equal(JSON.parse(requests[1].body).operation, 'saga_recovery_resolve');
  assert.equal(requests[1].headers['idempotency-key'], 'recovery-1');
});
