# Goal × team hold/wake diagnosis

## Verdict

**PASS (diagnosis only; not fixed/release-ready).** The bounded symptom is reproduced at the installed continuation and native notification seams. The supported cause is a missing cross-module binding/reconciliation listener, not a failed native child completion mechanism.

## Exact symptom

An active auto-continuing Goal can enqueue its checkpoint continuation while a bound team child is still active. The Goal runtime has no bound child run/session/task input. When the child later completes, pi-subagents emits and notifies normally, but pi-goal-x has no listener that reconciles the exact Goal/task/run and releases/arms continuation. A bare native completion event therefore cannot wake Goal orchestration.

## Source state

Installed baseline was checked against `baseline-manifest.json`; all inspected target files matched. Versions: `pi-goal-x@0.30.5`, `pi-subagents@0.64.0`. No installed source, tests, configuration, Goal, mission, session, or retained child was changed. `git status` was not applicable from `/home/timmypai` (not a repository); package hashes, rather than that cwd, are authoritative.

Representative matching hashes:

- `pi-goal-x/extensions/goal-runtime.ts`: `d39fe986...2e870c`
- `pi-goal-x/extensions/goal-events.ts`: `fc891b38...154c15`
- `pi-subagents/src/runs/background/notify.ts`: `1f8c70ea...e09dc8`
- `pi-subagents/src/runs/background/result-watcher.ts`: `8f70643a...e09dc8`
- `goal-task-step.js`: `4a5f3e2a...0a85`

## Normal team-member handoff

- **summary:** Goal idle continuation and pi-subagents native completion are separate; the missing exact binding/reconciliation seam is the cause.
- **changedFiles:** none in source, tests, configuration, Goals, missions, sessions, or retained children. Scratch probe artifacts only.
- **criteria:** C1 hold reproduced; C2 watcher/native ordering reproduced; C3 duplicate/ownership safety reproduced; C4 marker/proof restart condition reproduced with disposable artifacts; C5 stale/foreign safety exercised and lifecycle safety traced.
- **nextAction:** Parent routes to implementer; implementer adds the parent-owned public event adapter; verifier runs C1–C5, then fresh review.

## Checks

| Command | cwd | exit | log/evidence | result |
| --- | --- | ---: | --- | --- |
| `node .../hold-wake-probe.mjs > .../hold-wake-probe.json 2> .../hold-wake-probe.stderr` | `/home/timmypai` | 0 | `.../diagnose/hold-wake-probe.json` | pass; real installed seams and disposable files |
| `node --experimental-strip-types .../hold-wake-probe.mjs` | `/home/timmypai` | 1 | raw stderr preserved in tool output; limitation recorded above | environment loader failure; not retried unchanged |
| package hash comparison against `baseline-manifest.json` | `/home/timmypai` | 0 | command output / manifest | pass; inspected targets unchanged |

## Reproduction

Command (successful run):

```sh
cd /home/timmypai
node /home/timmypai/.pi/agent/teams/goal-team-evidence/hold-wake-20260906/diagnose/hold-wake-probe.mjs \
  > /home/timmypai/.pi/agent/teams/goal-team-evidence/hold-wake-20260906/diagnose/hold-wake-probe.json \
  2> /home/timmypai/.pi/agent/teams/goal-team-evidence/hold-wake-20260906/diagnose/hold-wake-probe.stderr
```

Environment: Node `v24.18.0`, cwd `/home/timmypai`; installed package sources loaded with the already-installed `jiti` loader. Exit `0`; probe JSON is clean and contains no stderr. The first bootstrap attempt used `node --experimental-strip-types` and exited `1` with raw error `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING: Stripping types is currently unsupported for files under node_modules` (environment/tool-loader limitation, not a product failure). A second unchanged retry was not made; jiti was a new discriminating loader variable and succeeded. The missing peer `@earendil-works/pi-tui` was resolved to the already-installed peer via a jiti alias, without changing package files.

Evidence: `hold-wake-probe.json`, `hold-wake-probe.stderr` in the diagnose directory.

### Observed probe cases

- **C1 continuation:** real `GoalRuntime.queueContinuation` with only idle/pending-message context mocked emitted one follow-up in 26 ms: `<pi_goal_continuation goal_id="goal-probe" kind="checkpoint" v="2"/>`. This is a minimal seam reproduction: the simulated active child is intentionally not represented in the runtime API, so the runtime cannot hold on it. It does not claim a live child was operated.
- **C2 native result path:** real `createResultWatcher` read a disposable result file, called the mocked notifier once, emitted one `subagent:async-complete` with `runId=run-file`, and removed the delivered result file. The order is notifier acknowledgement first, native event second. Goal was not invoked.
- **C3 duplicate/ownership:** real `registerSubagentNotify` delivered one owned success and one owned failure; duplicate success produced no extra message. Foreign owner and foreign session completion events produced no notification (`rejectedForeignMessageCount=0`).
- **C4 restart/artifacts:** real `listAsyncRuns` saw a synthetic running status. After only writing `status.json: state=complete`, both `reconcile:false` and normal reconcile returned no completed listing while `.active-runs` remained. No process-terminal proof was invented. This is disposable artifact testing, not a claim about a retained production run.
- **C5 stale/foreign safety:** native notifier ownership filtering and exact run/session fields were exercised. Goal lifecycle registration included only Pi lifecycle names and did not include `subagent:async-complete`; no unrelated event caused a Goal message.

