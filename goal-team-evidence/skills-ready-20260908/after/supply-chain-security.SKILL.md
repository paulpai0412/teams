---
name: supply-chain-security
description: Statically assess dependency, CI/CD and artifact-provenance risks, or prepare approved release configuration and rollback plans. Use for supply-chain changes; no scanning, signing or deployment execution.
---

# Supply-chain review and release preparation

Local guidance shared by two existing roles: security is read-only; release may edit
only parent-approved pipeline/config/runbook files. Neither role gains shell, cloud,
credentials, signing, publishing or deployment authority from this skill. No installs,
delegation or shared-memory writes. Follow the parent's schema and required gates;
writer acceptanceReport remains a native sibling.

## Establish the candidate

Identify approved source/ref, dependency manifests/lockfiles, pipeline entrypoints,
artifact identity, target environment and required checks. Separate source review,
build evidence, published artifact, deployment and health/readback. Missing target
or evidence is a gap, not permission to invent a release receipt.

## Review relevant boundaries

- **Dependencies:** compare manifest and lockfile changes, registry/source URLs,
  integrity fields, version pinning, install hooks and added transitive dependencies.
  Consider dependency confusion, typosquatting, unexpected maintainers and licenses.
  A lockfile hash is not proof a dependency is safe or that a CVE is exploitable.
- **CI inputs and privileges:** trace untrusted PR/issue/artifact values into commands;
  inspect event context, token scopes, third-party action immutable pins and runner
  isolation. Never run untrusted PR code with privileged target-branch credentials.
- **Secrets and identity:** assess where credentials originate and where they could
  flow without retrieving their values. Prefer narrowly scoped, short-lived identity
  where already supported; inspect OIDC issuer/audience/subject and protected targets.
- **Artifacts:** require a binding from reviewed source to actual build digest and
  promotion candidate. Inspect provenance/SBOM/signature evidence when required;
  distinguish generating a signature from verifying it against an approved identity.
- **Release safety:** inspect approval gates, concurrent deployment controls, immutable
  promotion and post-deploy health/readback. Define rollback trigger and exact known
  good artifact; data migrations may not be reversible by reverting the application.
- **Scanner evidence:** assess supplied reports with tool/version/date/database/source
  context and reachability. Stale or absent scanning is not a clean bill of health.

## Work and evidence

Read source and supplied artifacts; do not execute scans, containers, PoCs, signing
commands or credential retrieval. Request a parent-approved isolated check when needed,
including the source scope, expected evidence and side-effect constraints. Never
upload source/SBOM to a service or start continuous monitoring from this skill.

Security reports findings with file/location, trust-boundary path, likely impact,
confidence and a bounded remediation suggestion. Release prepares only the authorized
config/runbook delta and a plan specifying candidate, protected checks, approvals,
rollback and health criteria. Actual publication/deployment belongs to the parent
under separate target/action approval. Do not claim it occurred from a valid plan.

## Optional reference

[GitHub Actions secure use](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions).
External docs and example commands do not grant execution or install authority.
