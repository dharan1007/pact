import { canonicalStringify, sha256Hex } from './engine.js';
import { validateAdapterPlan } from './adapter.js';

const clone = value => structuredClone(value);
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(code) { throw new Error(code); }
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function assertJson(value, code) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail(code);
    JSON.parse(encoded);
  } catch {
    fail(code);
  }
}
function pathSegments(path) {
  const segments = path.split('.');
  if (segments.some(segment => !segment || FORBIDDEN_PATH_SEGMENTS.has(segment))) fail('PACT_RUNTIME_UNSAFE_PATH');
  return segments;
}
function getPath(object, path) {
  return pathSegments(path).reduce((node, key) => node?.[key], object);
}
function setPath(object, path, value) {
  const segments = pathSegments(path);
  let cursor = object;
  for (const key of segments.slice(0, -1)) {
    if (!isPlainObject(cursor[key])) fail(`PACT_RUNTIME_PATH_NOT_OBJECT:${path}`);
    cursor = cursor[key];
  }
  cursor[segments.at(-1)] = clone(value);
}
function same(a, b) { return canonicalStringify(a) === canonicalStringify(b); }
function validateApprovalClaims(value) {
  if (!isPlainObject(value)) fail('PACT_RUNTIME_APPROVAL_REJECTED');
  if (typeof value.humanPrincipal !== 'string' || value.humanPrincipal.trim() === '') fail('PACT_RUNTIME_APPROVAL_INVALID_PRINCIPAL');
  if (typeof value.agentSession !== 'string' || value.agentSession.trim() === '') fail('PACT_RUNTIME_APPROVAL_INVALID_SESSION');
  assertJson(value, 'PACT_RUNTIME_APPROVAL_INVALID_CLAIMS');
  return clone(value);
}

