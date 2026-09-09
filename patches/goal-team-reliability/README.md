# Goal team reliability delta — pi-goal-x 0.30.5

Extends the existing `goal-team-hold-wake` patch; does not replace pi-subagents,
change permissions/models, launch children, mutate Goals or reload sessions.

Changes: parent-boundary hold reconciliation after transient completion observation
failure; merged effective completion settings; native active/unknown run guards at
Goal/task completion. These are execution-state checks, **not** source freshness or
REQUIRED product-evidence validation. Main/host acceptance remains mandatory.

## Apply / verify / recover

```bash
node ~/.pi/agent/teams/patches/goal-team-reliability/apply.mjs --check
node ~/.pi/agent/teams/patches/goal-team-reliability/apply.mjs
node ~/.pi/agent/teams/patches/goal-team-reliability/apply.mjs --verify
# Only the exact backup name returned by apply, never a directory:
node ~/.pi/agent/teams/patches/goal-team-reliability/apply.mjs --revert BACKUP_NAME
```

Version + per-file hashes + the required base runtime hash must match. An unknown
hash/version, mixed state or validation error is not permission to force-install.
The wrapper reuses the prior patch's atomic backup/idempotence/rollback protocol,
with a required-base-file hash check. `--target` is for an explicit package root.
A failed validation restores preimages; named revert also handles a known mixed
pre/post interrupted installation. A consumed revert receipt cannot be reused.

After apply, a **user reload/new session** is required. Disk verification does not
prove that an already-running session loaded the new code. Do not reload another
session or stop its work automatically.

Upgrade order: for a supported clean 0.30.5 install, apply the base hold/wake patch
first, then this delta. After delta apply, use this bundle's checks; the original
base wrapper will correctly reject the newer overlapping files. To return to
vanilla, revert this delta using its receipt first, then revert the base patch.
Never regenerate expected hashes merely to get past a compatibility failure.

Pre/postimages are `.ts.txt` **data**, copied byte-for-byte to manifest `.ts`
targets. Partial snapshots are not standalone TypeScript modules: runtime checks
and LSP must run on a complete candidate/installed package, not these snapshots.
This naming does not waive validation of the actual target files.

## Offline checks

```bash
PI_OFFLINE=1 node ~/.pi/agent/teams/check-reliability-patch.mjs
PI_OFFLINE=1 node ~/.pi/agent/teams/check-goal-hold-wake.mjs
PI_OFFLINE=1 node ~/.pi/agent/teams/check-goal-completion.mjs
PI_OFFLINE=1 node ~/.pi/agent/teams/check-goal-step-storage.mjs
```

Checks use real native classes/entrypoints/state store with disposable status,
settings and package targets, but fake model results/mutations. They do not certify
live children, TUI pause/resume, independent review or real-world speedup.
The separate team helper v2 migration and outstanding skill/acceptance gaps are
in `../../GOAL-TEAMS.md` and `../../goal-team-evidence/reliability-20260908/report.md`.
