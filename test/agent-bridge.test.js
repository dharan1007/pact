import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactAgentToolCatalog, registerPactWebMcpBridge, registerPactMcpBridge } from '../src/agent-bridge.js';

function connector(log = []) {
  const normal = op => async (payload, options) => { log.push({ op, payload, options }); return { ok: true, op, payload }; };
  const consequential = op => async (payload, idempotencyKey, options) => { log.push({ op, payload, idempotencyKey, options }); return { ok: true, op, payload, idempotencyKey }; };
  return {
    inspect: normal('inspect'), preview: normal('preview'), approve: normal('approve'),
    commit: consequential('commit'), verify: normal('verify'), receipt: normal('receipt'),
    rollback: consequential('rollback'), cancel: normal('cancel')
  };
}

test('shared catalog exposes real API-backed agent tools and preserves idempotency', async () => {
  const log = [];
  const catalog = createPactAgentToolCatalog({ connector: connector(log) });
  const tools = catalog.tools();
  assert.equal(tools.length, 8);
  assert.equal(tools.find(t => t.name === 'pact_commit_transaction').inputSchema.required.includes('idempotencyKey'), true);
  const result = await catalog.execute('pact_commit_transaction', { payload: { transactionId: 'tx_1' }, idempotencyKey: 'commit:tx_1' });
  assert.equal(result.idempotencyKey, 'commit:tx_1');
  assert.equal(log[0].op, 'commit');
});

test('consequential agent calls fail closed without idempotency keys', async () => {
  const catalog = createPactAgentToolCatalog({ connector: connector() });
  await assert.rejects(() => catalog.execute('pact_commit_transaction', { payload: { transactionId: 'tx_1' } }), /PACT_AGENT_IDEMPOTENCY_KEY_REQUIRED/);
  await assert.rejects(() => catalog.execute('pact_rollback_transaction', { payload: { transactionId: 'tx_1' }, idempotencyKey: '  ' }), /PACT_AGENT_IDEMPOTENCY_KEY_REQUIRED/);
});

test('WebMCP bridge treats remote provider output as untrusted content by default and disposes by abort', async () => {
  const registrations = [];
  const modelContext = { async registerTool(tool, options) { registrations.push({ tool, options }); } };
  const bridge = await registerPactWebMcpBridge({ connector: connector(), modelContext });
  assert.equal(bridge.supported, true);
  assert.equal(registrations.length, 8);
  assert.equal(registrations[0].tool.annotations.untrustedContentHint, true);
  assert.equal(registrations[0].options.signal.aborted, false);
  const output = await registrations.find(r => r.tool.name === 'pact_preview_transaction').tool.execute({ payload: { intent: { type: 'real' } } }, {});
  assert.equal(output.op, 'preview');
  bridge.dispose();
  assert.equal(registrations[0].options.signal.aborted, true);
});

test('WebMCP bridge allows an application to explicitly mark a fully trusted backend', async () => {
  const registrations = [];
  const modelContext = { async registerTool(tool) { registrations.push(tool); } };
  await registerPactWebMcpBridge({ connector: connector(), modelContext, untrustedContentHint: false });
  assert.equal(registrations.every(tool => tool.annotations.untrustedContentHint === false), true);
  await assert.rejects(
    () => registerPactWebMcpBridge({ connector: connector(), modelContext, untrustedContentHint: 'no' }),
    /PACT_AGENT_INVALID_UNTRUSTED_CONTENT_HINT/
  );
});

test('MCP bridge registers the same tools and emits MCP content plus structuredContent', async () => {
  const registered = [];
  const server = { registerTool(name, config, handler) { registered.push({ name, config, handler }); return { name }; } };
  const bridge = registerPactMcpBridge({ connector: connector(), server, schemaFactory: jsonSchema => ({ jsonSchema }) });
  assert.equal(bridge.names.length, 8);
  const commit = registered.find(r => r.name === 'pact_commit_transaction');
  assert.equal(commit.config.annotations.idempotentHint, true);
  const result = await commit.handler({ payload: { transactionId: 'tx_2' }, idempotencyKey: 'commit:tx_2' }, {});
  assert.equal(result.structuredContent.op, 'commit');
  assert.equal(result.content[0].type, 'text');
});

test('agent bridge propagates cancellation to connector calls', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  const catalog = createPactAgentToolCatalog({ connector: connector() });
  await assert.rejects(() => catalog.execute('pact_preview_transaction', { payload: {} }, { signal: controller.signal }), /PACT_AGENT_ABORTED/);
});
