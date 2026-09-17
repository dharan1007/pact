import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const WORKFLOW = new URL('../.github/workflows/deploy-production.yml', import.meta.url);

async function workflowText() { return readFile(WORKFLOW, 'utf8'); }

test('production deploy accepts manual dispatch or an exact successful self-hosted qualification run from main', async () => {
  const text = await workflowText();
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /release_sha:/);
  assert.match(text, /workflow_run:/);
  assert.match(text, /workflows:\s*\["self-hosted-qualification"\]/);
  assert.match(text, /types:\s*\[completed\]/);
  assert.match(text, /github\.event\.workflow_run\.conclusion\s*==\s*'success'/);
  assert.match(text, /github\.event\.workflow_run\.head_branch\s*==\s*'main'/);
  assert.match(text, /github\.event\.workflow_run\.head_sha/);
  assert.match(text, /runs-on:\s*\[self-hosted, Linux, X64, production-ci\]/);
  assert.doesNotMatch(text, /runs-on:\s*ubuntu-latest/);
  assert.doesNotMatch(text, /production-release/, 'a second mutable release branch must not be a production trust root');
  assert.doesNotMatch(text, /release-request\.json/, 'deployment must not depend on a mutable release-request file');
  assert.match(text, /git fetch --no-tags origin main/);
  assert.match(text, /PACT_RELEASE_NOT_CURRENT_MAIN_HEAD/);
  assert.doesNotMatch(text, /hardening\/real-rest-provider-20260905/);
  assert.doesNotMatch(text, /git merge-base --is-ancestor/);
  assert.match(text, /name:\s*Check out exact release[\s\S]*?ref:\s*\$\{\{\s*steps\.release\.outputs\.release_sha\s*\}\}/);
  assert.match(text, /PACT_SOURCE_COMMIT=.*releaseSha/);
  assert.match(text, /VERCEL_ORG_ID:\s*team_APBZJjf6iizHCTuseqHosFnU/);
  assert.match(text, /VERCEL_PROJECT_ID:\s*prj_4a7E35CAWFjsdq04HieKX5VUvv6V/);
  assert.match(text, /PACT_PRODUCTION_URL:\s*https:\/\/pact-webmcp\.vercel\.app/);
});

test('production deploy requires exact-SHA self-hosted verification, real provider corpus and CodeQL before Vercel', async () => {
  const text = await workflowText();
  assert.match(text, /self-hosted qualification verify/);
  assert.match(text, /self-hosted real provider corpus/);
  assert.match(text, /self-hosted qualification codeql/);
  assert.match(text, /PACT_SELF_HOSTED_QUALIFICATION_NOT_GREEN/);
  assert.match(text, /PACT_REAL_PROVIDER_CORPUS_NOT_GREEN/);
  assert.match(text, /PACT_SELF_HOSTED_CODEQL_NOT_GREEN/);
  const verifyGate = text.indexOf('PACT_SELF_HOSTED_QUALIFICATION_NOT_GREEN');
  const corpusGate = text.indexOf('PACT_REAL_PROVIDER_CORPUS_NOT_GREEN');
  const codeqlGate = text.indexOf('PACT_SELF_HOSTED_CODEQL_NOT_GREEN');
  const pull = text.indexOf('vercel@59.11.7 pull');
  assert.ok(verifyGate >= 0 && corpusGate > verifyGate && codeqlGate > corpusGate);
  assert.ok(pull > codeqlGate, 'all evidence gates must be checked before any Vercel production operation');
});

test('production deploy pins every third-party GitHub Action to an immutable commit', async () => {
  const text = await workflowText();
  const uses = [...text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)].map(match => match[1]);
  assert.ok(uses.length >= 2, 'expected checkout and setup-node actions');
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/i, `un-pinned action: ${action}`);
});

test('production deploy fails closed on credentials and stages, smokes and verifies before promotion', async () => {
  const text = await workflowText();
  assert.match(text, /secrets\.VERCEL_TOKEN/);
  assert.match(text, /VERCEL_TOKEN_REQUIRED/);
  assert.match(text, /npm run verify/);
  assert.match(text, /npm audit --audit-level=high --omit=dev/);
  assert.match(text, /vercel@59\.11\.7\s+pull/);
  assert.match(text, /vercel@59\.11\.7\s+build\s+--prod/);
  assert.match(text, /vercel@59\.11\.7\s+deploy\s+--prebuilt\s+--prod\s+--skip-domain/);
  assert.match(text, /--env\s+PACT_SOURCE_COMMIT=/);
  assert.match(text, /id:\s*stage/);
  assert.match(text, /PACT_PRODUCTION_URL:\s*\$\{\{\s*steps\.stage\.outputs\.deployment_url\s*\}\}/);
  assert.match(text, /verify-production-smoke\.mjs/);
  assert.match(text, /vercel@59\.11\.7\s+promote\s+\$\{\{\s*steps\.stage\.outputs\.deployment_url\s*\}\}\s+--yes/);
  const stageIndex = text.indexOf('--skip-domain');
  const stagedVerifyIndex = text.indexOf('steps.stage.outputs.deployment_url');
  const smokeIndex = text.indexOf('verify-production-smoke.mjs');
  const promoteIndex = text.indexOf(' promote ');
  const finalVerifyIndex = text.lastIndexOf('npm run verify:production');
  assert.ok(stageIndex >= 0);
  assert.ok(stagedVerifyIndex > stageIndex);
  assert.ok(smokeIndex > stagedVerifyIndex);
  assert.ok(promoteIndex > smokeIndex);
  assert.ok(finalVerifyIndex > promoteIndex);
});
