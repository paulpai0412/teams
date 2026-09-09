# Delivery repair — installed, partial acceptance

2026-09-08. User authorized 開始修正 / 繼續. Main-only: no agent children, existing Goal/mission/focus changes, model/permission/global concurrency changes, dependency installation, reload, commit/push, publication or deployment.

## Delivered

- `teams/host-evidence.mjs`: parent host-check CLI with explicit source/command/runtime identity, before/after snapshots, original logs/exit, bounded reads, permanent exclusive command intent, no automatic retries, and freshness validation. Failures, source/log drift, altered commands, timeouts and unresolved attempts do not become PASS.
- Optional parent-owned acceptance contract/reference: required checks and artifacts plus explicit entrypoint observations. Canonical JSON metadata avoids formatting-only contract identity drift; source and raw evidence stay byte-bound. New judgments invalidate the previous ready decision before checking. Parent semantic judgment and independent review are not fabricated or cryptographically proven.
- `goal-request.mjs --dispatch`: derives the source fingerprint and native setup/dispatch args; persists a content-addressed effective packet/setup script. Recovery uses the existing CLI. Refuses mismatched binding/active intent, carries the chosen timeout into `runs.run`, and preserves the existing compact v2 history/legacy replay behavior. Not an atomic dispatch or admission bypass.
- Goal completion guard for explicitly registered new contracts: task validation and the shared Goal completion transaction recheck required receipts/source; Goal intent changes, active/unresolved mission intents and missing evidence block. Existing settings/legacy Goal behavior remain user-owned.
- Found and fixed the real persistence boundary: GoalService can acknowledge completion only in its turn buffer. The opt-in path now reuses existing `endTurn()`/`isTurnBuffered()` before the completing transaction, then the native lock/write path; no new store or controller. Tests read actual disposable Goal files and verify pending usage survives. This is not merely a fake callback counter.
- Role readiness failures now expose exact `missingSkills` and `missing-declared-skill` without weakening the failure. Updated EVIDENCE-PRACTICE, GOAL-TEAMS, HANDOFF-PRACTICE and OPERATING-MODEL.

## Installed patch and rollback

- `pi-goal-x@0.30.5`, `pi-subagents@0.64.0` unchanged.
- Patch: `patches/goal-team-delivery/`, ID `pi-goal-x-0.30.5-goal-team-delivery-v1`.
- Base: hold-wake v1 → reliability v2 → delivery v1.
- Runtime targets: `extensions/goal-completion.ts`, `goal-task-tools.ts`, new `goal-team-evidence.mjs`. The new module equals the parent helper byte-for-byte.
- Backup: `2026-09-08T03-45-26-051Z-f166ce8e`.
- `applied.json`, `verified.json`: actual installed APPLIED / VERIFIED. `apply.mjs --check` reports COMPATIBLE/post. No reload performed.

```sh
node ~/.pi/agent/teams/patches/goal-team-delivery/apply.mjs --check
node ~/.pi/agent/teams/patches/goal-team-delivery/apply.mjs --verify
node ~/.pi/agent/teams/patches/goal-team-delivery/apply.mjs --revert 2026-09-08T03-45-26-051Z-f166ce8e
```

Revert removes the optional protection. First pause/review any new Goals relying on those references; do not silently remove their requirements. Older overlapping patch wrappers are expected to reject the newer hashes.

## Mechanical evidence

| Check                                                              | Result / raw evidence                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Missing host-check seam                                            | RED: `host-red.log`                                                                         |
| Existing completion accepted without sealed evidence               | RED: `completion-red.log`                                                                   |
| Completion acknowledged while native file remained active          | RED: `completion-buffer-red.log`                                                            |
| Actual completion entrypoints + native buffered/persisted boundary | 33 PASS in candidate/installed runtime verification                                         |
| Real host CLI/process/failure/freshness checks                     | 23 PASS in runtime verification                                                             |
| Existing hold/native-status behavior                               | 30 PASS in runtime verification                                                             |
| Candidate frozen-source host receipt                               | `checks/candidate-input.json`, `candidate.json`, `.intent`, `.log`; final verify succeeded  |
| Real preparation CLI, effective-packet recovery, timeout           | 12 PASS: `dispatch-green.json`                                                              |
| Native state store / 50 × 8 KiB history                            | 8 PASS, 25,454 bytes: `storage-green.json`                                                  |
| Goal compatibility home/Grafana                                    | 54 each: `goal-home.json`, `goal-grafana.json`                                              |
| Selected-role behavior home/Grafana                                | 11 each: `roles-home.json`, `roles-grafana.json`                                            |
| Handoff / existing outcome gate                                    | 43 / 54: `handoff.json`, `outcomes.json`                                                    |
| Real package CLI / absent-file rollback / mixed revert / hashes    | 11 PASS: `package-green.json`; disposable target only                                       |
| Primary LSP                                                        | Six changed/helper/candidate files, zero errors; not a full project scan                    |
| Session diagnostics                                                | lens all/error: no errors across 26 diagnosed files; JSON analysis coverage warnings remain |

