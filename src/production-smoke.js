import { createHmac } from 'node:crypto';
import { canonicalStringify } from './engine.js';
import { createPactHttpConnector } from './http.js';

const fail = code => { throw new Error(code); };
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function nonEmpty(value, code, max = 512) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  const normalized = value.trim();
  if (normalized.length > max) fail(code);
  return normalized;
}

function validateAdapter(adapter) {
  if (!isPlainObject(adapter)) fail('PACT_SMOKE_ADAPTER_REQUIRED');
  return {
    id: nonEmpty(adapter.id, 'PACT_SMOKE_ADAPTER_ID_REQUIRED', 256),
    version: nonEmpty(adapter.version, 'PACT_SMOKE_ADAPTER_VERSION_REQUIRED', 128)
  };
}

function validateIntent(intent) {
  if (!isPlainObject(intent)) fail('PACT_SMOKE_INTENT_REQUIRED');
  try {
    return JSON.parse(JSON.stringify(intent));
  } catch {
    fail('PACT_SMOKE_INTENT_MUST_BE_JSON');
  }
}

function assertReceipt(receipt, transaction) {
  if (!isPlainObject(receipt)) fail('PACT_SMOKE_RECEIPT_REQUIRED');
  if (receipt.txId !== transaction.id) fail('PACT_SMOKE_RECEIPT_TX_MISMATCH');
  if (receipt.planHash !== transaction.planHash) fail('PACT_SMOKE_RECEIPT_PLAN_MISMATCH');
  if (receipt.baseVersion !== transaction.baseVersion) fail('PACT_SMOKE_RECEIPT_BASE_VERSION_MISMATCH');
  if (!Number.isSafeInteger(receipt.commitVersion) || receipt.commitVersion !== transaction.baseVersion + 1) {
    fail('PACT_SMOKE_RECEIPT_COMMIT_VERSION_INVALID');
  }
  if (receipt.verifiedVersion !== receipt.commitVersion) fail('PACT_SMOKE_RECEIPT_VERIFIED_VERSION_MISMATCH');
  if (typeof receipt.receiptHash !== 'string' || !/^[a-f0-9]{64}$/i.test(receipt.receiptHash)) fail('PACT_SMOKE_RECEIPT_HASH_INVALID');
  return receipt;
}

export async function runProductionTransactionSmoke({
  baseUrl,
  adapter,
  intent,
  approvalSecret,
  humanPrincipal = 'release:production-smoke',
  agentSession = 'release:production-smoke',
  idempotencyKey,
  now = () => Date.now(),
  nonce,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
} = {}) {
  adapter = validateAdapter(adapter);
  intent = validateIntent(intent);
  baseUrl = nonEmpty(baseUrl, 'PACT_SMOKE_BASE_URL_REQUIRED', 2048);
  approvalSecret = nonEmpty(approvalSecret, 'PACT_SMOKE_APPROVAL_SECRET_REQUIRED', 4096);
  if (Buffer.byteLength(approvalSecret, 'utf8') < 32) fail('PACT_SMOKE_APPROVAL_SECRET_TOO_SHORT');
  humanPrincipal = nonEmpty(humanPrincipal, 'PACT_SMOKE_HUMAN_PRINCIPAL_REQUIRED', 256);
  agentSession = nonEmpty(agentSession, 'PACT_SMOKE_AGENT_SESSION_REQUIRED', 256);
  if (typeof now !== 'function') fail('PACT_SMOKE_CLOCK_REQUIRED');
  const currentTime = now();
  if (!Number.isFinite(currentTime)) fail('PACT_SMOKE_INVALID_CLOCK');
  nonce = nonce == null ? `smoke-${globalThis.crypto.randomUUID()}` : nonEmpty(nonce, 'PACT_SMOKE_NONCE_REQUIRED', 256);
  idempotencyKey = idempotencyKey == null ? `smoke-${globalThis.crypto.randomUUID()}` : nonEmpty(idempotencyKey, 'PACT_SMOKE_IDEMPOTENCY_KEY_REQUIRED', 256);

  const pact = createPactHttpConnector({ baseUrl, fetchImpl, timeoutMs });
  const preview = await pact.preview({ adapter, intent });
  const transaction = preview?.transaction;
  if (!isPlainObject(transaction) || transaction.state !== 'PREVIEWED' || typeof transaction.id !== 'string' ||
      typeof transaction.planHash !== 'string' || !/^[a-f0-9]{64}$/i.test(transaction.planHash) ||
      !Number.isSafeInteger(transaction.baseVersion) || transaction.baseVersion < 0) {
    fail('PACT_SMOKE_PREVIEW_INVALID');
  }
  if (transaction.adapter?.id !== adapter.id || transaction.adapter?.version !== adapter.version) fail('PACT_SMOKE_ADAPTER_MISMATCH');

  const expiresAt = Math.floor(currentTime + 60_000);
  const claims = { humanPrincipal, agentSession, expiresAt, nonce };
  const message = canonicalStringify({
    txId: transaction.id,
    planHash: transaction.planHash,
    baseVersion: transaction.baseVersion,
    adapter: transaction.adapter,
    claims
  });
  const approval = {
    ...claims,
    signature: createHmac('sha256', approvalSecret).update(message).digest('hex')
  };

  const approved = await pact.approve({ transactionId: transaction.id, approval });
  if (approved?.transaction?.state !== 'APPROVED' || typeof approved?.capability?.token !== 'string' || !approved.capability.token) {
    fail('PACT_SMOKE_APPROVAL_INVALID');
  }

  const committed = await pact.commit({
    transactionId: transaction.id,
    capabilityToken: approved.capability.token,
    idempotencyKey
  }, idempotencyKey);
  if (committed?.transaction?.state !== 'COMMITTED' || committed.transaction.commitVersion !== transaction.baseVersion + 1) {
    fail('PACT_SMOKE_COMMIT_INVALID');
  }

  const verified = await pact.verify({ transactionId: transaction.id });
  const verifiedReceipt = assertReceipt(verified?.receipt, transaction);
  const fetched = await pact.receipt({ transactionId: transaction.id });
  const fetchedReceipt = assertReceipt(fetched?.receipt, transaction);
  if (canonicalStringify(verifiedReceipt) !== canonicalStringify(fetchedReceipt)) fail('PACT_SMOKE_RECEIPT_REPLAY_MISMATCH');

  return {
    transactionId: transaction.id,
    adapter: transaction.adapter,
    baseVersion: transaction.baseVersion,
    commitVersion: fetchedReceipt.commitVersion,
    receiptHash: fetchedReceipt.receiptHash
  };
}
