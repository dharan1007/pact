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

test('production gate requires exact deployed release provenance and a live PACT authority route', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' });
    if (String(url).endsWith('/release-provenance.json')) {
      return response(200, { releaseSha: 'b'.repeat(40) }, { 'content-type': 'application/json' });
    }
    if (String(url).endsWith('/api/pact')) {
      return response(405, { error: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
    }
    return response(404, 'not found');
  };

  const result = await verifyProductionDeployment({
    baseUrl: 'https://pact.example',
    expectedReleaseSha: 'b'.repeat(40),
    fetchImpl
  });

  assert.equal(result.releaseSha, 'b'.repeat(40));
  assert.equal(result.authorityReachable, true);
  assert.deepEqual(calls.map(call => call.url), [
    'https://pact.example/release-provenance.json',
    'https://pact.example/api/pact'
  ]);
});

test('production gate fails closed when provenance is missing, stale, malformed, or the authority route is absent', async () => {
  await assert.rejects(
    () => verifyProductionDeployment({
      baseUrl: 'https://pact.example',
      expectedReleaseSha: 'c'.repeat(40),
      fetchImpl: async () => response(404, 'missing')
    }),
    /PACT_PRODUCTION_PROVENANCE_UNAVAILABLE/
  );

  await assert.rejects(
    () => verifyProductionDeployment({
      baseUrl: 'https://pact.example',
      expectedReleaseSha: 'c'.repeat(40),
      fetchImpl: async url => String(url).endsWith('/release-provenance.json')
        ? response(200, { releaseSha: 'd'.repeat(40) })
        : response(405, '')
    }),
    /PACT_PRODUCTION_RELEASE_MISMATCH/
  );

  await assert.rejects(
    () => verifyProductionDeployment({
      baseUrl: 'https://pact.example',
      expectedReleaseSha: 'c'.repeat(40),
      fetchImpl: async url => String(url).endsWith('/release-provenance.json')
        ? response(200, { releaseSha: 'c'.repeat(40) })
        : response(404, 'missing')
    }),
    /PACT_PRODUCTION_AUTHORITY_UNAVAILABLE/
  );
});
