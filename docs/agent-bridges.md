# PACT agent bridges

PACT exposes one transaction contract through ordinary HTTPS, browser WebMCP, and MCP servers. The caller changes, but the authority lifecycle does not: read canonical state, preview the exact plan, verify human authority, commit under state and idempotency constraints, re-read the real outcome, and emit a receipt.

## Real provider execution

Use `createPactExternalRuntime()` when the canonical state belongs to another service rather than to PACT's in-memory reference engine. A real integration implements `read`, `plan`, `apply`, and `verify`.

For REST/OpenAPI-style systems, `createPactRestIntegration()` supplies the transport boundary:

```js
import { createPactExternalRuntime } from '../sdk/runtime.js';
import { createPactRestIntegration } from '../sdk/http.js';

const integration = createPactRestIntegration({
  id: 'acme.projects',
  version: '1.0.0',
  baseUrl: 'https://api.example.com',
  headers: { authorization: `Bearer ${process.env.PROVIDER_TOKEN}` },
  resourcePath: ({ intent }) => `/projects/${intent.projectId}`,
  plan: async ({ intent, state }) => ({
    effects: [{
      path: 'project.owner',
      before: state.project.owner,
      after: intent.newOwner
    }],
    invariants: [{ path: 'project.plan', equals: state.project.plan }]
  }),
  buildApply: ({ plan }) => ({
    method: 'PATCH',
    body: { owner: plan.effects[0].after }
  }),
  verify: async ({ state, plan }) => state.project.owner === plan.effects[0].after
});

const pact = createPactExternalRuntime({
  integration,
  verifyApproval: request => verifySignedApproval(request)
});
```

The REST integration requires HTTPS outside localhost, only resolves same-origin resource paths, reads a remote revision from `ETag` (or an application-provided revision mapper), sends that revision as `If-Match`, and propagates the PACT idempotency key to the provider. Keep provider credentials server-side. Do not put third-party bearer tokens, database credentials, signing keys, or other secrets in browser WebMCP code.

The external runtime checks the provider revision immediately before `apply()`. If the provider may have committed but the response is lost, the transaction becomes `COMMIT_UNCERTAIN`; PACT can then re-read and verify the real remote outcome instead of blindly issuing another effect.

## Browser WebMCP

```js
import { createPactHttpConnector } from '/sdk/http.js';
import { registerPactWebMcpBridge } from '/sdk/agent-bridge.js';

const connector = createPactHttpConnector({ baseUrl: 'https://api.example.com' });
const bridge = await registerPactWebMcpBridge({ connector });
// document.modelContext now exposes the PACT transaction tools.
// Remote/provider output is untrustedContentHint: true by default.

bridge.dispose();
```

The WebMCP bridge targets the current `document.modelContext.registerTool()` producer surface and uses the registration `AbortSignal` for lifecycle cleanup. Tool callbacks return structured JavaScript values. Consequential operations still require an explicit idempotency key. Because remote systems can contain user-generated or adversarial data, the bridge marks output as untrusted by default; set `untrustedContentHint: false` only when the application can genuinely guarantee that backend output is trusted.

## MCP server

PACT intentionally does not hand-roll MCP transport framing. Use the official current MCP SDK for Streamable HTTP or stdio and register the same PACT catalog into it.

```js
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { createPactHttpConnector } from './sdk/http.js';
import { registerPactMcpBridge } from './sdk/agent-bridge.js';

const connector = createPactHttpConnector({ baseUrl: process.env.PACT_API_ORIGIN });

function makeServer() {
  const server = new McpServer({ name: 'pact', version: '1.0.0' }, { capabilities: { tools: {} } });
  registerPactMcpBridge({
    connector,
    server,
    schemaFactory: jsonSchema => jsonSchemaToStandardSchema(jsonSchema)
  });
  return server;
}

export default createMcpHandler(makeServer);
```

For MCP `2026-07-28`, use the official v2 SDK's modern server entry points rather than implementing the wire protocol yourself. The protocol core is stateless in that revision, but PACT transaction state is application state and still needs durable persistence in the PACT authority service.

## Shared tool contract

The catalog exposes `inspect`, `preview`, `approve`, `commit`, `verify`, `receipt`, `rollback`, and `cancel`. Inputs are wrapped as `{ payload }`; `commit` and `rollback` additionally require `idempotencyKey`. Cancellation propagates to the underlying HTTPS connector. MCP results include both text content and `structuredContent`; WebMCP returns the structured JavaScript value directly.

The MCP annotations describe read-only, destructive, idempotent and open-world behavior to compatible hosts. The WebMCP bridge only emits annotation fields supported by the current WebMCP draft.

## Architecture

```text
Browser / WebMCP agent ─┐
MCP agent host ─────────┼─> PACT HTTPS transaction service
CLI / app / backend ────┘          │
                                   ├─ approval verifier
                                   ├─ durable authority + journal
                                   └─ real integration
                                       ├─ REST / OpenAPI
                                       ├─ SaaS API
                                       ├─ internal service
                                       ├─ database gateway
                                       └─ upstream MCP-backed action
```

The agent never receives ambient provider credentials. It receives transaction tools. The server owns secrets, approval verification, replay protection and consequential writes. PACT verifies the external result before issuing a receipt.
