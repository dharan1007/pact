# Security Policy

PACT is security-sensitive infrastructure. Please do not disclose a vulnerability publicly before the maintainer has had a reasonable opportunity to investigate and ship a fix.

## Supported version

Security fixes target the current `main` branch and the latest tagged release. Older experimental snapshots may not receive patches.

## Report privately

Prefer GitHub's **Security → Report a vulnerability** / private vulnerability reporting flow when it is enabled for this repository.

If private reporting is unavailable, contact the repository owner privately through the contact method on the maintainer's GitHub profile. Do not include exploit details in a public issue, discussion, gist or social-media post.

A useful report includes:

- affected commit/release,
- exact component/adapter/store/endpoint,
- threat model and required attacker capability,
- minimal reproduction,
- impact,
- whether the issue bypasses an invariant or only degrades availability,
- suggested mitigation if known.

Never include real production credentials, customer data or third-party secrets in a report.

## High-priority classes

Please report privately if you find behavior that can:

- forge or replay an approval outside its intended transaction/plan/version/identity,
- reuse a supposedly one-shot commit capability,
- bypass canonical base-version/CAS protections,
- make the same idempotency key commit a different authorized payload,
- make a crash-recovery path accept canonical state from the wrong transaction,
- forge or materially alter a verified receipt/audit record without detection,
- escape adapter-plan validation through prototype-related or unbounded paths,
- leak `PACT_APPROVAL_SECRET`, Redis credentials, bearer tokens or other server secrets,
- make insecure remote HTTP silently equivalent to HTTPS,
- bypass Origin/authentication boundaries in a deployment that has configured them,
- make conflicting/malformed release provenance appear valid.

## Scope clarification

The repository is a reference implementation and security substrate, not a certification that every downstream adapter/application is safe. Domain-specific authorization, identity proofing, business invariants and deployment controls remain the integrator's responsibility.

WebMCP is an experimental integration surface. Browser/API changes upstream may create compatibility issues without representing a PACT cryptographic/transactional vulnerability.

## Coordinated disclosure

The maintainer will acknowledge actionable reports as soon as reasonably possible, reproduce/triage the issue, coordinate a fix and release notes, and credit the reporter if requested and appropriate. Exact timelines depend on severity and the complexity of safe remediation.

Please avoid destructive testing against public/shared infrastructure. Reproduce against local or explicitly authorized environments whenever possible.