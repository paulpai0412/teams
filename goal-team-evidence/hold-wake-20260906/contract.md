# Hold/wake implementation contract — 2026-09-06

## Authority / source / recovery

User requests implementation of ../hold-wake-handoff.md. Main orchestrates; native pi-subagents alone controls children. No focused Goal; do not create/focus/resume/mutate any existing Goal. This is a new non-goal mission, not a continuation of completed goal-team integration mission ed6d264b-7219-408a-9c88-3bdda9845475. Native current-session fleet empty and global mission list has no active matching task at intake. Do not operate unrelated sessions or retained children for testing.
Cwd /home/timmypai. Targets are installed pi-goal-x 0.30.5, pi-subagents 0.64.0 and teams/goal-task-step.js; not git checkouts. baseline-manifest.json pins 353 source/doc/helper files, manifest sha256 ba5c437f544130f515afee4915250a0761771512e470fc3fb9b0a703c918e0b0. No target graph index; use pi-lens and bounded source search. role-preflight.json validates current home role settings. Executable profiles all user team.*, no project overrides in native discovery.

## Observable criteria (all required)

C1: Exact active autoContinue Goal/current task/owner session with a natively bound active run does not emit empty Goal checkpoint continuations while waiting; Goal status stays active, and user input remains usable.
C2: Matching native success/failure completion returns control to main for reconciliation; bridge neither dispatches another child nor completes a Goal/task, and completion is not double-delivered by a second bridge wake.
C3: User pause/stop/unfocus, different session, newer task/run, and duplicate/late notifications do not resume or revive stale work; unrelated Goal continuation is not held.
C4: Restart, stale markers and unknown/missing retained status reconcile via actual native status/receipts; no blind relaunch, invented completion or permanent marker-only hold.
C5: A runnable regression and real installed continuation/notification integration seam verify C1-C4 on exact final source; documentation describes operation, recovery, measured limitations, backup/rollback and npm upgrade overwrite risk.

## Scope / gates / risks

First diagnose without source edits. Parent approves minimal seam and file list after evidence. Allowed implementation: bounded installed runtime/helper changes, their regression checks and directly related operation docs, with pre-edit scoped backups. No _goalCore coupling, new polling daemon/scheduler/controller, tools/models/permissions/provider changes, dependencies, package installs, Harness-X changes, publication/deploy/commit/push, secret access or production effects. Existing goal files are off limits. Test-only disposable goals/sessions/artifacts permitted in dedicated scratch resources; no model workers through raw CLI/SDK or alternate controllers. Actual public extension callbacks/runtime integration may be driven without model calls, label mocked boundaries honestly.
Required: debugger causal repro; sole implementer; independent mechanical verifier with real integration/QA scenarios; fresh no-write correctness review; no-write security review (agent lifecycle/session boundary); documentation validation. Browser gate N/A: no browser artifact. Separate planner/QA/E2E roles N/A initially: focused debugger and verifier can cover these seams; add a role only if evidence needs it. Release/production gates N/A: not authorized or requested.
Risks: event ordering/duplicate delivery, status-vs-process proof confusion, missing start binding, stale queued checkpoints, reload/unfocus races, package overwrite and ambient extension effects. Infrastructure failure is not a pass.
Budget: one child during diagnosis/implementation, <=3 gates concurrently, <=8 launches per wave, <=3 fix rounds, no advisor absent material unresolved question. Preserve native run receipts and final exact-source hashes in this directory. Rollback only scoped changed files after confirming no intervening edits; never bulk restore settings/goals.

## Acceptance / retrospective

Per-criterion met/not_met/indeterminate/needs_user judgments with actual inputs/observations/logs/source hashes. All required evidence must be current and met for completion. Main directly inspects evidence; child verdict alone insufficient. Preserve <=3 verified lessons with source/run refs, no policy/model/tool expansion.
