const clone = value => structuredClone(value);
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
const ADAPTER_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(code) { throw new Error(code); }

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
}

function validatePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) fail('PACT_ADAPTER_INVALID_PATH');
  const segments = path.split('.');
  if (segments.some(segment => !PATH_SEGMENT.test(segment) || FORBIDDEN_PATH_SEGMENTS.has(segment))) fail('PACT_ADAPTER_UNSAFE_PATH');
  return path;
}

function validateJsonValue(value, code) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail(code);
    JSON.parse(encoded);
  } catch {
    fail(code);
  }
}

export function validateAdapterPlan(input, { maxEffects = 256, maxInvariants = 256 } = {}) {
  assertPlainObject(input, 'PACT_ADAPTER_INVALID_PLAN');
  if (!Array.isArray(input.effects) || input.effects.length === 0) fail('PACT_ADAPTER_EFFECTS_REQUIRED');
  if (input.effects.length > maxEffects) fail('PACT_ADAPTER_TOO_MANY_EFFECTS');
  if (input.invariants != null && !Array.isArray(input.invariants)) fail('PACT_ADAPTER_INVALID_INVARIANTS');
  if ((input.invariants?.length ?? 0) > maxInvariants) fail('PACT_ADAPTER_TOO_MANY_INVARIANTS');

  const seenPaths = new Set();
  const effects = input.effects.map(effect => {
    assertPlainObject(effect, 'PACT_ADAPTER_INVALID_EFFECT');
    const path = validatePath(effect.path);
    if (seenPaths.has(path)) fail('PACT_ADAPTER_DUPLICATE_EFFECT_PATH');
    seenPaths.add(path);
    if (!Object.hasOwn(effect, 'before') || !Object.hasOwn(effect, 'after')) fail('PACT_ADAPTER_INVALID_EFFECT');
    validateJsonValue(effect.before, 'PACT_ADAPTER_INVALID_EFFECT_VALUE');
    validateJsonValue(effect.after, 'PACT_ADAPTER_INVALID_EFFECT_VALUE');
    return { path, before: clone(effect.before), after: clone(effect.after) };
  });

  const invariants = (input.invariants ?? []).map(invariant => {
    assertPlainObject(invariant, 'PACT_ADAPTER_INVALID_INVARIANT');
    const path = validatePath(invariant.path);
    if (!Object.hasOwn(invariant, 'equals')) fail('PACT_ADAPTER_INVALID_INVARIANT');
    validateJsonValue(invariant.equals, 'PACT_ADAPTER_INVALID_INVARIANT_VALUE');
    return { path, equals: clone(invariant.equals) };
  });

  const out = { effects, invariants };
  if (input.metadata !== undefined) {
    validateJsonValue(input.metadata, 'PACT_ADAPTER_INVALID_METADATA');
    out.metadata = clone(input.metadata);
  }
  return out;
}

export function definePactAdapter(adapter) {
  assertPlainObject(adapter, 'PACT_ADAPTER_REQUIRED');
  if (typeof adapter.id !== 'string' || !ADAPTER_ID.test(adapter.id) || adapter.id.length > 128) fail('PACT_ADAPTER_INVALID_ID');
  if (typeof adapter.version !== 'string' || !SEMVER.test(adapter.version)) fail('PACT_ADAPTER_INVALID_VERSION');
  if (typeof adapter.describe !== 'function') fail('PACT_ADAPTER_DESCRIBE_REQUIRED');
  if (typeof adapter.plan !== 'function') fail('PACT_ADAPTER_PLAN_REQUIRED');
  if (typeof adapter.verify !== 'function') fail('PACT_ADAPTER_VERIFY_REQUIRED');

  return Object.freeze({
    id: adapter.id,
    version: adapter.version,
    describe: adapter.describe.bind(adapter),
    async plan(context) {
      assertPlainObject(context, 'PACT_ADAPTER_PLAN_CONTEXT_REQUIRED');
      return validateAdapterPlan(await adapter.plan(clone(context)));
    },
    async verify(context) {
      assertPlainObject(context, 'PACT_ADAPTER_VERIFY_CONTEXT_REQUIRED');
      const result = await adapter.verify(clone(context));
      if (typeof result !== 'boolean') fail('PACT_ADAPTER_VERIFY_MUST_RETURN_BOOLEAN');
      return result;
    }
  });
}
