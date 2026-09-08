# Contributing to PACT

PACT is transaction/security infrastructure for consequential agent actions. Contributions are welcome, but changes to approval, authority, idempotency, canonical state, recovery or receipts must be reviewed as security-sensitive state-machine changes rather than ordinary feature work.

## High-value contributions

- Domain adapters with explicit effects, invariants and verification.
- Property/fault-injection tests for replay, concurrency, stale state and crash recovery.
- Durable canonical/journal stores that preserve atomicity/CAS semantics.
- Provider integration tests against real services where credentials remain private.
- Protocol/SDK examples that do not bypass the canonical authority path.
- Threat-model, security and operational documentation.
- Developer-experience and accessibility improvements to demo/workspace surfaces.

Look for [`good first issue`](https://github.com/dharan1007/pact/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) and [`help wanted`](https://github.com/dharan1007/pact/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).

## Setup

```bash
git clone https://github.com/dharan1007/pact.git
cd pact
npm install
npm run verify
```

## Transaction invariants

Unless an accepted design explicitly changes the protocol, preserve:

1. Preview binds an exact semantic plan to canonical base state/version.
2. Approval is authenticated and bound to transaction, plan hash, base version and identity/session claims.
3. Commit authority is short-lived and single use.
4. Consequential commits require an idempotency key.
5. Same-key/different-payload replay is rejected.
6. Canonical mutation uses atomic compare-and-swap/single-winner semantics.
7. Crash recovery reconciles only the exact authorized transaction against observed canonical state.
8. Corrupt/non-monotonic durable transaction records fail closed.
9. Verification checks resulting canonical state, not merely transport success.
10. Receipt/audit evidence is bound to verified transaction facts.
11. Production provenance cannot silently resolve conflicting source SHAs.

## Required verification

```bash
npm test
npm run check
npm run build
npm run verify
```

If a change affects a real provider path, include the deterministic local tests **and** describe the authorized live-provider verification performed. Never commit provider credentials.

## Adapter contributions

A useful adapter proposal specifies:

- domain and operation,
- intent schema,
- exact effects,
- invariants that must not change,
- canonical state/version source,
- authorization/identity assumptions,
- verification logic,
- idempotency/recovery implications,
- privacy/security considerations.

Avoid adapters that merely wrap a remote API call and call HTTP success a verified transaction.

## Security-sensitive changes

Open a design issue/RFC before changing approval, capability, canonical-store, durable-state, Redis atomicity, provenance or receipt semantics.

Vulnerabilities should follow `SECURITY.md`, not a public issue.

## Pull requests

Keep PRs small enough that a reviewer can reason about the state transition. Include:

- failure mode being prevented or feature outcome,
- state transitions affected,
- tests for success **and** adversarial/error paths,
- deployment/provider impact,
- compatibility impact,
- docs updates.

Security or transaction logic without negative tests is incomplete.

## Evidence standards

Do not describe PACT as preventing a class of failure unless the checked-in implementation/tests demonstrate the relevant invariant. Do not use synthetic/provider mocks as proof that a real external transaction path is production-ready.