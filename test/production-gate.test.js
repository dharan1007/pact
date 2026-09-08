import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyProductionDeployment } from '../src/production-gate.js';

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return headers[String(name).toLowerCase()] ?? null; } },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
  };
}

test('production gate requires exact deployed provenance and an authority route advertising the same release', async () => {
  const sha = 'b'.repeat(40);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' });
    if (String(url).endsWith('/release-provenance.json')) {
      return response(200, {
        schema: 1,
        sourceCommit: sha,
        sourceRepository: 'https://github.com/dharan1007/pact',
        buildContract: 'pact-release-v1'
      }, { 'content-type': 'application/json' });
    }
    if (String(url).endsWith('/api/pact')) {
      return response(405, { error: { code: 'PACT_HTTP_METHOD_NOT_ALLOWED' } }, {
        allow: 'POST',
        'x-pact-release': sha,
        'content-type': 'application/json'
      });
    }
    return response(404, 'not found');
  };

  const result = await verifyProductionDeployment({
    baseUrl: 'https://pact.example',
    expectedReleaseSha: sha,
    fetchImpl
  });

  assert.equal(result.releaseSha, sha);
  assert.equal(result.authorityReachable, true);
  assert.deepEqual(calls.map(call => call.url), [
    'https://pact.example/release-provenance.json',
    'https://pact.example/api/pact'
  ]);
});

test('production gate fails closed on missing or stale provenance and missing or mismatched authority release evidence', async () => {
  const sha = 'c'.repeat(40);
  await assert.rejects(
    () => verifyProductionDeployment({
      baseUrl: 'https://pact.example',
      expectedReleaseSha: sha,
      fetchImpl: async () => response(404, 'missing')
    }),
    /PACT_PRODUCTION_PROVENANCE_UNAVAILABLE/
  );

  await assert.rejects(
    () => verifyProductionDeployment({
      baseUrl: 'https://pact.example',
      expectedReleaseSha: sha,
      fetchImpl: async url => String(url).endsWith('/release-provenance.json')
        ? response(200, { schema: 1, sourceCommit: 'd'.repeat(40), sourceRepository: 'https://github.com/dharan1007/pact', buildContract: 'pact-release-v1' })
        : response(405, '', { 'x-pact-release': sha })
    }),
    /PACT_PRODUCTION_RELEASE_MISMATCH/
  );

  await assert.rejects(
    () => verifyProductionDeployment({
      baseUrl: 'https://pact.example',
      expectedReleaseSha: sha,
      fetchImpl: async url => String(url).endsWith('/release-provenance.json')
        ? response(200, { schema: 1, sourceCommit: sha, sourceRepository: 'https://github.com/dharan1007/pact', buildContract: 'pact-release-v1' })
        : response(404, 'missing')
    }),
    /PACT_PRODUCTION_AUTHORITY_UNAVAILABLE/
  );

  await assert.rejects(
    () => verifyProductionDeployment({
      baseUrl: 'https://pact.example',
      expectedReleaseSha: sha,
      fetchImpl: async url => String(url).endsWith('/release-provenance.json')
        ? response(200, { schema: 1, sourceCommit: sha, sourceRepository: 'https://github.com/dharan1007/pact', buildContract: 'pact-release-v1' })
        : response(405, '', { allow: 'POST', 'x-pact-release': 'e'.repeat(40) })
    }),
    /PACT_PRODUCTION_AUTHORITY_RELEASE_MISMATCH/
  );
});
