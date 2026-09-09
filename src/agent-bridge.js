const READ_ONLY = new Set(['pact_inspect','pact_get_transaction_receipt','pact_saga_inspect','pact_saga_get_receipt','pact_saga_recovery_inspect']);
const CONSEQUENTIAL = new Set(['pact_commit_transaction','pact_saga_execute','pact_saga_reconcile','pact_saga_recovery_resolve']);

const CORE_DEFINITIONS = [
  ['pact_inspect','Inspect PACT state','Read transaction and canonical state without mutation','inspect'],
  ['pact_preview_transaction','Preview transaction','Build the exact transaction plan against canonical state','preview'],
  ['pact_approve_transaction','Approve transaction','Submit application-verified human approval evidence for an exact preview','approve'],
  ['pact_commit_transaction','Commit transaction','Commit an approved transaction. Requires an idempotencyKey.','commit'],
  ['pact_verify_transaction','Verify transaction','Verify postconditions against canonical state and persist the verified receipt','verify'],
  ['pact_get_transaction_receipt','Get transaction receipt','Read the verified receipt for a transaction','receipt']
];

const SAGA_DEFINITIONS = [
  ['pact_saga_preview','Preview cross-resource saga','Freeze an ordered multi-resource execution plan before approval','sagaPreview'],
  ['pact_saga_approve','Approve cross-resource saga','Bind one human approval to the exact frozen saga plan','sagaApprove'],
  ['pact_saga_execute','Execute cross-resource saga','Execute an approved saga with durable per-step recovery. Requires an idempotencyKey.','sagaExecute'],
  ['pact_saga_inspect','Inspect cross-resource saga','Read durable saga execution, compensation, and uncertainty state','sagaInspect'],
  ['pact_saga_reconcile','Reconcile uncertain saga','Resolve an uncertain provider outcome under the original approved capability. Requires the original idempotencyKey.','sagaReconcile'],
  ['pact_saga_recovery_inspect','Inspect operator recovery evidence','Read the evidence-bound recovery snapshot for a saga that requires reconciliation','sagaRecoveryInspect'],
  ['pact_saga_recovery_resolve','Resolve operator recovery','Submit human-approved recovery evidence bound to the exact observed recovery snapshot. Requires an idempotencyKey.','sagaRecoveryResolve'],
  ['pact_saga_get_receipt','Get saga receipt','Read the aggregate hash-bound terminal saga receipt','sagaReceipt']
];

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function fail(code) { throw new Error(code); }
function definitionsFor(connector) {
  if (!connector || typeof connector !== 'object') fail('PACT_AGENT_CONNECTOR_REQUIRED');
  for (const [, , , op] of CORE_DEFINITIONS) if (typeof connector[op] !== 'function') fail(`PACT_AGENT_CONNECTOR_OPERATION_REQUIRED:${op}`);
  const sagaMethods = SAGA_DEFINITIONS.map(([, , , op]) => op);
  const sagaCount = sagaMethods.filter(op => typeof connector[op] === 'function').length;
  if (sagaCount !== 0 && sagaCount !== sagaMethods.length) fail('PACT_AGENT_INCOMPLETE_SAGA_CONNECTOR');
  return sagaCount === sagaMethods.length ? [...CORE_DEFINITIONS, ...SAGA_DEFINITIONS] : CORE_DEFINITIONS;
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
  const definitions = definitionsFor(connector);
  const tools = definitions.map(([name, title, description, operation]) => ({
    name,
    title,
    description,
    operation,
    inputSchema: schemaFor(name),
    annotations: {
      readOnlyHint: READ_ONLY.has(name),
      destructiveHint: name === 'pact_commit_transaction' || name === 'pact_saga_execute' || name === 'pact_saga_reconcile' || name === 'pact_saga_recovery_resolve',
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

export async function registerPactWebMcpBridge({ connector, modelContext = globalThis.document?.modelContext }) {
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
          untrustedContentHint: true
        },
        execute: async input => catalog.execute(tool.name, input)
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
