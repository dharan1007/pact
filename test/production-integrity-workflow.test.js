import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const WORKFLOW = new URL('../.github/workflows/production-integrity.yml', import.meta.url);

async function workflowText() {
  return readFile(WORKFLOW, 'utf8');
}

test('continuous production integrity follows main and verifies exact live provenance', async () => {
  const text = await workflowText();

  assert.match(text, /schedule:/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /ref:\s*main/);
  assert.doesNotMatch(text, /hardening\/real-rest-provider-20260905/, 'production integrity must not follow a dated hardening branch');
  assert.match(text, /git rev-parse HEAD/);
  assert.match(text, /PACT_EXPECTED_RELEASE_SHA/);
  assert.match(text, /PACT_PRODUCTION_URL=https:\/\/pact-webmcp\.vercel\.app/);
  assert.match(text, /npm run verify:production/);
});

test('continuous production integrity exercises a real provider transaction and removes pulled secrets', async () => {
  const text = await workflowText();

  assert.match(text, /secrets\.VERCEL_TOKEN/);
  assert.match(text, /VERCEL_TOKEN_REQUIRED/);
  assert.match(text, /vercel@59\.11\.7 env pull \.pact-production\.env/);
  assert.match(text, /verify-production-smoke\.mjs/);
  assert.match(text, /node --env-file=\.pact-production\.env scripts\/verify-production-smoke\.mjs/);
  assert.match(text, /if:\s*always\(\)/);
  assert.match(text, /rm -f \.pact-production\.env/);

  const provenanceIndex = text.indexOf('npm run verify:production');
  const envPullIndex = text.indexOf('env pull .pact-production.env');
  const smokeIndex = text.indexOf('verify-production-smoke.mjs');
  const cleanupIndex = text.indexOf('rm -f .pact-production.env');
  assert.ok(provenanceIndex >= 0, 'live provenance verification must exist');
  assert.ok(envPullIndex > provenanceIndex, 'production environment must be pulled only after provenance verification');
  assert.ok(smokeIndex > envPullIndex, 'real transaction smoke must use the verified production environment');
  assert.ok(cleanupIndex > smokeIndex, 'pulled production environment must be removed after smoke execution');
});
