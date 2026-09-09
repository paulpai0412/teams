# Agent teams efficiency implementation — 2026-09-08

## Scope and result
Parent-only implementation; no model child, new controller, model/tool/permission
change, Goal/mission mutation, dependency installation, App source change, commit or
publication. Completed the approved offline TDD scope. Independent live review/TUI
canary and real token/time comparison are NOT claimed.

## Changes
- `goal-request.mjs`: early attempt validation; preserve work/retry identity; reject
  dropped/conflicting legacy checks. New --dispatch requires explicit work and calls
  existing effective-profile/command capability preflight before saving artifacts.
- `work-contract.mjs`: small shared responsibility/criteria/check validator, reused by
  Goal preparation and ordinary handoff. No natural-language classification.
- `handoff-contract.mjs`: optional same work contract; existing native schema and
  acceptance preflight reused, not a second role/capability registry.
- `goal-task-step.js`: fixed per-criterion schema and validation; role-scoped child
  packet once; compact execution/report/product outcomes; task/role three-admission
  ceiling independent of phase/source names; reason/evidence for later admissions;
  no report-only relaunch at unchanged source; original active/replay safeguards kept.
- `check-goal-dispatch.mjs`: fixture migrated to new required work contract.
- `EFFICIENCY-CONTRACT.md` plus linked operating/handoff/Goal/evidence/team-flow docs:
  reviewer vs scenario QA vs actual browser execution, host-first checks, affected
  evidence reuse, bounded recovery, and no routine startup/progress echoes.

## TDD evidence

| Slice | RED | GREEN |
| --- | --- | --- |
| Reject attempt 4 before dispatch artifacts | dispatch-red.log | dispatch-green.log |
| QA cannot own browser execution | work-red.log | work-green.log |
| Explicit work and actual no-shell capability | capability-red.log | capability-green.log |
| Summary-only report cannot pass | criteria-red.log | criteria-green.log |
| Renamed phase ceiling and separate failed execution/report | budget-outcome-red.log | budget-outcome-green.log |
| Read-only report source consistency | source-red.log | source-green.log |

`all-green.log`: **17 final node:test tests pass**. Includes positive compatibility,
exact command/criterion preservation, missing/foreign/duplicate rows, no retry without
reason, report-only no-relaunch and source-binding rejection.

`evidence-reuse.test.mjs` confirms EXISTING host functionality without new production
code: one real check run, unrelated scope edit permits verify, relevant edit rejects;
verify never executes the check again. This was already green, not a claimed new RED.

Run from any cwd:

```sh
node --test /home/timmypai/.pi/agent/teams/goal-team-evidence/efficiency-20260908/*.test.mjs
```

Six existing suites (logs `final-*.log`), all PASS:
- goal-dispatch: 12 cases, real CLI + disposable native state.
- goal-step-storage: 8 cases, 50 synthetic steps; state 38,386 bytes (<80 KiB bound).
- handoff-contract: 43 cases.
- team-outcomes: 54 cases.
- host-evidence: 23 cases.
- goal-team: 54 cases, includes native workflow syntax validation.

Primary LSP: 8 changed JS/test files, zero diagnostics. Workflow body uses its native
validator via goal-team suite (not standalone JS top-level-return assumptions).

## Measured vs unmeasured
- Bad preparation: zero generated dispatch artifacts and zero model calls.
- Fourth phase-renamed task/role admission: launch count remains 3.
- Missing-report retry: launch count remains 1.
- Unaffected receipt reuse: real command count remains 1; changed scope still rejects.
- Small check packet retains command/criterion once, <2,000 bytes in the test fixture.
- Admission/outcome metadata increases stored state; this is accepted bounded overhead,
  NOT a claim that every packet/state is smaller. Reduced repeated runs are the aim.
- No live provider token, latency, cost, or quality measurements; no percentage savings.

## Compatibility and limits
New --dispatch inputs need work; saved legacy effective packets remain readable.
No old Goal or mission was rewritten. Prior historical admissions are not automatically
backfilled. Parent must inspect history on recovery. Do not change role/task/mission
or delete counters to bypass the ceiling. Explicit scope/budget changes require user
approval. Direct native calls are not covered by these helper checks.

Effective shell checks do not replace selected-role skill/model readiness or actual
browser availability; no missing skill is installed or requirement removed. Work is an
explicit contract, not proof that free-text task prose is contradiction-free. Source
echo is correlation; actual host verification and all REQUIRED gates remain necessary.
No automatic promotion of captured pass after failed execution. Original native errors
and reports remain evidence; main must reconcile, not invent a wrapper failure.

## Backups, hashes and rollback
`manifest.json` identifies all 11 production/doc paths and their before/after hashes.
`changes.diff` is the exact delta. `goal-request.mjs.before` predates slice 1;
`before/` contains the other original changed files. New files have before=null.

Rollback only when no owned child is active and every target matches its manifest
**afterSha256**; if it differs, stop and reconcile later edits. Restore existing files
from their recorded before paths and remove only the two newly introduced production/
document files (`work-contract.mjs`, `EFFICIENCY-CONTRACT.md`) after verifying hashes.
Preserve this evidence directory. Never restore all of ~/.pi or clear Goal/mission state.
Helpers load on invocation; existing sessions must reread/reload changed guidance.
Older hash-gated patch bundles may reject these changed helper hashes. Do not bypass
or blindly reapply them; rebase upgrades against this preserved delta.

## Retrospective
1. Dispatch contract checks must run before any model turn; skills alone cannot repair
   contradictory assignments. Reused native capability validation rather than a new runner.
2. Preserve evidence and classify failure before retry. Role/phase renaming must not
   reset counts; no report-shape issue justifies rerunning the writer.
3. Prefer existing exact-scope verify/reuse; no model is needed to repeat deterministic
   commands. Validate speed with a future authorized live canary, not fixture counts.