export function createPactRuntime(options = {}) {
  const adapter = options.adapter;
  if (!adapter || typeof adapter.plan !== 'function' || typeof adapter.verify !== 'function') fail('PACT_RUNTIME_ADAPTER_REQUIRED');
  if (!isPlainObject(options.initialState)) fail('PACT_RUNTIME_INITIAL_STATE_REQUIRED');
  if (!Number.isSafeInteger(options.initialState.version) || options.initialState.version < 0) fail('PACT_RUNTIME_INVALID_VERSION');

  const now = options.now ?? (() => Date.now());
  const leaseMs = options.leaseMs ?? 120_000;
  const verifyApproval = options.verifyApproval;
  let canonical = clone(options.initialState);
  let transaction = null;
  let lease = null;
  const audit = [];

  const payload = tx => ({
    txId: tx.id,
    adapter: tx.adapter,
    intent: tx.intent,
    baseVersion: tx.baseVersion,
    effects: tx.effects,
    invariants: tx.invariants
  });

  async function appendAudit(type, data = {}) {
    const prevHash = audit.at(-1)?.hash ?? 'GENESIS';
    const body = { index: audit.length, at: now(), type, data, prevHash };
    audit.push({ ...body, hash: await sha256Hex(body) });
  }

  async function assertPlanIntegrity() {
    if (!transaction?.planHash) fail('PACT_RUNTIME_PLAN_REQUIRED');
    if (await sha256Hex(payload(transaction)) !== transaction.planHash) fail('PACT_RUNTIME_PLAN_TAMPERED');
  }

  async function assertApprovalIntegrity() {
    if (!transaction?.approvalClaims || !transaction?.approvalClaimsHash) fail('PACT_RUNTIME_APPROVAL_REQUIRED');
    if (await sha256Hex(transaction.approvalClaims) !== transaction.approvalClaimsHash) fail('PACT_RUNTIME_APPROVAL_CLAIMS_TAMPERED');
  }

  function startIntent(intent) {
    if (transaction && !['CANCELLED', 'ROLLED_BACK', 'VERIFIED'].includes(transaction.state)) fail('PACT_RUNTIME_ACTIVE_TRANSACTION');
    assertJson(intent, 'PACT_RUNTIME_INTENT_MUST_BE_JSON');
    transaction = {
      id: `tx_${globalThis.crypto.randomUUID()}`,
      state: 'DRAFT',
      adapter: { id: adapter.id, version: adapter.version },
      intent: clone(intent),
      createdAt: now()
    };
    lease = null;
    return clone(transaction);
  }

  async function preview() {
    if (!transaction || !['DRAFT', 'STALE'].includes(transaction.state)) fail('PACT_RUNTIME_NOT_PREVIEWABLE');
    const plan = validateAdapterPlan(await adapter.plan({
      intent: clone(transaction.intent),
      state: clone(canonical),
      transaction: { id: transaction.id, state: transaction.state }
    }));
    for (const effect of plan.effects) {
      if (!same(getPath(canonical, effect.path), effect.before)) fail(`PACT_RUNTIME_ADAPTER_PRECONDITION_MISMATCH:${effect.path}`);
    }
    for (const invariant of plan.invariants) {
      if (!same(getPath(canonical, invariant.path), invariant.equals)) fail(`PACT_RUNTIME_INVARIANT_NOT_TRUE_AT_PREVIEW:${invariant.path}`);
    }
    transaction = {
      ...transaction,
      state: 'PREVIEWED',
      baseVersion: canonical.version,
      effects: plan.effects,
      invariants: plan.invariants,
      metadata: plan.metadata
    };
    delete transaction.approvalClaims;
    delete transaction.approvalClaimsHash;
    transaction.planHash = await sha256Hex(payload(transaction));
    lease = null;
    await appendAudit('PREVIEWED', { txId: transaction.id, adapter: transaction.adapter, planHash: transaction.planHash, baseVersion: transaction.baseVersion });
    return clone(transaction);
  }

  async function approve({ approval } = {}) {
    if (transaction?.state !== 'PREVIEWED') fail('PACT_RUNTIME_NOT_PREVIEWED');
    await assertPlanIntegrity();
    if (typeof verifyApproval !== 'function') fail('PACT_RUNTIME_APPROVAL_VERIFIER_REQUIRED');
    const verified = await verifyApproval({
      approval: clone(approval),
      txId: transaction.id,
      planHash: transaction.planHash,
      adapter: clone(transaction.adapter),
      intent: clone(transaction.intent),
      baseVersion: transaction.baseVersion,
      effects: clone(transaction.effects),
      invariants: clone(transaction.invariants)
    });
    if (!verified) fail('PACT_RUNTIME_APPROVAL_REJECTED');
    const approvalClaims = validateApprovalClaims(verified);
    const approvalClaimsHash = await sha256Hex(approvalClaims);
    lease = {
      token: `lease_${globalThis.crypto.randomUUID()}`,
      txId: transaction.id,
      planHash: transaction.planHash,
      approvalClaimsHash,
      issuedAt: now(),
      expiresAt: now() + leaseMs
    };
    transaction = { ...transaction, state: 'APPROVED', approvalClaims, approvalClaimsHash, approvedAt: now() };
    await appendAudit('APPROVED', {
      txId: transaction.id,
      planHash: transaction.planHash,
      approvalClaimsHash,
      humanPrincipal: approvalClaims.humanPrincipal,
      agentSession: approvalClaims.agentSession,
      expiresAt: lease.expiresAt
    });
    return clone(transaction);
  }

  async function commit() {
    if (!transaction) fail('PACT_RUNTIME_NO_TRANSACTION');
    if (['COMMITTED', 'VERIFIED'].includes(transaction.state)) return clone(transaction);
    if (transaction.state !== 'APPROVED') fail('PACT_RUNTIME_NOT_APPROVED');
    await assertPlanIntegrity();
    await assertApprovalIntegrity();
    if (!lease || lease.txId !== transaction.id || lease.planHash !== transaction.planHash || lease.approvalClaimsHash !== transaction.approvalClaimsHash || now() > lease.expiresAt) fail('PACT_RUNTIME_INVALID_OR_EXPIRED_LEASE');
    if (canonical.version !== transaction.baseVersion) fail('PACT_RUNTIME_STALE_PLAN');

    for (const effect of transaction.effects) {
      if (!same(getPath(canonical, effect.path), effect.before)) fail(`PACT_RUNTIME_PRECONDITION_FAILED:${effect.path}`);
    }
    const next = clone(canonical);
    for (const effect of transaction.effects) setPath(next, effect.path, effect.after);
    for (const invariant of transaction.invariants) {
      if (!same(getPath(next, invariant.path), invariant.equals)) fail(`PACT_RUNTIME_INVARIANT_FAILED:${invariant.path}`);
    }
    next.version = canonical.version + 1;
    canonical = next;
    transaction = { ...transaction, state: 'COMMITTED', commitVersion: canonical.version, committedAt: now() };
    lease = null;
    await appendAudit('COMMITTED', { txId: transaction.id, planHash: transaction.planHash, approvalClaimsHash: transaction.approvalClaimsHash, commitVersion: transaction.commitVersion });
    return clone(transaction);
  }

  async function verify() {
    if (!transaction) fail('PACT_RUNTIME_NO_TRANSACTION');
    if (transaction.state === 'VERIFIED') return clone(transaction.receipt);
    if (transaction.state !== 'COMMITTED') fail('PACT_RUNTIME_NOT_COMMITTED');
    await assertPlanIntegrity();
    await assertApprovalIntegrity();
    for (const effect of transaction.effects) {
      if (!same(getPath(canonical, effect.path), effect.after)) fail(`PACT_RUNTIME_POSTCONDITION_FAILED:${effect.path}`);
    }
    for (const invariant of transaction.invariants) {
      if (!same(getPath(canonical, invariant.path), invariant.equals)) fail(`PACT_RUNTIME_INVARIANT_FAILED:${invariant.path}`);
    }
    const adapterVerified = await adapter.verify({
      intent: clone(transaction.intent),
      state: clone(canonical),
      plan: { effects: clone(transaction.effects), invariants: clone(transaction.invariants), metadata: clone(transaction.metadata) },
      approvalClaims: clone(transaction.approvalClaims),
      transaction: { id: transaction.id, baseVersion: transaction.baseVersion, commitVersion: transaction.commitVersion, planHash: transaction.planHash }
    });
    if (!adapterVerified) fail('PACT_RUNTIME_ADAPTER_VERIFICATION_FAILED');
    const body = {
      txId: transaction.id,
      adapter: clone(transaction.adapter),
      planHash: transaction.planHash,
      approvalClaims: clone(transaction.approvalClaims),
      approvalClaimsHash: transaction.approvalClaimsHash,
      baseVersion: transaction.baseVersion,
      commitVersion: transaction.commitVersion,
      verifiedVersion: canonical.version,
      effects: clone(transaction.effects),
      invariants: clone(transaction.invariants),
      verifiedAt: now()
    };
    const receipt = { ...body, receiptHash: await sha256Hex(body) };
    transaction = { ...transaction, state: 'VERIFIED', receipt };
    await appendAudit('RECEIPT', { txId: transaction.id, receiptHash: receipt.receiptHash, approvalClaimsHash: transaction.approvalClaimsHash });
    return clone(receipt);
  }

  async function rollback() {
    if (transaction?.state !== 'VERIFIED') fail('PACT_RUNTIME_NOT_VERIFIED');
    if (canonical.version !== transaction.receipt.verifiedVersion) fail('PACT_RUNTIME_ROLLBACK_CONFLICT');
    for (const effect of transaction.effects) {
      if (!same(getPath(canonical, effect.path), effect.after)) fail('PACT_RUNTIME_ROLLBACK_CONFLICT');
    }
    const next = clone(canonical);
    for (const effect of [...transaction.effects].reverse()) setPath(next, effect.path, effect.before);
    next.version = canonical.version + 1;
    canonical = next;
    transaction = { ...transaction, state: 'ROLLED_BACK', rollbackVersion: canonical.version, rolledBackAt: now() };
    await appendAudit('ROLLED_BACK', { txId: transaction.id, rollbackVersion: canonical.version });
    return clone(transaction);
  }

  function cancel() {
    if (!transaction) fail('PACT_RUNTIME_NO_TRANSACTION');
    if (['COMMITTED', 'VERIFIED', 'ROLLED_BACK'].includes(transaction.state)) fail('PACT_RUNTIME_TOO_LATE_TO_CANCEL');
    transaction = { ...transaction, state: 'CANCELLED', cancelledAt: now() };
    lease = null;
    return clone(transaction);
  }

  function inspect() {
    return { adapter: { id: adapter.id, version: adapter.version }, canonical: clone(canonical), transaction: clone(transaction), lease: clone(lease), audit: clone(audit) };
  }

  return { startIntent, preview, approve, commit, verify, rollback, cancel, inspect };
}

