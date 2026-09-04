# PACT agent bridges

PACT's agent bridge exposes the same PACT transaction operations through three surfaces: the HTTPS `/api/pact` connector, browser WebMCP, and MCP servers. The bridge does not execute arbitrary external side effects by itself; it forwards to the configured PACT authority endpoint, so the endpoint remains responsible for authentication, canonical-state transactions, durable journaling, adapter execution and recovery.

## Browser WebMCP

```js
import { createPactHttpConnector } from '/sdk/http.js';
import { registerPactWebMcpBridge } from '/sdk/agent-bridge.js';

const connector = createPactHttpConnector({ baseUrl: 'https://api.example.com' });
const bridge = await registerPactWebMcpBridge({ connector });
// document.modelContext now exposes the PACT transaction tools.
// On teardown:
bridge.dispose();
```

The WebMCP bridge targets the current `document.modelContext.registerTool()` producer surface and uses the registration `AbortSignal` for lifecycle cleanup. Tool callbacks return normal structured JavaScript values. Consequential operations still require an explicit idempotency key.

## MCP server

PACT intentionally does not hand-roll MCP transport framing. Use the current official MCP SDK for Streamable HTTP or stdio and register the PACT catalog into it.

```js
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { createPactHttpConnector } from './sdk/http.js';
import { registerPactMcpBridge } from './sdk/agent-bridge.js';

const connector = createPactHttpConnector({ baseUrl: process.env.PACT_API_ORIGIN });

function makeServer() {
  const server = new McpServer({ name: 'pact', version: '1.0.0' }, { capabilities: { tools: {} } });
  registerPactMcpBridge({
    connector,
    server,
    // Convert PACT's JSON Schema descriptor to the Standard Schema implementation
    // your MCP application uses. This example keeps conversion app-owned.
    schemaFactory: jsonSchema => jsonSchemaToZod(jsonSchema, z)
  });
  return server;
}

export default createMcpHandler(makeServer);
```

For MCP `2026-07-28`, use the official v2 SDK's modern server entry points (`createMcpHandler` for HTTP or `serveStdio` for stdio) rather than implementing the wire protocol yourself. The protocol core is stateless in that revision, but PACT transaction state is application state and must still be durably persisted by the PACT authority service.

## Tool contract

The shared catalog exposes `inspect`, `preview`, `approve`, `commit`, `verify`, `receipt`, `rollback`, and `cancel`. Inputs are wrapped as `{ payload }`; `commit` and `rollback` additionally require `idempotencyKey`. Cancellation propagates to the underlying HTTP connector. MCP results include both text content and `structuredContent`; WebMCP returns the structured JavaScript value directly.

## Real integrations

A real integration should place a domain adapter and durable transaction service behind `/api/pact`, then expose the same service to browser agents through WebMCP and to external agent hosts through MCP. Do not put third-party API credentials in browser WebMCP tools. Keep secrets and consequential external API calls on the authenticated server side, bind approval to the exact PACT plan, and verify the canonical external outcome before issuing a receipt.
