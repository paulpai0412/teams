# Goal × team hold/wake — delivered

Delivered and applied on 2026-09-06 for installed `pi-goal-x@0.30.5`.

- Reusable package: `~/.pi/agent/teams/patches/goal-team-hold-wake/`
- Final evidence: `~/.pi/agent/teams/goal-team-evidence/hold-wake-20260906/final-main-only/report.md`
- Rollback backup: `2026-09-06T03-18-29-931Z-4ed43c13`
- Activation: user must run `/reload` or start a new Pi session; the patch never reloads automatically.

The bridge holds only an exactly bound active Goal/task/session/run after structured tool-result
and bounded native-status validation. Native completion must declare a terminal state and the
reopened native status must independently confirm the same terminal owner identity. The bridge
never wakes, launches/resumes a child, completes a Goal/task, changes `autoContinue`, or clears
`teamGoalActiveStep`; `pi-subagents` remains the sole notifier/controller.

Verification: focused installed-source/notifier test PASS (26 cases), home and Grafana helper
checks PASS (50 each), patch check/verify and full disposable apply/idempotence/revert/rollback/
crash-recovery/incompatible/symlink lifecycle PASS, primary LSP 0 diagnostics, scoped pi-lens
0 errors. `goal-task-step.js` remains byte-identical at SHA-256
`8a7301fce7c29ef0eb21376f185795618ec0cb56adcf8e6633b476e43cef668c`.

Declared boundaries: no existing Goal/task was touched and no live Goal/model-child E2E was run;
fixtures use actual installed Goal runtime/events and native notifier with deterministic local
session/status data. The package's declared unit-runner file is absent. Independent reviewers
found the pre-fix early-release P1, but the user then required main-agent-only execution, so the
post-fix candidate has no independent child review. Package updates may overwrite installed
source; rerun package `--check` and never bypass its version/hash gate.
