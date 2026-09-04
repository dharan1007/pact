import { createPactHttpConnector } from './http.js';

const $ = id => document.getElementById(id);
const connector = createPactHttpConnector({ baseUrl: location.origin, timeoutMs: 10_000 });
const state = { transaction: null, capability: null, receipt: null };

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = typeof value === 'string' ? value : pretty(value);
}

function status(message, kind = 'info') {
  const node = $('playground-status');
  node.textContent = message;
  node.dataset.kind = kind;
}

function showError(error) {
  const body = error?.details ?? { error: { code: error?.message || 'PACT_PLAYGROUND_UNKNOWN_ERROR' } };
  setText('error-output', body);
  $('error-panel').hidden = false;
  status(error?.message || 'Request failed', 'error');
}

function clearError() {
  $('error-panel').hidden = true;
  setText('error-output', '');
}

function parseJson(id, code) {
  const value = $(id).value.trim();
  if (!value) throw new Error(code);
  try { return JSON.parse(value); } catch { throw new Error(code); }
}

function updateButtons() {
  const txState = state.transaction?.state ?? 'IDLE';
  $('approve').disabled = txState !== 'PREVIEWED';
  $('commit').disabled = txState !== 'APPROVED' || !state.capability?.token;
  $('verify').disabled = txState !== 'COMMITTED';
  $('receipt').disabled = txState !== 'VERIFIED';
  $('inspect').disabled = !state.transaction?.id;
  setText('tx-state', txState);
  setText('tx-id', state.transaction?.id ?? '—');
  setText('plan-hash', state.transaction?.planHash ?? '—');
}

function renderRecoveredTransaction(transaction) {
  if (!transaction) return;
  setText('plan-output', {
    transactionId: transaction.id,
    adapter: transaction.adapter,
    baseVersion: transaction.baseVersion,
    planHash: transaction.planHash,
    effects: transaction.effects,
    invariants: transaction.invariants,
    metadata: transaction.metadata
  });
  if (transaction.state === 'COMMITTED') {
    setText('commit-output', { transaction, recovery: 'Canonical write already exists. Resume with Verify; do not commit again.' });
  } else if (transaction.state === 'VERIFIED') {
    setText('verification-output', { transaction, recovery: 'Transaction is already verified. Reload the receipt if needed.' });
  }
}

function recordRequest(operation, payload, idempotencyKey = null) {
  const envelope = { operation, payload };
  setText('request-output', envelope);
  setText('request-header-output', idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {});
}

async function run(operation, payload, execute, idempotencyKey = null) {
  clearError();
  recordRequest(operation, payload, idempotencyKey);
  status(`${operation.toUpperCase()} request in progress…`);
  try {
    const result = await execute();
    setText('response-output', result);
    status(`${operation.toUpperCase()} succeeded`, 'success');
    return result;
  } catch (error) {
    showError(error);
    throw error;
  }
}

async function preview() {
  const intent = parseJson('intent-input', 'PACT_PLAYGROUND_INVALID_INTENT_JSON');
  const payload = { adapter: { id: 'pact.generic', version: '1.0.0' }, intent };
  const result = await run('preview', payload, () => connector.preview(payload));
  state.transaction = result.transaction;
  state.capability = null;
  state.receipt = null;
  $('recovery-tx-id').value = result.transaction.id;
  renderRecoveredTransaction(result.transaction);
  updateButtons();
}

async function approve() {
  if (!state.transaction?.id) throw new Error('PACT_PLAYGROUND_TRANSACTION_REQUIRED');
  const approval = parseJson('approval-input', 'PACT_PLAYGROUND_INVALID_APPROVAL_JSON');
  const payload = { transactionId: state.transaction.id, approval };
  const result = await run('approve', payload, () => connector.approve(payload));
  state.transaction = result.transaction;
  state.capability = result.capability;
  setText('approval-output', {
    claims: result.capability?.claims,
    expiresAt: result.capability?.expiresAt,
    capabilityIssued: Boolean(result.capability?.token),
    idempotentReplay: Boolean(result.idempotentReplay)
  });
  updateButtons();
}

