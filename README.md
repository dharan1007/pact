# PACT — Transactional WebMCP

PACT is an experimental trust and transaction layer for consequential browser-agent actions. It binds a human-approved semantic plan to canonical state, commits under short-lived authority, verifies the resulting state, and emits a tamper-evident receipt.

## What is real in this repository

- `src/webmcp.js` — imperative WebMCP bridge targeting the current `document.modelContext` API. It registers state-dependent tools, current security annotations, abort-driven lifecycle cleanup and structured JavaScript results.
- `src/http.js` — reusable HTTPS REST connector for the canonical PACT `/api/pact` authority endpoint. Consequential commit calls fail closed unless the caller supplies a non-empty idempotency key; caller cancellation and connector deadlines are distinct errors.
- `src/adapter.js` — executable adapter contract and defensive declarative-plan validator. Adapters must expose `describe`, `plan` and `verify`; plans are bounded to validated effects and invariants.
- `src/api-authority.js` — canonical server authority service implementing `preview`, authenticated `approve`, one-shot `commit`, `verify`, `receipt`, and `inspect` semantics over durable transaction state.
- `src/durable-state.js` — journaled durable transaction-state abstraction with persistent replay records, monotonic recovery validation, CAS transitions and fail-closed corrupt-record handling.
- `src/canonical-store.js` — durable canonical application-state repository with atomic version CAS, persistent exact-replay snapshots, stale-write rejection and single-winner concurrency.
- `src/authority.js` — server-side short-lived single-use commit capability primitive bound to transaction, plan, canonical version and identity claims.
- `src/server-approval.js` — HMAC-SHA256 approval verifier binding approval claims to transaction ID, plan hash, base version, adapter, principal, agent session, nonce and expiry.
- `src/redis-store.js` — Redis-compatible HTTPS REST atomic store using `SET ... NX` for creation and Lua compare-and-swap for cross-instance atomicity.
- `src/server-runtime.js` — production composition of the generic adapter, durable authority/journal, canonical store, authenticated approval verifier and HTTP handler.
- `api/pact.js` — Vercel Function entrypoint for the canonical authority service. It fails closed when durable Redis configuration, approval secret or exact release SHA are unavailable.
- `src/playground.js` + `/workspace/` — generic HTTP playground showing request, plan, approval, commit, verification, receipt, protocol errors and durable transaction recovery by ID.
- `pact-manifest.json` — machine-readable product, compatibility, adapter, authority, durability and HTTP semantics manifest.
- `schema/pact-manifest.schema.json` — JSON Schema for the product manifest.
- `schema/pact-adapter.schema.json` — JSON Schema for adapter plans.
- `src/provenance.js` — canonical release-SHA resolver that rejects malformed or conflicting GitHub/Vercel/PACT provenance sources.
- `scripts/build.mjs` — deterministic release builder that emits release provenance and hashes it into the release-integrity manifest.

The repository therefore contains a real reference server-side transaction plane, not only a browser simulation. The included production runtime is intentionally generic: its bundled adapter atomically replaces `document.value` in a canonical `pact-generic-v1` document. Real applications should supply domain-specific adapters and canonical state while preserving the same transaction, approval, replay and verification contract.

## Canonical transaction lifecycle

The server-side reference lifecycle is:

```text
PREVIEWED
  -> APPROVED
  -> COMMIT_AUTHORIZED
  -> COMMITTED
  -> VERIFIED
```

`preview` creates the exact semantic plan against a canonical base version. `approve` accepts only a cryptographically authenticated approval claim and issues transaction-bound single-use commit authority. `commit` requires an idempotency key and atomically writes canonical state. `verify` checks the resulting state against the approved intent/plan. `receipt` returns the verified durable receipt. `inspect` allows durable recovery after client or server interruption.

A crash after canonical write but before journal completion is explicitly recoverable: PACT resumes only when the observed canonical version, effects and invariants match the authorized transaction. Concurrent retries with the same commit key converge on one physical canonical write; competing base-version writers permit one winner.

## Product routes and machine-readable surfaces

- `/` — product thesis and product boundary
- `/demo/` — guided reference transaction
- `/workspace/` — canonical generic `/api/pact` playground with recovery
- `/how-it-works/` — protocol lifecycle
- `/security/` — threat model and enforced invariants
- `/developers/` — SDK, HTTP and WebMCP integration guidance
- `/pact-manifest.json` — machine-readable compatibility manifest
- `/schema/pact-manifest.schema.json` — product manifest schema
- `/schema/pact-adapter.schema.json` — adapter plan schema
- `/adapter.bundle.js` — browser-consumable adapter contract/validator
- `/http.bundle.js` — browser-consumable REST connector
- `/sdk/runtime.js` — generic adapter-driven runtime
- `/sdk/api-authority.js` — canonical server authority service
- `/sdk/http-handler.js` — canonical HTTP request handler
- `/sdk/server-runtime.js` — production server runtime composition
- `/sdk/server-approval.js` — authenticated approval verifier
- `/sdk/durable-state.js` — durable transaction/journal store
- `/sdk/canonical-store.js` — durable canonical state repository
- `/sdk/authority.js` — one-shot authority primitive
- `/sdk/redis-store.js` — Redis-compatible atomic store
- `/sdk/provenance.js` — release provenance resolver
- `/release-provenance.json` — generated source provenance for the built artifact

