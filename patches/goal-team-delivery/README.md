# Goal-team delivery delta

Supported base: pi-goal-x 0.30.5 with goal-team-hold-wake v1 and goal-team-reliability v2. No dependency/model/permission changes. Three runtime targets: goal-completion.ts, goal-task-tools.ts, and new goal-team-evidence.mjs (byte-identical to the parent host-evidence.mjs). The existing generic reliability applier is reused; its historical error prefix is unchanged.

```sh
node ~/.pi/agent/teams/patches/goal-team-delivery/apply.mjs --check
node ~/.pi/agent/teams/patches/goal-team-delivery/apply.mjs
node ~/.pi/agent/teams/patches/goal-team-delivery/apply.mjs --verify
node ~/.pi/agent/teams/patches/goal-team-delivery/apply.mjs --revert EXACT_BACKUP_NAME
```

Use `--target /absolute/disposable/pi-goal-x` for package checks. Exact pre/post/prerequisite hashes are required; unknown source is never overwritten. Failed validation rolls back, including removing the newly added module. Named revert supports mixed pre/post recovery and preserves receipts. Never repeat a mutation after an ambiguous timeout without inspecting actual source/backup state.

A clean supported version needs base → reliability v2 → delivery. Reverse that order to return to vanilla. Older wrappers rejecting overlapping newer post hashes are behaving correctly. Reverting removes the optional evidence protection; first pause/review any Goals that rely on these references. No applier command migrates, focuses or rewrites Goals/missions.

Only explicitly registered `team-evidence/1` task contracts opt in. Completion uses the existing GoalService endTurn/isTurnBuffered API before acknowledging a completing mutation, avoiding a memory-only success. Receipt validation never runs commands inside a Goal callback. Existing disabled-contract/task settings and legacy Goals remain user-owned.

See ../../EVIDENCE-PRACTICE.md for source scope, required parent judgment, immutable check attempts, canonical metadata, buffer/final-source checks and limitations. Installed files do not mean a running Pi session has reloaded. Offline tests are not independent review, live Goal/TUI E2E, authenticity proof or measured delivery speed.
