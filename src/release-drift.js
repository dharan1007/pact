import { createReleaseLock, validateReleaseLock } from './release-lock.js';
import { classifySectionChange } from './release-diff.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const MAX_PATHS = 128;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function leafPaths(before, after, base, out) {
  if (out.truncated) return;
  if (Object.is(before, after)) return;
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      leafPaths(before[key], after[key], base ? `${base}.${key}` : key, out);
      if (out.truncated) return;
    }
    return;
  }
  if (out.paths.length >= MAX_PATHS) {
    out.truncated = true;
    return;
  }
  out.paths.push({ path: base || '(root)', before: clone(before) ?? null, after: clone(after) ?? null });
}

function undeclaredSeverity(name) {
  if (name === 'permissions' || name === 'tools' || name === 'mcp') return 'high';
  return 'medium';
}

export async function evaluateDrift(pinnedLock, observedDescriptor = {}) {
  const pinned = await validateReleaseLock(pinnedLock);
  if (!isPlainObject(observedDescriptor)) fail('PACT_DRIFT_OBSERVATION_REQUIRED');
  if (observedDescriptor.agent != null && observedDescriptor.agent !== pinned.agent) fail('PACT_DRIFT_IDENTITY_MISMATCH');
  if (observedDescriptor.environment != null && observedDescriptor.environment !== pinned.environment) {
    fail('PACT_DRIFT_IDENTITY_MISMATCH');
  }
  const observed = await createReleaseLock({
    agent: pinned.agent,
    environment: pinned.environment,
    ...Object.fromEntries(
      Object.entries(observedDescriptor).filter(([key]) => key !== 'agent' && key !== 'environment')
    )
  });
  if (observed.agent !== pinned.agent || observed.environment !== pinned.environment) fail('PACT_DRIFT_IDENTITY_MISMATCH');

  const findings = [];
  for (const name of Object.keys(observed.sections).sort()) {
    const seen = observed.sections[name];
    const wanted = pinned.sections[name];
    if (!wanted) {
      findings.push({
        section: name,
        kind: 'undeclared',
        severity: undeclaredSeverity(name),
        detail: `live section ${name} is not in the pinned release`
      });
      continue;
    }
    if (wanted.hash === seen.hash) continue;
    const out = { paths: [], truncated: false };
    leafPaths(wanted.content, seen.content, '', out);
    const classification = classifySectionChange(name, wanted.content, seen.content);
    findings.push({
      section: name,
      kind: 'drifted',
      severity: classification.severity,
      changeKind: classification.kind,
      detail: `live section ${name} differs from the pinned release`,
      paths: out.paths,
      ...(out.truncated ? { pathsTruncated: true } : {})
    });
  }
  for (const name of Object.keys(pinned.sections).sort()) {
    if (!observed.sections[name]) {
      findings.push({ section: name, kind: 'unobserved', severity: 'low', detail: `pinned section ${name} was not observed` });
    }
  }
  return {
    agent: pinned.agent,
    environment: pinned.environment,
    releaseId: pinned.releaseId,
    drifted: findings.some(finding => finding.kind === 'drifted' || finding.kind === 'undeclared'),
    findings
  };
}
