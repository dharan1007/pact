import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactEngine } from '../src/engine.js';
import { createWebMcpRegistry, toWebMcpResult } from '../src/webmcp.js';

test('WebMCP execute results preserve structured JavaScript values for user-agent serialization', () => {
  const out = toWebMcpResult({ state: 'PREVIEWED', txId: 'tx_1' });
  assert.deepEqual(out, { state: 'PREVIEWED', txId: 'tx_1' });
});

test('registered tools expose only current WebMCP annotations and registration cancellation options', async () => {
  const idleEngine = createPactEngine();
  const idleCalls = [];
  const modelContext = { registerTool(tool, options) { idleCalls.push({ tool, options }); } };
  const idleRegistry = createWebMcpRegistry({ engine: idleEngine, modelContext });
  await idleRegistry.refresh();

  const inspectRegistration = idleCalls.find(({ tool }) => tool.name === 'pact_inspect');
  const inspect = inspectRegistration.tool;
  assert.equal(typeof inspect.title, 'string');
  assert(inspect.title.length > 0);
  assert.equal(typeof inspect.description, 'string');
  assert(inspect.description.length > 20);
  assert.deepEqual(inspect.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.deepEqual(inspect.annotations, {
    readOnlyHint: true,
    untrustedContentHint: false
  });
  assert.ok(inspectRegistration.options.signal instanceof AbortSignal);
  assert.deepEqual(await inspect.execute({}), idleEngine.inspect());

  const startRegistration = idleCalls.find(({ tool }) => tool.name === 'pact_start_intent');
  const start = startRegistration.tool;
  assert.deepEqual(start.annotations, {
    readOnlyHint: false,
    untrustedContentHint: false
  });
  assert.ok(startRegistration.options.signal instanceof AbortSignal);

  // The current ToolExecuteCallback receives only the input object. Hosts that
  // still pass an obsolete second argument must not turn it into an execution
  // cancellation channel.
  const obsoleteExecution = new AbortController();
  obsoleteExecution.abort(new Error('obsolete execute option'));
  const started = await start.execute({}, { signal: obsoleteExecution.signal });
  assert.equal(started.state, 'DRAFT');

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
  const commitRegistration = approvedCalls.find(({ tool }) => tool.name === 'pact_commit_transaction');
  const commit = commitRegistration.tool;
  assert.deepEqual(commit.annotations, {
    readOnlyHint: false,
    untrustedContentHint: false
  });
  assert.ok(commitRegistration.options.signal instanceof AbortSignal);
});
