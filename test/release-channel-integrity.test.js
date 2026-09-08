import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const file = relative => readFile(new URL(relative, ROOT), 'utf8');

test('production promotion verifies the exact prebuilt artifact and staged deployment before alias promotion', async () => {
  const [workflow, pkg] = await Promise.all([
    file('.github/workflows/deploy-production.yml'),
    file('package.json')
  ]);

  assert.match(pkg, /"verify:prebuilt"\s*:\s*"node scripts\/verify-prebuilt\.mjs"/);
  assert.match(
    workflow,
    /Build production artifact[\s\S]*npm run verify:prebuilt[\s\S]*Stage production-configured artifact[\s\S]*Verify immutable staged deployment before promotion[\s\S]*Promote verified staged deployment[\s\S]*Verify live production alias after promotion/
  );
  assert.match(workflow, /--prod\s+--skip-domain/);
});

test('repository has a scheduled fail-closed production drift monitor', async () => {
  const workflow = await file('.github/workflows/production-integrity.yml');

  assert.match(workflow, /schedule:/);
  assert.match(workflow, /cron:\s*['"]?\*\/15 \* \* \* \*['"]?/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /PACT_EXPECTED_RELEASE_SHA/);
  assert.match(workflow, /npm run verify:production/);
});
