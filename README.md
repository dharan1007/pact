# PACT — Transactional WebMCP

PACT is an experimental trust and transaction layer for consequential browser-agent actions. It binds a human-approved semantic plan to canonical state, commits under short-lived authority, verifies the resulting state, and emits a tamper-evident receipt.

## What is real in this repository

- `src/webmcp.js` — imperative WebMCP bridge targeting the current `document.modelContext` API. It registers state-dependent tools, current security annotations, abort-driven lifecycle cleanup and structured JavaScript results.
- `src/http.js` — reusable HTTPS REST connector for a PACT-compatible `/api/pact` authority endpoint. Commit and rollback fail closed unless the caller supplies a non-empty idempotency key.
- `src/adapter.js` — executable adapter contract and defensive declarative-plan validator. Adapters must expose `describe`, `plan` and `verify`; plans are bounded to validated effects and invariants.
- `pact-manifest.json` — machine-readable product, compatibility, adapter and HTTP semantics manifest.
- `schema/pact-manifest.schema.json` — JSON Schema for the product manifest.
- `schema/pact-adapter.schema.json` — JSON Schema for adapter plans.
- `src/engine.js` — deterministic reference transaction engine used by the hosted playground and tests.
- `src/orchestrator.js` — crash-aware begin/approve/commit/verify orchestration around the reference engine.
- `src/persistence.js` — fail-closed browser snapshot persistence with cross-tab concurrency protection.

Important boundary: `src/adapter.js` is reusable and validates third-party adapter plans, but the bundled `src/engine.js` is still a reference-domain implementation. The hosted playground therefore demonstrates PACT semantics rather than mutating arbitrary external systems. A production deployment must provide an authenticated `/api/pact` authority endpoint, durable canonical state and an engine/runtime that invokes the chosen adapter end-to-end.

## Product routes and machine-readable surfaces

- `/` — product thesis and product boundary
- `/demo/` — guided reference transaction
- `/workspace/` — live reference playground with exact transaction state and audit data
- `/how-it-works/` — protocol lifecycle
- `/security/` — threat model and enforced invariants
- `/developers/` — WebMCP and integration guidance
- `/pact-manifest.json` — machine-readable compatibility manifest
- `/schema/pact-manifest.schema.json` — product manifest schema
- `/schema/pact-adapter.schema.json` — adapter plan schema
- `/adapter.bundle.js` — browser-consumable adapter contract/validator
- `/http.bundle.js` — browser-consumable REST connector

## WebMCP compatibility

PACT targets the experimental imperative WebMCP API surface at `document.modelContext.registerTool()`. Tool definitions include explicit names, titles, descriptions, closed JSON input schemas, `readOnlyHint`, `untrustedContentHint`, and `consequentialHint` annotations, registration lifecycle cancellation through `AbortController`, and execution cancellation checks using the callback `AbortSignal`.

Imperative tool callbacks return normal JavaScript values. PACT deliberately does not wrap them in an MCP `content[]` envelope because the current WebMCP draft defines the browser/user agent as the layer that serializes tool execution results.

WebMCP remains experimental and subject to change. The compatibility target used for this repository is the WebMCP Community Group draft published 26 August 2026; recheck the live draft before production adoption.

## Adapter contract

```js
import { definePactAdapter } from './src/adapter.js';

const adapter = definePactAdapter({
  id: 'projects.v1',
  version: '1.0.0',
  describe() {
    return { name: 'Project ownership', operations: ['transfer_owner'] };
  },
  async plan({ intent, state }) {
    return {
      effects: [{
        path: `projects.${intent.projectId}.owner`,
        before: state.projects[intent.projectId].owner,
        after: intent.newOwner
      }],
      invariants: [{ path: 'billing.plan', equals: state.billing.plan }]
    };
  },
  async verify({ state, plan }) {
    return plan.effects.every(effect =>
      effect.path.split('.').reduce((node, key) => node?.[key], state) === effect.after
    );
  }
});
```

The validator rejects unsafe prototype-related paths, duplicate effect paths, non-JSON values and unbounded effect/invariant sets before a plan can be accepted as an adapter plan.

## HTTP connector

```js
import { createPactHttpConnector } from './src/http.js';

const pact = createPactHttpConnector({ baseUrl: 'https://your-app.example' });
const preview = await pact.preview({ intent: { type: 'transfer_owner', projectId: 'helios', newOwner: 'maya' } });
const transactionId = preview.transactionId ?? preview.transaction?.id;
const committed = await pact.commit({ transactionId }, `commit:${transactionId}`);
const receipt = await pact.verify({ transactionId });
```

The connector refuses insecure remote HTTP origins; plain HTTP is accepted only for localhost development. `commit` and `rollback` require explicit idempotency keys so network retries cannot silently degrade into ambiguous repeated consequential requests. The authority endpoint, authentication policy, replay ledger, canonical state store and adapter execution remain application responsibilities.

## Verification

```bash
npm run verify
```

The suite covers exact-plan binding, stale-state rejection, lease expiry, preconditions, negative invariants, commit/verify idempotency, receipt integrity, audit-chain tampering, rollback conflicts, fail-closed persistence, cross-tab locking/CAS, WebMCP lifecycle/current imperative contract, HTTP transport safety, mandatory consequential idempotency, adapter-contract validation, multi-route asset integrity, and deterministic release generation.
