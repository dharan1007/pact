import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  discoverGit,
  discoverPackage,
  discoverMcpServer,
  discoverOpenaiModel,
  discoverAnthropicModel,
  composeDescriptor
} from '../src/release-discover.js';
import { createReleaseLock } from '../src/release-lock.js';

function stubServer(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const close = server => new Promise(resolve => server.close(resolve));

test('git discovery reports the real repository state', () => {
  const found = discoverGit({ cwd: process.cwd() });
  assert.equal(found.provider, 'git');
  const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim().toLowerCase();
  assert.equal(found.sections.source.git_sha, expected);
  assert.equal(typeof found.sections.source.dirty, 'boolean');
  if (found.sections.source.dirty) {
    assert.match(found.sections.source.diff_hash, /^sha256:[a-f0-9]{64}$/);
  } else {
    assert.equal(found.sections.source.diff_hash, null);
  }
  assert.throws(() => discoverGit({ exec: () => { throw new Error('no git'); } }), /PACT_DISCOVER_GIT_UNAVAILABLE/);
});

test('package discovery inventories real dependency metadata', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-discover-pkg-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-agent', version: '2.3.0', dependencies: { leftpad: '1.3.0' } }));
  writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  const found = discoverPackage({ root: dir });
  assert.equal(found.sections.runtime.package, 'demo-agent');
  assert.equal(found.sections.runtime.version, '2.3.0');
  assert.deepEqual(found.sections.runtime.dependencies, { leftpad: '1.3.0' });
  assert.equal(found.sections.runtime.lockfile, 'package-lock.json');
  assert.match(found.sections.runtime.lockfile_hash, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => discoverPackage({ root: path.join(dir, 'missing') }), /PACT_DISCOVER_PACKAGE_UNREADABLE/);
});

test('mcp discovery performs the real initialize plus tools/list handshake', async () => {
  const seen = [];
  const server = await stubServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const message = JSON.parse(body);
      seen.push({ method: message.method, session: req.headers['mcp-session-id'] ?? null });
      if (message.method === 'initialize') {
        res.setHeader('mcp-session-id', 'sess-1');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'crm', version: '7.1' } } }));
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search', description: 'Search records', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }] } }));
      }
    });
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const found = await discoverMcpServer({ url });
    const keys = Object.keys(found.sections.mcp);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^crm@127\.0\.0\.1-\d+$/);
    const entry = found.sections.mcp[keys[0]];
    assert.equal(entry.server_version, '7.1');
    assert.match(entry.tool_manifest.search.schema_hash, /^sha256:[a-f0-9]{64}$/);
    assert.match(entry.tool_manifest.search.description_hash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(entry.tool_manifest.search.schema, { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] });
    assert.equal(seen[1].session, 'sess-1');
  } finally {
    await close(server);
  }
  await assert.rejects(
    discoverMcpServer({ url: 'http://127.0.0.1:1/mcp', timeoutMs: 500 }),
    /PACT_DISCOVER_MCP_UNREACHABLE|PACT_DISCOVER_MCP_HTTP_0/
  );
});

test('model discovery calls the real provider REST contract', async () => {
  const openai = await stubServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer sk-test');
    res.end(JSON.stringify({ id: 'gpt-x', created: 1720000000, owned_by: 'test' }));
  });
  const anthropic = await stubServer((req, res) => {
    assert.equal(req.headers['x-api-key'], 'sk-ant-test');
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    res.end(JSON.stringify({ id: 'fable-1', display_name: 'Fable', created_at: '2026-01-01T00:00:00Z' }));
  });
  try {
    const openaiBase = `http://127.0.0.1:${openai.address().port}/v1/`;
    const foundOpenai = await discoverOpenaiModel({ apiKey: 'sk-test', model: 'gpt-x', baseUrl: openaiBase });
    assert.equal(foundOpenai.sections.model.id, 'gpt-x');
    assert.equal(foundOpenai.sections.model.created, 1720000000);
    const anthropicBase = `http://127.0.0.1:${anthropic.address().port}/v1/`;
    const foundAnthropic = await discoverAnthropicModel({ apiKey: 'sk-ant-test', model: 'fable-1', baseUrl: anthropicBase });
    assert.equal(foundAnthropic.sections.model.display_name, 'Fable');
  } finally {
    await close(openai);
    await close(anthropic);
  }
  await assert.rejects(discoverOpenaiModel({ apiKey: '', model: 'gpt-x' }), /PACT_DISCOVER_AUTH_REQUIRED/);
});

test('compose merges discoveries with provenance and locks the result', async () => {
  const { descriptor, provenance } = composeDescriptor({
    agent: 'support-agent',
    environment: 'production',
    discoveries: [
      { provider: 'git', sections: { source: { git_sha: 'a'.repeat(40) } } },
      { provider: 'mcp', sections: { tools: { 'crm.search': { schema_hash: 'sha256:1' } } } }
    ]
  });
  assert.deepEqual(provenance, { source: ['git'], tools: ['mcp'] });
  const lock = await createReleaseLock(descriptor, { now: () => 1_000 });
  assert.match(lock.releaseId, /^pact_[a-f0-9]{64}$/);
  assert.throws(
    () => composeDescriptor({ agent: '', environment: 'production', discoveries: [] }),
    /PACT_DISCOVER_AGENT_REQUIRED/
  );
  assert.throws(
    () => composeDescriptor({ agent: 'a', environment: 'e', discoveries: [{ provider: 'x' }] }),
    /PACT_DISCOVER_RESULT_INVALID/
  );
});