## Causal source trace

1. `goal-runtime.ts:81-100` documents and implements continuation eligibility as active + autoContinue, then idle/pending-message checks at lines 91-99. `sendQueuedContinuation` repeats actionable/readiness checks at `:148-169`, then sends at `:170-180`. There is no child run, task, session, or completion-owner check.
2. `goal-events.ts:93-98` registers Goal lifecycle hooks. The complete set observed by the probe was `context`, `turn_start`, `tool_call`, `tool_execution_end`, `turn_end`, `message_end`, `session_start`, `session_before_compact`, `session_compact`, `session_tree`, `before_agent_start`, `agent_end`, `agent_settled`, and `session_shutdown`; `subagent:async-complete` is absent.
3. `goal-events.ts:481-534` clears/reconciles Goal state on Pi `agent_end`; `:536-564` queues continuation at `agent_settled` when `isActionableContinuationGoal` passes. This is the current Goal wake path and is unrelated to detached child completion.
4. `result-watcher.ts:540-559` calls the notifier, `:560-574` handles acknowledgement/marking, and `:576-603` emits `subagent:async-complete` and removes the result only after observers succeed. This native seam is healthy and has exact result identity.
5. `notify.ts:584-620` rejects missing/foreign ownership, deduplicates by completion key, and batches/delivers. `:622-627` subscribes only its own notifier to async/foreground completion events. It does not reconcile Goal state.
6. `rpc.ts:440-469` advertises `events.asyncComplete`, `childStatus`, `processTerminal`, status projection, and process-terminal proof. `docs/extension-api.md:5-26,37-46,61-63` makes the RPC and event scope public and process-local; `:405-423` says status files are authoritative for liveness and explicitly warns that quiet detached runs do not generate parent activity.
7. `goal-task-step.js:1-26` requires a fresh active Goal/pending task, exact `goalId/taskId/phase/agent/task/cwd/sourceState`, and exact `teamGoalBinding` Goal/cwd. `:28-43` prevents reused step keys and unreconciled active steps. `:44-80` persists intent before launch and preserves the active marker through ambiguous errors. It intentionally delegates reconciliation to the parent and has no native completion subscription.
8. `process-terminal.ts:118-132` initializes pending proof; `async-execution.ts:523-530` emits process-terminal proof; `async-status.ts:181-203` retains an active marker when liveness/proof is unknown. `stale-run-reconciler.ts:174-187` marks repaired terminal state with unknown observer proof rather than asserting observed termination. Therefore status/marker alone must not authorize a relaunch or Goal wake.

## Ranked hypotheses

### Supported: missing Goal-side binding/reconciliation seam (high confidence)

The real continuation seam emits with no child-state input, and the real result watcher/notifier path completes without any Goal listener. The source and probe agree on the full chain: Goal idle check -> checkpoint; result file -> notifier -> native event; native event -> no Goal handler.

### Excluded: native result watcher failed to emit (high confidence)

Disposable result-file probe observed notifier count 1, native event count 1, correct run ID, and delivery artifacts removed. No watcher error was logged.

### Excluded: duplicate or foreign notification caused the missing wake (high confidence)

Dedupe and owner/session filtering were exercised; duplicates and foreign identities generated no extra notification. These are safety concerns, not the primary missing wake cause.

### Excluded: child-status is the generic completion event (high confidence)

The documented/native completion seam is `subagent:async-complete`; `child-status` is a progress/stopping hint and is not emitted by the result watcher as terminal result delivery. It cannot replace exact terminal reconciliation.

### Remaining uncertainty: host lifetime/session disposal (medium)

Docs state a host can dispose the listener while detached work continues (`extension-api.md:405-423`). This run did not reclaim or restart a real Pi session, by authorization. If the parent host disposes the session, no in-process event listener can wake it; artifact reconciliation is then mandatory.

## Smallest public integration recommendation

Use one parent-owned adapter at the existing Goal extension registration boundary: subscribe to the already-public process-local `pi.events.on("subagent:async-complete", ...)` seam advertised by `ping.capabilities.events.asyncComplete`. Do not add a daemon or poller, import private `_goalCore`, or modify installed packages merely to obtain an event.

On each event, the adapter should:

