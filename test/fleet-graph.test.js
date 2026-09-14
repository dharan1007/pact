import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseLock } from '../src/release-lock.js';
import { buildFleetGraph, blastRadius, releasesUsing } from '../src/fleet-graph.js';

const supportV1 = () => createReleaseLock({
  agent: 'support-agent',
  environment: 'production',
  model: { provider: 'acme', id: 'm-1' },
  tools: { 'crm.search': { schema_hash: 'sha256:1' } },
  mcp: { 'sales@crm': { tool_manifest: { lookup: { schema_hash: 'sha256:a' } } } }
}, { now: () => 1_000 });

const supportV2 = () => createReleaseLock({
  agent: 'support-agent',
  environment: 'production',
  model: { provider: 'acme', id: 'm-2' },
  tools: { 'crm.search': { schema_hash: 'sha256:1' } },
  mcp: { 'sales@crm': { tool_manifest: { lookup: { schema_hash: 'sha256:b' } } } }
}, { now: () => 2_000 });

const billing = () => createReleaseLock({
  agent: 'billing-agent',
  environment: 'production',
  model: { provider: 'acme', id: 'm-1' },
  tools: { 'stripe.refund': { schema_hash: 'sha256:9' } }
}, { now: () => 1_500 });

test('fleet graph indexes agents, releases and dependency hashes', async () => {
  const [v1, v2, bill] = await Promise.all([supportV1(), supportV2(), billing()]);
  const graph = await buildFleetGraph({ locks: [v1, v2, bill] });
  assert.deepEqual(Object.keys(graph.agents).sort(), ['billing-agent', 'support-agent']);
  assert.deepEqual(graph.agents['support-agent'].environments.production, [v1.releaseId, v2.releaseId].sort());
  assert.ok(graph.dependencyIndex['model:m-1'].some(entry => entry.agent === 'billing-agent'));
  assert.ok(graph.dependencyIndex['tools:crm.search'].every(entry => entry.hash === 'sha256:1'));
  const record = releasesUsing(graph, v1.releaseId);
  assert.equal(record.agent, 'support-agent');
  assert.throws(() => releasesUsing(graph, 'pact_unknown'), /PACT_FLEET_RELEASE_UNKNOWN/);
  await assert.rejects(() => buildFleetGraph({ locks: [] }), /PACT_FLEET_LOCKS_REQUIRED/);
});

test('blast radius returns the exact dependent set for a changed dependency', async () => {
  const [v1, v2, bill] = await Promise.all([supportV1(), supportV2(), billing()]);
  const graph = await buildFleetGraph({ locks: [v1, v2, bill] });
  const mcpBlast = blastRadius(graph, { section: 'mcp', key: 'sales@crm.lookup' });
  assert.deepEqual(mcpBlast.agents, ['support-agent:production']);
  assert.equal(mcpBlast.dependents, 2);
  const staleHash = blastRadius(graph, { section: 'mcp', key: 'sales@crm.lookup', hash: 'sha256:a' });
  assert.deepEqual(staleHash.releases, [v1.releaseId]);
  const modelBlast = blastRadius(graph, { section: 'model', key: 'm-1' });
  assert.deepEqual(modelBlast.agents, ['billing-agent:production', 'support-agent:production']);
  const empty = blastRadius(graph, { section: 'tools', key: 'nope' });
  assert.deepEqual(empty.agents, []);
  assert.deepEqual(empty.releases, []);
  assert.throws(() => blastRadius(graph, {}), /PACT_FLEET_SECTION_REQUIRED/);
  assert.throws(() => blastRadius(null, { section: 'tools' }), /PACT_FLEET_GRAPH_REQUIRED/);
});
