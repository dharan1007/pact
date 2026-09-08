import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const WORKFLOW = new URL('../.github/workflows/deploy-production.yml', import.meta.url);

async function workflowText() {
  return readFile(WORKFLOW, 'utf8');
}

test('production deploy workflow pins the reviewed release SHA and existing Vercel project', async () => {
  const text = await workflowText();

  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /release_sha:/);
  assert.match(text, /ref:\s*\$\{\{\s*inputs\.release_sha\s*\}\}/);
  assert.match(text, /VERCEL_ORG_ID:\s*team_APBZJjf6iizHCTuseqHosFnU/);
  assert.match(text, /VERCEL_PROJECT_ID:\s*prj_4a7E35CAWFjsdq04HieKX5VUvv6V/);
  assert.match(text, /PACT_PRODUCTION_URL:\s*https:\/\/pact-webmcp\.vercel\.app/);
  assert.match(text, /PACT_SOURCE_COMMIT:\s*\$\{\{\s*inputs\.release_sha\s*\}\}/);
});

test('production deploy workflow fails closed on missing deploy credentials and verifies the live release after promotion', async () => {
  const text = await workflowText();

  assert.match(text, /secrets\.VERCEL_TOKEN/);
  assert.match(text, /VERCEL_TOKEN_REQUIRED/);
  assert.match(text, /vercel@59\.11\.7\s+pull/);
  assert.match(text, /vercel@59\.11\.7\s+build\s+--prod/);
  assert.match(text, /vercel@59\.11\.7\s+deploy\s+--prebuilt\s+--prod/);
  assert.match(text, /npm\s+run\s+verify:production/);
});
