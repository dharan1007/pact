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

test('workspace and demo use different runtime entrypoints', () => {
  const workspace = readFileSync(path.join(root,'dist/workspace/index.html'),'utf8');
  const demo = readFileSync(path.join(root,'dist/demo/index.html'),'utf8');
  assert.match(workspace,/workspace\.bundle\.js/);
  assert.match(demo,/demo\.bundle\.js/);
  assert.match(demo,/orchestrator\.bundle\.js/);
});

test('release ships runtime, authority, real integrations and agent bridges with manifest discovery', () => {
  const run = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  for (const file of ['engine.js', 'adapter.js', 'runtime.js', 'authority.js', 'redis-store.js', 'http.js', 'webmcp.js', 'agent-bridge.js']) {
    assert.equal(existsSync(path.join(root, 'dist/sdk', file)), true, `missing SDK module ${file}`);
  }
  assert.equal(existsSync(path.join(root, 'dist/docs/agent-bridges.md')), true, 'missing agent bridge integration guide');
  const manifest = JSON.parse(readFileSync(path.join(root, 'dist/pact-manifest.json'), 'utf8'));
  assert.equal(manifest.runtime.module, './sdk/runtime.js');
  assert.equal(manifest.runtime.adapterDriven, true);
  assert.equal(manifest.runtime.approvalVerifierRequired, true);
  assert.equal(manifest.authority.module, './sdk/authority.js');
  assert.equal(manifest.authority.storeModule, './sdk/redis-store.js');
  assert.equal(manifest.authority.atomicStoreRequired, true);
  assert.equal(manifest.authority.singleUseCommitCapability, true);
  assert.equal(manifest.integrations.externalRuntimeModule, './sdk/runtime.js');
  assert.equal(manifest.integrations.restModule, './sdk/http.js');
  assert.equal(manifest.integrations.remoteRevisionBinding, true);
  assert.equal(manifest.integrations.lostResponseRecovery, true);
  assert.equal(manifest.agentBridges.module, './sdk/agent-bridge.js');
  assert.deepEqual(manifest.agentBridges.surfaces, ['http', 'webmcp', 'mcp']);
  assert.equal(manifest.agentBridges.webmcpUntrustedContentDefault, true);
  assert.equal(manifest.agentBridges.mcpProtocolRevision, '2026-07-28');
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
