import { createPactExternalRuntime } from './runtime.js';

const ALLOWED_OPERATIONS = new Set(['inspect', 'preview', 'approve', 'commit', 'verify', 'receipt', 'rollback', 'cancel']);
const CONSEQUENTIAL = new Set(['commit', 'rollback']);
const clone = value => value === undefined ? undefined : structuredClone(value);

function fail(code) { throw new Error(code); }
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function requiredString(value, code, max = 256) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  const normalized = value.trim();
  if (normalized.length > max) fail(code);
  return normalized;
}
function assertJournal(journal) {
  if (!plainObject(journal)) fail('PACT_SERVICE_JOURNAL_REQUIRED');
  for (const method of ['createTransaction', 'getTransaction', 'claimOperation', 'completeOperation', 'markUncertain', 'updateSnapshot']) {
    if (typeof journal[method] !== 'function') fail(`PACT_SERVICE_JOURNAL_METHOD_REQUIRED:${method}`);
  }
}
function transactionIdFrom(payload) {
  if (!plainObject(payload)) fail('PACT_SERVICE_PAYLOAD_REQUIRED');
  return requiredString(payload.transactionId, 'PACT_SERVICE_TRANSACTION_ID_REQUIRED');
}
function publicInspect(record) {
  const snapshot = record.snapshot;
  return {
    transactionId: record.transactionId,
    journalVersion: record.version,
    transaction: clone(snapshot.transaction),
    integration: clone(snapshot.integration),
    audit: clone(snapshot.audit),
    operations: clone(record.operations)
  };
}

export function createPactTransactionService({ integration, journal, verifyApproval, runtimeFactory = createPactExternalRuntime } = {}) {
  assertJournal(journal);
  if (!integration || typeof integration !== 'object') fail('PACT_SERVICE_INTEGRATION_REQUIRED');
  if (typeof verifyApproval !== 'function') fail('PACT_SERVICE_APPROVAL_VERIFIER_REQUIRED');
  if (typeof runtimeFactory !== 'function') fail('PACT_SERVICE_RUNTIME_FACTORY_REQUIRED');

  function freshRuntime() {
    const runtime = runtimeFactory({ integration, verifyApproval });
    for (const method of ['startIntent', 'preview', 'approve', 'commit', 'verify', 'getReceipt', 'cancel', 'inspect', 'exportSnapshot', 'restoreSnapshot']) {
      if (typeof runtime?.[method] !== 'function') fail(`PACT_SERVICE_RUNTIME_METHOD_REQUIRED:${method}`);
    }
    return runtime;
  }

  async function hydrated(transactionId) {
    const record = await journal.getTransaction(transactionId);
    const runtime = freshRuntime();
    await runtime.restoreSnapshot(record.snapshot);
    return { record, runtime };
  }

  async function preview(payload, options) {
    if (!plainObject(payload) || !('intent' in payload)) fail('PACT_SERVICE_INTENT_REQUIRED');
    const runtime = freshRuntime();
    const draft = runtime.startIntent(clone(payload.intent));
    const transaction = await runtime.preview({ signal: options.signal });
    await journal.createTransaction({ transactionId: draft.id, snapshot: runtime.exportSnapshot() });
    return { transactionId: draft.id, transaction };
  }

  async function inspect(payload) {
    const id = transactionIdFrom(payload);
    const { record } = await hydrated(id);
    return publicInspect(record);
  }

  async function approve(payload) {
    const id = transactionIdFrom(payload);
    if (!('approval' in payload)) fail('PACT_SERVICE_APPROVAL_REQUIRED');
    const { record, runtime } = await hydrated(id);
    const transaction = await runtime.approve({ approval: clone(payload.approval) });
    await journal.updateSnapshot({ transactionId: id, expectedVersion: record.version, snapshot: runtime.exportSnapshot() });
    return { transactionId: id, transaction };
  }

  async function commit(payload, options) {
    const id = transactionIdFrom(payload);
    const idempotencyKey = requiredString(options.idempotencyKey, 'PACT_SERVICE_IDEMPOTENCY_KEY_REQUIRED');
    const initial = await journal.getTransaction(id);
    const tx = initial.snapshot?.transaction;
    if (!plainObject(tx) || typeof tx.planHash !== 'string') fail('PACT_SERVICE_TRANSACTION_NOT_PREPARED');
    const claim = await journal.claimOperation({
      transactionId: id,
      operation: 'commit',
      idempotencyKey,
      request: { transactionId: id, planHash: tx.planHash }
    });
    if (claim.status === 'replay') return clone(claim.response);
    if (claim.status === 'in_progress') return { status: 'in_progress', transactionId: id, claimId: claim.claimId };
    if (claim.status === 'uncertain') return { status: 'uncertain', transactionId: id, claimId: claim.claimId, recoveryRequired: true };
    if (claim.status !== 'claimed') fail('PACT_SERVICE_INVALID_CLAIM_STATE');

    const { runtime } = await hydrated(id);
    try {
      const transaction = await runtime.commit({ idempotencyKey, signal: options.signal });
      const response = { status: 'committed', transactionId: id, transaction };
      await journal.completeOperation({
        transactionId: id,
        operation: 'commit',
        claimId: claim.claimId,
        snapshot: runtime.exportSnapshot(),
        response
      });
      return clone(response);
    } catch (error) {
      if (error?.message === 'PACT_EXTERNAL_COMMIT_UNCERTAIN') {
        await journal.markUncertain({
          transactionId: id,
          operation: 'commit',
          claimId: claim.claimId,
          snapshot: runtime.exportSnapshot()
        });
      }
      throw error;
    }
  }

  async function verify(payload, options) {
    const id = transactionIdFrom(payload);
    const { record, runtime } = await hydrated(id);
    const receipt = await runtime.verify({ signal: options.signal });
    const operation = record.operations?.commit;
    if (operation?.state === 'UNCERTAIN') {
      await journal.completeOperation({
        transactionId: id,
        operation: 'commit',
        claimId: operation.claimId,
        snapshot: runtime.exportSnapshot(),
        response: { status: 'recovered', transactionId: id, receipt }
      });
      return { transactionId: id, receipt, recovered: true };
    }
    await journal.updateSnapshot({ transactionId: id, expectedVersion: record.version, snapshot: runtime.exportSnapshot() });
    return { transactionId: id, receipt, recovered: false };
  }

  async function receipt(payload) {
    const id = transactionIdFrom(payload);
    const { runtime } = await hydrated(id);
    return { transactionId: id, receipt: runtime.getReceipt() };
  }

  async function cancel(payload) {
    const id = transactionIdFrom(payload);
    const { record, runtime } = await hydrated(id);
    const transaction = runtime.cancel();
    await journal.updateSnapshot({ transactionId: id, expectedVersion: record.version, snapshot: runtime.exportSnapshot() });
    return { transactionId: id, transaction };
  }

  async function execute(operation, payload = {}, options = {}) {
    if (typeof operation !== 'string' || !ALLOWED_OPERATIONS.has(operation)) fail('PACT_SERVICE_UNKNOWN_OPERATION');
    if (!plainObject(payload)) fail('PACT_SERVICE_PAYLOAD_REQUIRED');
    if (options.signal?.aborted) throw new Error('PACT_SERVICE_ABORTED', { cause: options.signal.reason });
    if (operation === 'preview') return preview(payload, options);
    if (operation === 'inspect') return inspect(payload);
    if (operation === 'approve') return approve(payload);
    if (operation === 'commit') return commit(payload, options);
    if (operation === 'verify') return verify(payload, options);
    if (operation === 'receipt') return receipt(payload);
    if (operation === 'cancel') return cancel(payload);
    if (operation === 'rollback') fail('PACT_SERVICE_ROLLBACK_UNSUPPORTED');
    fail('PACT_SERVICE_UNKNOWN_OPERATION');
  }

  return Object.freeze({ execute });
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}
function errorStatus(code) {
  if (code === 'PACT_API_UNAUTHORIZED') return 401;
  if (code === 'PACT_API_METHOD_NOT_ALLOWED') return 405;
  if (code === 'PACT_API_UNSUPPORTED_MEDIA_TYPE') return 415;
  if (code.includes('NOT_FOUND')) return 404;
  if (code.includes('APPROVAL_REJECTED')) return 403;
  if (/(CONFLICT|STALE|ALREADY|MISMATCH|IN_PROGRESS|UNCERTAIN|VERSION)/.test(code)) return 409;
  if (/(INVALID|REQUIRED|UNKNOWN|UNSUPPORTED|MALFORMED)/.test(code)) return 400;
  return 500;
}
function safeError(error) {
  const code = typeof error?.message === 'string' && /^PACT_[A-Z0-9_:.-]+$/.test(error.message)
    ? error.message
    : 'PACT_API_INTERNAL_ERROR';
  return { code };
}

