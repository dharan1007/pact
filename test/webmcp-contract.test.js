import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactEngine } from '../src/engine.js';
import { createWebMcpRegistry, toWebMcpResult } from '../src/webmcp.js';

test('successful WebMCP results include MCP content while preserving structured fields', () => {
  const out = toWebMcpResult({ state: 'PREVIEWED', txId: 'tx_1' });
  assert.equal(out.state, 'PREVIEWED');
  assert.equal(out.isError, false);
  assert.deepEqual(out.content, [{ type: 'text', text: '{"state":"PREVIEWED","txId":"tx_1"}' }]);
});

test('registered tools expose title, description, closed input schema and read-only annotation', async () => {
  const engine = createPactEngine();
  const calls = [];
  const modelContext = { registerTool(tool, options) { calls.push({ tool, options }); } };
  const registry = createWebMcpRegistry({ engine, modelContext });
  await registry.refresh();
  const inspect = calls.find(({ tool }) => tool.name === 'pact_inspect').tool;
  assert.equal(typeof inspect.title, 'string');
  assert(inspect.title.length > 0);
  assert.equal(typeof inspect.description, 'string');
  assert(inspect.description.length > 20);
  assert.deepEqual(inspect.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.equal(inspect.annotations.readOnlyHint, true);
  const result = await inspect.execute({});
  assert.equal(result.isError, false);
  assert.equal(result.content[0].type, 'text');
  assert.doesNotThrow(() => JSON.parse(result.content[0].text));
});
