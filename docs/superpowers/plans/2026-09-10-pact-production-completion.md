# PACT Production Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close PACT's remaining provider-proof, observability, recovery-policy, and exact-source deployment gaps so the hardening branch can be judged against real production gates rather than declared capability.

**Architecture:** Add provider qualification as an isolated module consumed by the provider registry; add a vendor-neutral saga telemetry/operational-status module consumed by saga protocol/coordinator; extend the frozen saga requirement schema with human recovery policy; and make the existing release workflow invokable through a tightly gated release-request branch while preserving exact-head staged promotion.

**Tech Stack:** Node.js 22+, native `node:test`, ES modules, Redis-compatible atomic store abstraction, Vercel Functions/CLI release workflow, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-10-pact-production-completion-design.md`

## Global Constraints

- Preserve every invariant in `AGENTS.md`.
- Do not add dependencies unless the standard library cannot satisfy the requirement.
- Security/state-machine changes require adversarial negative tests before implementation.
- Provider qualification must not expose credentials or treat transport failure as proof.
- Human recovery policy must be frozen into the approved saga plan hash.
- Telemetry must never mutate authority state.
- Deployment must target the existing `pact-webmcp` Vercel project only.

---

### Task 1: Provider qualification evidence

**Files:**
- Create: `test/provider-qualification.test.js`
- Create: `src/provider-qualification.js`
- Modify: `src/provider-registry.js`
- Modify: `scripts/build.mjs`

**Interfaces:**
- Produces `createPactProviderQualifier({ store, now })`.
- Produces `qualifyConditionalWrite({ provider, probe })`, `qualifyRemoteFencing({ provider, probe })`, and `inspectQualification(providerId)`.
- Provider registry consumes durable qualification summaries and exposes `verification: declared|locally-enforced|provider-verified` per capability.

- [ ] **Step 1: Write failing conditional-write qualification test**
  Create a provider harness with versioned strong ETags. Establish revision r1, mutate safely to r2, attempt a stale r1 `If-Match` write, and assert qualification succeeds only when stale mutation is rejected and canonical state remains r2.

- [ ] **Step 2: Run the new test and verify RED**
  Run `node --test test/provider-qualification.test.js`; expected failure is missing `provider-qualification.js` / missing qualifier API.

- [ ] **Step 3: Write failing remote-fencing qualification test**
  Harness accepts fence 8, rejects fence 7, and exposes canonical state. Assert qualifier records provider-verified fencing only after stale fence rejection plus unchanged canonical state.

- [ ] **Step 4: Implement durable qualification module**
  Persist versioned evidence using atomic store keys derived from SHA-256 of provider identity + resource + probe type. Evidence fields: providerId, resourceKey, atomicDomain, probeType, startedAt, completedAt, beforeRevision, qualifiedRevision/generation, staleProbeResult, canonicalUnchanged, evidenceHash, status. Reject corrupt/mismatched evidence.

- [ ] **Step 5: Integrate provider registry capability discovery**
  Keep current conservative/local enforcement values. Add nested qualification metadata so a capability can distinguish `declared`, `locally-enforced`, and `provider-verified`; never upgrade to provider-verified without matching durable evidence.

- [ ] **Step 6: Package module**
  Add `src/provider-qualification.js` to the SDK build copy graph and add packaging regression if build tests do not already enforce dependency closure.

- [ ] **Step 7: Run focused and full verification**
  Run `node --test test/provider-qualification.test.js test/provider-registry.test.js` then `npm run verify`.

### Task 2: Minimum provider guarantee requirements

**Files:**
- Create/Modify: `test/saga-protocol.test.js`
- Modify: `src/saga-protocol.js`
- Modify: `src/provider-registry.js`
- Modify: schemas/manifest only if the external contract is represented there.

**Interfaces:**
- Extend step requirements with optional `conditionalWriteStrength` enum: `any`, `strong-validator`, `provider-verified`.
- Extend optional `remoteFencingStrength` enum: `declared`, `provider-verified`.

- [ ] **Step 1: Add RED preview rejection tests**
  Assert a provider that is locally strong but not provider-verified cannot satisfy `conditionalWriteStrength: provider-verified`; assert equivalent remote-fence requirement fails before approval.

- [ ] **Step 2: Run focused test and verify RED**
  Run the exact saga protocol tests; expected failure is that current requirement normalization ignores strength.

- [ ] **Step 3: Implement normalized versioned requirement comparison**
  Freeze strength requirements into the saga plan. Capability negotiation compares requested minimum to provider qualification metadata. Existing boolean `conditionalWrite` and `remoteFencing` remain backward compatible.

- [ ] **Step 4: Verify plan-hash sensitivity**
  Add test proving changing a strength requirement changes the plan hash and makes old approval evidence unusable.

- [ ] **Step 5: Run focused and full verification**
  Run saga/provider tests and `npm run verify`.

### Task 3: Saga-native observability and attention state

**Files:**
- Create: `test/saga-observability.test.js`
- Create: `src/saga-observability.js`
- Modify: `src/saga.js`
- Modify: `src/saga-protocol.js`
- Modify: `src/server-runtime.js`
- Modify: `scripts/build.mjs`

**Interfaces:**
- `createPactSagaTelemetry({ sink, now, reconciliationSlaMs })`.
- `emit(event)` receives secret-redacted structured events.
- `deriveOperationalStatus(saga)` returns current step, lease generation/expiry, takeover count, reconciliation age, compensation attempts, terminal state, `attentionRequired`.

- [ ] **Step 1: Add RED secret-redaction test**
  Emit events from saga execution containing approval/capability/provider objects and assert output never contains bearer tokens, capability token strings, raw approval artifacts, or authorization secrets.

- [ ] **Step 2: Add RED SLA status test**
  Put saga in `RECONCILIATION_REQUIRED`, advance clock beyond SLA, and assert `attentionRequired: true` without mutating durable saga state.

- [ ] **Step 3: Implement telemetry module**
  Define bounded event schema and redaction. Sink exceptions become explicit telemetry error results and never change transaction state.

- [ ] **Step 4: Instrument coordinator/protocol boundaries**
  Emit create, approval, execute, step start/finish, lease acquire/takeover/loss, reconciliation-required, compensation, recovery, and terminal events. Include saga/step/provider IDs and timing, not secrets.

- [ ] **Step 5: Expose operational inspection**
  Include `operational` status in saga inspect/recovery inspect responses.

- [ ] **Step 6: Package and verify**
  Add SDK build entry, run focused tests, then `npm run verify`.

### Task 4: Human-recovery-required policy

**Files:**
- Modify: `test/saga-protocol.test.js`
- Modify: `test/saga-recovery.test.js` or equivalent existing recovery suite
- Modify: `src/saga-protocol.js`
- Modify: HTTP/MCP schemas if step requirement schema is enumerated there.

**Interfaces:**
- Step requirement `humanRecoveryRequired: boolean`, default `false`.
- Programmatic `sagaReconcile` rejects uncertain steps with policy enabled; existing evidence-bound human recovery resolution remains the permitted path.

- [ ] **Step 1: Add RED programmatic-reconcile rejection test**
  Create approved saga with `humanRecoveryRequired: true`, force uncertain provider result, call programmatic reconcile, expect `PACT_SAGA_HUMAN_RECOVERY_REQUIRED` and zero additional provider mutation.

- [ ] **Step 2: Add RED human recovery success test**
  Inspect evidence, approve recovery through existing recovery authority, resolve, and assert terminal receipt includes the resolution evidence.

- [ ] **Step 3: Implement requirement normalization/policy gate**
  Freeze flag into plan, default false, and enforce at programmatic reconciliation boundary.

- [ ] **Step 4: Verify compatibility**
  Existing saga plans without the field must retain current behavior.

- [ ] **Step 5: Run full verification**
  `npm run verify`.

### Task 5: Safe invokable production release trigger

**Files:**
- Modify: `.github/workflows/deploy-production.yml`
- Create: `release-request.json` only on `production-release` branch when releasing
- Add/Modify: release workflow tests.

**Interfaces:**
- Workflow accepts existing `workflow_dispatch` and a new push trigger on `production-release`.
- Push path resolves requested SHA only from validated `release-request.json`.

- [ ] **Step 1: Add RED workflow-policy test**
  Require owner actor, schema version 1, exact 40-char SHA, requested SHA equals live hardening branch HEAD, successful `verify` check for exact SHA, and checkout/deploy of requested SHA rather than release branch contents.

- [ ] **Step 2: Implement gated push trigger**
  Add `push.branches: [production-release]`; derive `PACT_SOURCE_COMMIT` from dispatch input or release request. Fail closed unless actor is repository owner for push mode.

- [ ] **Step 3: Preserve staged release gates**
  Keep Vercel org/project pins, prebuilt verification, immutable staging, staged production verifier, real provider smoke, promotion, and final production verifier.

- [ ] **Step 4: Run full verification**
  `npm run verify` and confirm workflow policy tests pass.

- [ ] **Step 5: Create/update `production-release` branch from current hardening head**
  Write `release-request.json` with exact final hardening SHA and a fresh nonce. This push is the deployment attempt.

- [ ] **Step 6: Inspect deployment workflow**
  If it fails, inspect exact failing job/log. Repair repository-controlled failures. If it fails only because a secret/provider configuration is absent, report that exact external gate and do not claim production completion.

- [ ] **Step 7: If deployment succeeds, verify staged and production**
  Confirm immutable staged URL, `release-provenance.json` exact SHA, `/api/pact`, public routes, configured real-provider smoke, promotion, final alias provenance/API, and runtime errors.

### Task 6: Final branch/release completion

**Files:**
- Modify: `README.md`, `SECURITY.md`, `ROADMAP.md`, `pages/security.html`, `pages/developers.html`, `pact-manifest.json` only where current behavior has changed.
- Modify PR #12 body.

- [ ] **Step 1: Update public product and security surfaces**
  Document provider qualification states, observability, human-recovery policy, and exact deployment evidence without overstating production proof.

- [ ] **Step 2: Run final exact-head verification**
  Run/confirm `npm run verify`, CodeQL, release artifact/package closure, and PR mergeability on one exact SHA.

- [ ] **Step 3: Production readiness gate**
  Only if staged/prod provenance, API, site, real-provider smoke, and runtime checks are all green: mark PR ready and merge. Otherwise keep draft and state the single remaining external blocker.

- [ ] **Step 4: Post-merge verification if merge occurs**
  Verify main CI, production provenance still points to the deployed source or approved merge provenance policy, and no production regressions appear.
