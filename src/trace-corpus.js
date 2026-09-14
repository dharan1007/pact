import { canonicalStringify, sha256Hex } from './engine.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const MAX_INDEX = 512;
const REDACTED = '[REDACTED]';
const DEFAULT_SENSITIVE_KEYS = /(token|secret|passwd|password|api[_-]?key|authorization|auth_|credential|ssn|card[_-]?number|private[_-]?key)/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value, code, max = 1024) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  const normalized = value.trim();
  if (normalized.length > max) fail(code);
  return normalized;
}

function assertJson(value, code) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail(code);
  }
  if (encoded === undefined) fail(code);
  try {
    return JSON.parse(encoded);
  } catch {
    fail(code);
  }
}

function finiteNumber(value, code, { min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail(code);
  return value;
}

const OUTCOMES = new Set(['success', 'failure', 'escalated', 'unknown']);

function normalizeToolCalls(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('PACT_CORPUS_TOOL_CALLS_INVALID');
  return value.map((call, index) => {
    if (!isPlainObject(call)) fail(`PACT_CORPUS_TOOL_CALL_INVALID:${index}`);
    return {
      tool: nonEmpty(call.tool, `PACT_CORPUS_TOOL_NAME_REQUIRED:${index}`, 256),
      args: call.args === undefined ? null : assertJson(call.args, `PACT_CORPUS_TOOL_ARGS_INVALID:${index}`)
    };
  });
}

export function normalizeTraceEvent(event = {}) {
  if (!isPlainObject(event)) fail('PACT_CORPUS_EVENT_REQUIRED');
  const traceId = nonEmpty(event.traceId, 'PACT_CORPUS_TRACE_ID_REQUIRED', 256);
  const agent = nonEmpty(event.agent, 'PACT_CORPUS_AGENT_REQUIRED', 256);
  let releaseId = null;
  if (event.releaseId != null) {
    releaseId = nonEmpty(event.releaseId, 'PACT_CORPUS_RELEASE_ID_INVALID', 128);
    if (!/^pact_[a-f0-9]{64}$/.test(releaseId)) fail('PACT_CORPUS_RELEASE_ID_INVALID');
  }
  const outcome = event.outcome ?? 'unknown';
  if (!OUTCOMES.has(outcome)) fail('PACT_CORPUS_OUTCOME_INVALID');
  const normalized = {
    traceId,
    agent,
    releaseId,
    model: event.model == null ? null : nonEmpty(event.model, 'PACT_CORPUS_MODEL_INVALID', 256),
    promptHash: event.promptHash == null ? null : nonEmpty(event.promptHash, 'PACT_CORPUS_PROMPT_HASH_INVALID', 512),
    toolCalls: normalizeToolCalls(event.toolCalls),
    output: event.output === undefined ? null : assertJson(event.output, 'PACT_CORPUS_OUTPUT_INVALID'),
    latencyMs: event.latencyMs == null ? null : finiteNumber(event.latencyMs, 'PACT_CORPUS_LATENCY_INVALID'),
    costUsd: event.costUsd == null ? null : finiteNumber(event.costUsd, 'PACT_CORPUS_COST_INVALID'),
    outcome,
    ts: event.ts == null ? null : finiteNumber(event.ts, 'PACT_CORPUS_TS_INVALID')
  };
  if (normalized.ts != null && !Number.isSafeInteger(Math.trunc(normalized.ts))) fail('PACT_CORPUS_TS_INVALID');
  return normalized;
}

function otelAttribute(attributes, ...names) {
  for (const name of names) {
    if (attributes[name] != null) return attributes[name];
  }
  return undefined;
}

function parseJsonAttribute(value, code) {
  if (value == null) return undefined;
  if (typeof value !== 'string') fail(code);
  try {
    return JSON.parse(value);
  } catch {
    fail(code);
  }
}

export function fromOtelSpan(span = {}) {
  if (!isPlainObject(span)) fail('PACT_CORPUS_SPAN_REQUIRED');
  const attributes = isPlainObject(span.attributes) ? span.attributes : {};
  const traceId = otelAttribute(attributes, 'pact.trace_id', 'pact.traceId');
  const agent = otelAttribute(attributes, 'pact.agent');
  let latencyMs = null;
  const start = span.startTimeUnixNano ?? span.startTimeUnixMs;
  const end = span.endTimeUnixNano ?? span.endTimeUnixMs;
  if (start != null && end != null) {
    const scale = span.startTimeUnixNano != null ? 1e6 : 1;
    latencyMs = Number(end) / scale - Number(start) / scale;
    if (!Number.isFinite(latencyMs) || latencyMs < 0) fail('PACT_CORPUS_SPAN_TIME_INVALID');
  }
  const statusCode = span.status?.code;
  const explicitOutcome = otelAttribute(attributes, 'pact.outcome');
  return normalizeTraceEvent({
    traceId,
    agent,
    releaseId: otelAttribute(attributes, 'pact.release_id', 'pact.releaseId') ?? null,
    model: otelAttribute(attributes, 'pact.model') ?? null,
    promptHash: otelAttribute(attributes, 'pact.prompt_hash', 'pact.promptHash') ?? null,
    toolCalls: parseJsonAttribute(otelAttribute(attributes, 'pact.tool.calls'), 'PACT_CORPUS_SPAN_TOOL_CALLS_INVALID') ?? [],
    output: parseJsonAttribute(otelAttribute(attributes, 'pact.output'), 'PACT_CORPUS_SPAN_OUTPUT_INVALID') ?? null,
    latencyMs,
    costUsd: otelAttribute(attributes, 'pact.cost_usd', 'pact.costUsd') ?? null,
    outcome: explicitOutcome ?? (statusCode === 2 || statusCode === 'ERROR' ? 'failure' : 'unknown'),
    ts: latencyMs != null && span.startTimeUnixNano != null ? Math.trunc(Number(span.startTimeUnixNano) / 1e6) : null
  });
}

function splitPath(path) {
  return String(path).split('.').filter(Boolean);
}

function applyRedactionAt(root, segments, fired, base) {
  if (segments.length === 0) return true;
  const [head, ...rest] = segments;
  if (Array.isArray(root)) {
    let changed = false;
    if (head === '*') {
      root.forEach((entry, index) => {
        if (applyRedactionAt(entry, rest, fired, `${base}[${index}]`)) {
          if (rest.length === 0) {
            root[index] = REDACTED;
            fired.push(`${base}[${index}]`);
          }
          changed = true;
        }
      });
    } else if (/^\d+$/.test(head) && Number(head) < root.length) {
      const index = Number(head);
      if (rest.length === 0) {
        root[index] = REDACTED;
        fired.push(`${base}[${index}]`);
        return true;
      }
      return applyRedactionAt(root[index], rest, fired, `${base}[${index}]`);
    }
    return changed;
  }
  if (isPlainObject(root)) {
    if (head === '*') {
      let changed = false;
      for (const key of Object.keys(root)) {
        if (rest.length === 0) {
          root[key] = REDACTED;
          fired.push(base ? `${base}.${key}` : key);
          changed = true;
        } else if (applyRedactionAt(root[key], rest, fired, base ? `${base}.${key}` : key)) {
          changed = true;
        }
      }
      return changed;
    }
    if (!Object.prototype.hasOwnProperty.call(root, head)) return false;
    if (rest.length === 0) {
      root[head] = REDACTED;
      fired.push(base ? `${base}.${head}` : head);
      return true;
    }
    return applyRedactionAt(root[head], rest, fired, base ? `${base}.${head}` : head);
  }
  return false;
}

function redactSensitiveKeys(node, pattern, fired, base) {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => redactSensitiveKeys(entry, pattern, fired, `${base}[${index}]`));
    return;
  }
  if (!isPlainObject(node)) return;
  for (const key of Object.keys(node)) {
    const path = base ? `${base}.${key}` : key;
    if (pattern.test(key) && node[key] !== REDACTED) {
      node[key] = REDACTED;
      fired.push(path);
    } else {
      redactSensitiveKeys(node[key], pattern, fired, path);
    }
  }
}

