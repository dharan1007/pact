# AGENTS.md — PACT

## Product

PACT is a transaction/authority layer for consequential agent actions. Its canonical lifecycle is preview → authenticated approval → one-shot authority → idempotent commit → canonical verification → receipt, with durable inspection/recovery.

## Non-negotiable invariants

- Approval must remain bound to the exact transaction, plan hash, base version and identity/session claims.
- Commit authority remains short-lived and single use.
- Consequential commit calls require an explicit idempotency key.
- Same-key/different-payload replay is rejected.
- Canonical state mutations preserve atomic compare-and-swap/single-winner semantics.
- Crash recovery reconciles only the exact authorized transaction against authoritative state.
- Verification checks canonical state; transport success is insufficient.
- Corrupt/non-monotonic durable records fail closed.
- Release provenance rejects malformed/conflicting source identities.
- WebMCP is an integration surface, not a bypass around PACT authority.

## Read first

1. `README.md`
2. `SECURITY.md`
3. `src/adapter.js`
4. `src/api-authority.js`
5. `src/durable-state.js`
6. `src/canonical-store.js`
7. `src/authority.js`
8. `src/server-approval.js`
9. `src/redis-store.js`
10. `ROADMAP.md`

## Verification

```bash
npm install
npm test
npm run check
npm run build
npm run verify
```

## Change discipline

- Security/state-machine changes need negative/adversarial tests.
- Adapter examples must identify authoritative state and verification, not just remote API success.
- Never commit Redis tokens, approval secrets or signed real approval claims.
- Keep provider failures explicit.
- Update machine-readable schemas/manifests when external contracts change.
- Do not create or advertise a remote MCP registry endpoint until one actually implements the PACT transaction contract.