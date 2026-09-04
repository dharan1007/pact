# PACT — Transactional WebMCP

PACT is an experimental trust and transaction layer for consequential browser-agent actions. It binds a human-approved semantic plan to canonical state, commits under short-lived authority, verifies the resulting state, and emits a tamper-evident receipt.

## What is real in this repository

- `src/webmcp.js` — imperative WebMCP bridge targeting the current `document.modelContext` API. It registers state-dependent tools, current security annotations, abort-driven lifecycle cleanup and structured JavaScript results.
- `src/http.js` — reusable HTTPS REST connector for a PACT-compatible `/api/pact` authority endpoint. Commit and rollback fail closed unless the caller supplies a non-empty idempotency key; caller cancellation and connector deadlines are distinct errors.
- `src/adapter.js` — executable adapter contract and defensive declarative-plan validator. Adapters must expose `describe`, `plan` and `verify`; plans are bounded to validated effects and invariants.
- `src/runtime.js` — adapter-driven generic transaction runtime with plan/state binding, verified approval claims, commit verification, rollback conflict checks, receipts and audit events.
- `src/authority.js` — server-side short-lived single-use commit capability primitive. It requires an application-controlled approval verifier and an atomic `get/create/compareAndSwap` store.
- `src/redis-store.js` — production-oriented Redis-compatible HTTPS REST authority store using `SET ... NX` for creation and a Lua compare-and-swap for atomic capability consumption across serverless instances.
- `pact-manifest.json` — machine-readable product, compatibility, adapter, authority and HTTP semantics manifest.
- `schema/pact-manifest.schema.json` — JSON Schema for the product manifest.
- `schema/pact-adapter.schema.json` — JSON Schema for adapter plans.
- `src/engine.js` — deterministic reference transaction engine used by the hosted playground and tests.
- `src/orchestrator.js` — crash-aware begin/approve/commit/verify orchestration around the reference engine.
- `src/persistence.js` — fail-closed browser snapshot persistence with cross-tab concurrency protection.

Important boundary: the generic SDK and durable authority-store primitive are reusable, but the hosted playground is still primarily the Helios reference-domain experience. A complete production deployment must still provide an authenticated canonical `/api/pact` service, durable canonical application state, adapter execution against that state, transaction/idempotency journaling, recovery behavior and operational controls. The Redis authority store makes authority consumption durable; by itself it does not make arbitrary application state transactional.

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
- `/sdk/runtime.js` — generic adapter-driven runtime
- `/sdk/authority.js` — one-shot server authority primitive
- `/sdk/redis-store.js` — durable Redis-compatible authority store

## WebMCP compatibility

PACT targets the experimental imperative WebMCP API surface at `document.modelContext.registerTool()`. Tool definitions use explicit names, titles, descriptions, closed JSON input schemas and the current annotation fields `readOnlyHint` and `untrustedContentHint`. PACT also observes the execution callback `AbortSignal` and owns registration cleanup through an `AbortController`.

PACT does not emit a `consequentialHint` annotation because that field is not part of the current WebMCP annotation dictionary targeted by this repository. Consequential-action protection is enforced by PACT's own transaction/authority layer instead of being represented as a WebMCP guarantee.

Imperative tool callbacks return normal JavaScript values. PACT deliberately does not wrap them in an MCP `content[]` envelope because the current WebMCP draft defines the browser/user agent as the layer that serializes tool execution results.

WebMCP remains experimental and subject to change. Recheck the live Community Group draft before production adoption.

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

## Durable server authority

```js
import { createPactAuthority } from './src/authority.js';
import { createRedisAuthorityStore } from './src/redis-store.js';

const store = createRedisAuthorityStore({
  url: process.env.PACT_REDIS_REST_URL,
  token: process.env.PACT_REDIS_REST_TOKEN
});

const authority = createPactAuthority({
  store,
  verifyApproval: request => verifySignedApproval(request)
});
```

The Redis store requires HTTPS and keeps the bearer token in the authorization header rather than Redis command payloads. Record creation uses `SET NX`; capability consumption uses one Lua compare-and-swap operation so concurrent serverless instances cannot both consume the same record version. Corrupt durable records fail closed. This store is suitable for the PACT authority record contract, but application canonical-state transactions and the full `/api/pact` journal still need their own durable atomic design.

## HTTP connector

```js
import { createPactHttpConnector } from './src/http.js';

const pact = createPactHttpConnector({ baseUrl: 'https://your-app.example' });
const request = new AbortController();
const preview = await pact.preview(
  { intent: { type: 'transfer_owner', projectId: 'helios', newOwner: 'maya' } },
  { signal: request.signal }
);
const transactionId = preview.transactionId ?? preview.transaction?.id;
const committed = await pact.commit({ transactionId }, `commit:${transactionId}`, { signal: request.signal });
const receipt = await pact.verify({ transactionId }, { signal: request.signal });
```

The connector refuses insecure remote HTTP origins; plain HTTP is accepted only for localhost development. `commit` and `rollback` require explicit idempotency keys so network retries cannot silently degrade into ambiguous repeated consequential requests. Caller cancellation raises `PACT_HTTP_ABORTED`; the connector's own deadline raises `PACT_HTTP_TIMEOUT`. The authority endpoint, authentication policy, transaction journal, canonical state store and adapter execution remain application responsibilities until the canonical server service is implemented.

## Verification

```bash
npm run verify
```

The suite covers exact-plan binding, stale-state rejection, lease expiry, preconditions, negative invariants, commit/verify idempotency, receipt integrity, audit-chain tampering, rollback conflicts, fail-closed persistence, cross-tab locking/CAS, WebMCP lifecycle/current imperative contract, HTTP transport safety and cancellation, mandatory consequential idempotency, adapter-contract validation, authority replay semantics, durable Redis create/CAS contention behavior, multi-route asset integrity, and deterministic release generation.
