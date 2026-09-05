# PACT — Transactional WebMCP

PACT is an experimental trust and transaction layer for consequential agent actions. It binds a human-approved semantic plan to canonical state, commits under short-lived authority, verifies the resulting state, and emits a tamper-evident receipt. The same authority can sit behind ordinary HTTPS clients, MCP hosts, or browser WebMCP tools.

## What is real in this repository

- `src/webmcp.js` — imperative WebMCP bridge targeting `document.modelContext`, with state-dependent tools, current security annotations, abort-driven cleanup and structured JavaScript results.
- `src/agent-bridge.js` — shared agent-tool catalog for HTTP, WebMCP and MCP surfaces.
- `src/http.js` — reusable HTTPS connector for the canonical PACT `/api/pact` authority endpoint. Commit fails closed without an idempotency key; caller cancellation and connector deadlines are distinct errors.
- `src/adapter.js` — executable adapter contract and defensive declarative-plan validator.
- `src/api-authority.js` — canonical durable server authority implementing `preview`, authenticated `approve`, one-shot `commit`, `verify`, `receipt`, and `inspect`.
- `src/durable-state.js` — journaled durable transaction state with persistent replay records, CAS transitions and crash-recovery validation.
- `src/canonical-store.js` — durable internal canonical application-state repository with atomic version CAS and exact replay snapshots.
- `src/rest-resource.js` — real REST-provider canonical bridge. It binds PACT state to provider `ETag` revisions, commits with `If-Match` plus `Idempotency-Key`, detects out-of-band provider drift, and supports exact lost-response recovery when the real provider state can be proven.
- `src/authority.js` — short-lived single-use commit capability bound to transaction, plan, canonical version and verified identity claims.
- `src/server-approval.js` — HMAC-SHA256 approval verifier binding claims to transaction ID, plan hash, base version, adapter, principal, agent session, nonce and expiry.
- `src/redis-store.js` — Redis-compatible HTTPS REST atomic store using create-if-absent and Lua compare-and-swap.
- `src/server-runtime.js` — production composition layer. It supports the built-in generic canonical document and an official `rest-json` mode for real JSON REST resources.
- `api/pact.js` — Vercel Function entrypoint. It fails closed when durable storage, approval secret or exact release provenance are unavailable.
- `src/playground.js` + `/workspace/` — canonical HTTP playground showing request, plan, approval, commit, verification, receipt, errors and durable recovery by transaction ID.
- `pact-manifest.json` + `schema/pact-manifest.schema.json` — machine-readable product contract and schema, now checked against each other by CI.
- `src/provenance.js` + `scripts/build.mjs` — deterministic release provenance and integrity hashing.

PACT therefore contains a real server-side transaction plane rather than only a browser simulation. The default `generic` runtime remains useful for the playground and integration testing. For real systems, use a domain adapter and canonical bridge; the shipped `rest-json` mode is the first production-oriented bridge for JSON REST resources.

## Canonical transaction lifecycle

```text
PREVIEWED
  -> APPROVED
  -> COMMIT_AUTHORIZED
  -> COMMITTED
  -> VERIFIED
```

`preview` creates the exact semantic plan against a canonical base version. `approve` accepts only an authenticated approval claim and issues transaction-bound single-use commit authority. `commit` requires an idempotency key and writes canonical state. `verify` checks the resulting real state against the approved plan. `receipt` returns the verified durable receipt. `inspect` supports recovery after client or server interruption.

A crash after canonical write but before transaction-journal completion is explicitly recoverable when PACT can prove the observed state matches the authorized transaction. Concurrent retries with the same commit key converge on one durable authorization path; competing base-version writers permit one winner.

## Real REST provider mode

The official `/api/pact` runtime can bind a transaction directly to a real JSON REST resource:

```text
PACT_RUNTIME_MODE=rest-json
PACT_REST_BASE_URL=https://api.example.com
PACT_REST_RESOURCE_PATH=/v1/accounts/42
PACT_REST_RESOURCE_KEY=provider:account-42
PACT_REST_ADAPTER_ID=provider.account
PACT_REST_ADAPTER_VERSION=1.0.0          # optional
PACT_REST_METHOD=PUT                     # PUT or PATCH; optional
PACT_REST_BEARER_TOKEN=...               # optional, server-only
```

The provider must return a representation-specific `ETag` on successful reads and writes. PACT records that revision and sends the consequential write with `If-Match`; a provider change outside PACT makes an already-approved plan stale before mutation. The internal consumed authorization ID is sent as `Idempotency-Key`.

A network failure after a provider may have applied the write is treated as `PACT_REST_COMMIT_UNCERTAIN`, not silently retried. A later read/retry can recover only when the provider's new ETag and JSON object exactly match the intended result. PACT does **not** claim universal exactly-once behavior if a third-party provider ignores conditional writes or idempotency.

Provider credentials stay server-side. The REST bridge rejects insecure remote HTTP origins, cross-origin resource configuration, missing ETags, ETag reuse for a different representation, stale conditional writes, and mismatched provider postconditions.

See `docs/rest-provider.md` for the integration contract.

## Product routes and machine-readable surfaces

