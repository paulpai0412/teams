# Three flow fixes — main-agent-only, 2026-09-08

User authority: fix the first three diagnosed defects, using main only and without running team-flow. No child agents, new capability/provider/dependency, live Goal resume, vocab changes, installation, publish or restart was performed. Changes are local installed-package source patches; existing processes are NOT asserted to have reloaded them.

## Changes

1. `pi-goal-x/extensions/goal-team-hold.ts`: host-derived `ownerCwd` represents parent session ownership; `cwd` remains native execution identity. Binding, completion gating and recovery respect both; legacy entries without ownerCwd retain same-directory semantics. Requested execution directory must match dispatch directory. Session/task/run/tool/completion-owner checks remain mandatory.
2. `pi-subagents/src/runs/shared/subagent-prompt-runtime.ts`: structured-step steering is held in a bounded inbox queue during a turn, with a queued acknowledgement. At a nonterminal boundary it is delivered normally. A successful terminating structured-output result rejects retained/new guidance with an explicit reconciliation message. Failed report validation does NOT close the steering boundary. Ordinary non-structured steering is unchanged. **Pi core is not modified**: the fix prevents stale parent messages reaching its queue, rather than changing global terminate/follow-up semantics.
3. Both `runs/foreground/execution.ts` (workflow child path) and `runs/background/subagent-runner.ts`: read and validate captured structured report evidence even when execution failed. Keep the failure/exit status and include the report path labelled `not accepted`; never promote failed execution into success. Missing-capture, malformed report, cancellation and timeout protections remain. Captured work blocks automatic startup/model/abort replay and requires reconciliation. A schema/validation failure is retained alongside an existing execution error.

## Mechanical evidence

- `check-hold.mjs`: actual installed hold source and real disposable native status files; same/cross cwd bind, current hold, parent completion guard, recover, forged status/completion owner, terminal release and mismatched requested cwd.
- `check-steering.mjs`: actual installed `registerSteeringInbox` + actual installed Agent + in-memory provider; stale steer/follow_up/auto around final capture, late guidance rejection, ordinary/nonterminal guidance, failed report leaves guidance usable. No network/model.
- `check-report.mjs`: executes actual foreground/background ingestion blocks and background error projection, with the native schema reader and disposable report files. Failed evidence retained, success not promoted, malformed/stale/stopped/timed-out rejected. Retry guard checked structurally. **This is a focused boundary test, not a complete spawned-child transport E2E.**
- Preimage checks fail intentionally (`red-*.log`); current checks pass (`green-*.log`). First direct probe import failed due Node's node_modules type-stripping restriction; resolved in the probe via built-in stripping. Runtime-test imports initially required explicit aliases to the already-installed host peer packages; no package installed. Ack test was corrected to consume the ordered queued→failed acknowledgment sequence, not just its first entry.
- Existing installed Goal regression suite: 30 hold/wake + 33 completion + 23 host-evidence cases PASS, zero model/child calls; `existing-goal-regressions.log`.
- Primary LSP: four changed TS files clean, no unsupported/unavailable/inconclusive outcomes.
- `manifest.json`, `before/`, `after/`, `changes.diff`: exact before/after source evidence. `check-sources.mjs` verifies installed and backup/snapshot hashes.

Run focused checks:

```bash
D=/home/timmypai/.pi/agent/teams/goal-team-evidence/flow-fixes-20260908
node "$D/check-hold.mjs"
node "$D/check-steering.mjs"
node "$D/check-report.mjs"
node "$D/check-sources.mjs"
```

## Activation, recovery and limits

Use `/reload` or a new Pi session to load the extension changes before a later user-authorized live flow test. Do not resume the stopped vocab run merely to test these fixes. No live provider/E2E or independent review was run, per main-only/no-team-flow scope. Actual WebSocket network cause and task-3 stop input/caller provenance remain unresolved and untouched.

These patches depend on the current local package state (including earlier goal hold/reliability/delivery patches). Older overlapping patch-manifest checks will reject the new hashes; this does not mean the old postimage should be blindly reapplied. For this delta, check the saved manifest and tests here. Package upgrades may overwrite these changes; do not reapply blindly to an unknown version.

Rollback only after checking ALL four installed hashes still equal manifest postSha256 and each backup equals preSha256. Restore exactly the four `before` files to their manifest target paths, then reload. Do not restore if another session/upgrade has changed a target: reconcile first. Backups are retained; no automatic rollback or mutation of existing Goal/mission files has been performed.

Retrospective: cross-directory tests must exercise parent identity and native child status independently; report-file existence and failed execution are independent observations; native queued steering is not inherently safe after terminal capture. Both foreground and background runner paths must be covered, not just the first matched implementation.
