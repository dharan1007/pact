import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const routes = ['', 'demo', 'workspace', 'how-it-works', 'security', 'developers'];

test('production build emits every product route and every referenced local asset', () => {
  const run = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  for (const route of routes) {
    const file = route ? path.join(root,'dist',route,'index.html') : path.join(root,'dist','index.html');
    assert.equal(existsSync(file), true, `${route || '/'} route must exist`);
    const html = readFileSync(file,'utf8');
    const refs = [...html.matchAll(/(?:src|href)="\/(?!\/)([^"?#]+\.(?:js|css))"/g)].map(m=>m[1]);
    for (const ref of refs) assert.equal(existsSync(path.join(root,'dist',ref)), true, `${route || '/'} references missing ${ref}`);
  }
});

test('workspace uses the canonical HTTP playground while demo keeps the reference orchestrator', () => {
  const workspace = readFileSync(path.join(root,'dist/workspace/index.html'),'utf8');
  const demo = readFileSync(path.join(root,'dist/demo/index.html'),'utf8');
  assert.match(workspace,/playground\.bundle\.js/);
  assert.match(workspace,/http\.bundle\.js/);
  assert.doesNotMatch(workspace,/workspace\.bundle\.js/);
  assert.match(demo,/demo\.bundle\.js/);
  assert.match(demo,/orchestrator\.bundle\.js/);
});

test('release ships generic runtime, canonical API authority, durable state, real provider bridge, agent bridges and atomic stores with manifest discovery', () => {
  const run = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  for (const file of ['engine.js', 'adapter.js', 'runtime.js', 'authority.js', 'api-authority.js', 'redis-store.js', 'canonical-store.js', 'durable-state.js', 'rest-resource.js', 'http.js', 'http-handler.js', 'server-approval.js', 'server-runtime.js', 'provenance.js', 'webmcp.js', 'agent-bridge.js']) {
    assert.equal(existsSync(path.join(root, 'dist/sdk', file)), true, `missing SDK module ${file}`);
  }
  assert.equal(existsSync(path.join(root, 'api', 'pact.js')), true, 'missing Vercel /api/pact entrypoint');
  const manifest = JSON.parse(readFileSync(path.join(root, 'dist/pact-manifest.json'), 'utf8'));
  assert.equal(manifest.runtime.module, './sdk/runtime.js');
  assert.equal(manifest.runtime.adapterDriven, true);
  assert.equal(manifest.runtime.approvalVerifierRequired, true);
  assert.equal(manifest.authority.module, './sdk/authority.js');
  assert.equal(manifest.authority.storeModule, './sdk/redis-store.js');
  assert.equal(manifest.authority.canonicalStoreModule, './sdk/canonical-store.js');
  assert.equal(manifest.authority.atomicStoreRequired, true);
  assert.equal(manifest.authority.singleUseCommitCapability, true);
  assert.equal(manifest.integrations.restResourceModule, './sdk/rest-resource.js');
  assert.equal(manifest.integrations.providerRevision, 'etag');
  assert.equal(manifest.integrations.conditionalWriteHeader, 'If-Match');
  assert.equal(manifest.integrations.idempotencyHeader, 'Idempotency-Key');
  assert.equal(manifest.integrations.lostResponseRecovery, true);
  assert.equal(manifest.integrations.credentialsBoundary, 'server-side');
  assert.equal(manifest.agentBridges.module, './sdk/agent-bridge.js');
  assert.deepEqual(manifest.agentBridges.surfaces, ['http', 'webmcp', 'mcp']);
  assert.deepEqual(manifest.agentBridges.canonicalOperations, ['inspect', 'preview', 'approve', 'commit', 'verify', 'receipt']);
  assert.equal(manifest.agentBridges.webmcpHost, 'document.modelContext');
  assert.equal(manifest.agentBridges.webmcpExecuteCallback, 'single-input');
  assert.equal(manifest.agentBridges.webmcpRegistrationAbortSignal, true);
  assert.equal(manifest.agentBridges.webmcpExecutionAbortSignal, false);
  assert.equal(manifest.agentBridges.webmcpUntrustedContentDefault, true);
  assert.equal(manifest.agentBridges.mcpTransportOwnedByHost, true);
});

test('Vercel release contract publishes dist while retaining the canonical api function', () => {
  const config = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(config.$schema, 'https://openapi.vercel.sh/vercel.json');
  assert.equal(config.outputDirectory, 'dist');
  assert.equal(config.buildCommand, 'npm run build');
  assert.ok(config.functions && config.functions['api/pact.js'], 'api/pact.js must be declared as a Vercel Function');
  assert.ok(Number.isInteger(config.functions['api/pact.js'].maxDuration), 'api/pact.js maxDuration must be explicit');
});

test('release exposes validated source provenance and includes it in integrity hashing', () => {
  const env = { ...process.env };
  delete env.GITHUB_SHA;
  delete env.VERCEL_GIT_COMMIT_SHA;
  env.PACT_SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
  const run = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const provenance = JSON.parse(readFileSync(path.join(root, 'dist/release-provenance.json'), 'utf8'));
  assert.equal(provenance.sourceCommit, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(provenance.sourceRepository, 'https://github.com/dharan1007/pact');
  assert.equal(provenance.commitProvenance, 'validated-consistent-build-environment');
  assert.deepEqual(provenance.provenanceSources, ['PACT_SOURCE_COMMIT']);
  const release = JSON.parse(readFileSync(path.join(root, 'dist/release-manifest.json'), 'utf8'));
  assert.match(release.files['release-provenance.json'], /^[a-f0-9]{64}$/);
});

test('release build fails closed when declared provenance sources disagree', () => {
  const env = { ...process.env };
  delete env.GITHUB_SHA;
  env.PACT_SOURCE_COMMIT = 'a'.repeat(40);
  env.VERCEL_GIT_COMMIT_SHA = 'b'.repeat(40);
  const run = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8', env });
  assert.notEqual(run.status, 0);
  assert.match(`${run.stderr}\n${run.stdout}`, /PACT_RUNTIME_RELEASE_SHA_CONFLICT/);
});

test('identical source produces an identical release manifest', () => {
  const first = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const manifestA = readFileSync(path.join(root,'dist/release-manifest.json'),'utf8');
  const second = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const manifestB = readFileSync(path.join(root,'dist/release-manifest.json'),'utf8');
  assert.equal(manifestB, manifestA);
});
