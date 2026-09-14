import { canonicalStringify } from './engine.js';
import { validateReleaseLock } from './release-lock.js';
import { normalizeTraceEvent, mulberry32 } from './trace-corpus.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const MAX_DETAILS = 1024;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function same(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

const SUPPORTED_SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'description', 'title']);

export function validateAgainstSchema(value, schema, path = '') {
  if (schema === true) return { verdict: 'compatible', reasons: [] };
  if (schema === false) return { verdict: 'incompatible', reasons: [`${path || '(root)'}: schema accepts nothing`] };
  if (!isPlainObject(schema)) return { verdict: 'unknown', reasons: [`${path || '(root)'}: schema is not an object`] };
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      return { verdict: 'unknown', reasons: [`${path || '(root)'}: unsupported keyword ${key}`] };
    }
  }
  const reasons = [];
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) return { verdict: 'unknown', reasons: [`${path || '(root)'}: enum is not an array`] };
    if (!schema.enum.some(entry => same(entry, value))) {
      return { verdict: 'incompatible', reasons: [`${path || '(root)'}: value not in enum`] };
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    const matches = types.some(type => type === actual || (type === 'number' && (actual === 'integer' || actual === 'number')));
    if (!matches) {
      reasons.push(`${path || '(root)'}: expected ${types.join('|')}, got ${actual}`);
      return { verdict: 'incompatible', reasons };
    }
  }
  if (schema.type === 'object' || (schema.properties !== undefined || schema.required !== undefined)) {
    if (!isPlainObject(value)) {
      reasons.push(`${path || '(root)'}: expected object`);
      return { verdict: 'incompatible', reasons };
    }
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        reasons.push(`${path || '(root)'}: missing required ${key}`);
        return { verdict: 'incompatible', reasons };
      }
    }
    for (const [key, sub] of Object.entries(isPlainObject(schema.properties) ? schema.properties : {})) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const nested = validateAgainstSchema(value[key], sub, path ? `${path}.${key}` : key);
      if (nested.verdict !== 'compatible') return nested;
    }
    if (schema.additionalProperties === false && isPlainObject(schema.properties)) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          reasons.push(`${path || '(root)'}: additional property ${key} not allowed`);
          return { verdict: 'incompatible', reasons };
        }
      }
    }
  }
  if (schema.items !== undefined) {
    if (!Array.isArray(value)) {
      reasons.push(`${path || '(root)'}: expected array`);
      return { verdict: 'incompatible', reasons };
    }
    for (let index = 0; index < value.length; index += 1) {
      const nested = validateAgainstSchema(value[index], schema.items, `${path || '(root)'}[${index}]`);
      if (nested.verdict !== 'compatible') return nested;
    }
  }
  return { verdict: 'compatible', reasons };
}

function candidateToolMap(lock) {
  const map = new Map();
  const tools = lock.sections.tools?.content;
  if (isPlainObject(tools)) {
    for (const [name, entry] of Object.entries(tools)) map.set(name, { entry, origin: `tools.${name}` });
  }
  const mcp = lock.sections.mcp?.content;
  if (isPlainObject(mcp)) {
    for (const [server, config] of Object.entries(mcp)) {
      const manifest = isPlainObject(config) ? config.tool_manifest : null;
      if (!isPlainObject(manifest)) continue;
      for (const [tool, entry] of Object.entries(manifest)) {
        map.set(`${server}.${tool}`, { entry, origin: `mcp.${server}.${tool}` });
        if (!map.has(tool)) map.set(tool, { entry, origin: `mcp.${server}.${tool}` });
      }
    }
  }
  return map;
}

function baselineToolMap(lock) {
  return candidateToolMap(lock);
}

function toolEntryHash(entry) {
  if (!isPlainObject(entry)) return null;
  if (typeof entry.schema_hash === 'string') return entry.schema_hash;
  return null;
}

