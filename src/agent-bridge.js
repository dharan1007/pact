const READ_ONLY = new Set(['pact_inspect','pact_get_transaction_receipt']);
const CONSEQUENTIAL = new Set(['pact_commit_transaction','pact_rollback_transaction']);

const DEFINITIONS = [
  ['pact_inspect','Inspect PACT state','Read transaction and canonical state without mutation','inspect'],
  ['pact_preview_transaction','Preview transaction','Build the exact transaction plan against canonical state','preview'],
  ['pact_approve_transaction','Approve transaction','Submit application-verified human approval evidence for an exact preview','approve'],
  ['pact_commit_transaction','Commit transaction','Commit an approved transaction. Requires an idempotencyKey.','commit'],
  ['pact_verify_transaction','Verify transaction','Verify postconditions and return the transaction receipt','verify'],
  ['pact_get_transaction_receipt','Get transaction receipt','Read the verified receipt for a transaction','receipt'],
  ['pact_rollback_transaction','Rollback transaction','Rollback a verified transaction. Requires an idempotencyKey.','rollback'],
  ['pact_cancel_transaction','Cancel transaction','Cancel a transaction before commit','cancel']
];

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function fail(code) { throw new Error(code); }
function assertConnector(connector) {
  if (!connector || typeof connector !== 'object') fail('PACT_AGENT_CONNECTOR_REQUIRED');
  for (const [, , , op] of DEFINITIONS) if (typeof connector[op] !== 'function') fail(`PACT_AGENT_CONNECTOR_OPERATION_REQUIRED:${op}`);
}
function schemaFor(name) {
  const properties = { payload: { type: 'object', additionalProperties: true } };
  const required = ['payload'];
  if (CONSEQUENTIAL.has(name)) {
    properties.idempotencyKey = { type: 'string', minLength: 1, maxLength: 256 };
    required.push('idempotencyKey');
  }
  return { type: 'object', properties, required, additionalProperties: false };
}
function resultForMcp(value) {
  const structuredContent = clone(value);
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent
  };
}

export function createPactAgentToolCatalog({ connector }) {
  assertConnector(connector);
  const tools = DEFINITIONS.map(([name, title, description, operation]) => ({
    name,
    title,
    description,
    operation,
    inputSchema: schemaFor(name),
    annotations: {
      readOnlyHint: READ_ONLY.has(name),
      destructiveHint: name === 'pact_rollback_transaction',
      idempotentHint: CONSEQUENTIAL.has(name),
      openWorldHint: true
    }
  }));
  const byName = new Map(tools.map(tool => [tool.name, tool]));

  async function execute(name, input = {}, options = {}) {
    const tool = byName.get(name);
    if (!tool) fail('PACT_AGENT_UNKNOWN_TOOL');
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('PACT_AGENT_INVALID_INPUT');
    if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) fail('PACT_AGENT_PAYLOAD_REQUIRED');
    if (options.signal?.aborted) throw new Error('PACT_AGENT_ABORTED', { cause: options.signal.reason });
    const requestOptions = { signal: options.signal };
    if (CONSEQUENTIAL.has(name)) {
      const key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
      if (!key) fail('PACT_AGENT_IDEMPOTENCY_KEY_REQUIRED');
      return clone(await connector[tool.operation](clone(input.payload), key, requestOptions));
    }
    return clone(await connector[tool.operation](clone(input.payload), requestOptions));
  }

  return { tools: () => clone(tools), execute };
}

export async function registerPactWebMcpBridge({
  connector,
  modelContext = globalThis.document?.modelContext,
  untrustedContentHint = true
}) {
  if (typeof untrustedContentHint !== 'boolean') fail('PACT_AGENT_INVALID_UNTRUSTED_CONTENT_HINT');
  const catalog = createPactAgentToolCatalog({ connector });
  if (!modelContext?.registerTool) return { supported: false, names: [], dispose() {} };
  const controller = new AbortController();
  const names = [];
  try {
    for (const tool of catalog.tools()) {
      await modelContext.registerTool({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.annotations.readOnlyHint,
          untrustedContentHint
        },
        execute: async (input, ctx = {}) => catalog.execute(tool.name, input, { signal: ctx.signal })
      }, { signal: controller.signal });
      names.push(tool.name);
    }
  } catch (cause) {
    controller.abort();
    throw new Error('PACT_AGENT_WEBMCP_REGISTRATION_FAILED', { cause });
  }
  return { supported: true, names, dispose: () => controller.abort() };
}

export function registerPactMcpBridge({ connector, server, schemaFactory }) {
  if (!server?.registerTool) fail('PACT_AGENT_MCP_SERVER_REQUIRED');
  if (typeof schemaFactory !== 'function') fail('PACT_AGENT_MCP_SCHEMA_FACTORY_REQUIRED');
  const catalog = createPactAgentToolCatalog({ connector });
  const registrations = [];
  for (const tool of catalog.tools()) {
    const inputSchema = schemaFactory(clone(tool.inputSchema));
    const registration = server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema,
      annotations: clone(tool.annotations)
    }, async (input, ctx = {}) => resultForMcp(await catalog.execute(tool.name, input, { signal: ctx.signal })));
    registrations.push(registration);
  }
  return { names: catalog.tools().map(tool => tool.name), registrations };
}
