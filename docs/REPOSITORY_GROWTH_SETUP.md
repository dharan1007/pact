# PACT GitHub Discovery Setup

## About panel

**Description**

> Transactional safety for AI agent actions: preview the exact plan, approve, commit once, verify canonical state and receive durable receipt evidence.

**Homepage**

`https://pact-webmcp.vercel.app/`

**Topics**

`ai-agents`, `agent-security`, `agentic-ai`, `transactions`, `authorization`, `idempotency`, `audit-log`, `zero-trust`, `human-in-the-loop`, `webmcp`, `mcp`, `model-context-protocol`, `developer-tools`, `security`, `javascript`

PACT competes for the "agent transaction safety" concept, not the existing Pact contract-testing category. Keep descriptions/title text explicit enough to avoid confusion with Pact Foundation tooling.

## Repository features

Enable Issues and Discussions. Maintain Projects only when a public issue-backed roadmap is active. Disable an empty Wiki.

Discussion categories:

1. Announcements
2. Q&A
3. Ideas
4. Show and tell
5. RFC / design
6. Domain adapters
7. Security design (non-vulnerability architecture only)

Pin a welcome post, roadmap post and a "show your PACT adapter/transaction trace" post.

## Social preview

Use a 1280×640 card built around:

```text
INTENT → PREVIEW → APPROVE → COMMIT → VERIFY → RECEIPT

Transactions for AI-agent actions.
```

Avoid permanent numeric security claims on the image.

## Naming/search strategy

The display/product name remains **PACT**, but every discoverability surface should include a qualifier such as "agent transactions", "transactional agent safety" or "WebMCP transactions" because "Pact" is already strongly associated with contract testing.

Do not rename package/repository impulsively; preserve links/history. If a future package is published, choose a namespace that cannot be mistaken for Pact Foundation packages.

## Main branch policy

Recommended:

- require the existing `verify` CI status,
- require conversation resolution,
- block force pushes/deletion,
- prefer squash merging external contributions,
- delete merged feature branches,
- keep security-sensitive CODEOWNERS paths reviewed by the maintainer.

Production promotion should additionally require a real provider transaction and release provenance match where the current workflow supports those gates.

## Security / analysis

Enable:

- private vulnerability reporting,
- dependency graph,
- Dependabot alerts/security updates,
- secret scanning,
- push protection,
- CodeQL/default code scanning.

OpenSSF Scorecard is useful only after its findings are reviewed and maintained.

## Contributor discovery

Maintain a small set of real adapter, negative-test and provider/recovery tasks. Use `good first issue` for bounded schema/fixture/example work; do not label core approval cryptography as beginner work.

Contributor landing page:

`https://github.com/dharan1007/pact/contribute`

## Launch gate

Before a major external launch:

- `npm run verify` green on main,
- production deployment READY,
- real provider transaction gate passes,
- `/demo/`, `/workspace/` and `/api/pact` behave as documented,
- provenance artifact/header match intended source commit,
- SECURITY.md/private vulnerability reporting available,
- no claim that downstream adapters are certified merely because the reference runtime passes.

## Distribution narrative

Lead with a failure developers immediately recognize:

> An agent can retry an API call, but can it prove the user approved the exact plan against the current state, that only one commit won, and that the resulting canonical state actually matches the approved intent? PACT makes those transaction semantics explicit.

Then show replay/stale-state/crash demonstrations instead of leading with cryptographic implementation details.