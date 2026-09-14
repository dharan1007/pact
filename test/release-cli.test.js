import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const run = args => spawnSync(process.execPath, ['scripts/pact-release.mjs', ...args], { cwd: root, encoding: 'utf8' });
const write = (dir, name, value) => {
  const file = path.join(dir, name);
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
};
const json = run => JSON.parse(run.stdout);

test('cli capture is deterministic and diff plus gate block breaking changes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-release-cli-'));
  const before = write(dir, 'before.json', {
    agent: 'support-agent',
    environment: 'production',
    model: { provider: 'acme', id: 'm-1' },
    tools: { 'crm.search': { schema_hash: 'sha256:1' } }
  });
  const after = write(dir, 'after.json', {
    agent: 'support-agent',
    environment: 'production',
    model: { provider: 'acme', id: 'm-1' },
    tools: {}
  });

  const first = run(['capture', '--descriptor', before, '--now', '1000']);
  assert.equal(first.status, 0, first.stderr);
  const second = run(['capture', '--descriptor', before, '--now', '2000']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(json(first).releaseId, json(second).releaseId);

  const beforeLock = write(dir, 'before.lock.json', json(first));
  const afterCapture = run(['capture', '--descriptor', after, '--now', '1000']);
  assert.equal(afterCapture.status, 0, afterCapture.stderr);
  const afterLock = write(dir, 'after.lock.json', json(afterCapture));

  const diff = run(['diff', '--before', beforeLock, '--after', afterLock]);
  assert.equal(diff.status, 0, diff.stderr);
  assert.equal(json(diff).findings[0].kind, 'breaking');

  const gate = run(['gate', '--before', beforeLock, '--after', afterLock]);
  assert.equal(gate.status, 1);
  assert.equal(json(gate).decision, 'BLOCK');

  const allow = run(['gate', '--before', beforeLock, '--after', beforeLock]);
  assert.equal(allow.status, 0, allow.stderr);
  assert.equal(json(allow).decision, 'ALLOW');
});

test('cli drift reports undeclared live changes and rejects malformed input', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-release-cli-'));
  const descriptor = write(dir, 'agent.json', {
    agent: 'support-agent',
    environment: 'production',
    model: { provider: 'acme', id: 'm-1' }
  });
  const capture = run(['capture', '--descriptor', descriptor, '--now', '1000']);
  assert.equal(capture.status, 0, capture.stderr);
  const pinned = write(dir, 'pinned.lock.json', json(capture));
  const observed = write(dir, 'observed.json', { model: { provider: 'acme', id: 'm-2' } });

  const drift = run(['drift', '--pinned', pinned, '--observed', observed]);
  assert.equal(drift.status, 0, drift.stderr);
  assert.equal(json(drift).drifted, true);

  const malformed = write(dir, 'bad.json', '{not-json');
  const badCapture = run(['capture', '--descriptor', malformed]);
  assert.equal(badCapture.status, 2);
  assert.match(badCapture.stderr, /PACT_RELEASE_CLI_DESCRIPTOR_UNREADABLE_INVALID_JSON/);

  const unknown = run(['frobnicate']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /PACT_RELEASE_CLI_UNKNOWN_COMMAND/);

  const missing = run(['diff', '--before', pinned]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /PACT_RELEASE_CLI_FLAG_REQUIRED:--after/);
});

test('cli scripts pass syntax validation', () => {
  const check = spawnSync(process.execPath, ['--check', 'scripts/pact-release.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.ok(readFileSync(path.join(root, 'scripts/pact-release.mjs'), 'utf8').includes('runCli'));
});