async function commit() {
  if (!state.transaction?.id || !state.capability?.token) throw new Error('PACT_PLAYGROUND_APPROVAL_REQUIRED');
  const key = $('idempotency-key').value.trim() || `playground_${state.transaction.id}`;
  $('idempotency-key').value = key;
  const payload = {
    transactionId: state.transaction.id,
    capabilityToken: state.capability.token
  };
  const result = await run('commit', payload, () => connector.commit(payload, key), key);
  state.transaction = result.transaction;
  setText('commit-output', {
    transaction: result.transaction,
    idempotentReplay: Boolean(result.idempotentReplay)
  });
  updateButtons();
}

async function verify() {
  if (!state.transaction?.id) throw new Error('PACT_PLAYGROUND_TRANSACTION_REQUIRED');
  const payload = { transactionId: state.transaction.id };
  const result = await run('verify', payload, () => connector.verify(payload));
  state.transaction = result.transaction ?? { ...state.transaction, state: 'VERIFIED' };
  state.receipt = result.receipt;
  setText('verification-output', result);
  setText('receipt-output', result.receipt);
  updateButtons();
}

async function receipt() {
  if (!state.transaction?.id) throw new Error('PACT_PLAYGROUND_TRANSACTION_REQUIRED');
  const payload = { transactionId: state.transaction.id };
  const result = await run('receipt', payload, () => connector.receipt(payload));
  state.receipt = result.receipt;
  setText('receipt-output', result.receipt);
}

async function inspect() {
  if (!state.transaction?.id) throw new Error('PACT_PLAYGROUND_TRANSACTION_REQUIRED');
  const payload = { transactionId: state.transaction.id };
  const result = await run('inspect', payload, () => connector.inspect(payload));
  if (result.transaction) state.transaction = result.transaction;
  setText('inspect-output', result);
  renderRecoveredTransaction(result.transaction);
  updateButtons();
}

async function recover() {
  const transactionId = $('recovery-tx-id').value.trim();
  if (!transactionId) throw new Error('PACT_PLAYGROUND_RECOVERY_TRANSACTION_REQUIRED');
  const payload = { transactionId };
  const result = await run('inspect', payload, () => connector.inspect(payload));
  if (!result.transaction) throw new Error('PACT_PLAYGROUND_RECOVERY_TRANSACTION_NOT_FOUND');
  state.transaction = result.transaction;
  state.capability = null;
  state.receipt = null;
  setText('inspect-output', result);
  renderRecoveredTransaction(result.transaction);
  updateButtons();
  if (result.transaction.state === 'COMMITTED') {
    status('Recovered COMMITTED transaction. Resume with Verify; commit will not be repeated.', 'success');
  } else if (result.transaction.state === 'VERIFIED') {
    status('Recovered VERIFIED transaction. Reload the receipt if needed.', 'success');
  } else if (result.transaction.state === 'APPROVED') {
    status('Recovered APPROVED transaction without browser-held capability. Re-approval is required before commit.', 'info');
  } else {
    status(`Recovered ${result.transaction.state} transaction.`, 'success');
  }
}

for (const [id, fn] of Object.entries({ preview, approve, commit, verify, receipt, inspect, recover })) {
  $(id).addEventListener('click', () => fn().catch(() => {}));
}

$('intent-input').value = pretty({ value: { enabled: true, label: 'PACT verified change' } });
$('approval-input').value = pretty({
  humanPrincipal: 'human:replace-with-authenticated-principal',
  agentSession: 'agent:replace-with-session',
  expiresAt: 0,
  nonce: 'replace-with-unique-nonce',
  signature: 'replace-with-64-hex-hmac-generated-by-trusted-backend'
});
setText('request-output', { operation: 'preview', payload: { adapter: { id: 'pact.generic', version: '1.0.0' }, intent: JSON.parse($('intent-input').value) } });
setText('request-header-output', {});
setText('response-output', { status: 'Run Preview to call /api/pact.' });
updateButtons();
status('Ready. Preview is public; approval requires a server-signed authenticated approval claim.');