## WebMCP compatibility

PACT targets the experimental imperative WebMCP API surface at `document.modelContext.registerTool()`. Tool definitions use explicit names, titles, descriptions, closed JSON input schemas and the current annotation fields `readOnlyHint` and `untrustedContentHint`. PACT also observes the execution callback `AbortSignal` and owns registration cleanup through an `AbortController`.

PACT does not emit a `consequentialHint` annotation because that field is not part of the current WebMCP annotation dictionary targeted by this repository. Consequential-action protection is enforced by PACT's own transaction/authority layer instead of being represented as a WebMCP guarantee.

Imperative tool callbacks return normal JavaScript values. PACT deliberately does not wrap them in an MCP `content[]` envelope because the current WebMCP draft defines the browser/user agent as the layer that serializes tool execution results.

WebMCP remains an experimental Community Group draft and is subject to change. Recheck the live draft before production adoption.

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

## Canonical HTTP connector

```js
import { createPactHttpConnector } from './src/http.js';

const pact = createPactHttpConnector({ baseUrl: 'https://your-app.example' });
const request = new AbortController();

const preview = await pact.preview({
  adapterId: 'pact.generic',
  intent: { value: { project: 'helios', owner: 'maya' } }
}, { signal: request.signal });

const transactionId = preview.transactionId ?? preview.transaction?.id;

// Approval must be produced by your trusted approval/authentication boundary.
const approved = await pact.approve({
  transactionId,
  approval: signedApprovalClaim
}, { signal: request.signal });

const committed = await pact.commit(
  { transactionId, capability: approved.capability },
  `commit:${transactionId}`,
  { signal: request.signal }
);

const verified = await pact.verify({ transactionId }, { signal: request.signal });
const receipt = await pact.receipt({ transactionId }, { signal: request.signal });
```

The canonical HTTP surface is exactly `inspect`, `preview`, `approve`, `commit`, `verify`, and `receipt`. The connector refuses insecure remote HTTP origins; plain HTTP is accepted only for localhost development. `commit` requires an explicit idempotency key so retries cannot silently degrade into ambiguous repeated consequential requests. Caller cancellation raises `PACT_HTTP_ABORTED`; the connector's own deadline raises `PACT_HTTP_TIMEOUT`.

## Production server configuration

The Vercel Function runtime intentionally fails closed unless all production authority prerequisites are present:

```text
UPSTASH_REDIS_REST_URL   HTTPS Redis REST endpoint
UPSTASH_REDIS_REST_TOKEN Redis REST bearer token
PACT_APPROVAL_SECRET     strong server-only approval HMAC secret
VERCEL_GIT_COMMIT_SHA    exact 40-hex source SHA supplied by Git-linked Vercel deployment
```

`PACT_SOURCE_COMMIT` and `GITHUB_SHA` are also recognized provenance sources. If more than one source is present they must all resolve to the same exact SHA; disagreement fails the build/runtime closed.

`vercel.json` runs `npm run build`, publishes `dist`, and retains `api/pact.js` as the serverless Function. Do not deploy a locally copied artifact without an exact source SHA. A production release should be accepted only when the live `/release-provenance.json` and `x-pact-release` API header both match the intended Git commit.

## Security and durability properties covered by tests

The verification suite exercises, among other cases:

- exact plan/canonical-version binding
- cryptographically authenticated approval claims
- transaction/plan/version/identity-bound one-shot capabilities
- persistent idempotency and exact replay
- same-key/different-payload replay rejection
- canonical CAS and single-winner concurrency
- crash recovery after canonical write before journal completion
- stale state rejection
- approval expiry and malformed/forged approval rejection
- corrupt/non-monotonic durable-record rejection
- receipt and audit integrity
- HTTP method/media-type/error/header behavior
- HTTPS-only remote connector behavior
- cancellation vs timeout distinction
- current imperative WebMCP registration and cancellation contract
- generic playground durable recovery by transaction ID
- release packaging and deterministic provenance hashing
- malformed/conflicting source-SHA rejection
- Vercel `dist` + `/api/pact` release contract

These tests establish the behavior of the checked-in implementation. They are not a substitute for live production verification of the configured Redis provider, secret management, Vercel deployment identity, network behavior, or operational limits.

## Verification

```bash
npm run verify
```

The release gate runs the Node test suite, JavaScript syntax checks, the deterministic production build, release contract assertions and generated bundle syntax validation.
