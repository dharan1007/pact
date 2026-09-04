import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactEngine } from '../src/engine.js';
import { createWebMcpRegistry, toWebMcpResult } from '../src/webmcp.js';

test('WebMCP execute results preserve structured JavaScript values for user-agent serialization', () => {
  const out = toWebMcpResult({ state: 'PREVIEWED', txId: 'tx_1' });
  assert.deepEqual(out, { state: 'PREVIEWED', txId: 'tx_1' });
});

test('registered tools expose only current WebMCP annotations and execution cancellation options', async () => {
  const idleEngine = createPactEngine();
  const idleCalls = [];
  const modelContext = { registerTool(tool, options) { idleCalls.push({ tool, options }); } };
  const idleRegistry = createWebMcpRegistry({ engine: idleEngine, modelContext });
  await idleRegistry.refresh();

  const inspect = idleCalls.find(({ tool }) => tool.name === 'pact_inspect').tool;
  assert.equal(typeof inspect.title, 'string');
  assert(inspect.title.length > 0);
  assert.equal(typeof inspect.description, 'string');
  assert(inspect.description.length > 20);
  assert.deepEqual(inspect.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.deepEqual(inspect.annotations, {
    readOnlyHint: true,
    untrustedContentHint: false
  });
  assert.deepEqual(await inspect.execute({}, { signal: new AbortController().signal }), idleEngine.inspect());

  const start = idleCalls.find(({ tool }) => tool.name === 'pact_start_intent').tool;
  assert.deepEqual(start.annotations, {
    readOnlyHint: false,
    untrustedContentHint: false
  });

  const aborted = new AbortController();
  aborted.abort(new Error('cancelled by caller'));
  await assert.rejects(() => start.execute({}, { signal: aborted.signal }), /WEBMCP_EXECUTION_ABORTED/);

  const approvedEngine = createPactEngine();
  approvedEngine.startIntent();
  await approvedEngine.preview();
  await approvedEngine.approve({ trusted: true });
  const approvedCalls = [];
  const approvedRegistry = createWebMcpRegistry({
    engine: approvedEngine,
    modelContext: { registerTool(tool, options) { approvedCalls.push({ tool, options }); } }
  });
  await approvedRegistry.refresh();
  const commit = approvedCalls.find(({ tool }) => tool.name === 'pact_commit_transaction').tool;
  assert.deepEqual(commit.annotations, {
    readOnlyHint: false,
    untrustedContentHint: false
  });
});
