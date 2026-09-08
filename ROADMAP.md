# PACT Roadmap

PACT's roadmap is about proving a reusable transaction substrate across real domains without weakening its core invariants.

## Now — make the reference transaction plane auditable

- Keep preview → authenticated approval → one-shot commit → canonical verification → receipt as one explicit state machine.
- Expand adversarial tests for stale state, replay, same-key/different-payload, approval expiry, forged claims, concurrent writers and corrupt durable records.
- Keep real provider transaction verification in the production promotion gate rather than relying only on mocks.
- Strengthen receipt/provenance evidence and document exactly what a receipt does and does not prove.
- Improve the generic workspace so transaction IDs, plan hashes, base versions, approvals, commit authority, verification and recovery are inspectable without reading source code.
- Keep WebMCP as an integration surface rather than an authorization shortcut.

## Next — prove PACT is not a single-demo protocol

Priority is a small set of **real domain adapters** with different failure modes:

1. repository/project ownership or configuration changes,
2. database-backed canonical state,
3. one external REST/provider mutation with exact post-commit verification,
4. a long-running mutation that requires lease/fencing semantics.

Each adapter must define:

- canonical state/version source,
- intent schema,
- bounded effects and invariants,
- trusted approval identity boundary,
- idempotency behavior,
- recovery/reconciliation after uncertain commit,
- verification against authoritative state.

A new adapter is not accepted as evidence merely because its API call succeeds.

## Next — packaging and agent ecosystem

- Stabilize reusable SDK/package boundaries after adapter interfaces stop changing quickly.
- Publish client examples for major agent/tool hosts using the canonical HTTPS authority rather than duplicating business logic.
- Evaluate a remote MCP transaction facade only when it can preserve PACT approval/authority semantics faithfully; do not publish registry metadata for an endpoint that does not yet exist.
- Add a public Agent Transaction Safety Suite covering replay, TOCTOU/stale state, double commit, crash-after-target-write, approval tampering and receipt/provenance cases.
- Add property-based/fault-injection harnesses that third-party adapters can run before claiming compatibility.

## Later — stronger deployment guarantees

- Pluggable durable stores with explicit consistency/atomicity capability declarations.
- Execution leases and fencing for long-running target mutations.
- Stronger receipt tamper evidence / external anchoring where it adds real audit value.
- Better operator observability without exposing approval or credential secrets.
- Multi-instance chaos/recovery testing against supported store/provider combinations.

## Non-goals

PACT will not:

- treat an LLM confirmation message as authorization,
- make approval independent of the exact plan/base state,
- allow ambiguous consequential retries without idempotency identity,
- accept transport success as canonical verification,
- advertise every API wrapper as a PACT adapter,
- claim WebMCP itself provides PACT's security guarantees,
- weaken fail-closed behavior to make demos look smoother.

## Roadmap contribution process

Large changes to approval, capabilities, canonical state, recovery, durable stores or receipt semantics should start as an RFC/design issue. Smaller adapter fixtures, negative tests and documentation tasks should be carved out as approachable `good first issue` / `help wanted` contributions.