export function createPactApiHandler({ service, authenticate, maxBodyBytes = 1_000_000 } = {}) {
  if (!service || typeof service.execute !== 'function') fail('PACT_API_SERVICE_REQUIRED');
  if (typeof authenticate !== 'function') fail('PACT_API_AUTHENTICATE_REQUIRED');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 10_000_000) fail('PACT_API_INVALID_BODY_LIMIT');

  return async function handle(request) {
    try {
      if (!(request instanceof Request)) fail('PACT_API_INVALID_REQUEST');
      if (request.method !== 'POST') fail('PACT_API_METHOD_NOT_ALLOWED');
      const contentType = request.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) fail('PACT_API_UNSUPPORTED_MEDIA_TYPE');
      const auth = await authenticate(request);
      if (!auth || typeof auth !== 'object') fail('PACT_API_UNAUTHORIZED');
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > maxBodyBytes) fail('PACT_API_BODY_TOO_LARGE');
      let envelope;
      try { envelope = JSON.parse(text); }
      catch { fail('PACT_API_MALFORMED_JSON'); }
      if (!plainObject(envelope) || typeof envelope.operation !== 'string' || !/^[a-z][a-z0-9_]*$/.test(envelope.operation) || !plainObject(envelope.payload)) {
        fail('PACT_API_INVALID_ENVELOPE');
      }
      if (!ALLOWED_OPERATIONS.has(envelope.operation)) fail('PACT_API_UNKNOWN_OPERATION');
      const idempotencyKey = CONSEQUENTIAL.has(envelope.operation) ? request.headers.get('idempotency-key') : null;
      const result = await service.execute(envelope.operation, clone(envelope.payload), {
        idempotencyKey,
        auth: clone(auth),
        signal: request.signal
      });
      const status = result?.status === 'in_progress' ? 202 : result?.status === 'uncertain' ? 409 : 200;
      return jsonResponse(result, status);
    } catch (error) {
      const safe = safeError(error);
      return jsonResponse({ error: safe }, errorStatus(safe.code));
    }
  };
}
