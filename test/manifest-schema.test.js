import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('pact-manifest.json', 'utf8'));
const schema = JSON.parse(readFileSync('schema/pact-manifest.schema.json', 'utf8'));

function validate(value, contract, path = '$') {
  if (!contract || typeof contract !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(contract, 'const')) {
    assert.deepEqual(value, contract.const, `${path} must match schema const`);
  }
  if (contract.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${path} must be an object`);
    for (const required of contract.required ?? []) {
      assert.ok(Object.prototype.hasOwnProperty.call(value, required), `${path}.${required} is required by schema`);
    }
    if (contract.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.prototype.hasOwnProperty.call(contract.properties ?? {}, key), `${path}.${key} is not described by schema`);
      }
    }
    for (const [key, child] of Object.entries(contract.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validate(value[key], child, `${path}.${key}`);
    }
  }
  if (contract.type === 'array') {
    assert.ok(Array.isArray(value), `${path} must be an array`);
    if (Number.isInteger(contract.minItems)) assert.ok(value.length >= contract.minItems, `${path} violates minItems`);
    if (Number.isInteger(contract.maxItems)) assert.ok(value.length <= contract.maxItems, `${path} violates maxItems`);
    for (let index = 0; index < (contract.prefixItems ?? []).length && index < value.length; index += 1) {
      validate(value[index], contract.prefixItems[index], `${path}[${index}]`);
    }
  }
}

test('machine-readable product manifest conforms to its published structural schema', () => {
  validate(manifest, schema);
});
