# Patch delivery decision — 2026-09-06

User explicitly authorized: implement the Goal × team hold/wake change as a reusable patch and apply it to the currently installed pi-goal-x after validation. This resumes cancelled mission 3ee017f2-4571-46c2-85b1-1b907bc003e8; no persistent Goal is focused or created. Current target comparison before attempt 3 is clean: baseline changed=[], missing=[]; no active subagent fleet.

## Deliverable

Create a self-contained patch package under `/home/timmypai/.pi/agent/teams/patches/goal-team-hold-wake/` containing the smallest source patch, a Node stdlib apply/verify/revert wrapper, a manifest of supported pi-goal-x version and exact pre/post SHA-256 values, and concise README. Apply it to installed `pi-goal-x@0.30.5` only after checks pass. Update `GOAL-TEAMS.md` and the real goal-task-step launch contract only as required by the namespaced extension binding. Preserve all evidence under `goal-team-evidence/hold-wake-20260906/`.

## Patch behavior (required)

- Default/apply checks package version plus every preimage hash before mutation; unknown/changed versions fail closed with no partial writes.
- Already-applied exact postimage hashes are an idempotent no-op and still support verify.
- Back up exact existing files before mutation with path, version, timestamp and hashes; never overwrite an older backup.
- Apply atomically per file (temporary file + rename) with rollback of all touched files on any apply or focused-validation failure.
- `--check` performs compatibility/dry-run without mutation; `--verify` confirms exact postimage plus focused runtime check; `--revert <backup>` restores only a named owned backup after verifying current postimage, otherwise refuses.
- No postinstall/update hook, scheduler, network, dependency, package metadata/version/lock changes, goal files, credentials, publication/deploy/commit or automatic `/reload`.
- README states: npm/Pi upgrade overwrites the local patch; rerun `--check` then apply; source changes require a regenerated reviewed manifest; `/reload` or new Pi session is required after apply.

## Functional criteria

C1–C5 from contract.md remain required. Approved seam: top-level subagent `extensionBindings` namespaced `pi-goal-x.team-hold/1`; prelaunch `tool_call` hold validates exact focused active autoContinue Goal/current task/current session/cwd and toolCallId. Structured `tool_result` supplies runId/asyncDir; documented bounded lifecycle `status.json` must validate runId, current session identity (`getSessionFile() ?? getSessionId()`), cwd, non-empty completionOwnerId and active state before persisting an exact binding. Invalid/error/unreadable identity releases to main reconciliation. Matching native completion releases/dedupes only; existing notifier is the only wake. No Goal/task/autoContinue mutation, new child dispatch/revive, or automatic teamGoalActiveStep clearing. Reload reconstructs only a fully validated Goal-owned custom session binding, asks public targeted RPC for liveness, holds only active; terminal/unknown/missing/mismatch releases to main reconciliation. User paused/stopped/unfocused/newer goal/task/run and foreign/late/duplicate events never revive work.

## Gates

Sole implementer attempt 3 is the final planned writer attempt. Required exact-final-source gates: patch lifecycle regression (`--check`, apply, repeat, verify, incompatible fixture, forced validation-failure rollback, named revert in disposable copy); focused installed runtime/integration test with measured continuation/wake counts and explicit mock boundaries; home goal-team checks; primary LSP then lens all; independent verifier; fresh correctness reviewer; security reviewer. Main inspects source, hashes and raw logs. Any required criterion not met blocks completion. Do not reload this live session; applied code is verified through direct installed entrypoint loading and takes effect after user reload/new session.
