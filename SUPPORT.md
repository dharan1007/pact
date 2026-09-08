# PACT Support

## Usage / integration questions

After Discussions is enabled, use **Discussions → Q&A** for adapter design, SDK usage and transaction-lifecycle questions that are not confirmed defects.

Before asking, review:

- `README.md`
- `/developers/` on the live product
- `pact-manifest.json`
- `schema/pact-adapter.schema.json`
- `docs/agent-bridges.md`

## Bugs

Use the structured bug form. Include the transaction state, operation (`preview`, `approve`, `commit`, `verify`, `receipt`, `inspect`), canonical base version, error code and minimal reproduction. Remove all credentials and approval secrets.

## Adapter proposals

Use the adapter proposal issue form. Explain the authoritative state source, effects, invariants, approval identity, idempotency and post-commit verification. "Call API X" alone is not enough to define a PACT adapter.

## Security

Potential approval, authority, replay, canonical-state, receipt, credential or provenance vulnerabilities must be reported privately according to `SECURITY.md`.

## Response expectations

There is currently no paid or guaranteed-response SLA. GitHub is the canonical public support channel.