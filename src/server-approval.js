import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalStringify } from './engine.js';

const fail = code => { throw new Error(code); };
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function safeSignature(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) return null;
  return Buffer.from(value, 'hex');
}

export function createHmacApprovalVerifier({ secret, now = () => Date.now(), maxFutureMs = 120_000 } = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) fail('PACT_APPROVAL_SECRET_TOO_SHORT');
  if (typeof now !== 'function') fail('PACT_APPROVAL_CLOCK_REQUIRED');
  if (!Number.isSafeInteger(maxFutureMs) || maxFutureMs < 1_000 || maxFutureMs > 15 * 60_000) fail('PACT_APPROVAL_INVALID_MAX_FUTURE');

  return async function verifyApproval({ approval, txId, planHash, baseVersion, adapter } = {}) {
    if (!isPlainObject(approval) || !isPlainObject(adapter)) return false;
    const humanPrincipal = nonEmpty(approval.humanPrincipal);
    const agentSession = nonEmpty(approval.agentSession);
    const nonce = nonEmpty(approval.nonce);
    if (!humanPrincipal || !agentSession || !nonce) return false;
    if (!Number.isSafeInteger(approval.expiresAt)) return false;

    const currentTime = now();
    if (!Number.isFinite(currentTime)) return false;
    if (approval.expiresAt <= currentTime || approval.expiresAt > currentTime + maxFutureMs) return false;

    const supplied = safeSignature(approval.signature);
    if (!supplied) return false;

    const claims = {
      humanPrincipal,
      agentSession,
      expiresAt: approval.expiresAt,
      nonce
    };
    let message;
    try {
      message = canonicalStringify({ txId, planHash, baseVersion, adapter, claims });
    } catch {
      return false;
    }
    if (typeof message !== 'string') return false;

    const expected = createHmac('sha256', secret).update(message).digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    return { humanPrincipal, agentSession };
  };
}