function validateExternalIntegration(integration) {
  if (!integration || typeof integration !== 'object' || Array.isArray(integration)) fail('PACT_EXTERNAL_INTEGRATION_REQUIRED');
  if (typeof integration.id !== 'string' || !integration.id.trim()) fail('PACT_EXTERNAL_INTEGRATION_ID_REQUIRED');
  if (typeof integration.version !== 'string' || !integration.version.trim()) fail('PACT_EXTERNAL_INTEGRATION_VERSION_REQUIRED');
  for (const method of ['read', 'plan', 'apply', 'verify']) {
    if (typeof integration[method] !== 'function') fail(`PACT_EXTERNAL_INTEGRATION_METHOD_REQUIRED:${method}`);
  }
  return integration;
}

function validateExternalSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) fail('PACT_EXTERNAL_INVALID_SNAPSHOT');
  if (typeof snapshot.revision !== 'string' || !snapshot.revision.trim()) fail('PACT_EXTERNAL_REVISION_REQUIRED');
  if (!isPlainObject(snapshot.state)) fail('PACT_EXTERNAL_STATE_REQUIRED');
  assertJson(snapshot.state, 'PACT_EXTERNAL_STATE_MUST_BE_JSON');
  return { revision: snapshot.revision, state: clone(snapshot.state) };
}

