const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const ACTIVE_STEP_STATES = new Set(['EXECUTING', 'UNCERTAIN', 'COMPENSATING', 'COMPENSATION_UNCERTAIN']);
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_DEPTH = 16;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteTime(value, code) {
  if (!Number.isFinite(value)) fail(code);
  return value;
}

function redact(value, key = '', depth = 0) {
  if (depth > MAX_DEPTH) return '[REDACTED_DEPTH]';
  const normalizedKey = String(key).toLowerCase();
  const redactWhole = normalizedKey === 'approval' || normalizedKey === 'capabilitytoken' || normalizedKey === 'bearertoken' ||
    normalizedKey === 'accesstoken' || normalizedKey === 'refreshtoken' || normalizedKey === 'password' || normalizedKey === 'secret' ||
    normalizedKey === 'signature' || normalizedKey === 'authorizationtoken';
  if (redactWhole) return '[REDACTED]';
  if (normalizedKey === 'authorization' && typeof value === 'string') return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redact(item, '', depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const lower = childKey.toLowerCase();
      const sensitiveScalar = lower === 'token' || lower.endsWith('token') || lower.endsWith('secret') || lower === 'signature' || lower === 'password';
      out[childKey] = sensitiveScalar ? '[REDACTED]' : redact(childValue, childKey, depth + 1);
    }
    return out;
  }
  return clone(value);
}

function currentStepOf(saga) {
  if (!Array.isArray(saga?.steps)) return null;
  const active = saga.steps.find(step => ACTIVE_STEP_STATES.has(step?.state));
  if (active) return { id: active.id ?? null, handler: active.handler ?? null, state: active.state ?? null };
  const pending = saga.steps.find(step => step?.state === 'PENDING');
  if (pending) return { id: pending.id ?? null, handler: pending.handler ?? null, state: pending.state ?? null };
  const last = saga.steps.at(-1);
  return last ? { id: last.id ?? null, handler: last.handler ?? null, state: last.state ?? null } : null;
}

export function createPactSagaTelemetry({ sink = async () => {}, now = () => Date.now(), reconciliationSlaMs = 15 * 60_000 } = {}) {
  if (typeof sink !== 'function') fail('PACT_SAGA_TELEMETRY_SINK_REQUIRED');
  if (typeof now !== 'function') fail('PACT_SAGA_TELEMETRY_CLOCK_REQUIRED');
  if (!Number.isSafeInteger(reconciliationSlaMs) || reconciliationSlaMs < 1 || reconciliationSlaMs > 30 * 24 * 60 * 60_000) {
    fail('PACT_SAGA_TELEMETRY_INVALID_RECONCILIATION_SLA');
  }

  async function emit(rawEvent) {
    if (!isPlainObject(rawEvent) || typeof rawEvent.type !== 'string' || !rawEvent.type.trim()) fail('PACT_SAGA_TELEMETRY_INVALID_EVENT');
    const at = finiteTime(now(), 'PACT_SAGA_TELEMETRY_INVALID_CLOCK');
    const event = redact({ ...clone(rawEvent), type: rawEvent.type.trim(), at });
    let encoded;
    try { encoded = JSON.stringify(event); } catch { fail('PACT_SAGA_TELEMETRY_EVENT_NOT_JSON'); }
    if (encoded.length > MAX_EVENT_BYTES) fail('PACT_SAGA_TELEMETRY_EVENT_TOO_LARGE');
    try {
      await sink(clone(event));
      return { delivered: true };
    } catch {
      return { delivered: false, errorCode: 'PACT_SAGA_TELEMETRY_SINK_FAILED' };
    }
  }

  function deriveOperationalStatus(saga) {
    if (!isPlainObject(saga)) fail('PACT_SAGA_TELEMETRY_SAGA_REQUIRED');
    const at = finiteTime(now(), 'PACT_SAGA_TELEMETRY_INVALID_CLOCK');
    const createdAt = Number.isFinite(saga.createdAt) ? saga.createdAt : at;
    const sagaAgeMs = Math.max(0, at - createdAt);
    const lease = isPlainObject(saga.lease) ? {
      ownerId: typeof saga.lease.ownerId === 'string' ? saga.lease.ownerId : null,
      generation: Number.isSafeInteger(saga.lease.generation) ? saga.lease.generation : null,
      expiresAt: Number.isFinite(saga.lease.expiresAt) ? saga.lease.expiresAt : null,
      remainingMs: Number.isFinite(saga.lease.expiresAt) ? Math.max(0, saga.lease.expiresAt - at) : null
    } : null;
    const leaseGeneration = Number.isSafeInteger(saga.leaseGeneration) && saga.leaseGeneration >= 0 ? saga.leaseGeneration : 0;
    const takeoverCount = Math.max(0, leaseGeneration - 1);
    const compensationAttempts = Array.isArray(saga.steps)
      ? saga.steps.reduce((total, step) => total + (Number.isSafeInteger(step?.compensationAttempts) ? step.compensationAttempts : 0), 0)
      : 0;
    let reconciliationAgeMs = null;
    if (saga.state === 'RECONCILIATION_REQUIRED') {
      const since = Number.isFinite(saga.reconciliationRequiredAt) ? saga.reconciliationRequiredAt
        : (Number.isFinite(saga.updatedAt) ? saga.updatedAt : createdAt);
      reconciliationAgeMs = Math.max(0, at - since);
    }
    return Object.freeze({
      sagaAgeMs,
      currentStep: currentStepOf(saga),
      lease,
      takeoverCount,
      reconciliationAgeMs,
      compensationAttempts,
      terminalState: ['COMMITTED', 'COMPENSATED', 'PARTIALLY_COMMITTED'].includes(saga.state) ? saga.state : null,
      attentionRequired: reconciliationAgeMs != null && reconciliationAgeMs >= reconciliationSlaMs
    });
  }

  return Object.freeze({ emit, deriveOperationalStatus, reconciliationSlaMs });
}
