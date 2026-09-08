# PACT

**Transactional safety for AI-agent actions that change real state.**

PACT turns a consequential agent action into an explicit transaction:

```text
INTENT
  ↓
PREVIEW EXACT PLAN
  ↓
HUMAN / TRUSTED APPROVAL
  ↓
SHORT-LIVED ONE-SHOT AUTHORITY
  ↓
COMMIT
  ↓
VERIFY CANONICAL STATE
  ↓
TAMPER-EVIDENT RECEIPT
```

It is a reference trust/transaction layer for browser and agent systems where retries, stale state, replay and "the API returned 200" are not sufficient evidence that a consequential action happened correctly.

[**Try PACT**](https://pact-webmcp.vercel.app/) · [Guided demo](https://pact-webmcp.vercel.app/demo/) · [Workspace](https://pact-webmcp.vercel.app/workspace/) · [Security](https://pact-webmcp.vercel.app/security/) · [Developers](https://pact-webmcp.vercel.app/developers/) · [Contributing](CONTRIBUTING.md)

[![verify](https://github.com/dharan1007/pact/actions/workflows/ci.yml/badge.svg)](https://github.com/dharan1007/pact/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## The problem

Agent systems can already call APIs. The harder problem starts when the call is consequential:

- Was the user shown the exact effects that will be committed?
- Did canonical state change after preview but before commit?
- Can an old approval be replayed?
- Can two concurrent writers both "succeed"?
- What happens if the target commits and the process crashes before local bookkeeping finishes?
- Can a retry prove it is the same transaction rather than another mutation?
- Is there durable evidence of what was approved, committed and verified?

PACT makes those questions first-class protocol/state-machine concerns rather than application-specific afterthoughts.

## Try the transaction lifecycle

The public product separates two useful paths:

- [`/demo/`](https://pact-webmcp.vercel.app/demo/) — guided reference transaction.
- [`/workspace/`](https://pact-webmcp.vercel.app/workspace/) — generic canonical `/api/pact` playground with transaction recovery by ID.

The server-side lifecycle is:

```text
PREVIEWED
  → APPROVED
  → COMMIT_AUTHORIZED
  → COMMITTED
  → VERIFIED
```

`preview` binds an exact semantic plan to a canonical base version. `approve` accepts a cryptographically authenticated approval claim. `commit` requires one-shot authority and an idempotency key. `verify` checks canonical state against the approved effects/invariants. `receipt` returns durable verified evidence. `inspect` recovers transaction state after interruption.

## What PACT protects against

| Failure mode | PACT mechanism |
|---|---|
| Stale preview | Base-version binding + canonical CAS |
| Approval replay | Expiring transaction/plan/version/identity-bound approval claims |
| Capability replay | Short-lived single-use commit authority |
| Ambiguous retries | Required idempotency key + exact replay semantics |
| Concurrent writers | Atomic canonical compare-and-swap |
| Target commit then crash | Recovery reconciles observed canonical state with the authorized transaction |
| Plan tampering | Stable plan hash bound into approval/authority |
| Wrong principal/session | Identity claims bound to approval and authority |
| Audit ambiguity | Durable transaction records + verified receipt |
| Untrusted agent content | Explicit protocol/security boundary rather than trusting prose confirmation |

## What is implemented in this repository

- `src/adapter.js` — executable adapter contract and defensive declarative-plan validator.
- `src/api-authority.js` — canonical authority service implementing `preview`, authenticated `approve`, one-shot `commit`, `verify`, `receipt` and `inspect`.
- `src/durable-state.js` — journaled durable transaction state with monotonic recovery validation, CAS transitions and fail-closed corrupt-record handling.
- `src/canonical-store.js` — canonical state repository with atomic version CAS and exact-replay snapshots.
- `src/authority.js` — transaction/plan/version/identity-bound single-use commit capability.
- `src/server-approval.js` — HMAC-SHA256 approval verification bound to transaction, plan hash, base version, adapter, principal, agent session, nonce and expiry.
- `src/redis-store.js` — Redis-compatible HTTPS REST atomic store with create-if-absent and Lua compare-and-swap semantics.
- `src/http.js` — reusable HTTPS connector for the canonical PACT authority endpoint with explicit timeout/cancellation separation.
- `src/webmcp.js` — browser WebMCP bridge using state-dependent tool registration and abort-driven cleanup.
- `src/server-runtime.js` — production composition of adapter, durable authority/journal, canonical store, authenticated approval verifier and HTTP handler.
- `api/pact.js` — Vercel Function entry point for the canonical authority service.
- `pact-manifest.json` plus schemas — machine-readable product/adapter compatibility contract.
- release provenance generation and integrity checks.

The included runtime is intentionally generic. Its bundled adapter atomically replaces `document.value` in a canonical `pact-generic-v1` document. Real applications should provide domain-specific adapters and canonical state while preserving the transaction/approval/replay/verification contract.

## Adapter model

An adapter describes the domain, plans bounded declarative effects and verifies resulting state.

```js
import { definePactAdapter } from './src/adapter.js';

const adapter = definePactAdapter({
  id: 'projects.v1',
  version: '1.0.0',

  describe() {
    return {
      name: 'Project ownership',
      operations: ['transfer_owner']
    };
  },

  async plan({ intent, state }) {
    return {
      effects: [{
        path: `projects.${intent.projectId}.owner`,
        before: state.projects[intent.projectId].owner,
        after: intent.newOwner
      }],
      invariants: [{
        path: 'billing.plan',
        equals: state.billing.plan
      }]
    };
  },

  async verify({ state, plan }) {
    return plan.effects.every(effect =>
      effect.path.split('.').reduce((node, key) => node?.[key], state) === effect.after
    );
  }
});
```

The validator rejects unsafe prototype-related paths, duplicate effect paths, non-JSON values and unbounded effect/invariant sets before a plan is accepted.

## Canonical HTTPS connector

```js
import { createPactHttpConnector } from './src/http.js';

const pact = createPactHttpConnector({
  baseUrl: 'https://your-app.example'
});

const preview = await pact.preview({
  adapterId: 'pact.generic',
  intent: {
    value: { project: 'helios', owner: 'maya' }
  }
});

const transactionId = preview.transactionId ?? preview.transaction?.id;

const approved = await pact.approve({
  transactionId,
  approval: signedApprovalClaim
});

await pact.commit(
  { transactionId, capability: approved.capability },
  `commit:${transactionId}`
);

await pact.verify({ transactionId });
const receipt = await pact.receipt({ transactionId });
```

Approval must come from the application's trusted authentication/approval boundary. The connector intentionally does not manufacture approval on behalf of the user.

## Crash and replay semantics

PACT distinguishes several cases that are often collapsed into "retry":

1. same idempotency key + same authorized transaction → converge on the original result,
2. same key + different payload → reject,
3. changed canonical base version → reject stale writer,
4. canonical write observed after a crash before journal completion → reconcile only when canonical version/effects/invariants match the authorized transaction,
5. malformed/non-monotonic durable state → fail closed.

Those behaviors are covered by the checked-in tests; they are not informal guarantees derived from the UI demo.

## Production runtime requirements

The Vercel authority runtime fails closed unless the configured production prerequisites are present:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
PACT_APPROVAL_SECRET
VERCEL_GIT_COMMIT_SHA
```

`PACT_SOURCE_COMMIT` and `GITHUB_SHA` are recognized provenance sources. If multiple sources are present they must resolve to the same exact source SHA.

A production release should be accepted only when the deployed provenance artifact and API release header match the intended Git commit and a real provider transaction passes the release verification path.

## WebMCP

PACT also exposes the transaction lifecycle to browser agents through the experimental imperative WebMCP producer API at `document.modelContext.registerTool()` when available.

WebMCP is not itself PACT's authorization mechanism. Consequential-action safety comes from PACT's transaction/approval/authority/state contract. Browser tool registration is only one integration surface.

Because WebMCP remains experimental, compatibility claims should be rechecked against the current draft when changing this integration.

## Machine-readable surfaces

- `/pact-manifest.json`
- `/schema/pact-manifest.schema.json`
- `/schema/pact-adapter.schema.json`
- `/adapter.bundle.js`
- `/http.bundle.js`
- `/sdk/runtime.js`
- `/sdk/api-authority.js`
- `/sdk/http-handler.js`
- `/sdk/server-runtime.js`
- `/sdk/server-approval.js`
- `/sdk/durable-state.js`
- `/sdk/canonical-store.js`
- `/sdk/authority.js`
- `/sdk/redis-store.js`
- `/sdk/provenance.js`
- `/release-provenance.json`

## Verify locally

```bash
git clone https://github.com/dharan1007/pact.git
cd pact
npm install
npm run verify
```

`npm run verify` runs the Node tests, syntax checks, deterministic production build, release-contract assertions and generated bundle syntax validation.

## Security testing areas

The suite covers, among other cases:

- exact plan/base-version binding,
- authenticated approval claims,
- one-shot transaction-bound capabilities,
- persistent idempotency and exact replay,
- same-key/different-payload rejection,
- canonical CAS and single-winner concurrency,
- crash recovery after canonical write before journal completion,
- stale-state rejection,
- approval expiry/forgery rejection,
- corrupt/non-monotonic durable record rejection,
- receipt/audit integrity,
- HTTPS-only remote connector behavior,
- cancellation versus timeout,
- WebMCP registration/cancellation behavior,
- deterministic source provenance.

These tests prove behavior of the checked-in implementation. They are not a substitute for verifying the configured Redis provider, secret management, deployment identity, network behavior and operational limits.

## Contributing

PACT especially benefits from domain adapters, property/fault-injection tests, durable-store implementations, protocol/security review and integration examples. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and start with [`good first issue`](https://github.com/dharan1007/pact/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) or [`help wanted`](https://github.com/dharan1007/pact/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).

Security-sensitive findings should follow [`SECURITY.md`](SECURITY.md) when present or the repository's security policy rather than being disclosed as a public exploit issue.

## Roadmap

See [`ROADMAP.md`](ROADMAP.md). The priority is to prove PACT across multiple real domain adapters/providers without weakening transaction invariants.

## Related projects

- [KATA](https://github.com/dharan1007/kata) — reusable deterministic research workflows for agents.
- [SPOOL](https://github.com/dharan1007/spool) — deterministic local-first data migration.
- [FAULTLINE](https://github.com/dharan1007/faultline) — causal browser-failure reduction.

## License

MIT — see [`LICENSE`](LICENSE).

If you believe consequential agent actions need transaction semantics rather than best-effort API calls, star PACT to follow the work and help other agent-infrastructure builders discover the project.