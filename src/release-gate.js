const fail = code => { throw new Error(code); };

const DECISIONS = new Set(['ALLOW', 'WARN', 'BLOCK']);
const SEVERITIES = new Set(['high', 'medium', 'low']);

function assertStringArray(value, code) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) fail(code);
  return [...value];
}

function normalizePolicy(policy = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('PACT_GATE_POLICY_REQUIRED');
  for (const key of Object.keys(policy)) {
    if (!['blockOnSeverities', 'blockOnKinds', 'warnOnSeverities', 'blockOnDrift'].includes(key)) {
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
  return { blockOnSeverities, warnOnSeverities, blockOnKinds, blockOnDrift };
}

function findingId(finding) {
  return `${finding.section}:${finding.kind}`;
}

export function evaluateGate({ diff = null, drift = null, policy = {} } = {}) {
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

  if (!DECISIONS.has(decision)) fail('PACT_GATE_DECISION_INVALID');
  return {
    decision,
    reasons: [...new Set(reasons)].sort(),
    diffSummary: diff?.summary ?? null,
    drifted: drift?.drifted ?? null,
    policy: normalized
  };
}
