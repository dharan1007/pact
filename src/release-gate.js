const fail = code => { throw new Error(code); };

const DECISIONS = new Set(['ALLOW', 'WARN', 'BLOCK']);
const SEVERITIES = new Set(['high', 'medium', 'low']);

function assertStringArray(value, code) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) fail(code);
  return [...value];
}

function finiteRate(value, code) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !(value >= 0) || !(value <= 1)) fail(code);
  return value;
}

function finiteCount(value, code) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function finitePercent(value, code) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code);
  return value;
}

function normalizeReplayCeilings(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PACT_GATE_POLICY_REPLAY_INVALID');
  for (const key of Object.keys(value)) {
    if (!['maxChangedOutcomeRate', 'maxNewFailureRate', 'maxDestructiveCount', 'maxCostRisePct', 'maxP95LatencyRisePct', 'blockOnChangedConsequential', 'blockOnUnknowns', 'protectedTraceIds'].includes(key)) {
      fail(`PACT_GATE_POLICY_REPLAY_KEY_UNKNOWN:${key}`);
    }
  }
  const ceilings = {
    maxChangedOutcomeRate: finiteRate(value.maxChangedOutcomeRate, 'PACT_GATE_POLICY_REPLAY_RATE_INVALID'),
    maxNewFailureRate: finiteRate(value.maxNewFailureRate, 'PACT_GATE_POLICY_REPLAY_RATE_INVALID'),
    maxDestructiveCount: finiteCount(value.maxDestructiveCount, 'PACT_GATE_POLICY_REPLAY_COUNT_INVALID') ?? 0,
    maxCostRisePct: finitePercent(value.maxCostRisePct, 'PACT_GATE_POLICY_REPLAY_PCT_INVALID'),
    maxP95LatencyRisePct: finitePercent(value.maxP95LatencyRisePct, 'PACT_GATE_POLICY_REPLAY_PCT_INVALID'),
    blockOnChangedConsequential: value.blockOnChangedConsequential ?? true,
    blockOnUnknowns: value.blockOnUnknowns ?? false,
    protectedTraceIds: value.protectedTraceIds ?? []
  };
  if (typeof ceilings.blockOnChangedConsequential !== 'boolean') fail('PACT_GATE_POLICY_REPLAY_FLAG_INVALID');
  if (typeof ceilings.blockOnUnknowns !== 'boolean') fail('PACT_GATE_POLICY_REPLAY_FLAG_INVALID');
  if (!Array.isArray(ceilings.protectedTraceIds) || ceilings.protectedTraceIds.some(id => typeof id !== 'string')) {
    fail('PACT_GATE_POLICY_REPLAY_PROTECTED_INVALID');
  }
  return ceilings;
}

function normalizePolicy(policy = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('PACT_GATE_POLICY_REQUIRED');
  for (const key of Object.keys(policy)) {
    if (!['blockOnSeverities', 'blockOnKinds', 'warnOnSeverities', 'blockOnDrift', 'replayCeilings'].includes(key)) {
      fail(`PACT_GATE_POLICY_UNKNOWN_KEY:${key}`);
    }
  }
  const blockOnSeverities = assertStringArray(policy.blockOnSeverities, 'PACT_GATE_POLICY_SEVERITIES_INVALID') ?? ['high'];
  const warnOnSeverities = assertStringArray(policy.warnOnSeverities, 'PACT_GATE_POLICY_SEVERITIES_INVALID') ?? ['medium'];
  const blockOnKinds = assertStringArray(policy.blockOnKinds, 'PACT_GATE_POLICY_KINDS_INVALID') ?? [];
  for (const severity of [...blockOnSeverities, ...warnOnSeverities]) {
    if (!SEVERITIES.has(severity)) fail(`PACT_GATE_POLICY_SEVERITY_UNKNOWN:${severity}`);
  }
  const blockOnDrift = policy.blockOnDrift ?? true;
  if (typeof blockOnDrift !== 'boolean') fail('PACT_GATE_POLICY_BLOCK_ON_DRIFT_INVALID');
  return { blockOnSeverities, warnOnSeverities, blockOnKinds, blockOnDrift, replayCeilings: normalizeReplayCeilings(policy.replayCeilings) };
}

function findingId(finding) {
  return `${finding.section}:${finding.kind}`;
}

function risePercent(before, after) {
  if (before == null || after == null) return null;
  if (!(before > 0)) return null;
  return ((after - before) / before) * 100;
}