export function redactEvent(event, { paths = [], keys = DEFAULT_SENSITIVE_KEYS } = {}) {
  if (!Array.isArray(paths)) fail('PACT_CORPUS_REDACT_PATHS_INVALID');
  if (!(keys instanceof RegExp)) fail('PACT_CORPUS_REDACT_KEYS_INVALID');
  const copy = clone(assertJson(event, 'PACT_CORPUS_EVENT_NOT_JSON'));
  const fired = [];
  for (const path of paths) {
    if (typeof path !== 'string' || !path) fail('PACT_CORPUS_REDACT_PATH_INVALID');
    applyRedactionAt(copy, splitPath(path), fired, '');
  }
  redactSensitiveKeys(copy, keys, fired, '');
  return { event: copy, redacted: [...new Set(fired)].sort() };
}

function assertStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.create !== 'function' || typeof store.compareAndSwap !== 'function') {
    fail('PACT_CORPUS_ATOMIC_STORE_REQUIRED');
  }
}

export function mulberry32(seed) {
  if (!Number.isSafeInteger(seed)) fail('PACT_CORPUS_SEED_INVALID');
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function createTraceCorpus({ store, prefix = 'pact:corpus:' } = {}) {
  assertStore(store);
  if (typeof prefix !== 'string' || !prefix) fail('PACT_CORPUS_PREFIX_REQUIRED');
  const keyFor = traceId => `${prefix}trace:${traceId}`;
  const indexKey = agent => `${prefix}index:${agent}`;

  async function append(event) {
    const normalized = normalizeTraceEvent(event);
    const key = keyFor(normalized.traceId);
    const record = { version: 0, event: clone(normalized) };
    if (await store.create(key, record)) {
      await appendIndex(normalized);
      return { event: clone(normalized), idempotentReplay: false };
    }
    const existing = await store.get(key);
    if (!existing || canonicalStringify(existing.event) !== canonicalStringify(normalized)) {
      fail('PACT_CORPUS_CONFLICT');
    }
    return { event: clone(existing.event), idempotentReplay: true };
  }

  async function appendIndex(normalized) {
    const key = indexKey(normalized.agent);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const raw = await store.get(key);
      if (!raw) {
        if (await store.create(key, { version: 0, ids: [normalized.traceId] })) return;
        continue;
      }
      if (!Number.isSafeInteger(raw.version) || !Array.isArray(raw.ids)) fail('PACT_CORPUS_INDEX_CORRUPT');
      if (raw.ids.includes(normalized.traceId)) return;
      if (raw.ids.length >= MAX_INDEX) fail('PACT_CORPUS_INDEX_FULL');
      if (await store.compareAndSwap(key, raw.version, { version: raw.version + 1, ids: [...raw.ids, normalized.traceId] })) return;
    }
    fail('PACT_CORPUS_INDEX_CONTENTION');
  }

  async function get(traceId) {
    if (typeof traceId !== 'string' || !traceId) fail('PACT_CORPUS_TRACE_ID_REQUIRED');
    const raw = await store.get(keyFor(traceId));
    if (!raw) fail('PACT_CORPUS_NOT_FOUND');
    return clone(normalizeTraceEvent(raw.event));
  }

  async function list(agent) {
    if (typeof agent !== 'string' || !agent) fail('PACT_CORPUS_AGENT_REQUIRED');
    const raw = await store.get(indexKey(agent));
    if (!raw) return [];
    if (!Number.isSafeInteger(raw.version) || !Array.isArray(raw.ids)) fail('PACT_CORPUS_INDEX_CORRUPT');
    return [...raw.ids];
  }

  async function sample(agent, { n = 100, seed = 1 } = {}) {
    if (!Number.isSafeInteger(n) || n < 1) fail('PACT_CORPUS_SAMPLE_SIZE_INVALID');
    const ids = await list(agent);
    const random = mulberry32(seed);
    const scored = ids.map(id => ({ id, rank: random() }));
    scored.sort((left, right) => left.rank - right.rank || (left.id < right.id ? -1 : 1));
    const events = [];
    for (const { id } of scored.slice(0, n)) events.push(await get(id));
    return events;
  }

  return Object.freeze({ append, get, list, sample });
}

export async function corpusEventHash(event) {
  return sha256Hex(normalizeTraceEvent(event));
}
