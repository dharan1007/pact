# PACT Release Integrity

PACT is the release-integrity control plane for production AI agents. It fingerprints
the complete behavior of an agent — model, prompts, tools, MCP servers, skills,
permissions, retrieval, memory, policies and runtime — into one immutable release
identity, detects undeclared drift, gates rollout on deterministic rules, attributes
regressions to the exact changed dependency, and safely rolls back recoverable
external effects through its transaction engine.

Four verbs govern everything PACT builds:

- **CAPTURE** — what exactly is running?
- **COMPARE** — what actually changed?
- **PROVE** — will the new combination behave acceptably?
- **CONTROL** — should it reach production, and can we recover if it fails?

## What is implemented in this repository

All of the following runs locally and in CI today:

- `pact.lock` — a content-hash release manifest (`src/release-lock.js`,
  schema in `schema/pact-lock.schema.json`). Same agent content always yields the
  same `releaseId`; any tampering fails closed on load. Caller-supplied `sha256:`
  pins are treated as opaque equality-comparable fingerprints, never as verified
  content.
- Real discovery (`src/release-discover.js`) — git SHA plus dirty-tree evidence,
  package/dependency/lockfile inventory, live MCP `initialize` + `tools/list`
  handshakes with per-tool schema capture, and OpenAI/Anthropic model metadata
  over their real REST contracts. `composeDescriptor` merges provider results
  with per-section provenance. Dashboards without APIs cannot be discovered;
  those sections stay unobserved rather than invented.
- Structural diff (`src/release-diff.js`) — section-level change classification
  (`breaking`, `permission-changed`, `contract-changed`, `model-changed`,
  `behavioral`, `data-changed`, …) with bounded leaf-level paths and deterministic
  severities. No probabilities are estimated anywhere.
- Immutable lock registry (`src/release-registry.js`) — pin/get/history over the
  same atomic compare-and-swap store contract as the transaction engine, with
  same-key/different-payload replay rejected.
- Trace corpus (`src/trace-corpus.js`) — normalized execution events with
  OpenTelemetry span mapping (`pact.*` attributes), deterministic redaction with
  an audit list, idempotent ingest and seeded sampling.
- Side-effect-safe replay (`src/replay.js`) — decision-compatibility of recorded
  tool calls against candidate contracts (removed/broken, schema-checked,
  opaque-change unknown), runner-based experiments through an intercepting tool
  client that returns recorded results and never executes, Wilson-score rate
  intervals, exact latency percentiles, and a descriptive PROVE report. Output
  equality is canonical, never semantic.
- Drift evaluation (`src/release-drift.js`) — compare a pinned lock against an
  observed snapshot; report `drifted`/`undeclared` sections, list pinned-but-
  unobserved sections as unknown rather than guessing.
- Release gate (`src/release-gate.js`) — deterministic ALLOW/WARN/BLOCK from diff
  severities, change kinds, drift, and empirical replay ceilings (changed-outcome
  and failure rates, destructive proposals, cost/latency rises, protected traces,
  unknowns) under an explicit policy object.
- Bisection (`src/release-bisect.js`) — single-factor hybrid-lock search that
  reports `isolated`, `multiple-candidates`, `not-reproduced` or `inconclusive`.
  It does not explore interactions and says so.
- Canary evaluation (`src/release-canary.js`) — validated rollout schedules plus
  deterministic promote/hold/rollback decisions from observed step metrics.
  Traffic orchestration itself is not included.
- Regression attribution (`src/release-attribution.js`) — given a bad release and
  lock history, return the exact changed dependency set ordered by a documented
  severity/class rank. It does not estimate probabilities or confidence scores.
- Release-transaction linkage — receipts optionally carry the agent release ID
  (preview-supplied and/or approval-bound with HMAC enforcement); linked receipts
  are indexed per release (`src/release-effects.js`) and recoverable through
  caller-supplied resolvers with deterministic evidence (`src/release-recovery.js`).
  Built-in per-adapter compensators are not included.
- Fleet graph (`src/fleet-graph.js`) — exact agent/release/dependency indexing
  with set-based blast-radius queries over recorded locks.
- Transactional recovery (existing engine) — the CONTROL substrate: one-shot
  authority, idempotent commit, canonical verification, saga compensation and
  operator recovery for reversible/compensable external effects.
- CLI (`scripts/pact-release.mjs`, also `npm run release -- <command>`) with
  `capture`, `discover`, `diff`, `drift` and `gate` subcommands for CI
  integration. `gate` exits 0 on ALLOW/WARN and 1 on BLOCK; all other failures
  exit 2.
- TypeScript definitions (`types/release-integrity.d.ts`, strict-checked) and a
  version-pinned zero-dependency CycloneDX SBOM (`dist/sbom.cdx.json`).

## What is explicitly not built yet

- Discovery for vendor dashboards that expose no read API (those sections remain
  unobserved by design).
- Semantic output-equivalence judging; replay compares canonical equality only.
- Multi-factor interaction search in bisection.
- Hosted drift monitoring, dashboards and fleet-wide SaaS UX.
- Traffic mirroring/shadowing and automated promotion/rollback orchestration.
- Built-in per-adapter compensators for release recovery.
- npm publication (the root package stays private as the deployment app; the SDK
  ships via `dist/sdk` plus TypeScript definitions).
- Signed tags/artifacts (no signing key on the release machine).

Treat any claim beyond the implemented list above as roadmap, not product.

## Quick start

```bash
node scripts/pact-release.mjs discover --agent refund-agent --environment production --git --package-root . > descriptor.json
node scripts/pact-release.mjs capture --descriptor descriptor.json > pact.lock.json
node scripts/pact-release.mjs diff --before prod.lock.json --after candidate.lock.json
node scripts/pact-release.mjs gate --before prod.lock.json --after candidate.lock.json
node scripts/pact-release.mjs drift --pinned prod.lock.json --observed live.json
```

`agent.json` holds the agent descriptor: `agent`, `environment`, and any of
`source`, `model`, `prompts`, `skills`, `tools`, `mcp`, `retrieval`, `memory`,
`permissions`, `evals`, `runtime` as plain JSON. Unknown sections are rejected so
typos fail closed instead of silently changing the release identity.
