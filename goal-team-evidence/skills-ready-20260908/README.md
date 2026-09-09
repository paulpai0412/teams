# Missing team skills — approved local remediation (2026-09-08)

## Result

The five missing declared skills are now installed as **original local role guidance**
under `~/.pi/agent/skills/<name>/SKILL.md`; their catalog entries are updated.
All 14 roles pass the real **roles-only** configuration check. This supersedes prior
missing-skill status snapshots, not their historical test results. No claim of full
extension/environment health, browser execution, model quality or independent review.

User explicitly selected this work and approved creating/enabling the five local
versions without adding execution packages or changing roles/models/permissions.
No child agents, browser tests, live Goal/mission mutations, App changes or publication.
Public web sources were inspected; no upstream package or bootstrap script was installed.

## Inventory and compatibility review

A symlink-following inventory inspected 122 existing skill files and found no matching
names. Same-name candidates were found in zhaoxuya520/reverse-skill, but that is not proof
of original provenance. Those files included bootstrap instructions, extra skill/tool
routing, execution workflows and references to prior-case authorization. They were not
adopted verbatim. Popularity/stars were not used to justify their trustworthiness.

| Local skill | Role-compatible content |
| --- | --- |
| docs-generator | Source/evidence-based docs; no-shell example checks requested from parent; docs-only edits |
| browser-automation | Existing approved harness, isolated context, user-facing assertions, persistence/readback, safe evidence and owned cleanup; no installs/production sessions/harness edits |
| supply-chain-security | Static dependency/CI/provenance analysis; release prepares authorized config/runbook, security stays read-only; neither scans/signs/deploys |
| code-audit | Trace actual entrypoints/callers/sinks, auth and tenant boundaries, exception/data-safety paths; evidence/confidence and proposed checks, no active attacks |
| llm-security | Untrusted input/authority/tool/memory/output/recovery boundaries; no live attacks/provider calls or memory poisoning; prompt guidance is not a runtime control |

All five preserve the assigned schema and existing role authority. They contain no
executable helpers, install hooks, allowed-tools grants or nested controllers. Manual
scope/content review is not a model-behavior or security certification.

## Additional bug caught by actual dispatch preparation

The all-role check passed, but public preparation for `team.e2e` failed because selected
role validation accepted only letters. `check-skills-red.log` captures the real failure.
`check-config.mjs` now accepts a letter followed by letters/digits in the role suffix.
The existing exact canonical-role whitelist still rejects unknown names; duplicate
selection still rejects. No new role, tool or permission was admitted.

## Evidence

- `roles-red.json/.err`: actual prior four missing-skill failures.
- `roles-green.json/.err`: real resolver/effective roles PASS, 14 roles, app cwd.
- `check-skills.log`: **8 cases PASS** in disposable cwd. Four roles prepare through
  the public API with exact expected skill paths; docs/release execution checks remain
  rejected for no shell; unknown team.e3e and duplicate team.e2e remain rejected.
  No command execution, launch artifacts, child agents or browser runs in the fixture.
- `regression.log`: **28 existing usability/efficiency tests PASS**, including deliberate
  project-override missing-skill negatives (not dependent on host skills staying absent).
- `previous-overlay.log`: existing 29-file source overlay still verifies unchanged.
- `roles-before.sha256`: all four actual profile files retain their exact hashes.
- Primary LSP: changed check-config and check-skills scripts clean. Generated JSON LSP
  was unavailable; JSON was parsed by the actual tools and stdlib, not called LSP-clean.
- `manifest.json`, `after/`, original catalog/check-config copies and `changes.diff`:
  8 changed/new files, exact bytes and backup paths. No settings/auth material.

## Sources reviewed

- Local installed Pi `docs/skills.md`; [Agent Skills specification](https://agentskills.io/specification).
- [Playwright best practices source](https://github.com/microsoft/playwright/blob/main/docs/src/best-practices-js.md)
  (the rendered documentation endpoint failed; GitHub source was readable).
- [GitHub Actions secure use](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions).
- [OWASP LLM risks](https://genai.owasp.org/llm-top-10/) and [ASVS](https://owasp.org/www-project-application-security-verification-standard/).
- Rejected same-name candidates: `https://github.com/zhaoxuya520/reverse-skill/tree/main/skills/`
  (five corresponding SKILL.md files inspected, not installed or treated as authority).

## Recheck and rollback

```sh
node ~/.pi/agent/teams/goal-team-evidence/skills-ready-20260908/check-skills.mjs
PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=off node ~/.pi/agent/teams/check-config.mjs --roles-only "$PWD"
```

Use `/reload` or a new session to refresh the parent skill catalog; no session was
restarted automatically. Per-task browser/executable/auth/fixture checks still apply.
Required independent review and live canary for the broader teams repair remain open.

Before rollback, verify each manifest target still matches postSha256; stop on later
changes. Restore the saved catalog and check-config together if rolling back the whole
slice; remove only the five matching new SKILL.md files, not whole parent directories.
Do not delete unrelated skills or change roles to conceal missing guidance. Removing
these skills deliberately restores the corresponding readiness failures.

Lesson: successful all-role discovery does not establish selected-role dispatch parity;
exercise actual canonical names including digits, and keep unknown-role negatives.