The candidate receipt binds its declared files and original command output. Other logs are paired with the final source inventory, not falsely described as signed host attestations. Package test backup manifests are fixtures, not the installed backup receipt.

Final source capture: `final-source.sha256` covers 29 maintained/helper/patch/runtime files; `final-hash-check.log` passed. The explicit formatter check passed, and the candidate host receipt was re-verified afterward. `before/` contains partial helper backups; the runtime patch has its own exact three-target backup/rollback, not a claimed one-command rollback of every helper/document edit.

## Required gates still missing

**Overall remains partial.** Independent lifecycle/security review and live Goal/TUI canary are REQUIRED and absent; user declined reviewer/children. No model-quality, browser, live Goal pause/resume or time-to-accepted improvement is claimed. JSON LSP coverage gaps are not called a full clean scan. The helper is not a secret scanner, environment-complete fingerprint, tamper-proof signature, cross-session CAS, continuous watcher, or descendant-process cleanup guarantee. Later edits can invalidate evidence; they do not automatically reopen a completed Goal.

Legacy/unregistered Goals do not gain the new gate automatically. Explicit disableContracts/disableTasks choices are preserved. Missing required product evidence still blocks acceptance under the parent policy, regardless of those user settings.

## Dependency review — no profile weakening

Actual profiles were inspected. Current all-role readiness remains FAIL (`role-health.json`, exit 1 in `role-health.log` context):

| Role     | Missing declarations                            | Assessment / action                                                                                                                                                                                                   |
| -------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| docs     | docs-generator                                  | Authoring guidance; absence does not itself prove an executable is missing. Retain the requirement pending an approved replacement/remediation.                                                                       |
| e2e      | browser-automation                              | Role permits browser/CLI/API flows. A future scoped proposal can distinguish browser guidance from CLI/TUI requirements; no requirement was removed here. Actual executables/harness still need task-specific checks. |
| release  | supply-chain-security                           | Security guidance for release preparation, not deployment permission. Role remains without shell/deploy capability.                                                                                                   |
| security | code-audit, llm-security, supply-chain-security | Threat-review guidance. Active scanning still belongs to an approved isolated parent/verifier path; installed guidance alone would not certify that path.                                                             |

Do not install skills or delete declarations just to obtain PASS. Unchecked sections after a role failure remain unverified.

## Source stability and historical drift

An explicit installed-formatter pass precedes this final source capture. This is necessary because pi-lens normally formats at agent_end. No global formatter/lint setting was changed.

The prior reliability ledger remains historical: the earlier eight helper AST comparisons established formatting equivalence only for those eight. The old bytes of apply.mjs/verify-runtime.mjs could not be reconstructed from the retained source-diff (their source additions are absent there); no assertion of semantic equivalence is made for those two. This round inspected the current applier in full, reused it unchanged, and tested its current behavior with the 11-case package suite, establishing a new baseline instead of overwriting old hashes.

## Bounded retrospective

1. A real mutation callback is not necessarily the persistence boundary. The native buffered-file RED test caught what the initial fake-service checks missed; retain that test before future completion changes.
2. Reuse existing GoalService buffering APIs rather than introducing another transaction/store layer. Use a module outline early to discover these APIs before designing alternatives.
3. Format first, then freeze/check, and only rerun affected checks. Report formatting, environmental, semantic and persistence failures separately.
4. Fixture counts/local check durations are not efficiency evidence. Measure first-pass acceptance, main+child tokens, wait time and rework causes on real tasks before altering routing/concurrency.
