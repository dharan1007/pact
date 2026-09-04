import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactEngine } from '../src/engine.js';
import { createWebMcpRegistry, toWebMcpResult } from '../src/webmcp.js';

test('WebMCP execute results preserve structured JavaScript values for user-agent serialization', () => {
  const out = toWebMcpResult({ state: 'PREVIEWED', txId: 'tx_1' });
  assert.deepEqual(out, { state: 'PREVIEWED', txId: 'tx_1' });
});

test('registered tools expose current WebMCP annotations and execution cancellation options', async () => {
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
  assert.deepEqual(inspect.annotations, {
    readOnlyHint: true,
    untrustedContentHint: false,
    consequentialHint: false
  });
  assert.deepEqual(await inspect.execute({}, { signal: new AbortController().signal }), engine.inspect());

  const commit = calls.find(({ tool }) => tool.name === 'pact_start_intent').tool;
  assert.deepEqual(commit.annotations, {
    readOnlyHint: false,
    untrustedContentHint: false,
    consequentialHint: true
  });

  const aborted = new AbortController();
  aborted.abort(new Error('cancelled by caller'));
  await assert.rejects(() => commit.execute({}, { signal: aborted.signal }), /WEBMCP_EXECUTION_ABORTED/);
});
