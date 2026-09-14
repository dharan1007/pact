const fail = code => { throw new Error(code); };
const DECISIONS = new Set(['promote', 'hold', 'rollback']);

function finiteRate(value, code) {
  if (typeof value !== 'number' || !(value >= 0) || !(value <= 1)) fail(code);
  return value;
}

function finiteNonNegative(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(code);
  return value;
}

export function validateCanaryPlan({ steps = [] } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) fail('PACT_CANARY_STEPS_REQUIRED');
  if (steps.length > 8) fail('PACT_CANARY_TOO_MANY_STEPS');
  let previous = 0;
  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) fail(`PACT_CANARY_STEP_INVALID:${index}`);
    if (typeof step.percent !== 'number' || !(step.percent > 0) || step.percent > 100) {
      fail(`PACT_CANARY_PERCENT_INVALID:${index}`);
    }
    if (step.percent <= previous) fail(`PACT_CANARY_PERCENT_NOT_ASCENDING:${index}`);
    previous = step.percent;
    if (!Number.isSafeInteger(step.bakeMs) || step.bakeMs < 60_000 || step.bakeMs > 7 * 24 * 60 * 60_000) {
      fail(`PACT_CANARY_BAKE_INVALID:${index}`);
    }
  });
  if (previous !== 100) fail('PACT_CANARY_MUST_REACH_100');
  return steps.map(step => ({ percent: step.percent, bakeMs: step.bakeMs }));
}

export function evaluateCanaryStep({ metrics = {}, thresholds = {} } = {}) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) fail('PACT_CANARY_METRICS_REQUIRED');
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) fail('PACT_CANARY_THRESHOLDS_INVALID');
  for (const key of Object.keys(thresholds)) {
    if (!['maxFailureRate', 'maxDestructiveCount', 'maxP95LatencyMs', 'maxErrorBudgetBurn'].includes(key)) {
      fail(`PACT_CANARY_THRESHOLD_UNKNOWN:${key}`);
    }
  }
  const reasons = [];
  let decision = 'promote';
  const failureRate = metrics.failureRate ?? 0;
  const destructive = metrics.destructiveProposed ?? 0;
  finiteRate(failureRate, 'PACT_CANARY_METRICS_FAILURE_RATE_INVALID');
  finiteNonNegative(destructive, 'PACT_CANARY_METRICS_DESTRUCTIVE_INVALID');

  if (thresholds.maxFailureRate != null) {
    finiteRate(thresholds.maxFailureRate, 'PACT_CANARY_THRESHOLD_RATE_INVALID');
    if (failureRate > thresholds.maxFailureRate) {
      decision = 'rollback';
      reasons.push(`rollback:failure-rate:${failureRate}`);
    }
  }
  if (thresholds.maxDestructiveCount != null) {
    if (!Number.isSafeInteger(thresholds.maxDestructiveCount) || thresholds.maxDestructiveCount < 0) {
      fail('PACT_CANARY_THRESHOLD_COUNT_INVALID');
    }
    if (destructive > thresholds.maxDestructiveCount) {
      decision = 'rollback';
      reasons.push(`rollback:destructive-proposed:${destructive}`);
    }
  }
  if (thresholds.maxP95LatencyMs != null) {
    finiteNonNegative(thresholds.maxP95LatencyMs, 'PACT_CANARY_THRESHOLD_LATENCY_INVALID');
    const p95 = metrics.p95LatencyMs;
    if (p95 == null) {
      if (decision !== 'rollback') {
        decision = 'hold';
        reasons.push('hold:p95-unknown');
      }
    } else if (p95 > thresholds.maxP95LatencyMs) {
      decision = 'rollback';
      reasons.push(`rollback:p95-latency:${p95}`);
    }
  }
  if (thresholds.maxErrorBudgetBurn != null) {
    finiteRate(thresholds.maxErrorBudgetBurn, 'PACT_CANARY_THRESHOLD_RATE_INVALID');
    const burn = metrics.errorBudgetBurn ?? 0;
    finiteRate(burn, 'PACT_CANARY_METRICS_BURN_INVALID');
    if (burn > thresholds.maxErrorBudgetBurn) {
      decision = 'rollback';
      reasons.push(`rollback:error-budget-burn:${burn}`);
    }
  }
  if (metrics.uncertainTraces > 0 && decision === 'promote') {
    decision = 'hold';
    reasons.push(`hold:uncertain-traces:${metrics.uncertainTraces}`);
  }
  if (!DECISIONS.has(decision)) fail('PACT_CANARY_DECISION_INVALID');
  return { decision, reasons: [...new Set(reasons)].sort() };
}
