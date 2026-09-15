# PACT Organisational Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn PACT's existing authority/registry/saga machinery into an organisational-grade provider-driver control plane with evidence-backed assurance classes, provider-specific concurrency semantics, policy enforcement, measurable qualification and exact release provenance.

**Architecture:** Keep the canonical preview → approval → authority → commit → verify → receipt protocol. Extract provider semantics behind a strict driver contract; derive assurance from executed qualification evidence; block consequential actions that require stronger guarantees than the provider has demonstrated.

**Tech Stack:** Node.js ESM, Vercel Functions, Redis-compatible HTTPS atomic store, provider-specific HTTPS APIs, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-15-organisational-readiness-design.md`

## Global Constraints

- Never emulate missing remote concurrency safety with local locks while claiming equivalent assurance.
- Provider assurances are evidence-derived and expire when config/driver identity changes.
- `UNRESOLVED` consequential effects are never converted to success.
- Production credentials remain server-side and are not exposed to untrusted PR code.
- Main remains the sole production release trust root.

---

### Task 1: Provider-driver contract and assurance model

**Files:**
- Create: `src/provider-driver.js`
- Create: `src/provider-assurance.js`
- Create: `test/provider-driver.test.js`
- Create: `test/provider-assurance.test.js`

**Interfaces:**
- `definePactProviderDriver(driver)` validates `describe/read/plan/precondition/commit/observe/verify/reconcile`.
- `ASSURANCE = {P0_UNQUALIFIED,P1_IDEMPOTENT,P2_CONDITIONAL,P3_STRONGLY_VERSIONED,P4_REMOTE_FENCED}`.
- `deriveProviderAssurance({description,evidence,now})` returns class + reasons + evidence digest.

- [ ] Write failing tests for missing methods, invalid driver IDs/versions and falsely elevated assurance.
- [ ] Write failing tests for expired/mismatched evidence.
- [ ] Implement the minimal contract and monotonic assurance derivation.
- [ ] Commit `feat: define provider drivers and assurance classes`.

### Task 2: Adapt current REST bridge as `etag-json`

**Files:**
- Create: `src/providers/etag-json.js`
- Modify: `src/rest-resource.js`
- Modify: `src/provider-registry.js`
- Create: `test/provider-etag-json.test.js`

**Interfaces:**
- `createEtagJsonDriver(config) -> PactProviderDriver`.

- [ ] Write failing tests requiring strong ETag for P3, stale `If-Match` conflict classification, post-read verification and same-key/different-payload rejection.
- [ ] Wrap/reuse existing REST bridge rather than duplicate CAS/replay logic.
- [ ] Make weak ETags or unqualified conditional semantics lower assurance rather than pretending strong safety.
- [ ] Commit `feat: expose qualified etag-json provider driver`.

### Task 3: Kubernetes resourceVersion driver

**Files:**
- Create: `src/providers/kubernetes-resource.js`
- Create: `test/provider-kubernetes.test.js`

**Interfaces:**
- `createKubernetesResourceDriver({baseUrl,resourcePath,token,...})`.
- Revision is `metadata.resourceVersion`; HTTP 409 maps to stale state.

- [ ] Write failing tests for read/version extraction, mutation carrying the observed resourceVersion, 409 conflict, reread verification and divergence.
- [ ] Implement HTTPS-only Kubernetes JSON resource mutation with server-side auth.
- [ ] Do not claim provider-level idempotency unless separately qualified.
- [ ] Commit `feat: add kubernetes resourceVersion driver`.

### Task 4: Idempotent-command driver

**Files:**
- Create: `src/providers/idempotent-command.js`
- Create: `test/provider-idempotent-command.test.js`

**Interfaces:**
- `createIdempotentCommandDriver({command,observe,idempotencyHeader,...})`.

- [ ] Write failing tests for exact command-body binding to idempotency key, same-key replay, different-payload rejection, timeout-after-submit reconciliation and observed-resource verification.
- [ ] Implement generic command + observation driver suitable for Stripe-style APIs.
- [ ] Cap base assurance at P1 unless an independently qualified precondition primitive is supplied.
- [ ] Commit `feat: add idempotent command provider driver`.

### Task 5: Explicit-version command driver

**Files:**
- Create: `src/providers/versioned-command.js`
- Create: `test/provider-versioned-command.test.js`

**Interfaces:**
- Driver config supplies `readRevision`, `applyRevision`, `classifyConflict` and `observe` callbacks/HTTP mappings.

- [ ] Write failing tests for expected-revision binding, conflict, provider postcondition mismatch and reconciliation.
- [ ] Implement bounded declarative mapping without arbitrary code from untrusted configuration.
- [ ] Qualify for P2/P3 only with executed conflict/idempotency evidence.
- [ ] Commit `feat: add explicit-version command driver`.

### Task 6: Active qualification engine

**Files:**
- Modify: `src/provider-qualification.js`
- Create: `src/provider-qualification-suite.js`
- Create: `test/provider-qualification-suite.test.js`
- Create: `schema/pact-provider-qualification.schema.json`

**Interfaces:**
- `qualifyProvider({driver,qualificationTarget,scenarios,store,now}) -> evidence`.

- [ ] Write failing tests for stale-write, concurrent writers, same-key replay, different-payload replay, uncertain commit, divergence and fencing scenarios.
- [ ] Require a dedicated qualification target identity and reject ambiguous production targets.
- [ ] Bind evidence to provider ID, resource key, atomic domain, driver version/config digest and release SHA.
- [ ] Default evidence expiry to 30 days.
- [ ] Commit `feat: qualify real provider mutation semantics`.

### Task 7: Policy gate by minimum assurance

**Files:**
- Create: `src/provider-policy.js`
- Modify: `src/provider-registry.js`
- Modify: `src/server-runtime.js`
- Create: `test/provider-policy.test.js`

**Interfaces:**
- `evaluateProviderPolicy({operation,minimumAssurance,providerAssurance})`.

- [ ] Write failing tests proving PREVIEW may remain available while APPROVE/COMMIT is blocked below minimum assurance.
- [ ] Add fail-closed error `PACT_PROVIDER_ASSURANCE_INSUFFICIENT` carrying non-sensitive required/actual classes.
- [ ] Bind policy result/evidence digest into transaction/receipt context.
- [ ] Commit `feat: enforce evidence-backed provider assurance policy`.

### Task 8: Receipt/audit enrichment and observability

**Files:**
- Modify: `src/api-authority.js`
- Modify: `src/durable-state.js`
- Create: `src/operational-metrics.js`
- Create: `test/receipt-provider-assurance.test.js`
- Create: `test/operational-metrics.test.js`

**Interfaces:**
- Receipts include provider driver/version, assurance class/evidence digest, observed revisions and reconciliation classification.

- [ ] Write failing receipt tests for assurance binding and no-success-on-unresolved behavior.
- [ ] Add bounded structured metrics for conflicts, uncertain commits, reconciliation outcomes, verification mismatches and latency.
- [ ] Ensure metrics/audit events exclude provider credentials and raw sensitive payloads.
- [ ] Commit `feat: bind provider assurance into receipts and operations`.

### Task 9: Production qualification benchmark

**Files:**
- Create: `scripts/qualify-provider.mjs`
- Create: `scripts/summarize-provider-qualification.mjs`
- Create: `test/provider-qualification-report.test.js`
- Modify: `pact-manifest.json`

**Interfaces:**
- CLI runs qualification only against explicitly configured qualification resources.
- Summary computes transaction counts, duplicate effects, false verification, unresolved rate and P50/P95/P99 latencies.

- [ ] Write failing report tests rejecting fabricated/missing evidence and sample sizes below production threshold.
- [ ] Implement signed/digested evidence report generation.
- [ ] Keep manifest status experimental until real provider runs satisfy the spec.
- [ ] Commit `feat: produce measurable provider qualification evidence`.

### Task 10: Zero-hosted-minute trusted verification path

**Files:**
- Create: `.github/workflows/self-hosted-verify.yml`
- Modify: `.github/workflows/deploy-production.yml`
- Modify: `.github/workflows/production-integrity.yml`
- Modify: `test/production-deploy-workflow.test.js`

**Interfaces:**
- Trusted manual/main jobs may use `[self-hosted, Linux, X64, production-ci]`.

- [ ] Add tests preventing production-secret jobs from running for untrusted PR/fork contexts.
- [ ] Add exact-SHA self-hosted verification path.
- [ ] Run staged provenance → qualification-safe provider transaction → promote → canonical reverify.
- [ ] Commit `ci: add trusted self-hosted production qualification path`.

### Task 11: Verification and release

- [ ] Execute `npm run verify` on an available runner/local environment.
- [ ] Execute CodeQL or equivalent security scan without pretending substitutes equal CodeQL.
- [ ] Execute real-provider qualification where credentials/safe qualification targets exist.
- [ ] Deploy preview/staged exact SHA, verify release provenance and runtime logs.
- [ ] Merge only after executable gates are green.
- [ ] Promote exact main SHA and re-run canonical production verification.
- [ ] Keep product/driver status experimental or qualified-pilot until 1,000 real qualification transactions per production driver family meet the zero-critical-error thresholds.
