import { diffReleaseLocks } from './release-diff.js';

const fail = code => { throw new Error(code); };

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
const KIND_RANK = {
  breaking: 0,
  'permission-changed': 1,
  'contract-changed': 2,
  'model-changed': 3,
  drifted: 3,
  undeclared: 3,
  behavioral: 4,
  'data-changed': 5,
  'state-compat': 5,
  'code-changed': 6,
  added: 7,
  'coverage-changed': 8,
  'runtime-changed': 8,
  unobserved: 9
};

function nonEmpty(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  return value.trim();
}

function rankKind(kind) {
  return Object.prototype.hasOwnProperty.call(KIND_RANK, kind) ? KIND_RANK[kind] : 10;
}

export async function attributeRegression({ getLock, historyIds = null, badReleaseId, goodReleaseId = null } = {}) {
  if (typeof getLock !== 'function') fail('PACT_ATTRIBUTION_LOCK_READER_REQUIRED');
  badReleaseId = nonEmpty(badReleaseId, 'PACT_ATTRIBUTION_BAD_RELEASE_REQUIRED');
  const bad = await getLock(badReleaseId);

  let baselineId = goodReleaseId == null ? null : nonEmpty(goodReleaseId, 'PACT_ATTRIBUTION_GOOD_RELEASE_REQUIRED');
  if (baselineId == null) {
    if (!Array.isArray(historyIds) || historyIds.length === 0) fail('PACT_ATTRIBUTION_NO_BASELINE');
    const index = historyIds.indexOf(badReleaseId);
    if (index <= 0) fail('PACT_ATTRIBUTION_NO_BASELINE');
    baselineId = historyIds[index - 1];
  }
  if (baselineId === badReleaseId) fail('PACT_ATTRIBUTION_SAME_RELEASE');
  const baseline = await getLock(baselineId);

  const diff = await diffReleaseLocks(baseline, bad);
  const candidates = diff.findings
    .map(finding => ({
      section: finding.section,
      kind: finding.kind,
      severity: finding.severity,
      detail: finding.detail,
      ...(finding.paths ? { paths: finding.paths } : {})
    }))
    .sort((left, right) =>
      (SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]) ||
      (rankKind(left.kind) - rankKind(right.kind)) ||
      (left.section < right.section ? -1 : left.section > right.section ? 1 : 0)
    );
  return {
    badReleaseId: diff.afterReleaseId,
    baselineReleaseId: diff.beforeReleaseId,
    unchanged: diff.unchanged,
    candidates,
    note: 'Candidates are ordered by deterministic severity and change-class rank. PACT does not estimate probabilities; confirm against executions before acting.'
  };
}
