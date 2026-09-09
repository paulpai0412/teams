# Agent teams usability corrections — 2026-09-08

**Status: offline implementation verified; overall operational acceptance PARTIAL.**
Main-only. No model calls, real children, live Goal/mission edits, App edits,
installation, model/tool/permission changes or publication. Native `subagent validate`
was used only for offline syntax validation, not dispatch. TODO-73b0ff5e remains open.

## Changes

1. `goal-request.mjs`: async public `prepareGoalDispatch` and CLI share work/shell
   preflight plus existing selected-role check-config readiness before saving artifacts.
   No second capability registry or installer. `prepareGoalRequest`/non-dispatch CLI
   remains normalization for saved data, not the supported new-work entrypoint.
   New effective packets preserve sourcePaths; attempts 1..4 allow initial + 3 repairs.
2. `goal-task-step.js`: v2 repair ledger, 3 authorized repair replays per task/role,
   not 3 successful slices. Successes do not require fake retry explanations; source or
   phase renaming never resets accumulated repairs. Old count-ledgers fail closed.
   A failed record needs typed parent recovery; text retry cannot repeat report work.
   Throws retain blocked/unknown outcomes, original bounded error/available references,
   active ownership and native throw behavior; unknown is not 'no child launched'.
3. `goal-recovery.mjs`: parent reads exact native workflow status, sibling mission
   binding, actual mission record and saved request. Requires unique terminal child
   identity and fresh host-check receipt/intent/log/runtime on the original source
   scope. Emits a zero-child state script with changed-record/binding/other-owner
   guards and idempotent partial-write recovery. Adds a separate decision, preserving
   original failure/unknown status. report-only never permits replay; captured pass
   cannot receive retry authority. Source must match at next failed-step admission.
4. Documentation and affected old tests updated to the corrected behavior. The original
   three-success ceiling test was wrong; its saved preimage and logs remain preserved.
5. `check-installed.mjs`: read-only chronological verification of known hold-wake →
   reliability → delivery → flow-fixes → efficiency → usability layers. Checks saved
   pre/post bytes, overlapping hash continuity and all 29 final files. An isolated
   copied-stack negative test rejects one altered installed byte. Old wrappers were
   NOT patched or bypassed; this is not a clean-install/upgrade installer.

## Validation at final source

- `all-tests.log`: **28 node:test tests pass**, including 11 new tests and 17 prior
  tests (affected expectations migrated). Four successful slices; three authorized
  repairs + no fourth; API/CLI readiness parity; throw outcome retention; terminal,
  identity, scope/freshness and changed-record negatives; report-only no replay;
  recovery replay after record-write/marker-clear boundary, producer-to-consumer retry
  exactly once, rejection of bare recovery labels without provenance; copied-stack tampering.
- Six existing suites: **194 cases pass**: dispatch 12, storage 8, handoff 43,
  outcomes 54, host evidence 23, Goal/team 54. Separate named `.log` files here.
- 50-step native mission storage fixture: **39,386 bytes**, below existing 80 KiB bound.
- Primary LSP: 11 JS/test files, zero diagnostics. Session lens: only three existing
  App reduced-motion !important warnings; generated roles.json had unavailable JSON
  language analysis, not a source-code clean claim.
- Native validate: current goal-task-step.js and generated recovery.workflow.txt
  both `{ok:true,errors:[]}`. Test runs/state/status fixtures are not provider E2E.
- `installed-overlay.log`: 29 exact final files verified; `installed-negative.log`
  proves changed-byte rejection in a disposable copy, never by tampering live source.
- RED evidence: preparation-red, lifecycle-red, ordinal-red, recovery-red and
  recovery-replay-red and recovery-provenance-red logs. recovery-red is an absent-new-module baseline, NOT a
  behavioral old-runtime reproduction; other named REDs exercise actual prior behavior.
- `roles.json` remains FAIL for docs/e2e/release/security missing declared skills.
  These selected roles now block new Goal preparation; nothing was auto-installed.

## Operational boundaries / outstanding gates

- REQUIRED independent review and explicit-authority live Goal/TUI/provider recovery
  canary are still absent. No measured live token/time/cost improvement. Do not mark
  the whole usability task done or advertise autonomous/general long-task reliability.
- The parent must choose a host check that actually proves resolved effects/outcomes.
  An arbitrary exit-0 check is not semantic acceptance. Recovery's continue decision
  does not change a failed child into a passing product; final task gates still apply.
- Unknown/absent native child identity, old packets without source scope and old
  count-ledgers remain blocked for deliberate parent migration; no invented history.
  Existing goals/missions were not migrated. Single-owner state, not CAS/exactly-once.
- Preparation and later state-script application are not atomic with filesystem/native
  changes. Recheck source/native status before applying; next dispatch compares the
  source binding. External environments and other processes are still parent checks.
- Ordinary handoff/direct native/state-edit paths are not a global guarded gateway.
  This change unifies the supported Goal dispatch API/CLI, not every controller API.
- Read-only overlay verification resolves the known superseded-hash diagnosis, not
  a tested package-upgrade/rollback transaction. Never force old hash-gated installers.

## Re-run

```sh
node --test ~/.pi/agent/teams/goal-team-evidence/usability-fixes-20260908/*.test.mjs \
  ~/.pi/agent/teams/goal-team-evidence/efficiency-20260908/*.test.mjs
node ~/.pi/agent/teams/goal-team-evidence/usability-fixes-20260908/check-installed.mjs
```

Recovery input and command are documented in `teams/EFFICIENCY-CONTRACT.md`.
Do not execute recovery setup against a live mission merely to test it.

## Backup / rollback

`manifest.json`: 18 edited/new code/test/doc files with before/after paths and SHA-256.
`changes.diff` and `before/`/`after/` preserve the exact delta. No auth/config/Goal data.
Before rollback, stop/reconcile affected work and verify EVERY target still matches
postSha256; otherwise stop and reconcile later edits. Restore matching before files
as a coherent helper/docs/test set; remove newly introduced paths only if their exact
postimage is still present and no later consumer depends on them. Never reset missions
or old counters to make rollback/preflight pass. Existing package-runtime fixes remain.

## Bounded retrospective

- Test realistic successful progression plus failure recovery, not only rejection
  branches. Success admissions and implementation repairs are different concepts.
- Test returned failure AND thrown failure, plus public API AND CLI. One green route
  cannot establish parity; zero model calls are enough for these counterexamples.
- Keep host/source/raw-error evidence separate from acceptance and semantic judgment.
  Versioned source overlays explain expected stale wrapper rejection without disabling
  hash guards or pretending an installer/live workflow has been tested.