export function evaluateGate({ diff = null, drift = null, replay = null, policy = {} } = {}) {
  const normalized = normalizePolicy(policy);
  const reasons = [];
  let decision = 'ALLOW';

  const findings = Array.isArray(diff?.findings) ? diff.findings : [];
  for (const finding of findings) {
    const id = findingId(finding);
    if (normalized.blockOnKinds.includes(finding.kind) || normalized.blockOnSeverities.includes(finding.severity)) {
      decision = 'BLOCK';
      reasons.push(`block:${id}:${finding.severity}`);
    } else if (decision !== 'BLOCK' && normalized.warnOnSeverities.includes(finding.severity)) {
      decision = 'WARN';
      reasons.push(`warn:${id}:${finding.severity}`);
    }
  }

  const driftFindings = Array.isArray(drift?.findings)
    ? drift.findings.filter(finding => finding.kind === 'drifted' || finding.kind === 'undeclared')
    : [];
  if (driftFindings.length > 0 && normalized.blockOnDrift) {
    decision = 'BLOCK';
    for (const finding of driftFindings) reasons.push(`block:drift:${findingId(finding)}:${finding.severity}`);
  }

  if (replay != null) {
    decision = applyReplayCeilings(replay, normalized.replayCeilings ?? {}, decision, reasons);
  }

  if (!DECISIONS.has(decision)) fail('PACT_GATE_DECISION_INVALID');
  return {
    decision,
    reasons: [...new Set(reasons)].sort(),
    diffSummary: diff?.summary ?? null,
    drifted: drift?.drifted ?? null,
    replaySample: replay?.sample ?? null,
    policy: normalized
  };
}

function applyReplayCeilings(replay, ceilings, decision, reasons) {
  if (!replay || typeof replay !== 'object') fail('PACT_GATE_REPLAY_REQUIRED');
  const outcomes = replay.outcomes ?? {};
  const changedRate = outcomes.changed?.rate;
  const newFailureRate = outcomes.newFailures?.rate;
  if (ceilings.maxChangedOutcomeRate != null && typeof changedRate === 'number' && changedRate > ceilings.maxChangedOutcomeRate) {
    decision = 'BLOCK';
    reasons.push(`block:replay:changed-outcome-rate:${changedRate}`);
  }
  if (ceilings.maxNewFailureRate != null && typeof newFailureRate === 'number' && newFailureRate > ceilings.maxNewFailureRate) {
    decision = 'BLOCK';
    reasons.push(`block:replay:new-failure-rate:${newFailureRate}`);
  }
  const destructive = Array.isArray(replay.toolDecisions?.destructiveProposed) ? replay.toolDecisions.destructiveProposed : [];
  if (ceilings.maxDestructiveCount != null && destructive.length > ceilings.maxDestructiveCount) {
    decision = 'BLOCK';
    reasons.push(`block:replay:destructive-proposed:${destructive.length}`);
  }
  const changedConsequential = Array.isArray(replay.toolDecisions?.changedConsequential) ? replay.toolDecisions.changedConsequential : [];
  if (ceilings.blockOnChangedConsequential && changedConsequential.length > 0) {
    decision = 'BLOCK';
    for (const tool of changedConsequential) reasons.push(`block:replay:changed-consequential:${tool}`);
  }
  const costRise = risePercent(replay.cost?.baseline?.total, replay.cost?.candidate?.total);
  if (ceilings.maxCostRisePct != null && costRise != null && costRise > ceilings.maxCostRisePct) {
    decision = 'BLOCK';
    reasons.push(`block:replay:cost-rise-pct:${costRise}`);
  }
  const latencyRise = risePercent(replay.latency?.baseline?.p95, replay.latency?.candidate?.p95);
  if (ceilings.maxP95LatencyRisePct != null && latencyRise != null && latencyRise > ceilings.maxP95LatencyRisePct) {
    decision = 'BLOCK';
    reasons.push(`block:replay:p95-rise-pct:${latencyRise}`);
  }
  const protectedViolations = Array.isArray(replay.protected?.violations) ? replay.protected.violations : [];
  if (protectedViolations.length > 0) {
    decision = 'BLOCK';
    for (const traceId of protectedViolations) reasons.push(`block:replay:protected-trace:${traceId}`);
  }
  const unknowns = (replay.unknowns?.uncertainTraces ?? 0) + (replay.contractCompat?.unknown ?? 0);
  if (unknowns > 0) {
    if (ceilings.blockOnUnknowns) {
      decision = 'BLOCK';
      reasons.push(`block:replay:unknowns:${unknowns}`);
    } else if (decision !== 'BLOCK') {
      decision = 'WARN';
      reasons.push(`warn:replay:unknowns:${unknowns}`);
    }
  }
  return decision;
}