export async function decisionCompatReplay({ traces = [], baselineLock = null, candidateLock, contracts = {} } = {}) {
  if (!Array.isArray(traces) || traces.length === 0) fail('PACT_REPLAY_TRACES_REQUIRED');
  const candidate = await validateReleaseLock(candidateLock);
  const baseline = baselineLock == null ? null : await validateReleaseLock(baselineLock);
  if (!isPlainObject(contracts)) fail('PACT_REPLAY_CONTRACTS_INVALID');
  const contractTools = isPlainObject(contracts.tools) ? contracts.tools : {};
  const grantedScopes = Array.isArray(contracts.scopes) ? contracts.scopes : null;
  const toolScopes = isPlainObject(contracts.toolScopes) ? contracts.toolScopes : null;

  const candidateMap = candidateToolMap(candidate);
  const baselineMap = baseline ? baselineToolMap(baseline) : new Map();
  const details = [];
  let truncated = false;
  const totals = { calls: 0, compatible: 0, broken: 0, incompatible: 0, unknown: 0 };

  const push = detail => {
    if (detail.verdict === 'compatible') totals.compatible += 1;
    else if (detail.verdict === 'broken') totals.broken += 1;
    else if (detail.verdict === 'incompatible') totals.incompatible += 1;
    else totals.unknown += 1;
    totals.calls += 1;
    if (details.length < MAX_DETAILS) details.push(detail);
    else truncated = true;
  };

  for (const raw of traces) {
    const trace = normalizeTraceEvent(raw);
    for (const call of trace.toolCalls) {
      const candidateEntry = candidateMap.get(call.tool);
      if (!candidateEntry) {
        push({ traceId: trace.traceId, tool: call.tool, verdict: 'broken', reason: 'tool-removed' });
        continue;
      }
      const inlineSchema = isPlainObject(candidateEntry.entry) ? candidateEntry.entry.schema : undefined;
      const schemaToCheck = inlineSchema !== undefined ? inlineSchema : contractTools[call.tool];
      if (schemaToCheck !== undefined) {
        const checked = validateAgainstSchema(call.args, schemaToCheck, '');
        if (checked.verdict === 'compatible') {
          push({ traceId: trace.traceId, tool: call.tool, verdict: 'compatible', reason: 'schema-compatible' });
        } else if (checked.verdict === 'incompatible') {
          push({ traceId: trace.traceId, tool: call.tool, verdict: 'incompatible', reason: checked.reasons[0] });
        } else {
          push({ traceId: trace.traceId, tool: call.tool, verdict: 'unknown', reason: checked.reasons[0] });
        }
        continue;
      }
      const baselineEntry = baselineMap.get(call.tool);
      const beforeHash = toolEntryHash(isPlainObject(baselineEntry) ? baselineEntry.entry : null);
      const afterHash = toolEntryHash(candidateEntry.entry);
      if (beforeHash && afterHash && beforeHash === afterHash) {
        push({ traceId: trace.traceId, tool: call.tool, verdict: 'compatible', reason: 'contract-unchanged' });
        continue;
      }
      if (grantedScopes && toolScopes && Array.isArray(toolScopes[call.tool])) {
        const missing = toolScopes[call.tool].filter(scope => !grantedScopes.includes(scope));
        if (missing.length > 0) {
          push({ traceId: trace.traceId, tool: call.tool, verdict: 'broken', reason: `scope-denied:${missing.join(',')}` });
          continue;
        }
      }
      push({ traceId: trace.traceId, tool: call.tool, verdict: 'unknown', reason: 'opaque-contract-change' });
    }
  }

  return {
    traces: traces.length,
    candidateReleaseId: candidate.releaseId,
    baselineReleaseId: baseline?.releaseId ?? null,
    totals,
    details,
    ...(truncated ? { detailsTruncated: true } : {})
  };
}

export function createReplayToolClient({ recorded = [], onPropose = null } = {}) {
  if (!Array.isArray(recorded)) fail('PACT_REPLAY_RECORDED_INVALID');
  if (onPropose != null && typeof onPropose !== 'function') fail('PACT_REPLAY_ON_PROPOSE_INVALID');
  const proposals = [];
  const recordedCalls = recorded.map(entry => {
    if (!isPlainObject(entry) || typeof entry.tool !== 'string') fail('PACT_REPLAY_RECORDED_ENTRY_INVALID');
    return { tool: entry.tool, args: entry.args === undefined ? null : clone(entry.args), result: clone(entry.result ?? null) };
  });

  async function invoke(tool, args = null) {
    if (typeof tool !== 'string' || !tool) fail('PACT_REPLAY_TOOL_REQUIRED');
    const proposal = { tool, args: clone(args), executed: false, matched: false };
    proposals.push(proposal);
    if (onPropose) await onPropose(clone(proposal));
    const hit = recordedCalls.find(entry => entry.tool === tool && same(entry.args, proposal.args));
    if (hit) {
      proposal.matched = true;
      return { result: clone(hit.result), executed: false, matched: true };
    }
    proposal.unmatched = true;
    return { result: null, executed: false, matched: false, unmatched: true };
  }

  function proposalLog() {
    return clone(proposals);
  }

  return Object.freeze({ invoke, proposals: proposalLog });
}