- `/` — product thesis and product boundary
- `/demo/` — guided reference transaction
- `/workspace/` — canonical `/api/pact` playground with recovery
- `/how-it-works/` — protocol lifecycle
- `/security/` — threat model and enforced invariants
- `/developers/` — SDK, real-provider, HTTP, WebMCP and agent integration guidance
- `/pact-manifest.json` — machine-readable compatibility manifest
- `/schema/pact-manifest.schema.json` — product manifest schema
- `/schema/pact-adapter.schema.json` — adapter plan schema
- `/sdk/runtime.js` — adapter-driven runtime
- `/sdk/api-authority.js` — canonical server authority
- `/sdk/http-handler.js` — canonical HTTP handler
- `/sdk/server-runtime.js` — server runtime composition
- `/sdk/rest-resource.js` — real REST provider canonical bridge and JSON-resource adapter
- `/sdk/server-approval.js` — authenticated approval verifier
- `/sdk/durable-state.js` — durable transaction/journal state
- `/sdk/canonical-store.js` — internal canonical state repository
- `/sdk/authority.js` — one-shot authority primitive
- `/sdk/redis-store.js` — Redis-compatible atomic store
- `/sdk/agent-bridge.js` — HTTP/WebMCP/MCP shared tool bridge
- `/sdk/provenance.js` — release provenance resolver
- `/docs/rest-provider.md` — real provider integration guide
- `/release-provenance.json` — generated source provenance for the built artifact

## WebMCP compatibility

PACT targets the experimental imperative WebMCP API at `document.modelContext.registerTool()`. Tool definitions use explicit names, titles, descriptions, closed JSON input schemas and the annotation fields `readOnlyHint` and `untrustedContentHint`. PACT observes the execution callback `AbortSignal` and owns registration cleanup through an `AbortController`.

PACT does not emit a `consequentialHint` field. Consequential-action protection is enforced by PACT's transaction and authority layer rather than represented as a WebMCP guarantee. Imperative callbacks return normal JavaScript values for the user agent to serialize.

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

The validator rejects prototype-related paths, duplicate effect paths, non-JSON values and unbounded effect/invariant sets before a plan can be accepted.

For generic JSON REST resources, `createPactJsonResourceAdapter()` provides a safe path-replacement adapter over `resource.*`. Domain-specific systems should use their own adapter when invariants, commands, partial updates, side effects or verification need richer semantics.

## Canonical HTTP connector

```js
import { createPactHttpConnector } from './src/http.js';

const pact = createPactHttpConnector({ baseUrl: 'https://your-app.example' });
const request = new AbortController();

const preview = await pact.preview({
  adapter: { id: 'provider.account', version: '1.0.0' },
  intent: { path: ['account', 'owner'], value: 'maya' }
}, { signal: request.signal });

const transactionId = preview.transaction.id;

const approved = await pact.approve({
  transactionId,
  approval: signedApprovalClaim
}, { signal: request.signal });

await pact.commit(
  { transactionId, capabilityToken: approved.capability.token },
  `commit:${transactionId}`,
  { signal: request.signal }
);

const verified = await pact.verify({ transactionId }, { signal: request.signal });
const receipt = await pact.receipt({ transactionId }, { signal: request.signal });
```

The canonical HTTP surface is exactly `inspect`, `preview`, `approve`, `commit`, `verify`, and `receipt`. The connector refuses insecure remote HTTP origins; plain HTTP is accepted only for localhost development. `commit` requires an explicit idempotency key. Caller cancellation raises `PACT_HTTP_ABORTED`; the connector deadline raises `PACT_HTTP_TIMEOUT`.

Real-provider errors are intentionally classifiable by agents and clients: stale provider state maps to conflict semantics, uncertain provider commit is surfaced separately, and upstream/provider failures are not collapsed into an opaque successful response. Provider response bodies and unexpected internal exception messages are not copied into protocol errors.

## Production server configuration

Every production mode requires:

```text
UPSTASH_REDIS_REST_URL    HTTPS Redis REST endpoint
UPSTASH_REDIS_REST_TOKEN  Redis REST bearer token
PACT_APPROVAL_SECRET      strong server-only approval HMAC secret
VERCEL_GIT_COMMIT_SHA     exact 40-hex source SHA from a Git-linked deployment
```

`PACT_SOURCE_COMMIT` and `GITHUB_SHA` are also recognized provenance sources. If multiple provenance sources are present, all must resolve to the same SHA or the build/runtime fails closed.

`PACT_RUNTIME_MODE=generic` is the default. `PACT_RUNTIME_MODE=rest-json` activates the real provider configuration shown above. Unknown modes or incomplete provider configuration fail closed.

`vercel.json` runs `npm run build`, publishes `dist`, and retains `api/pact.js` as the serverless Function. Do not accept a locally copied artifact without an exact source SHA. A production release should be accepted only when live `/release-provenance.json` and the `x-pact-release` API header match the intended Git commit and the real transaction smoke gate succeeds.

## Security and durability properties covered by tests

The verification suite covers, among other cases:

- exact plan/canonical-version binding
- authenticated approval claims
- transaction/plan/version/identity-bound one-shot capabilities
- persistent idempotency and exact replay
- same-key/different-payload replay rejection
- canonical CAS and single-winner concurrency
- crash recovery after canonical write before journal completion
- real provider ETag revision binding and `If-Match` conditional writes
- out-of-band provider drift invalidation
- provider `Idempotency-Key` propagation
- lost provider response recovery without a second write when state can be proven
- prototype-pollution path rejection in the JSON-resource adapter
- approval expiry and malformed/forged approval rejection
- corrupt/non-monotonic durable-record rejection
- receipt and audit integrity
- HTTP method/media-type/error/header behavior
- HTTPS-only connector/provider behavior
- cancellation vs timeout distinction
- current imperative WebMCP registration and cancellation contract
- generic playground durable recovery by transaction ID
- manifest/schema self-consistency
- deterministic provenance hashing and provenance-conflict rejection
- Vercel `dist` + `/api/pact` release contract

These tests establish checked-in behavior; they are not a substitute for live verification of the configured Redis provider, third-party provider semantics, secret management, deployment identity, network behavior or operational limits.

## Verification

```bash
npm run verify
```

The release gate runs the Node test suite, JavaScript syntax checks, deterministic production build, release contract assertions and generated bundle syntax validation.
