import { canonicalStringify, sha256Hex } from './engine.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };
const LOCK_VERSION = 1;

const SECTIONS = Object.freeze([
  'source',
  'model',
  'prompts',
  'skills',
  'tools',
  'mcp',
  'retrieval',
  'memory',
  'permissions',
  'evals',
  'runtime'
]);

const MAX_SECTION_BYTES = 262_144;
const MAX_AGENT_LENGTH = 256;
const MAX_ENV_LENGTH = 64;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value, code, max) {
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

function normalizeSection(name, value) {
  if (value === undefined) return undefined;
  const content = assertJson(value, `PACT_LOCK_SECTION_NOT_JSON:${name}`);
  const bytes = Buffer.byteLength(canonicalStringify(content), 'utf8');
  if (bytes > MAX_SECTION_BYTES) fail(`PACT_LOCK_SECTION_TOO_LARGE:${name}`);
  return content;
}

function assertClock(now) {
  if (typeof now !== 'function') fail('PACT_LOCK_CLOCK_REQUIRED');
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) fail('PACT_LOCK_INVALID_CLOCK');
  return value;
}

export function lockSectionNames() {
  return [...SECTIONS];
}

export async function createReleaseLock(descriptor = {}, { now = () => Date.now() } = {}) {
  if (!isPlainObject(descriptor)) fail('PACT_LOCK_DESCRIPTOR_REQUIRED');
  const agent = nonEmpty(descriptor.agent, 'PACT_LOCK_AGENT_REQUIRED', MAX_AGENT_LENGTH);
  const environment = nonEmpty(descriptor.environment, 'PACT_LOCK_ENVIRONMENT_REQUIRED', MAX_ENV_LENGTH);
  for (const key of Object.keys(descriptor)) {
    if (key !== 'agent' && key !== 'environment' && !SECTIONS.includes(key)) {
      fail(`PACT_LOCK_UNKNOWN_SECTION:${key}`);
    }
  }
  const capturedAt = assertClock(now);
  const sections = {};
  for (const name of SECTIONS) {
    const content = normalizeSection(name, descriptor[name]);
    if (content === undefined) continue;
    sections[name] = { hash: `sha256:${await sha256Hex(content)}`, content: clone(content) };
  }
  const releaseId = `pact_${await sha256Hex({ agent, environment, sections })}`;
  return { lockVersion: LOCK_VERSION, agent, environment, capturedAt, sections, releaseId };
}

export async function validateReleaseLock(lock) {
  if (!isPlainObject(lock)) fail('PACT_LOCK_REQUIRED');
  if (lock.lockVersion !== LOCK_VERSION) fail('PACT_LOCK_VERSION_UNSUPPORTED');
  const agent = nonEmpty(lock.agent, 'PACT_LOCK_AGENT_REQUIRED', MAX_AGENT_LENGTH);
  const environment = nonEmpty(lock.environment, 'PACT_LOCK_ENVIRONMENT_REQUIRED', MAX_ENV_LENGTH);
  if (!Number.isSafeInteger(lock.capturedAt) || lock.capturedAt < 0) fail('PACT_LOCK_CAPTURED_AT_INVALID');
  if (!isPlainObject(lock.sections)) fail('PACT_LOCK_SECTIONS_REQUIRED');
  for (const key of Object.keys(lock.sections)) {
    if (!SECTIONS.includes(key)) fail(`PACT_LOCK_UNKNOWN_SECTION:${key}`);
  }
  const sections = {};
  for (const name of Object.keys(lock.sections)) {
    const entry = lock.sections[name];
    if (!isPlainObject(entry) || typeof entry.hash !== 'string') fail(`PACT_LOCK_SECTION_CORRUPT:${name}`);
    const content = normalizeSection(name, entry.content);
    const expected = `sha256:${await sha256Hex(content)}`;
    if (entry.hash !== expected) fail(`PACT_LOCK_SECTION_HASH_MISMATCH:${name}`);
    sections[name] = { hash: expected, content: clone(content) };
  }
  const releaseId = `pact_${await sha256Hex({ agent, environment, sections })}`;
  if (lock.releaseId !== releaseId) fail('PACT_LOCK_RELEASE_ID_MISMATCH');
  return { lockVersion: LOCK_VERSION, agent, environment, capturedAt: lock.capturedAt, sections, releaseId };
}
