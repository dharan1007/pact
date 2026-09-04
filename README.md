# PACT — Transactional WebMCP

PACT is an experimental trust and transaction layer for consequential browser-agent actions. It binds a human-approved semantic plan to canonical state, commits under short-lived authority, verifies the resulting state, and emits a tamper-evident receipt.

## What is real in this repository

- `src/webmcp.js` — imperative WebMCP bridge. It registers state-dependent tools on the current `document.modelContext` surface, exposes current WebMCP tool annotations, and preserves structured JavaScript results for user-agent serialization.
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

PACT targets the current experimental imperative WebMCP API surface at `document.modelContext.registerTool()`. Tool definitions include explicit names, titles, descriptions, closed JSON input schemas, current `readOnlyHint`, `untrustedContentHint`, and `consequentialHint` annotations, registration lifecycle cancellation through `AbortController`, and execution cancellation checks using the callback `AbortSignal`.

Imperative tool callbacks return normal JavaScript values. PACT deliberately does not wrap them in an MCP `content[]` envelope because the current WebMCP draft defines the browser/user agent as the layer that serializes tool execution results.

WebMCP remains experimental and subject to change. PACT therefore feature-detects the API and does not present browser support as universal or stable. The compatibility target used for this repository is the WebMCP Community Group draft published 26 August 2026; the live draft should be rechecked before production adoption.

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

The suite covers exact-plan binding, stale-state rejection, lease expiry, preconditions, negative invariants, commit/verify idempotency, receipt integrity, audit-chain tampering, rollback conflicts, fail-closed persistence, cross-tab locking/CAS, WebMCP lifecycle and current imperative contract, HTTP connector safety/semantics, multi-route asset integrity, and deterministic release generation.
