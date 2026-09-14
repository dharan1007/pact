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

All of the following runs locally and in CI today, covered by `test/release-*.test.js`:

- `pact.lock` — a content-hash release manifest (`src/release-lock.js`,
  schema in `schema/pact-lock.schema.json`). Same agent content always yields the
  same `releaseId`; any tampering fails closed on load. Caller-supplied `sha256:`
  pins are treated as opaque equality-comparable fingerprints, never as verified
  content.
- Structural diff (`src/release-diff.js`) — section-level change classification
  (`breaking`, `permission-changed`, `contract-changed`, `model-changed`,
  `behavioral`, `data-changed`, …) with bounded leaf-level paths and deterministic
  severities. No probabilities are estimated anywhere.
- Immutable lock registry (`src/release-registry.js`) — pin/get/history over the
  same atomic compare-and-swap store contract as the transaction engine, with
  same-key/different-payload replay rejected.
- Drift evaluation (`src/release-drift.js`) — compare a pinned lock against an
  observed snapshot; report `drifted`/`undeclared` sections, list pinned-but-
  unobserved sections as unknown rather than guessing.
- Release gate (`src/release-gate.js`) — deterministic ALLOW/WARN/BLOCK from diff
  severities, change kinds and drift under an explicit policy object.
- Regression attribution (`src/release-attribution.js`) — given a bad release and
  lock history, return the exact changed dependency set ordered by a documented
  severity/class rank. It does not estimate probabilities or confidence scores.
- Transactional recovery (existing engine) — the CONTROL subsystem: one-shot
  authority, idempotent commit, canonical verification, saga compensation and
  operator recovery for reversible/compensable external effects.
- CLI (`scripts/pact-release.mjs`, also `npm run release -- <command>`) with
  `capture`, `diff`, `drift` and `gate` subcommands for CI integration. `gate`
  exits 0 on ALLOW/WARN and 1 on BLOCK; all other failures exit 2.

## What is explicitly not built yet

- Live discovery connectors (OpenAI/Anthropic/LangGraph/MCP fleet scanning).
- Large-scale production-trace replay, shadow execution and canary orchestration.
- Hosted drift monitoring, dashboards and fleet-wide impact search.
- Model-migration qualification against real inference.
- Automatic rollback of agent releases (recovery of external effects exists;
  release promotion control does not).

Treat any claim beyond the implemented list above as roadmap, not product.

## Quick start

```bash
node scripts/pact-release.mjs capture --descriptor agent.json --now 1720000000000 > pact.lock.json
node scripts/pact-release.mjs diff --before prod.lock.json --after candidate.lock.json
node scripts/pact-release.mjs gate --before prod.lock.json --after candidate.lock.json
node scripts/pact-release.mjs drift --pinned prod.lock.json --observed live.json
```

`agent.json` holds the agent descriptor: `agent`, `environment`, and any of
`source`, `model`, `prompts`, `skills`, `tools`, `mcp`, `retrieval`, `memory`,
`permissions`, `evals`, `runtime` as plain JSON. Unknown sections are rejected so
typos fail closed instead of silently changing the release identity.