function normalizeRunnerResult(value, code) {
  if (!isPlainObject(value)) fail(code);
  const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls : fail(code);
  for (const call of toolCalls) {
    if (!isPlainObject(call) || typeof call.tool !== 'string') fail(code);
  }
  return {
    toolCalls: clone(toolCalls),
    output: value.output === undefined ? null : clone(value.output),
    latencyMs: value.latencyMs == null ? null : value.latencyMs,
    costUsd: value.costUsd == null ? null : value.costUsd,
    error: value.error == null ? null : String(value.error)
  };
}

export function wilson(count, total, z = 1.96) {
  if (!Number.isSafeInteger(count) || count < 0) fail('PACT_REPLAY_COUNT_INVALID');
  if (!Number.isSafeInteger(total) || total <= 0 || count > total) fail('PACT_REPLAY_TOTAL_INVALID');
  if (!(z > 0)) fail('PACT_REPLAY_Z_INVALID');
  const rate = count / total;
  const denominator = 1 + (z * z) / total;
  const center = (rate + (z * z) / (2 * total)) / denominator;
  const spread = (z / denominator) * Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total));
  return { rate, lower: Math.max(0, center - spread), upper: Math.min(1, center + spread), count, total };
}

export function percentile(sortedValues, quantile) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) fail('PACT_REPLAY_VALUES_REQUIRED');
  if (!(quantile >= 0 && quantile <= 1)) fail('PACT_REPLAY_QUANTILE_INVALID');
  const values = [...sortedValues].sort((left, right) => left - right);
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) fail('PACT_REPLAY_VALUES_NUMERIC');
  const rank = quantile * (values.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return values[lower] + (values[upper] - values[lower]) * (rank - lower);
}

export async function runExperiment({
  traces = [],
  seed = 1,
  sampleSize = null,
  baseline,
  candidate,
  isConsequential = () => false,
  isDestructive = () => false
} = {}) {
  if (!Array.isArray(traces) || traces.length === 0) fail('PACT_REPLAY_TRACES_REQUIRED');
  if (typeof baseline !== 'function' || typeof candidate !== 'function') fail('PACT_REPLAY_RUNNER_REQUIRED');
  if (typeof isConsequential !== 'function' || typeof isDestructive !== 'function') fail('PACT_REPLAY_CLASSIFIER_REQUIRED');
  const normalized = traces.map(raw => normalizeTraceEvent(raw));
  const random = mulberry32(seed);
  const ordered = normalized
    .map(trace => ({ trace, rank: random() }))
    .sort((left, right) => left.rank - right.rank || (left.trace.traceId < right.trace.traceId ? -1 : 1))
    .map(entry => entry.trace);
  const selected = sampleSize == null ? ordered : ordered.slice(0, sampleSize);
  if (selected.length === 0) fail('PACT_REPLAY_SAMPLE_EMPTY');

  const perTrace = [];
  for (const trace of selected) {
    const context = { traceId: trace.traceId, recorded: clone(trace.toolCalls) };
    let baseResult = null;
    let candidateResult = null;
    let uncertain = false;
    try {
      baseResult = normalizeRunnerResult(await baseline(clone(context)), 'PACT_REPLAY_BASELINE_RESULT_INVALID');
    } catch (error) {
      if (error?.uncertain === true) uncertain = true;
      else throw error;
    }
    try {
      candidateResult = normalizeRunnerResult(await candidate(clone(context)), 'PACT_REPLAY_CANDIDATE_RESULT_INVALID');
    } catch (error) {
      if (error?.uncertain === true) uncertain = true;
      else throw error;
    }
    if (uncertain || !baseResult || !candidateResult) {
      perTrace.push({ traceId: trace.traceId, uncertain: true });
      continue;
    }
    const baseCalls = baseResult.toolCalls.map(call => canonicalStringify({ tool: call.tool, args: call.args ?? null }));
    const candidateCalls = candidateResult.toolCalls.map(call => canonicalStringify({ tool: call.tool, args: call.args ?? null }));
    const newCalls = candidateResult.toolCalls.filter(
      call => !baseCalls.includes(canonicalStringify({ tool: call.tool, args: call.args ?? null }))
    );
    const changedConsequential = newCalls.filter(call => isConsequential(call.tool)).map(call => call.tool);
    const destructive = newCalls.filter(call => isDestructive(call.tool, call.args ?? null)).map(call => call.tool);
    perTrace.push({
      traceId: trace.traceId,
      callsMatch: same(baseCalls, candidateCalls),
      outputMatch: same(baseResult.output, candidateResult.output),
      baselineError: baseResult.error,
      candidateError: candidateResult.error,
      newFailure: candidateResult.error != null && baseResult.error == null,
      recoveredFailure: candidateResult.error == null && baseResult.error != null,
      changedConsequential: [...new Set(changedConsequential)],
      destructive: [...new Set(destructive)],
      baselineLatencyMs: baseResult.latencyMs,
      candidateLatencyMs: candidateResult.latencyMs,
      baselineCostUsd: baseResult.costUsd,
      candidateCostUsd: candidateResult.costUsd
    });
  }
  return { seed, sampled: selected.length, requested: normalized.length, perTrace };
}

