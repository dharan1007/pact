## Problem / failure mode

<!-- What transaction, safety, adapter or developer problem does this solve? -->

## State-machine change

<!-- Which lifecycle states/transitions/invariants are affected? Write "none" if truly none. -->

## Verification

- [ ] `npm test` passes.
- [ ] `npm run check` passes.
- [ ] `npm run build` passes.
- [ ] `npm run verify` passes.
- [ ] Negative/adversarial tests were added where security or transaction semantics changed.
- [ ] Real-provider verification is described if a provider path changed.

## Transaction invariants

- [ ] Exact plan/base-version binding is preserved.
- [ ] Approval authentication/binding is preserved.
- [ ] Commit authority remains one-shot and bounded.
- [ ] Idempotency / same-key-different-payload behavior remains explicit.
- [ ] Canonical CAS/recovery/verification semantics are preserved.
- [ ] Receipt/provenance claims remain truthful.

## Security / deployment impact

<!-- Secrets, Redis/store, auth, Origin, provider, provenance or operational implications. -->

## User-facing proof

<!-- Reproduction, adapter example, transaction trace or screenshot. -->

## Documentation / schemas

<!-- README, SECURITY, manifest, schemas, SDK docs changed or why not. -->