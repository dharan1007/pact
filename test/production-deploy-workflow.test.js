import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const WORKFLOW = new URL('../.github/workflows/deploy-production.yml', import.meta.url);

async function workflowText() {
  return readFile(WORKFLOW, 'utf8');
}

test('production deploy workflow accepts manual dispatch or one tightly gated production-release request', async () => {
  const text = await workflowText();

  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /release_sha:/);
  assert.match(text, /^\s*push:\s*$/m);
  assert.match(text, /branches:\s*\[production-release\]/);
  assert.doesNotMatch(text, /branches:\s*\[[^\]]*,[^\]]*\]/, 'release push trigger must target exactly one branch');

  assert.match(text, /release-request\.json/);
  assert.match(text, /schema[^\n]*===?[^\n]*1|schema[^\n]*!==?[^\n]*1/);
  assert.match(text, /releaseSha|release_sha/);
  assert.match(text, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(text, /nonce/);
  assert.match(text, /github\.actor/);
  assert.match(text, /github\.repository_owner/);
  assert.match(text, /PACT_RELEASE_PUSH_ACTOR_FORBIDDEN/);
  assert.match(text, /PACT_RELEASE_REQUEST_INVALID/);

  assert.match(text, /git fetch --no-tags origin hardening\/real-rest-provider-20260905/);
  assert.match(text, /PACT_RELEASE_NOT_CURRENT_HARDENING_HEAD/);
  assert.doesNotMatch(text, /git merge-base --is-ancestor/);

  assert.match(text, /ref:\s*\$\{\{\s*steps\.release\.outputs\.release_sha\s*\}\}/);
  assert.doesNotMatch(text, /ref:\s*production-release/);
  assert.match(text, /PACT_SOURCE_COMMIT:\s*\$\{\{\s*steps\.release\.outputs\.release_sha\s*\}\}/);

  assert.match(text, /VERCEL_ORG_ID:\s*team_APBZJjf6iizHCTuseqHosFnU/);
  assert.match(text, /VERCEL_PROJECT_ID:\s*prj_4a7E35CAWFjsdq04HieKX5VUvv6V/);
  assert.match(text, /PACT_PRODUCTION_URL:\s*https:\/\/pact-webmcp\.vercel\.app/);
});

test('production deploy workflow fails closed on missing deploy credentials and stages before production promotion', async () => {
  const text = await workflowText();

  assert.match(text, /secrets\.VERCEL_TOKEN/);
  assert.match(text, /VERCEL_TOKEN_REQUIRED/);
  assert.match(text, /PACT_RELEASE_CI_NOT_GREEN/);
  assert.match(text, /vercel@59\.11\.7\s+pull/);
  assert.match(text, /vercel@59\.11\.7\s+build\s+--prod/);
  assert.match(text, /vercel@59\.11\.7\s+deploy\s+--prebuilt\s+--prod\s+--skip-domain/);
  assert.match(text, /--env\s+PACT_SOURCE_COMMIT=/);
  assert.match(text, /id:\s*stage/);
  assert.match(text, /deployment_url/);
  assert.match(text, /PACT_PRODUCTION_URL:\s*\$\{\{\s*steps\.stage\.outputs\.deployment_url\s*\}\}/);
  assert.match(text, /vercel@59\.11\.7\s+promote\s+\$\{\{\s*steps\.stage\.outputs\.deployment_url\s*\}\}\s+--yes/);

  const stageIndex = text.indexOf('--skip-domain');
  const stagedVerifyIndex = text.indexOf('steps.stage.outputs.deployment_url');
  const smokeIndex = text.indexOf('verify-production-smoke.mjs');
  const promoteIndex = text.indexOf(' promote ');
  const finalVerifyIndex = text.lastIndexOf('npm run verify:production');

  assert.ok(stageIndex >= 0, 'staged deployment must exist');
  assert.ok(stagedVerifyIndex > stageIndex, 'immutable staged deployment must be verified after deployment');
  assert.ok(smokeIndex > stagedVerifyIndex, 'real provider smoke must run after immutable verification');
  assert.ok(promoteIndex > smokeIndex, 'promotion must happen only after real provider smoke');
  assert.ok(finalVerifyIndex > promoteIndex, 'production alias must be re-verified after promotion');
});
