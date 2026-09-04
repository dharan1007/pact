const clone = value => structuredClone(value);

export function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonicalStringify(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function makeReferenceState() {
  return {
    version: 42,
    billing: { plan: 'team' },
    deletedRecords: 0,
    projects: { helios: { owner: 'acme-a' } },
    tasks: { t1: { owner: 'acme-a' }, t2: { owner: 'acme-b' } },
    people: {
      'acme-a': { status: 'active', prod: true, repo: 'write' },
      'acme-b': { status: 'active', prod: true, repo: 'write' },
      maya: { status: 'active', prod: true, repo: 'admin' }
    }
  };
}

const referenceEffects = () => [
  ['projects.helios.owner', 'acme-a', 'maya'],
  ['tasks.t1.owner', 'acme-a', 'maya'],
  ['tasks.t2.owner', 'acme-b', 'maya'],
  ['people.acme-a.prod', true, false],
  ['people.acme-b.prod', true, false],
  ['people.acme-a.repo', 'write', 'read:7d'],
  ['people.acme-b.repo', 'write', 'read:7d'],
  ['people.acme-a.status', 'active', 'suspended'],
  ['people.acme-b.status', 'active', 'suspended']
].map(([path, before, after]) => ({ path, before, after }));

function getPath(object, path) { return path.split('.').reduce((node, key) => node?.[key], object); }
function setPath(object, path, value) {
  const parts = path.split('.'); let cursor = object;
  for (const key of parts.slice(0, -1)) cursor = cursor[key];
  cursor[parts.at(-1)] = value;
}
function fail(code) { throw new Error(code); }

export function createPactEngine(options = {}) {
  const now = options.now ?? (() => Date.now());
  const leaseMs = options.leaseMs ?? 120_000;
  const restored = options.snapshot ? clone(options.snapshot) : null;
  let canonical = restored?.canonical ?? clone(options.initialState ?? makeReferenceState());
  let transaction = restored?.transaction ?? null;
  let lease = restored?.lease ?? null;
  let audit = restored?.audit ?? [];

  const txPayload = tx => ({
    txId: tx.id,
    baseVersion: tx.baseVersion,
    effects: tx.effects,
    constraints: tx.constraints
  });

  async function appendAudit(type, data = {}) {
    const prevHash = audit.at(-1)?.hash ?? 'GENESIS';
    const body = { index: audit.length, at: now(), type, data, prevHash };
    audit.push({ ...body, hash: await sha256Hex(body) });
  }

  async function assertAudit() {
    let prevHash = 'GENESIS';
    for (let i = 0; i < audit.length; i++) {
      const { hash, ...body } = audit[i];
      if (body.index !== i || body.prevHash !== prevHash || await sha256Hex(body) !== hash) fail('AUDIT_CHAIN_TAMPERED');
      prevHash = hash;
    }
  }

  function startIntent() {
    if (transaction && !['CANCELLED', 'ROLLED_BACK'].includes(transaction.state)) fail('ACTIVE_TRANSACTION');
    transaction = { id: `tx_${globalThis.crypto.randomUUID()}`, state: 'DRAFT', createdAt: now() };
    lease = null;
    return clone(transaction);
  }

  async function preview() {
    await assertAudit();
    if (!transaction || !['DRAFT', 'STALE'].includes(transaction.state)) fail('NOT_PREVIEWABLE');
    const before = { billingPlan: canonical.billing.plan, deletedRecords: canonical.deletedRecords };
    const next = {
      ...transaction,
      state: 'PREVIEWED',
      baseVersion: canonical.version,
      effects: referenceEffects(),
      constraints: { billingPlanUnchangedFrom: before.billingPlan, deletedRecordsUnchangedFrom: before.deletedRecords }
    };
    next.planHash = await sha256Hex(txPayload(next));
    transaction = next; lease = null;
    await appendAudit('PREVIEWED', { txId: next.id, planHash: next.planHash, baseVersion: next.baseVersion });
    return clone(transaction);
  }

  async function approve({ trusted }) {
    await assertAudit();
    if (!trusted) fail('TRUSTED_GESTURE_REQUIRED');
    if (transaction?.state !== 'PREVIEWED') fail('NOT_PREVIEWED');
    if (await sha256Hex(txPayload(transaction)) !== transaction.planHash) fail('PLAN_TAMPERED');
    lease = {
      token: `lease_${globalThis.crypto.randomUUID()}`,
      txId: transaction.id,
      planHash: transaction.planHash,
      issuedAt: now(),
      expiresAt: now() + leaseMs
    };
    transaction = { ...transaction, state: 'APPROVED', approvedAt: now() };
    await appendAudit('APPROVED', { txId: transaction.id, planHash: transaction.planHash, expiresAt: lease.expiresAt });
    return clone(transaction);
  }

  async function commit() {
    await assertAudit();
    if (!transaction) fail('NO_TRANSACTION');
    if (transaction.state === 'CANCELLED') fail('CANCELLED');
    if (['COMMITTED', 'VERIFIED'].includes(transaction.state)) return clone(transaction);
    if (transaction.state === 'STALE' || (transaction.baseVersion != null && canonical.version !== transaction.baseVersion)) fail('STALE_PLAN');
    if (transaction.state !== 'APPROVED') fail('NOT_APPROVED');
    if (!lease || lease.txId !== transaction.id || lease.planHash !== transaction.planHash || now() > lease.expiresAt) fail('INVALID_OR_EXPIRED_LEASE');
    if (await sha256Hex(txPayload(transaction)) !== transaction.planHash) fail('PLAN_TAMPERED');

    for (const effect of transaction.effects) if (getPath(canonical, effect.path) !== effect.before) fail(`PRECONDITION_FAILED:${effect.path}`);
    const next = clone(canonical);
    for (const effect of transaction.effects) setPath(next, effect.path, clone(effect.after));
    if (next.billing.plan !== transaction.constraints.billingPlanUnchangedFrom || next.deletedRecords !== transaction.constraints.deletedRecordsUnchangedFrom) fail('POLICY_VIOLATION');
    next.version = canonical.version + 1;
    canonical = next;
    transaction = { ...transaction, state: 'COMMITTED', commitVersion: canonical.version, committedAt: now() };
    lease = null;
    await appendAudit('COMMITTED', { txId: transaction.id, commitVersion: transaction.commitVersion, planHash: transaction.planHash });
    return clone(transaction);
  }

  async function verify() {
    await assertAudit();
    if (!transaction) fail('NO_TRANSACTION');
    if (transaction.state === 'VERIFIED') return getReceipt();
    if (transaction.state !== 'COMMITTED') fail('NOT_COMMITTED');
    for (const effect of transaction.effects) if (getPath(canonical, effect.path) !== effect.after) fail(`POSTCONDITION_FAILED:${effect.path}`);
    if (canonical.billing.plan !== transaction.constraints.billingPlanUnchangedFrom || canonical.deletedRecords !== transaction.constraints.deletedRecordsUnchangedFrom) fail('NEGATIVE_INVARIANT_FAILED');
    const body = {
      txId: transaction.id,
      planHash: transaction.planHash,
      commitVersion: transaction.commitVersion,
      verifiedVersion: canonical.version,
      effects: clone(transaction.effects),
      constraints: clone(transaction.constraints),
      verifiedAt: now()
    };
    const receipt = { ...body, receiptHash: await sha256Hex(body) };
    transaction = { ...transaction, state: 'VERIFIED', receipt };
    await appendAudit('RECEIPT', { txId: transaction.id, receiptHash: receipt.receiptHash });
    return clone(receipt);
  }

  async function getReceipt() {
    await assertAudit();
    if (transaction?.state !== 'VERIFIED' || !transaction.receipt) fail('NO_VERIFIED_RECEIPT');
    const { receiptHash, ...body } = transaction.receipt;
    if (await sha256Hex(body) !== receiptHash) fail('RECEIPT_TAMPERED');
    const anchor = audit.find(e => e.type === 'RECEIPT' && e.data?.txId === transaction.id && e.data?.receiptHash === receiptHash);
    if (!anchor) fail('RECEIPT_UNANCHORED');
    return clone(transaction.receipt);
  }

  function cancel() {
    if (!transaction) fail('NO_TRANSACTION');
    if (['COMMITTED', 'VERIFIED', 'ROLLED_BACK'].includes(transaction.state)) fail('TOO_LATE_TO_CANCEL');
    transaction = { ...transaction, state: 'CANCELLED', cancelledAt: now() };
    lease = null;
    return clone(transaction);
  }

  async function rollback() {
    await assertAudit();
    if (!transaction) fail('NO_TRANSACTION');
    if (transaction.state === 'ROLLED_BACK') fail('ALREADY_ROLLED_BACK');
    if (transaction.state !== 'VERIFIED') fail('NOT_VERIFIED');
    await getReceipt();
    if (canonical.version !== transaction.receipt.verifiedVersion) fail('ROLLBACK_CONFLICT');
    for (const effect of transaction.effects) if (getPath(canonical, effect.path) !== effect.after) fail('ROLLBACK_CONFLICT');
    const next = clone(canonical);
    for (const effect of [...transaction.effects].reverse()) setPath(next, effect.path, clone(effect.before));
    next.version = canonical.version + 1;
    canonical = next;
    transaction = { ...transaction, state: 'ROLLED_BACK', rollbackVersion: canonical.version, rolledBackAt: now() };
    await appendAudit('ROLLED_BACK', { txId: transaction.id, rollbackVersion: canonical.version });
    return clone(transaction);
  }

  function simulateConcurrentEdit() {
    canonical.version += 1;
    canonical.tasks.t1.note = 'concurrent human edit';
    if (transaction?.state === 'APPROVED') transaction = { ...transaction, state: 'STALE' };
    lease = null;
    return clone(canonical);
  }

  function approvalLeaseValid() {
    return transaction?.state === 'APPROVED' && lease?.txId === transaction.id && lease?.planHash === transaction.planHash && now() <= lease.expiresAt;
  }

  async function reconcileExpiredApproval() {
    if (transaction?.state !== 'APPROVED') return { expired: false, state: transaction?.state ?? 'IDLE' };
    if (approvalLeaseValid()) return { expired: false, state: 'APPROVED' };
    await assertAudit();
    if (await sha256Hex(txPayload(transaction)) !== transaction.planHash) fail('PLAN_TAMPERED');
    const nextState = canonical.version === transaction.baseVersion ? 'PREVIEWED' : 'STALE';
    transaction = { ...transaction, state: nextState, approvalExpiredAt: now() };
    lease = null;
    await appendAudit('APPROVAL_EXPIRED', { txId: transaction.id, planHash: transaction.planHash, state: nextState });
    return { expired: true, state: nextState, planHash: transaction.planHash };
  }

  async function validateIntegrity() {
    await assertAudit();
    if (transaction?.planHash && await sha256Hex(txPayload(transaction)) !== transaction.planHash) fail('PLAN_TAMPERED');
    if (lease) {
      if (!transaction || lease.txId !== transaction.id || lease.planHash !== transaction.planHash) fail('LEASE_BINDING_TAMPERED');
    }
    if (transaction?.state === 'COMMITTED') {
      if (transaction.commitVersion !== canonical.version) fail('COMMIT_VERSION_MISMATCH');
      for (const effect of transaction.effects) if (getPath(canonical, effect.path) !== effect.after) fail(`POSTCONDITION_FAILED:${effect.path}`);
    }
    if (transaction?.state === 'VERIFIED') {
      await getReceipt();
      for (const effect of transaction.effects) if (getPath(canonical, effect.path) !== effect.after) fail(`POSTCONDITION_FAILED:${effect.path}`);
      if (canonical.billing.plan !== transaction.constraints.billingPlanUnchangedFrom || canonical.deletedRecords !== transaction.constraints.deletedRecordsUnchangedFrom) fail('NEGATIVE_INVARIANT_FAILED');
    }
    return { ok: true, state: transaction?.state ?? 'IDLE', version: canonical.version };
  }

  function inspect() { return { canonical: clone(canonical), transaction: clone(transaction), lease: clone(lease), audit: clone(audit) }; }
  function exportSnapshot() { return inspect(); }
  function restoreSnapshot(snapshot) {
    if (!snapshot?.canonical || !Array.isArray(snapshot.audit)) fail('INVALID_SNAPSHOT');
    canonical = clone(snapshot.canonical);
    transaction = clone(snapshot.transaction ?? null);
    lease = clone(snapshot.lease ?? null);
    audit = clone(snapshot.audit);
    return inspect();
  }
  function activeCapabilities() {
    const names = ['pact_inspect'];
    if (!transaction || ['CANCELLED', 'ROLLED_BACK'].includes(transaction.state)) names.push('pact_start_intent');
    if (transaction && ['DRAFT', 'STALE'].includes(transaction.state)) names.push('pact_preview_transaction');
    if (transaction?.state === 'PREVIEWED') names.push('pact_request_human_approval');
    if (transaction?.state === 'APPROVED' && canonical.version === transaction.baseVersion && approvalLeaseValid()) names.push('pact_commit_transaction');
    if (transaction?.state === 'COMMITTED') names.push('pact_verify_transaction');
    if (transaction?.state === 'VERIFIED') names.push('pact_get_transaction_receipt', 'pact_rollback_transaction');
    if (transaction && !['COMMITTED','VERIFIED','ROLLED_BACK','CANCELLED'].includes(transaction.state)) names.push('pact_cancel_transaction');
    return names;
  }

  return {
    startIntent, preview, approve, commit, verify, getReceipt, cancel, rollback,
    simulateConcurrentEdit, inspect, exportSnapshot, restoreSnapshot, validateIntegrity, reconcileExpiredApproval, activeCapabilities,
    __unsafeMutateForTest(fn) { fn(transaction); },
    __unsafeMutateCanonicalForTest(fn) { fn(canonical); },
    __unsafeMutateAuditForTest(fn) { fn(audit); }
  };
}
