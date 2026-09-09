import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactAgentToolCatalog, registerPactWebMcpBridge, registerPactMcpBridge } from '../src/agent-bridge.js';

function connector(log = []) {
  const normal = op => async (payload, options) => { log.push({ op, payload, options }); return { ok: true, op, payload }; };
  const consequential = op => async (payload, idempotencyKey, options) => { log.push({ op, payload, idempotencyKey, options }); return { ok: true, op, payload, idempotencyKey }; };
  return {
    inspect: normal('inspect'), preview: normal('preview'), approve: normal('approve'),
    commit: consequential('commit'), verify: normal('verify'), receipt: normal('receipt')
  };
}

test('shared catalog exposes exactly the canonical API-backed agent tools and preserves commit idempotency', async () => {
  const log = [];
  const catalog = createPactAgentToolCatalog({ connector: connector(log) });
  const tools = catalog.tools();
  assert.equal(tools.length, 6);
  assert.deepEqual(tools.map(tool => tool.operation), ['inspect', 'preview', 'approve', 'commit', 'verify', 'receipt']);
  assert.equal(tools.some(tool => /rollback|cancel/.test(tool.name)), false);
  assert.equal(tools.find(t => t.name === 'pact_commit_transaction').inputSchema.required.includes('idempotencyKey'), true);
  const result = await catalog.execute('pact_commit_transaction', { payload: { transactionId: 'tx_1' }, idempotencyKey: 'commit:tx_1' });
  assert.equal(result.idempotencyKey, 'commit:tx_1');
  assert.equal(log[0].op, 'commit');
});

test('consequential agent commit fails closed without an idempotency key', async () => {
  const catalog = createPactAgentToolCatalog({ connector: connector() });
  await assert.rejects(() => catalog.execute('pact_commit_transaction', { payload: { transactionId: 'tx_1' } }), /PACT_AGENT_IDEMPOTENCY_KEY_REQUIRED/);
});

test('WebMCP bridge uses the current single-input execute callback and registration AbortSignal', async () => {
  const registrations = [];
  const modelContext = { async registerTool(tool, options) { registrations.push({ tool, options }); } };
  const bridge = await registerPactWebMcpBridge({ connector: connector(), modelContext });
  assert.equal(bridge.supported, true);
  assert.equal(registrations.length, 6);
  assert.equal(registrations[0].tool.annotations.untrustedContentHint, true);
  assert.equal(registrations[0].options.signal.aborted, false);
  const preview = registrations.find(r => r.tool.name === 'pact_preview_transaction').tool;
  assert.equal(preview.execute.length, 1);
  const output = await preview.execute({ payload: { intent: { type: 'real' } } });
  assert.equal(output.op, 'preview');
  bridge.dispose();
  assert.equal(registrations[0].options.signal.aborted, true);
});

test('MCP bridge registers the same canonical tools and emits MCP content plus structuredContent', async () => {
  const registered = [];
  const server = { registerTool(name, config, handler) { registered.push({ name, config, handler }); return { name }; } };
  const bridge = registerPactMcpBridge({ connector: connector(), server, schemaFactory: jsonSchema => ({ jsonSchema }) });
  assert.equal(bridge.names.length, 6);
  const commit = registered.find(r => r.name === 'pact_commit_transaction');
  assert.equal(commit.config.annotations.idempotentHint, true);
  const result = await commit.handler({ payload: { transactionId: 'tx_2' }, idempotencyKey: 'commit:tx_2' }, {});
  assert.equal(result.structuredContent.op, 'commit');
  assert.equal(result.content[0].type, 'text');
});

test('agent catalog and MCP path propagate cancellation to connector calls', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  const catalog = createPactAgentToolCatalog({ connector: connector() });
  await assert.rejects(() => catalog.execute('pact_preview_transaction', { payload: {} }, { signal: controller.signal }), /PACT_AGENT_ABORTED/);
});