function assertExternalStateMatchesPlan(state, plan, phase) {
  for (const effect of plan.effects) {
    const expected = phase === 'before' ? effect.before : effect.after;
    if (!same(getPath(state, effect.path), expected)) {
      fail(phase === 'before' ? `PACT_EXTERNAL_PRECONDITION_FAILED:${effect.path}` : `PACT_EXTERNAL_POSTCONDITION_FAILED:${effect.path}`);
    }
  }
  for (const invariant of plan.invariants) {
    if (!same(getPath(state, invariant.path), invariant.equals)) fail(`PACT_EXTERNAL_INVARIANT_FAILED:${invariant.path}`);
  }
}

function externalPlanPayload(tx) {
  return {
    txId: tx.id,
    integration: tx.integration,
    intent: tx.intent,
    baseRevision: tx.baseRevision,
    effects: tx.effects,
    invariants: tx.invariants,
    metadata: tx.metadata
  };
}

export function createPactExternalRuntime(options = {}) {
  const integration = validateExternalIntegration(options.integration);
  const verifyApproval = options.verifyApproval;
  const now = options.now ?? (() => Date.now());
  const leaseMs = options.leaseMs ?? 120_000;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) fail('PACT_EXTERNAL_INVALID_LEASE');

  let transaction = null;
  let lease = null;
  const audit = [];

  async function appendAudit(type, data = {}) {
    const prevHash = audit.at(-1)?.hash ?? 'GENESIS';
    const body = { index: audit.length, at: now(), type, data, prevHash };
    audit.push({ ...body, hash: await sha256Hex(body) });
  }

  function assertSignal(signal) {
    if (signal?.aborted) throw new Error('PACT_EXTERNAL_ABORTED', { cause: signal.reason });
  }

  async function readRemote(signal) {
    assertSignal(signal);
    const snapshot = validateExternalSnapshot(await integration.read({
      intent: clone(transaction?.intent),
      transaction: transaction ? { id: transaction.id, state: transaction.state } : null,
      signal
    }));
    assertSignal(signal);
    return snapshot;
  }

  async function assertPlanIntegrity() {
    if (!transaction?.planHash) fail('PACT_EXTERNAL_PLAN_REQUIRED');
    if (await sha256Hex(externalPlanPayload(transaction)) !== transaction.planHash) fail('PACT_EXTERNAL_PLAN_TAMPERED');
  }

  async function assertApprovalIntegrity() {
    if (!transaction?.approvalClaims || !transaction?.approvalClaimsHash) fail('PACT_EXTERNAL_APPROVAL_REQUIRED');
    if (await sha256Hex(transaction.approvalClaims) !== transaction.approvalClaimsHash) fail('PACT_EXTERNAL_APPROVAL_TAMPERED');
  }

  function startIntent(intent) {
    if (transaction && !['CANCELLED', 'VERIFIED'].includes(transaction.state)) fail('PACT_EXTERNAL_ACTIVE_TRANSACTION');
    assertJson(intent, 'PACT_EXTERNAL_INTENT_MUST_BE_JSON');
    transaction = {
      id: `tx_${globalThis.crypto.randomUUID()}`,
      state: 'DRAFT',
      integration: { id: integration.id, version: integration.version },
      intent: clone(intent),
      createdAt: now()
    };
    lease = null;
    return clone(transaction);
  }

  async function preview({ signal } = {}) {
    if (transaction?.state !== 'DRAFT') fail('PACT_EXTERNAL_NOT_PREVIEWABLE');
    const snapshot = await readRemote(signal);
    const plan = validateAdapterPlan(await integration.plan({
      intent: clone(transaction.intent),
      state: clone(snapshot.state),
      revision: snapshot.revision,
      transaction: { id: transaction.id, state: transaction.state },
      signal
    }));
    assertSignal(signal);
    assertExternalStateMatchesPlan(snapshot.state, plan, 'before');
    transaction = {
      ...transaction,
      state: 'PREVIEWED',
      baseRevision: snapshot.revision,
      effects: plan.effects,
      invariants: plan.invariants,
      metadata: plan.metadata,
      previewedAt: now()
    };
    transaction.planHash = await sha256Hex(externalPlanPayload(transaction));
    await appendAudit('EXTERNAL_PREVIEWED', { txId: transaction.id, baseRevision: transaction.baseRevision, planHash: transaction.planHash });
    return clone(transaction);
  }

  async function approve({ approval } = {}) {
    if (transaction?.state !== 'PREVIEWED') fail('PACT_EXTERNAL_NOT_PREVIEWED');
    await assertPlanIntegrity();
    if (typeof verifyApproval !== 'function') fail('PACT_EXTERNAL_APPROVAL_VERIFIER_REQUIRED');
    const verified = await verifyApproval({
      approval: clone(approval),
      txId: transaction.id,
      planHash: transaction.planHash,
      integration: clone(transaction.integration),
      intent: clone(transaction.intent),
      baseRevision: transaction.baseRevision,
      effects: clone(transaction.effects),
      invariants: clone(transaction.invariants)
    });
    if (!verified) fail('PACT_EXTERNAL_APPROVAL_REJECTED');
    const approvalClaims = validateApprovalClaims(verified);
    const approvalClaimsHash = await sha256Hex(approvalClaims);
    lease = {
      txId: transaction.id,
      planHash: transaction.planHash,
      approvalClaimsHash,
      issuedAt: now(),
      expiresAt: now() + leaseMs
    };
    transaction = { ...transaction, state: 'APPROVED', approvalClaims, approvalClaimsHash, approvedAt: now() };
    await appendAudit('EXTERNAL_APPROVED', { txId: transaction.id, approvalClaimsHash, expiresAt: lease.expiresAt });
    return clone(transaction);
  }

  async function commit({ idempotencyKey, signal } = {}) {
    if (!transaction) fail('PACT_EXTERNAL_NO_TRANSACTION');
    const key = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
    if (!key) fail('PACT_EXTERNAL_IDEMPOTENCY_KEY_REQUIRED');
    if (key.length > 256) fail('PACT_EXTERNAL_INVALID_IDEMPOTENCY_KEY');
    if (transaction.state === 'COMMITTED' || transaction.state === 'VERIFIED') {
      if (transaction.idempotencyKeyHash !== await sha256Hex(key)) fail('PACT_EXTERNAL_IDEMPOTENCY_KEY_MISMATCH');
      return clone(transaction);
    }
    if (transaction.state !== 'APPROVED') fail('PACT_EXTERNAL_NOT_APPROVED');
    await assertPlanIntegrity();
    await assertApprovalIntegrity();
    if (!lease || lease.txId !== transaction.id || lease.planHash !== transaction.planHash || lease.approvalClaimsHash !== transaction.approvalClaimsHash || now() > lease.expiresAt) {
      fail('PACT_EXTERNAL_INVALID_OR_EXPIRED_LEASE');
    }
    const current = await readRemote(signal);
    if (current.revision !== transaction.baseRevision) fail('PACT_EXTERNAL_STALE_REMOTE_STATE');
    const plan = { effects: clone(transaction.effects), invariants: clone(transaction.invariants), metadata: clone(transaction.metadata) };
    assertExternalStateMatchesPlan(current.state, plan, 'before');
    const idempotencyKeyHash = await sha256Hex(key);
    try {
      const applicationResult = await integration.apply({
        intent: clone(transaction.intent),
        state: clone(current.state),
        revision: current.revision,
        plan: clone(plan),
        approvalClaims: clone(transaction.approvalClaims),
        transaction: { id: transaction.id, planHash: transaction.planHash, baseRevision: transaction.baseRevision },
        idempotencyKey: key,
        signal
      });
      assertSignal(signal);
      const normalizedResult = applicationResult === undefined ? null : applicationResult;
      assertJson(normalizedResult, 'PACT_EXTERNAL_APPLY_RESULT_MUST_BE_JSON');
      const applicationResultHash = await sha256Hex(normalizedResult);
      transaction = {
        ...transaction,
        state: 'COMMITTED',
        idempotencyKeyHash,
        applicationResult: clone(normalizedResult),
        applicationResultHash,
        committedAt: now()
      };
      lease = null;
      await appendAudit('EXTERNAL_COMMITTED', { txId: transaction.id, idempotencyKeyHash, applicationResultHash });
      return clone(transaction);
    } catch (cause) {
      transaction = { ...transaction, state: 'COMMIT_UNCERTAIN', idempotencyKeyHash, commitAttemptedAt: now() };
      lease = null;
      await appendAudit('EXTERNAL_COMMIT_UNCERTAIN', { txId: transaction.id, idempotencyKeyHash });
      throw new Error('PACT_EXTERNAL_COMMIT_UNCERTAIN', { cause });
    }
  }

  async function verify({ signal } = {}) {
    if (!transaction) fail('PACT_EXTERNAL_NO_TRANSACTION');
    if (transaction.state === 'VERIFIED') return clone(transaction.receipt);
    if (!['COMMITTED', 'COMMIT_UNCERTAIN'].includes(transaction.state)) fail('PACT_EXTERNAL_NOT_COMMITTED');
    await assertPlanIntegrity();
    await assertApprovalIntegrity();
    const priorState = transaction.state;
    const current = await readRemote(signal);
    const plan = { effects: clone(transaction.effects), invariants: clone(transaction.invariants), metadata: clone(transaction.metadata) };
    assertExternalStateMatchesPlan(current.state, plan, 'after');
    const integrationVerified = await integration.verify({
      intent: clone(transaction.intent),
      state: clone(current.state),
      revision: current.revision,
      plan: clone(plan),
      applicationResult: clone(transaction.applicationResult),
      approvalClaims: clone(transaction.approvalClaims),
      transaction: { id: transaction.id, planHash: transaction.planHash, baseRevision: transaction.baseRevision },
      signal
    });
    assertSignal(signal);
    if (integrationVerified !== true) fail('PACT_EXTERNAL_INTEGRATION_VERIFICATION_FAILED');
    const body = {
      txId: transaction.id,
      integration: clone(transaction.integration),
      planHash: transaction.planHash,
      approvalClaims: clone(transaction.approvalClaims),
      approvalClaimsHash: transaction.approvalClaimsHash,
      baseRevision: transaction.baseRevision,
      verifiedRevision: current.revision,
      effects: clone(transaction.effects),
      invariants: clone(transaction.invariants),
      idempotencyKeyHash: transaction.idempotencyKeyHash,
      applicationResultHash: transaction.applicationResultHash ?? null,
      recoveredFromUncertainCommit: priorState === 'COMMIT_UNCERTAIN',
      verifiedAt: now()
    };
    const receipt = { ...body, receiptHash: await sha256Hex(body) };
    transaction = { ...transaction, state: 'VERIFIED', receipt };
    await appendAudit('EXTERNAL_RECEIPT', { txId: transaction.id, receiptHash: receipt.receiptHash, verifiedRevision: current.revision });
    return clone(receipt);
  }

  function getReceipt() {
    if (transaction?.state !== 'VERIFIED' || !transaction.receipt) fail('PACT_EXTERNAL_RECEIPT_NOT_AVAILABLE');
    return clone(transaction.receipt);
  }

  function cancel() {
    if (!transaction) fail('PACT_EXTERNAL_NO_TRANSACTION');
    if (['COMMITTED', 'COMMIT_UNCERTAIN', 'VERIFIED'].includes(transaction.state)) fail('PACT_EXTERNAL_TOO_LATE_TO_CANCEL');
    transaction = { ...transaction, state: 'CANCELLED', cancelledAt: now() };
    lease = null;
    return clone(transaction);
  }

  function inspect() {
    return {
      integration: { id: integration.id, version: integration.version },
      transaction: clone(transaction),
      lease: clone(lease),
      audit: clone(audit)
    };
  }

  return { startIntent, preview, approve, commit, verify, getReceipt, cancel, inspect };
}