1. Match exact `sessionId`/completion owner, `runId`, Goal ID, task ID/phase/attempt, and cwd against the durable `teamGoalBinding`/active-step projection.
2. Treat the event as a wake hint only; read/reconcile the exact status/receipt (RPC targeted status where available, otherwise package-owned lifecycle artifacts) before clearing `teamGoalActiveStep`.
3. On complete/failed/stopped/paused/needs-attention, return control to the main Goal/task reconciler; never dispatch a replacement child or mark a Goal complete automatically.
4. On duplicate/late/foreign events, no-op. On restart/unknown state, retain the active marker and require receipt/status reconciliation; never relaunch blindly.
5. Queue a Goal checkpoint only after exact binding reconciliation and only if Goal remains active + autoContinue. A user-paused/stopped/unfocused Goal must stay paused/stopped.

Exact installed package files inspected, but **not recommended for direct editing under this authority**: `pi-goal-x/extensions/goal-events.ts` and `pi-goal-x/extensions/goal-runtime.ts`. The parent-owned adapter's checkout path was not present in the authorized task contract, so no path is invented. If the implementer elects to place the listener in `goal-events.ts`, that is the smallest one-file package seam but requires a scoped backup and explicit upgrade-overwrite warning; it still needs a durable binding source. The existing `goal-task-step.js` should remain the launch/intent contract, not become a notification daemon.

## Regression plan C1–C5

- **C1 hold:** bind Goal/task/session/run, set Goal active + autoContinue, simulate idle while run status is running; assert no continuation message and no Goal pause mutation. After exact terminal reconcile, assert one checkpoint at most.
- **C2 native wake:** emit a real-shaped owned `subagent:async-complete` after a disposable terminal receipt; assert exact binding is reconciled and control returns to main. Assert notifier-before-event ordering and no replacement dispatch.
- **C3 stale/duplicate:** replay the same event, send old run/new task, foreign session, wrong completion owner, and late event after user pause; assert zero duplicate wake/relaunch and no pause revival.
- **C4 restart:** persist `teamGoalActiveStep` plus binding, stop/restart adapter, provide running/complete/failed/unknown status and receipt variants; assert running/unknown retain marker, terminal receipt reconciles once, and no blind launch occurs. Include process-terminal pending/observed/unknown cases.
- **C5 safety:** user pause/stop/unfocus and changed Goal/cwd must suppress wake; malformed/missing binding, mismatched task/phase/attempt, missing status, and status-marker-only terminal must fail closed. Verify bounded event payload handling and no unrelated Goal receives a wake.

## Affected callers and residual risks

Affected caller path is `goal-task-step.js` parent reconciliation and the Goal `agent_settled` continuation path. pi-subagents ordinary notifier callers are not broken and should not be altered. Risks: process-local events do not cross a separate Pi process; host session disposal loses the event; status `lastUpdate` is not a heartbeat; stale markers may remain until proof/repair policy allows release; an event is observational and not a delivery acknowledgement. These require restart artifact reconciliation, not more retries.

## Scratch artifacts and cleanup

- Evidence: `.../diagnose/hold-wake-probe.mjs`, `.json`, `.stderr`, `jiti-smoke.mjs`.
- Disposable `status-probe` and `result-probe` directories were removed by the probe. No production paths were touched.
- No source/test/config files were edited; no staged files, Goal, mission, session, or retained child were mutated.

## Memory candidates

- `pi-goal-x@0.30.5` continuation uses only Goal actionability and host idle/pending-message state; it has no child-run binding (confidence high; source lines `goal-runtime.ts:81-180`).
- `pi-subagents@0.64.0` result watcher calls notifier before emitting `subagent:async-complete`, and ownership/dedupe are notifier-level protections (confidence high; `result-watcher.ts:540-603`, `notify.ts:584-627`).
- Active markers plus terminal-looking status are not sufficient process proof; restart reconciliation must preserve unknown state (confidence high; `async-status.ts:181-203`, `process-terminal.ts:118-132`).

## Required handoff

Route this diagnosis to `team.implementer` through the parent for any patch, then verifier and fresh reviewer. This report does not claim the bug is fixed.

```acceptance-report
{
  "verdict": "pass",
  "sourceState": "installed pi-goal-x@0.30.5 and pi-subagents@0.64.0 baseline-verified; no repository source/tests/config edits",
  "evidence": [
    "real GoalRuntime continuation emitted while child binding is absent",
    "real result watcher acknowledged disposable result then emitted subagent:async-complete",
    "real notifier deduped duplicates and rejected foreign owner/session",
    "real RPC status exposed current-session async snapshot",
    "real status reader retained marker without fabricated process-terminal proof"
  ],
  "residualRisks": [
    "host session disposal can prevent in-process wake",
    "restart reconciliation must use exact durable artifacts and proof",
    "no live production Goal or retained child was operated"
  ]
}
```
