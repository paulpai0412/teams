# pi-goal-x 0.30.5 — Goal/team hold-wake patch

Local, version-gated patch for the installed `pi-goal-x`. It lets Goal auto-continue
wait for one exactly bound `pi-subagents` workflow without pausing the Goal.

## Apply

```bash
cd ~/.pi/agent/teams/patches/goal-team-hold-wake
node apply.mjs --check
node apply.mjs
node apply.mjs --verify
```

A second apply is an idempotent verified no-op. Apply creates a unique backup under
`backups/<name>/` before changing any file and prints that name. It writes each file
through a same-directory temporary file and rename. If source verification or the
focused runtime check fails, every touched file is restored and the backup is marked
`rolled-back`. A process crash after the `prepared` manifest is durable can be recovered
with the same named `--revert`; every target must still match an exact pre/post hash.

To restore an applied backup:

```bash
node apply.mjs --revert '<printed-backup-name>'
```

Revert accepts a name, not a path. It checks the patch ID, package version, target,
backup inventory/hashes, and exact known pre/post state for every target before restoring.
This permits retrying a named revert after an interrupted apply/revert, while an unsupported
version, unknown hash, symlink/non-regular target, changed source, or reused/reverted
backup is rejected without intentional source changes.

For disposable lifecycle tests only, `--target /absolute/pi-goal-x-copy` selects a
package copy. Normal operation must omit it.

## Runtime contract

The top-level async `subagent` call that runs
`~/.pi/agent/teams/goal-task-step.js` must include:

```json
{
  "extensionBindings": {
    "pi-goal-x.team-hold/1": {
      "goalId": "<focused active goal>",
      "taskId": "<currentTaskId>",
      "cwd": "<absolute parent cwd>"
    }
  }
}
```

`tool_call` establishes only a provisional hold. The matching structured
`tool_result` must provide `runId`/`asyncId`/`asyncDir`; the bounded native
`status.json` must independently match run, tool call, owner session, cwd, non-empty
`completionOwnerId`, and active state before a binding is persisted in the Goal
session. Reload performs one public targeted `pi-subagents` status RPC and repeats
native status validation. Missing, terminal, foreign, malformed, stale, or unknown
state releases the hold to main-agent reconciliation.

The bridge only suppresses Goal checkpoints and releases its own binding. A matching
completion event must declare a terminal state and the independently reopened native
`status.json` must also be terminal with the exact owner identity; an identity-only replay
or a terminal event while status remains active cannot release the hold. The bridge never
sends a wake, launches/resumes a child, mutates Goal/task/`autoContinue`, or clears
`teamGoalActiveStep`. The existing `pi-subagents` notifier remains the only wake path.
The focused check loads the installed Goal extension and the real `pi-subagents` notifier;
it exercises success and failure through notifier-before-observer ordering and expects one
native wake per run and zero bridge wakes. Pause, stop, unfocus, task change, session/cwd
change, and exact terminal completion invalidate the old hold; later resume cannot revive
it. A checkpoint already queued before
`tool_result` confirms the run cannot be withdrawn and may cause one reconciliation
turn.

## Updates and activation

An npm/Pi package update may overwrite these installed files. After every update,
run `node apply.mjs --check`; apply only if the exact supported preimage is reported.
A new source version requires a newly generated and reviewed manifest—never weaken
or bypass the hash gate.

Applying source does **not** hot-reload the current Pi process. Use `/reload` yourself
or start a new Pi session after delivery is accepted. This patch never reloads,
installs, publishes, deploys, commits, or changes package metadata/settings.
