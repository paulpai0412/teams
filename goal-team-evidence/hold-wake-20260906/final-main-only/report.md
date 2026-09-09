# Goal/team hold-wake — main-agent-only final report

Date: 2026-09-06
Target: installed `pi-goal-x@0.30.5`
Mode: main-agent-only after user direction; no post-fix child/reviewer launch.

## Result

The local hold-wake patch is applied and its current installed files exactly match the
package postimages. It is not active in this already-running Pi process; activation still
requires a user-initiated `/reload` or a new session.

Final backup name: `2026-09-06T03-18-29-931Z-4ed43c13`.
Reusable package: `/home/timmypai/.pi/agent/teams/patches/goal-team-hold-wake/`.
Exact hashes: `final.sha256` and `patch-package.sha256` beside this report.

## Review finding and repair

The stopped independent review wave identified a reachable P1: an identity-matching generic
`subagent:async-complete` event could release a hold without proving terminal state. The
main-agent-only repair now requires both:

1. a matching event with a recognized terminal state; and
2. a newly opened, bounded native `status.json` whose terminal state and complete owner
   identity match the persisted binding.

Identity-only replay and a terminal-looking event while native status is still active are
covered by the focused regression. Completion handling rechecks that the same binding is
still current after the asynchronous status observation, preventing a late duplicate from
releasing or superseding a newer binding.

The patch wrapper was also hardened to reject symlink/non-regular target files, validate the
exact backup inventory, and recover a named `prepared` backup from a crash-interrupted mixed
pre/post tree.

## C1–C5 disposition

| Criterion | Status | Observed evidence |
| --- | --- | --- |
| C1 exact active run suppresses Goal checkpoint without pausing Goal | met | `check-goal-hold-wake.log`: 26 cases pass; `checkpointWhileHeld=0`; Goal fixture stays active/autoContinue. |
| C2 native success/failure returns control once, without bridge side effects | met | The check loads the actual installed `pi-subagents` notifier: one native wake for success, one for failure, `bridgeWakeCount=0`; duplicate observer event is deduplicated. |
| C3 pause/stop/unfocus/foreign/newer/late events never revive stale work | met | Explicit pause, stopped Goal, no-focused-Goal, task-change, foreign session, active-status replay and duplicate/late cases pass. |
| C4 restart reconciles retained status without blind relaunch or permanent marker hold | met | Active RPC + independently validated status restores hold; terminal and missing/unknown status release to reconciliation. The bridge has no launch/resume path. |
| C5 exact-source integration and update-safe package/docs | met with declared boundary | Installed runtime/events/hold equal manifest postimages. `--check` and `--verify` pass. Lifecycle evidence covers apply, idempotence, named revert, forced-failure rollback, interrupted-apply recovery, unsupported hash and symlink rejection. Home and Grafana helper checks each pass 50 cases. Operations and update/reload limitations are documented. |

## Verification

- `node ~/.pi/agent/teams/check-goal-hold-wake.mjs` — PASS, 26 cases.
- `node ~/.pi/agent/teams/patches/goal-team-hold-wake/apply.mjs --check` — compatible, state `post`.
- `node ~/.pi/agent/teams/patches/goal-team-hold-wake/apply.mjs --verify` — VERIFIED, 26 focused cases.
- `PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=off node ~/.pi/agent/teams/check-goal-team.mjs /home/timmypai` — PASS, 50 cases.
- Same helper check from `/home/timmypai/apps/grafana` — PASS, 50 cases.
- Primary LSP diagnostics on seven changed JS/TS files — 0 diagnostics.
- Scoped pi-lens full/error scan — 0 errors; mode=all reported only pre-existing/intentional style warnings in local checker files.
- `goal-task-step.js` preserved exactly: SHA-256 `8a7301fce7c29ef0eb21376f185795618ec0cb56adcf8e6633b476e43cef668c`.
- Patch lifecycle summary: `../patch-lifecycle-main-only/summary.json`.

## Boundaries and residual risks

- No existing Goal/task/autoContinue was created, focused, resumed, or modified; no live
  Goal/model-child E2E was run. Session/status/event-bus inputs are deterministic local
  fixtures, while GoalRuntime, Goal event registration and the native notifier are actual
  installed source.
- The package-declared `scripts/run-unit-tests.mjs` does not exist, so that unavailable
  command is not reported as passing.
- The restricted verifier child could not see the parent `subagent` extension because
  no-nesting removes it; the same parent-only home/Grafana checks pass when run by main.
- The final review workflow was stopped after exposing the P1 and produced no completed
  reviewer/security reports. Per the user's main-agent-only direction, the repaired source
  received no new child review; this report does not claim otherwise.
- This is not an OS sandbox against a malicious same-UID process or trusted extension.
  Such a process can race local files or emit events; the bridge treats malformed/unknown
  observations conservatively but cannot create a security boundary inside one process.
- A Goal checkpoint already queued before the structured tool result establishes the exact
  hold cannot be withdrawn and may cause one reconciliation turn.
- Package updates can overwrite installed source. Run package `--check` after updates and
  never bypass the version/hash gate.
