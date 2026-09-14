const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const RESOLUTIONS = new Set(['reversed', 'compensated', 'already-canonical', 'irreversible', 'uncertain', 'unresolved']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value, code, max = 1024) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  const normalized = value.trim();
  if (normalized.length > max) fail(code);
  return normalized;
}

function errorInfo(error) {
  return typeof error?.message === 'string' && error.message ? error.message : 'PACT_RECOVERY_RESOLVER_FAILED';
}

export async function executeReleaseRecovery({ effects = [], resolvers = {}, idempotencyPrefix = 'pact-recovery', now = () => Date.now() } = {}) {
  if (!Array.isArray(effects) || effects.length === 0) fail('PACT_RECOVERY_EFFECTS_REQUIRED');
  if (!isPlainObject(resolvers)) fail('PACT_RECOVERY_RESOLVERS_REQUIRED');
  idempotencyPrefix = nonEmpty(idempotencyPrefix, 'PACT_RECOVERY_PREFIX_REQUIRED', 256);
  if (typeof now !== 'function') fail('PACT_RECOVERY_CLOCK_REQUIRED');
  for (const [adapter, resolver] of Object.entries(resolvers)) {
    if (typeof resolver !== 'function') fail(`PACT_RECOVERY_RESOLVER_INVALID:${adapter}`);
  }

  const evidence = [];
  for (const raw of effects) {
    if (!isPlainObject(raw)) fail('PACT_RECOVERY_EFFECT_INVALID');
    const effect = clone(raw);
    const txId = nonEmpty(effect.txId, 'PACT_RECOVERY_TX_ID_REQUIRED', 256);
    const adapterId = typeof effect.adapter?.id === 'string' && effect.adapter.id ? effect.adapter.id : null;
    const idempotencyKey = `${idempotencyPrefix}:${txId}:${adapterId ?? 'unknown'}`;
    const resolver = adapterId ? resolvers[adapterId] : null;
    if (!resolver) {
      evidence.push({ txId, adapter: adapterId, status: 'unresolved', detail: 'no resolver registered for adapter', idempotencyKey, at: now() });
      continue;
    }
    try {
      const outcome = await resolver({ effect: clone(effect), idempotencyKey });
      if (!isPlainObject(outcome) || !RESOLUTIONS.has(outcome.status)) fail('PACT_RECOVERY_RESOLUTION_INVALID');
      evidence.push({
        txId,
        adapter: adapterId,
        status: outcome.status,
        detail: typeof outcome.detail === 'string' ? outcome.detail : null,
        idempotencyKey,
        at: now()
      });
    } catch (error) {
      if (typeof error?.message === 'string' && error.message.startsWith('PACT_')) throw error;
      evidence.push({ txId, adapter: adapterId, status: 'uncertain', detail: errorInfo(error), idempotencyKey, at: now() });
    }
  }
  return evidence;
}

export function summarizeRecovery(evidence = []) {
  if (!Array.isArray(evidence)) fail('PACT_RECOVERY_EVIDENCE_REQUIRED');
  const byStatus = {};
  for (const entry of evidence) {
    if (!isPlainObject(entry) || !RESOLUTIONS.has(entry.status)) fail('PACT_RECOVERY_EVIDENCE_CORRUPT');
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
  }
  return { effects: evidence.length, byStatus };
}