function rateInterval(items, predicate) {
  const count = items.filter(predicate).length;
  return wilson(count, items.length);
}

function latencyStats(values) {
  const numeric = values.filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (numeric.length === 0) return null;
  return { n: numeric.length, p50: percentile(numeric, 0.5), p95: percentile(numeric, 0.95) };
}

function costStats(values) {
  const numeric = values.filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (numeric.length === 0) return null;
  const total = numeric.reduce((sum, value) => sum + value, 0);
  return { n: numeric.length, total, mean: total / numeric.length };
}

export function buildProveReport({ experiment, compat = null, baselineReleaseId = null, candidateReleaseId = null, protectedTraceIds = [], generatedAt = Date.now() } = {}) {
  if (!isPlainObject(experiment) || !Array.isArray(experiment.perTrace) || experiment.perTrace.length === 0) {
    fail('PACT_PROVE_EXPERIMENT_REQUIRED');
  }
  if (!Number.isSafeInteger(generatedAt) || generatedAt < 0) fail('PACT_PROVE_CLOCK_INVALID');
  if (!Array.isArray(protectedTraceIds) || protectedTraceIds.some(id => typeof id !== 'string')) {
    fail('PACT_PROVE_PROTECTED_INVALID');
  }
  const evaluated = experiment.perTrace.filter(entry => !entry.uncertain);
  const uncertain = experiment.perTrace.length - evaluated.length;
  const changed = evaluated.filter(entry => !entry.callsMatch || !entry.outputMatch || entry.newFailure);
  const report = {
    baselineReleaseId,
    candidateReleaseId,
    sample: { requested: experiment.requested, evaluated: evaluated.length, uncertain, seed: experiment.seed },
    outcomes: {
      equivalent: rateInterval(evaluated, entry => entry.callsMatch && entry.outputMatch && !entry.newFailure),
      changed: rateInterval(evaluated, entry => !entry.callsMatch || !entry.outputMatch),
      newFailures: rateInterval(evaluated, entry => entry.newFailure),
      recoveredFailures: rateInterval(evaluated, entry => entry.recoveredFailure)
    },
    toolDecisions: {
      changedConsequential: [...new Set(changed.flatMap(entry => entry.changedConsequential))].sort(),
      destructiveProposed: [...new Set(changed.flatMap(entry => entry.destructive))].sort()
    },
    latency: {
      baseline: latencyStats(evaluated.map(entry => entry.baselineLatencyMs)),
      candidate: latencyStats(evaluated.map(entry => entry.candidateLatencyMs))
    },
    cost: {
      baseline: costStats(evaluated.map(entry => entry.baselineCostUsd)),
      candidate: costStats(evaluated.map(entry => entry.candidateCostUsd))
    },
    unknowns: { uncertainTraces: uncertain },
    protected: {
      ids: [...protectedTraceIds],
      violations: evaluated
        .filter(entry => protectedTraceIds.includes(entry.traceId) && (!entry.callsMatch || !entry.outputMatch || entry.newFailure))
        .map(entry => entry.traceId)
    },
    generatedAt
  };
  if (compat) {
    if (!isPlainObject(compat.totals)) fail('PACT_PROVE_COMPAT_INVALID');
    report.contractCompat = {
      calls: compat.totals.calls,
      compatible: compat.totals.compatible,
      broken: compat.totals.broken,
      incompatible: compat.totals.incompatible,
      unknown: compat.totals.unknown
    };
  }
  return report;
}
