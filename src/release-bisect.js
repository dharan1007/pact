import { createReleaseLock, validateReleaseLock } from './release-lock.js';
import { diffReleaseLocks } from './release-diff.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const VERDICTS = new Set(['pass', 'fail', 'uncertain']);

async function hybridLock(baseline, candidate, section, now) {
  const sections = {};
  for (const [name, entry] of Object.entries(baseline.sections)) sections[name] = entry.content;
  sections[section] = candidate.sections[section].content;
  return createReleaseLock({ agent: baseline.agent, environment: baseline.environment, ...sections }, { now });
}

export async function isolateRegression({ baselineLock, candidateLock, evaluate, now = () => Date.now() } = {}) {
  if (typeof evaluate !== 'function') fail('PACT_BISECT_EVALUATE_REQUIRED');
  const baseline = await validateReleaseLock(baselineLock);
  const candidate = await validateReleaseLock(candidateLock);
  if (baseline.agent !== candidate.agent || baseline.environment !== candidate.environment) {
    fail('PACT_BISECT_IDENTITY_MISMATCH');
  }
  if (baseline.releaseId === candidate.releaseId) fail('PACT_BISECT_SAME_RELEASE');

  const verdictOf = async lock => {
    const verdict = await evaluate(clone(lock));
    if (!VERDICTS.has(verdict)) fail('PACT_BISECT_VERDICT_INVALID');
    return verdict;
  };

  const candidateVerdict = await verdictOf(candidate);
  if (candidateVerdict === 'uncertain') {
    return { conclusion: 'inconclusive', reason: 'candidate evaluation was uncertain', evidence: { candidate: 'uncertain' } };
  }
  if (candidateVerdict === 'pass') {
    return { conclusion: 'not-reproduced', reason: 'candidate passes under evaluation', evidence: { candidate: 'pass' } };
  }
  const baselineVerdict = await verdictOf(baseline);
  if (baselineVerdict !== 'pass') {
    return { conclusion: 'inconclusive', reason: 'baseline does not pass under evaluation', evidence: { baseline: baselineVerdict, candidate: 'fail' } };
  }

  const diff = await diffReleaseLocks(baseline, candidate);
  const changedSections = diff.findings.map(finding => finding.section);
  const evidence = { baseline: 'pass', candidate: 'fail', hybrids: {} };
  const reproductions = [];
  for (const section of changedSections) {
    const hybrid = await hybridLock(baseline, candidate, section, now);
    const verdict = await verdictOf(hybrid);
    evidence.hybrids[section] = verdict;
    if (verdict === 'fail') reproductions.push(section);
    if (verdict === 'uncertain') {
      return { conclusion: 'inconclusive', reason: `hybrid evaluation uncertain for ${section}`, evidence };
    }
  }
  if (reproductions.length === 0) {
    return { conclusion: 'inconclusive', reason: 'no single changed section reproduces the failure alone', evidence };
  }
  if (reproductions.length > 1) {
    return { conclusion: 'multiple-candidates', reason: 'several changed sections reproduce the failure independently', evidence, candidates: reproductions };
  }
  return {
    conclusion: 'isolated',
    section: reproductions[0],
    evidence,
    note: 'Single-factor isolation only. Interactions between changed sections are not explored; treat as a lead, not a proof.'
  };
}
