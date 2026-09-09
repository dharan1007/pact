# PACT Production Completion Design

## Goal

Finish the hardening branch as a truthful production transaction substrate by closing the remaining correctness, operations, policy, and release gaps without weakening PACT's existing approval, idempotency, CAS, recovery, fencing, evidence, or provenance invariants.

## Current baseline

The hardening branch already contains: durable single-resource authority, Redis CAS storage, ETag/If-Match REST bridging, detached replay evidence, atomic multi-field resource mutation, multi-resource sagas, compensation/reconciliation, durable worker leases/fencing, provider-side remote-fence transport, exact approval replay binding, operator recovery, step-verifiable evidence chains, provider registry/runtime composition, HTTP/MCP/WebMCP surfaces, production artifact verification, staged-promotion gates, and deterministic release provenance.

The remaining completion gaps are not new product categories. They are the places where PACT still relies on declared configuration or local state instead of production evidence.

## 1. Provider qualification

Add a server-side qualification primitive that actively proves provider safety claims before those claims can be advertised as verified.

For conditional writes, qualification records an initial canonical provider state/revision, obtains or creates a newer revision through a caller-supplied safe qualification mutation, attempts the old stale conditional mutation, and succeeds only when the provider rejects that stale mutation and canonical state remains at the newer revision. Qualification never treats transport failure alone as proof.

For monotonic remote fencing, qualification exercises generation N+1 and then stale generation N against a dedicated caller-supplied qualification mutation. It succeeds only when N+1 is accepted, stale N is rejected, and the canonical resource still reflects N+1.

Provider discovery distinguishes `declared`, `locally-enforced`, and `provider-verified`. Saga requirements may request a minimum concurrency/fencing strength; preview fails before approval when the selected provider does not satisfy it.

Qualification evidence is durable, SHA-256 bound to provider identity, resource key, atomic domain, observed revisions, probe type, result, and timestamp. Provider credentials never appear in qualification evidence.

## 2. Saga-native observability

Add a small structured telemetry boundary rather than embedding vendor-specific logging in the state machine. The saga coordinator emits bounded events for: saga create/approve/execute, step start/finish, lease acquire/takeover/loss, provider latency, reconciliation-required, compensation start/finish, operator recovery, and terminal outcome.

The runtime accepts an optional telemetry sink. Failures in the sink do not mutate transaction semantics and are surfaced as telemetry errors rather than being swallowed silently.

Inspection derives an operational status containing saga age, current step, lease generation/expiry, takeover count, reconciliation age, compensation attempts, and terminal state. A configurable reconciliation SLA marks a saga `attentionRequired: true`; it does not mutate the saga merely because time passed.

No approval artifacts, bearer tokens, provider credentials, or raw authorization tokens are emitted.

## 3. Plan-level recovery policy

Extend the frozen saga requirement contract with `humanRecoveryRequired` for steps whose business policy forbids autonomous reconciliation after an uncertain consequential action.

When such a step enters `RECONCILIATION_REQUIRED`, ordinary programmatic `sagaReconcile` must fail closed with an explicit policy error. Resolution must go through the existing evidence-bound `saga_recovery_inspect` -> fresh human approval -> `saga_recovery_resolve` path. The policy is frozen into the plan hash and therefore cannot be added or removed after approval.

Existing steps default to `false` for compatibility.

## 4. Exact-head production release path

Keep the existing staged-release architecture: exact SHA -> successful verify -> rerun repository verification -> pull pinned Vercel production configuration -> prebuilt build -> prebuilt integrity verification -> immutable `--skip-domain` deployment -> staged website/provenance/API verification -> configured real-provider smoke -> promote exact deployment -> reverify production alias.

Because the connected GitHub integration cannot call `workflow_dispatch`, add a tightly gated push trigger on a dedicated `production-release` branch. The trigger must read `release-request.json`, require the actor to be the repository owner, require the requested SHA to equal the current hardening branch head, require successful `verify` for that exact SHA, and checkout/build/deploy the requested SHA rather than branch contents. The release branch therefore cannot select an older or different commit.

A release request file contains only schema version, exact release SHA, and a nonce. It contains no secrets. The workflow remains fail-closed when `VERCEL_TOKEN`, production provider configuration, Redis configuration, approval secret, or smoke configuration are absent.

## Security invariants

- Approval remains bound to exact plan/base state and verified identity/session claims.
- Consequential operations require explicit idempotency identities.
- Same-key/different-payload replay fails closed.
- Canonical mutations preserve CAS/single-winner semantics.
- Uncertain provider outcomes are reconciled against authoritative state; they are never blindly retried or compensated.
- Worker and remote fencing generations remain monotonic.
- Provider qualification cannot upgrade a capability without durable probe evidence.
- Human-recovery policy is part of the frozen approved plan.
- Telemetry cannot alter authority state and cannot expose secrets.
- Release promotion never rebuilds a different source after staged verification.

## Acceptance criteria

1. New negative tests fail on the current implementation before production code is changed.
2. Provider qualification proves stale conditional-write rejection and stale remote-fence rejection against deterministic provider harnesses and records durable evidence.
3. Saga preview fails when a provider lacks a required verified capability.
4. Saga operational inspection reports leases, takeovers, uncertainty age, and SLA attention without exposing secrets.
5. `humanRecoveryRequired` blocks programmatic reconciliation and permits the existing approved operator recovery path.
6. Full `npm run verify` and CodeQL pass on the exact final hardening head.
7. Production build and SDK packaging include every new module/import.
8. A release request is pushed to `production-release`; the deployment workflow either produces a verified immutable deployment and promotes it, or fails at an explicit missing credential/configuration gate. No unverifiable deployment is accepted.
9. If promotion succeeds, `/`, public product routes, `/release-provenance.json`, and `/api/pact` are reverified on the production alias and the configured real-provider smoke has succeeded.
