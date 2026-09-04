# PACT — Transactional WebMCP

PACT is an experimental trust and transaction layer for consequential browser-agent actions. It binds a human-approved semantic plan to canonical state, commits under short-lived authority, verifies the resulting state, and emits a tamper-evident receipt.

## What is real in this repository

- `src/webmcp.js` — WebMCP bridge. It registers state-dependent tools on `document.modelContext` when available, with a legacy `navigator.modelContext` fallback, and returns MCP-shaped `content` results.
- `src/http.js` — reusable HTTPS REST connector for a PACT-compatible `/api/pact` authority endpoint. It provides operation envelopes, credential forwarding, timeouts, structured errors and idempotency-key support for commit/rollback calls.
- `pact-manifest.json` — machine-readable product/compatibility manifest.
- `schema/pact-manifest.schema.json` — JSON Schema for the manifest.
- `src/engine.js` — deterministic reference transaction engine used by the hosted playground and tests.
- `src/orchestrator.js` — crash-aware begin/approve/commit/verify orchestration around the reference engine.
- `src/persistence.js` — fail-closed browser snapshot persistence with cross-tab concurrency protection.

Important boundary: the bundled `src/engine.js` is a reference-domain implementation, not yet a generic production adapter runtime. The HTTP connector is reusable, but a real deployment must provide its own authenticated `/api/pact` authority endpoint and durable canonical-state adapter. PACT does not claim that the static hosted playground mutates arbitrary third-party systems.

## Product routes

- `/` — product thesis and product boundary
- `/demo/` — guided reference transaction
- `/workspace/` — live reference playground with exact transaction state and audit data
- `/how-it-works/` — protocol lifecycle
- `/security/` — threat model and enforced invariants
- `/developers/` — WebMCP and integration guidance
- `/pact-manifest.json` — machine-readable compatibility manifest
- `/schema/pact-manifest.schema.json` — manifest schema

## WebMCP compatibility

PACT follows the current experimental WebMCP direction by preferring `document.modelContext.registerTool()` and falling back to `navigator.modelContext` for implementations that still expose the earlier host. Tools are registered with explicit names, titles, descriptions, closed JSON input schemas, read-only annotations, abort-signal lifecycle management and MCP-compatible `content` results.

WebMCP is still experimental. PACT therefore feature-detects the API and does not present browser support as universal or stable.

## HTTP connector

```js
import { createPactHttpConnector } from './src/http.js';

const pact = createPactHttpConnector({
  baseUrl: 'https://your-app.example'
});

const preview = await pact.preview({ intent: { type: 'transfer_owner', projectId: 'helios', newOwner: 'maya' } });
const committed = await pact.commit({ transactionId: preview.transactionId }, preview.transactionId);
const receipt = await pact.verify({ transactionId: preview.transactionId });
```

The connector intentionally refuses insecure remote HTTP origins; plain HTTP is accepted only for localhost development. The authority endpoint, authentication policy, canonical state store and adapter implementation remain application responsibilities.

## Verification

```bash
npm run verify
```

The suite covers exact-plan binding, stale-state rejection, lease expiry, preconditions, negative invariants, commit/verify idempotency, receipt integrity, audit-chain tampering, rollback conflicts, fail-closed persistence, cross-tab locking/CAS, WebMCP lifecycle, current tool-result contract, HTTP connector safety/semantics, multi-route asset integrity, and deterministic release generation.
