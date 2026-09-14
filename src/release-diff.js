import { validateReleaseLock } from './release-lock.js';

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
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    for (let index = 0; index < before.length; index += 1) {
      leafPaths(before[index], after[index], `${base}[${index}]`, out);
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

export function classifySectionChange(name, beforeContent, afterContent) {
  return classifyChangedSection(name, beforeContent, afterContent);
}

function classifyChangedSection(name, beforeContent, afterContent) {
  if (name === 'permissions') return { kind: 'permission-changed', severity: 'high' };
  if (name === 'prompts' || name === 'skills') return { kind: 'behavioral', severity: 'medium' };
  if (name === 'retrieval') return { kind: 'data-changed', severity: 'medium' };
  if (name === 'memory') return { kind: 'state-compat', severity: 'medium' };
  if (name === 'source' || name === 'runtime') return { kind: 'code-changed', severity: 'low' };
  if (name === 'evals') return { kind: 'coverage-changed', severity: 'low' };
  if (name === 'model') {
    const beforeId = isPlainObject(beforeContent) ? beforeContent.id : undefined;
    const afterId = isPlainObject(afterContent) ? afterContent.id : undefined;
    if (beforeId !== afterId) return { kind: 'model-changed', severity: 'medium' };
    return { kind: 'behavioral', severity: 'medium' };
  }
  if (name === 'tools' || name === 'mcp') {
    const beforeEntries = isPlainObject(beforeContent) ? beforeContent : {};
    const afterEntries = isPlainObject(afterContent) ? afterContent : {};
    const removed = Object.keys(beforeEntries).filter(key => !Object.prototype.hasOwnProperty.call(afterEntries, key));
    if (removed.length > 0) return { kind: 'breaking', severity: 'high', removed };
    return { kind: 'contract-changed', severity: 'high' };
  }
  return { kind: 'behavioral', severity: 'medium' };
}

export async function diffReleaseLocks(beforeLock, afterLock) {
  const before = await validateReleaseLock(beforeLock);
  const after = await validateReleaseLock(afterLock);
  if (before.agent !== after.agent) fail('PACT_DIFF_AGENT_MISMATCH');
  if (before.environment !== after.environment) fail('PACT_DIFF_ENVIRONMENT_MISMATCH');

  const findings = [];
  const names = new Set([...Object.keys(before.sections), ...Object.keys(after.sections)]);
  for (const name of [...names].sort()) {
    const prior = before.sections[name];
    const next = after.sections[name];
    if (prior && !next) {
      findings.push({ section: name, kind: 'breaking', severity: 'high', detail: `section ${name} removed` });
      continue;
    }
    if (!prior && next) {
      const classification = name === 'permissions'
        ? { kind: 'permission-changed', severity: 'high' }
        : { kind: 'added', severity: 'low' };
      findings.push({ section: name, ...classification, detail: `section ${name} added` });
      continue;
    }
    if (prior.hash === next.hash) continue;
    const out = { paths: [], truncated: false };
    leafPaths(prior.content, next.content, '', out);
    const classification = classifyChangedSection(name, prior.content, next.content);
    findings.push({
      section: name,
      kind: classification.kind,
      severity: classification.severity,
      detail: `section ${name} changed`,
      ...(classification.removed ? { removed: classification.removed } : {}),
      paths: out.paths,
      ...(out.truncated ? { pathsTruncated: true } : {})
    });
  }

  const summary = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) summary[finding.severity] += 1;
  return {
    agent: after.agent,
    environment: after.environment,
    beforeReleaseId: before.releaseId,
    afterReleaseId: after.releaseId,
    unchanged: findings.length === 0,
    findings,
    summary
  };
}
