# PACT Organisational Readiness Design

## Purpose

Move PACT from an experimental transaction/release-integrity layer into an organisational-grade control plane for consequential agent and automation mutations, while preserving fail-closed semantics and refusing to claim guarantees a provider cannot actually support.

## Core invariant

PACT never equates local approval/audit state with remote mutation safety. A consequential action is only assigned an assurance level that is directly supported by the provider's observed concurrency, idempotency, verification and reconciliation semantics.

## Provider-driver architecture

Replace provider-type branching as the core integration abstraction with a versioned provider-driver contract. A driver owns the translation between PACT's canonical transaction model and a provider's real concurrency semantics.

Each production driver exposes:

- `describe()` — immutable provider capabilities and assurance prerequisites;
- `read(context)` — read canonical observed provider state and revision;
- `plan({ intent, observed })` — produce deterministic effects/invariants/provider command;
- `precondition({ observed, plan })` — materialize the provider-native expected-state guard;
- `commit({ plan, authorization, idempotencyKey, fence })` — issue one consequential mutation;
- `observe({ plan })` — independently read post-mutation state;
- `verify({ plan, observed })` — determine whether intended postconditions hold;
- `reconcile({ plan, error })` — classify uncertain effects as `COMMITTED`, `NOT_COMMITTED`, `DIVERGED`, or `UNRESOLVED`;
- optional `compensate()` only when the provider semantics make compensation explicit and verifiable.

Drivers never downgrade an unsupported primitive to a weaker local substitute without lowering the provider assurance class.

## Assurance classes

Every configured provider receives one evidence-backed class:

- `P0_UNQUALIFIED` — no verified remote safety semantics; consequential execution blocked by default.
- `P1_IDEMPOTENT` — provider verifies stable idempotency for the exact command/payload but has no strong expected-state guard.
- `P2_CONDITIONAL` — provider has a qualified conditional write/revision conflict primitive and read-after-write verification.
- `P3_STRONGLY_VERSIONED` — strong revision/validator binding plus qualified idempotency/reconciliation semantics.
- `P4_REMOTE_FENCED` — P3 plus a remotely enforced monotonically increasing fencing token or equivalent stale-writer exclusion.

The class is derived from executed qualification evidence, not only configuration declarations. Missing or expired evidence lowers the class.

## Initial driver families

### `etag-json`

Wraps the current strong REST resource bridge. Strong mode requires a strong ETag on reads, provider-supported conditional mutation, post-write representation or independent reread, and qualified replay semantics. It supports providers such as Salesforce/custom REST only when the concrete endpoint actually demonstrates these properties.

### `kubernetes-resource-version`

Uses Kubernetes object `metadata.resourceVersion` as the expected-state revision. Mutations carry the observed resourceVersion; HTTP 409 is a stale-writer conflict. Verification rereads the object and validates exact postconditions. No claim of provider idempotency is made unless the concrete command semantics establish it.

### `idempotent-command`

For Stripe-style command endpoints whose strongest primitive is provider-enforced idempotency rather than arbitrary record CAS. The driver binds the exact normalized command body to an idempotency key, records the provider's command/result identity, and independently observes the resulting resource. This class cannot exceed P1 unless an additional strong revision/precondition primitive is configured and qualified.

### `versioned-command`

For enterprise APIs that accept an explicit record/version/revision field or conditional token rather than an HTTP ETag. The driver maps that revision into the same canonical expected-state model and can qualify for P2/P3 when conflict and replay behavior are proven.

## Qualification engine

Provider qualification is an active destructive-safe probe against a dedicated qualification resource/account/namespace. It must never run against an arbitrary production resource.

Qualification scenarios include:

- stale revision rejection;
- two concurrent writers from the same base revision;
- same idempotency key + same payload;
- same idempotency key + different payload;
- response loss after provider may have committed;
- provider 5xx before and after mutation where reproducible;
- out-of-band mutation between preview and commit;
- postcondition mismatch;
- remote fence stale-generation rejection when declared.

Evidence records provider ID, resource key, atomic domain, endpoint/driver version, qualification resource identity, execution timestamps, scenario results and cryptographic digest.

Qualification evidence expires after a configurable period, default 30 days, and immediately when driver/config identity changes.

## Policy enforcement

PACT policy declares `minimumAssurance` per consequential operation/domain. Examples:

- low-risk metadata update: P1;
- CRM ownership/entitlement update: P2;
- infrastructure/identity mutation: P3;
- long-running distributed mutation requiring stale-worker exclusion: P4.

When a provider's current class is below policy, PREVIEW may be allowed for analysis but APPROVE/COMMIT fails closed with an explicit assurance error.

## Transaction semantics

The existing preview → authenticated approval → single-use authority → commit → verify → receipt lifecycle remains canonical.

A receipt must bind:

- transaction ID, plan hash and approved base revision;
- provider ID/driver/version and assurance class/evidence digest;
- verified human principal and agent session;
- idempotency key/authorization identity;
- observed before/after revisions;
- verification result;
- reconciliation classification when uncertainty occurred;
- release SHA.

No receipt may claim successful verification when provider state is `UNRESOLVED` or `DIVERGED`.

## Organisational operations

- Per-provider circuit breaker for repeated unresolved/verification failures.
- Bounded concurrency and provider rate limits.
- Structured audit events without provider secrets or raw sensitive payloads by default.
- Health endpoint distinguishes service health from provider qualification health.
- Metrics: preview/approval/commit/verify counts, conflicts, uncertain commits, reconciliation outcomes, duplicate-effect detections, verification failures and latency histograms.
- All production secrets stay server-side. Qualification credentials/resources are distinct from ordinary production mutation targets whenever possible.

## Real-world evidence gate

A driver/provider combination cannot be marked `PRODUCTION` solely because repository tests pass.

For each production driver family, qualification must include at least one real provider or standards-compliant provider environment and at least 1,000 executed qualification transactions across normal, conflict, replay and injected-failure scenarios before broad production claims.

Release acceptance requires:

- unauthorized/wrong-state mutations = 0;
- false successful verifications = 0;
- duplicate consequential effects under qualified replay semantics = 0;
- receipt/provider-state mismatches = 0;
- every uncertain commit classified or explicitly left `UNRESOLVED`, never guessed;
- measured P50/P95/P99 control-plane latency published;
- provider qualification current and bound to the release/driver configuration.

Until these conditions are met, manifests remain `experimental` or `qualified-pilot`.

## Deployment and CI

Main is the sole production trust root. Exact-source provenance remains mandatory. Production deployment stages an immutable build, verifies provenance, exercises a real qualification-safe provider transaction, and only then promotes the alias.

A dedicated self-hosted Linux runner labelled `production-ci` may execute private-repository verification while hosted minutes are exhausted. Production credentials are exposed only to trusted main/manual environment-protected jobs, never untrusted pull-request code.

## Non-goals

PACT does not promise universal exactly-once external effects, does not emulate missing remote CAS with local locks, does not claim provider rollback where compensation is not a real provider operation, and does not automatically make every REST/MCP tool safe. Unsupported semantics remain visible and fail closed.
