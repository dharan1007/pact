# PACT — Transactional WebMCP

PACT is a trust and transaction layer for consequential browser-agent actions. Instead of granting an agent broad application access, PACT turns intent into one exact semantic transaction, binds human approval to its plan hash and canonical state version, commits under short-lived authority, verifies the canonical outcome, and emits a tamper-evident receipt.

## Product routes

- `/` — product thesis and why PACT exists
- `/demo/` — guided Autopilot demo with one human approval checkpoint
- `/workspace/` — expert transaction, state, capability and audit controls
- `/how-it-works/` — protocol lifecycle
- `/security/` — threat model and enforced invariants
- `/developers/` — WebMCP capability lifecycle

## Autopilot

Normal usage is intentionally simple: PACT automatically starts the reference transaction, builds the exact preview and runs safety checks. It stops once at `PREVIEWED` for a trusted human decision. After approval, PACT automatically commits, verifies postconditions and negative invariants, anchors the receipt, and exposes rollback eligibility. Agents receive aggregate `pact_autopilot_prepare` and `pact_autopilot_finish` tools in addition to granular expert capabilities.

PACT never synthesizes the trusted human approval event.

## Verification

```bash
npm run verify
```

The suite covers exact-plan binding, stale-state rejection, lease expiry, preconditions, negative invariants, commit/verify idempotency, receipt integrity, audit-chain tampering, rollback conflicts, fail-closed persistence, cross-tab locking/CAS, WebMCP lifecycle, Autopilot approval boundaries, multi-route asset integrity, and deterministic release generation.
