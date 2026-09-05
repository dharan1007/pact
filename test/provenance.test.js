import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReleaseSha } from '../src/provenance.js';

test('release provenance accepts one exact lowercase or uppercase 40-hex SHA', () => {
  const sha = 'A'.repeat(40);
  assert.equal(resolveReleaseSha({ PACT_SOURCE_COMMIT: sha }), sha.toLowerCase());
});

test('release provenance rejects malformed SHA candidates', () => {
  assert.throws(
    () => resolveReleaseSha({ VERCEL_GIT_COMMIT_SHA: 'not-a-sha' }),
    /PACT_RUNTIME_INVALID_RELEASE_SHA/
  );
});

test('release provenance rejects disagreement across deployment provenance sources', () => {
  assert.throws(
    () => resolveReleaseSha({
      PACT_SOURCE_COMMIT: 'a'.repeat(40),
      VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40),
      GITHUB_SHA: 'a'.repeat(40)
    }),
    /PACT_RUNTIME_RELEASE_SHA_CONFLICT/
  );
});

test('release provenance can require a SHA and otherwise returns null', () => {
  assert.equal(resolveReleaseSha({}), null);
  assert.throws(() => resolveReleaseSha({}, { required: true }), /PACT_RUNTIME_RELEASE_SHA_REQUIRED/);
});
