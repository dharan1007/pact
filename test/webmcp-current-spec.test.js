import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactEngine } from '../src/engine.js';
import { createWebMcpRegistry } from '../src/webmcp.js';

function contextHarness() {
  const registrations = [];
  return {
    registrations,
    modelContext: {
      async registerTool(tool, options) { registrations.push({ tool, options }); }
    }
  };
}

test('reference WebMCP registry uses single-input execute callbacks and registration cancellation only', async () => {
  const { registrations, modelContext } = contextHarness();
  const registry = createWebMcpRegistry({ engine: createPactEngine(), modelContext });
  await registry.refresh();
  assert.ok(registrations.length > 0);
  for (const { tool, options } of registrations) {
    assert.equal(tool.execute.length, 1, `${tool.name} execute callback must accept only input`);
    assert.ok(options?.signal instanceof AbortSignal, `${tool.name} registration must carry AbortSignal`);
    assert.deepEqual(Object.keys(tool.annotations).sort(), ['readOnlyHint', 'untrustedContentHint']);
  }

  // The current WebMCP callback contract passes only the input object. Extra
  // arguments from an older host shape must be ignored instead of being treated
  // as a per-execution AbortSignal.
  const inspect = registrations.find(entry => entry.tool.name === 'pact_inspect').tool;
  const obsoleteExecution = new AbortController();
  obsoleteExecution.abort(new Error('obsolete-execute-options'));
  const result = await inspect.execute({}, { signal: obsoleteExecution.signal });
  assert.equal(result.transaction, null);
});
