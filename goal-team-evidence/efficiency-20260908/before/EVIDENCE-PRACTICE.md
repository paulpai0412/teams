# Parent-owned delivery evidence

Use the smallest sufficient path: main for small work; one writer only when it saves context/work, plus host checks. Add independent review/security/E2E when required by risk. Missing required evidence means partial, not accepted. This is not a new controller, task store, model auditor or capability installer.

## Freeze before measuring

1. Finish all edits and the already-installed formatter/lint fixes on owned files. pi-lens can format at `agent_end`; a test before that formatting is not automatically fresh afterward. Do not disable global formatting or lint to hide drift.
2. Declare the relevant source/test/config/generated-output paths explicitly. Keep receipts and saved packets outside that source scope. Run trusted argv checks through `host-evidence.mjs`.
3. Before accepting, call `verify`/`accept` again. Changed source bytes, directory membership/mode, command, Node runtime or logs invalidate a receipt. Re-run only affected checks, under a new receipt filename; unchanged checks can be selected again. A timeout/crash/old intent never authorizes re-execution.
4. Preserve old evidence. Historical hashes stay historical. Neither AST-equivalent formatting nor a changed hash alone proves tests passed on the new bytes.

Only explicitly approved, non-sensitive regular files/directories are inputs. Symlinks, obvious credential paths and oversized scopes fail closed. Limits: 128 scope roots, depth 16, 1,024 visited entries, 512 file-entry bound, 8 MiB per source/artifact file, 64 MiB source reads, 1 MiB JSON metadata, 8 MiB child output buffer. This is not a secret scanner, authenticated attestation, OS sandbox, continuous watcher or complete environment fingerprint. Parent must include relevant dependencies/config and separately recheck external services/environment. Timeout kills the direct process; descendants/effects require reconciliation.

## Host check CLI

`check.json` is `{cwd, sourcePaths, argv, timeoutMs}`. cwd and argv[0] are absolute; argv is already authorized/trusted, not copied blindly from a child report. No shell is added implicitly. Receipt filenames are single-use; `.intent` and `.log` are retained with the result.

```sh
node ~/.pi/agent/teams/host-evidence.mjs run check.json evidence/check-1.json
node ~/.pi/agent/teams/host-evidence.mjs verify check.json evidence/check-1.json
```

A failed/ambiguous check is never retried by this helper. `durationMs` is only local check timing, not time-to-accepted.

## Declared acceptance contract

Keep one parent-approved JSON contract under the work cwd. Fields:

- `version: "team-evidence/1"`, canonical absolute `cwd`.
- `criteria`: unique observable requirements, not merely "tests passed".
- `checks`: `{id, input}` entries, with the exact check.json inputs above. Check ids use letters/digits/underscore/hyphen.
- `requiredEvidence`: relative artifact filenames, e.g. independent review and real entrypoint observations. This list must include every REQUIRED non-command gate. File presence/hash does not prove review quality or independence; main must inspect the raw evidence.
- `decision`: relative current-decision JSON path. Old judgments are retained alongside it. A new seal invalidates the old ready decision before evaluating the new judgment; failure leaves pending, not a stale PASS.
- For Goal integration, `goalId`, `taskId`; for bound Goal-team work, `mission: {id, statePath}` naming the exact approved native mission state.json. Active or unresolved retained intents block. The helper never changes mission state.

Parent observations JSON: `{checks: {checkId: "relative/receipt.json"}, criterionResults: [{criterion, status: "met", entrypoint, observed, evidence: ["check:checkId", "file:relative-artifact.md"]}]}`. These are parent judgments after inspecting results, not copied child verdicts. Checks may select new immutable receipt paths after a repair without rewriting approved criteria or command definitions.

```sh
node ~/.pi/agent/teams/host-evidence.mjs seal contract.json observations.json
node ~/.pi/agent/teams/host-evidence.mjs accept contract.json
node ~/.pi/agent/teams/host-evidence.mjs reference contract.json
```

Structured contract/receipt metadata uses canonical JSON identity, so JSON formatting alone is not a new contract. Actual source, logs and required evidence remain byte-bound. Anyone able to rewrite all these files can forge their contents; this is an accidental-staleness/completeness guard under the parent ownership contract, not a signature system.

## Optional Goal runtime integration

For a NEW or explicitly restructured task list, show the requirements to the user and use the generated `team-evidence/1:<digest>:<relative-contract-path>` as `verification_contract`; use `block_completion:true` for team deliverables. No automatic existing-Goal migration or focus change. The ordinary child report schema remains unchanged.

The delivery patch checks the registered contract at task validation and the common Goal completion transaction, including after awaited observations/audits. It first uses the existing GoalService `endTurn()` to persist pending state for opted-in completion; an uncleared buffer blocks acknowledgment. The completing mutation then uses the native immediate lock/write path rather than returning success from memory only. Later work starts its usual next-turn buffering. Explicit `disableContracts`/`disableTasks` settings, legacy unregistered Goals and lightweight/skipped-task semantics remain user-owned; disabling these checks does not make missing product evidence pass the team's acceptance policy.

This does not prevent future edits or automatically reopen completed Goals. Freeze/idempotence and final receipt checks are still required. Native run-owner checks remain separate; this is not cross-session exactly-once execution. Independent review and live Goal/TUI canary are not supplied by these fixtures. Reverting the patch removes this optional runtime protection; first pause/review any Goals relying on its references. Revert does not rewrite Goals.

## Less handwritten dispatch metadata

The existing saved packet additionally accepts `missionId`, `sourcePaths`, explicit `timeoutMs`, fresh `goalStatus: "active"` / `taskStatus: "pending"`, and optionally `acceptanceContract` relative to cwd.

```sh
node ~/.pi/agent/teams/goal-request.mjs --dispatch /absolute/saved-input.json > prepared.json
```

This writes content-addressed effective packet/setup artifacts beside the saved input and returns small `setupArgs` then `dispatchArgs`. First run the selected-role/environment preflight. Use those native pi-subagents args unchanged, sequentially, against the explicit non-goal mission. Setup has no child and refuses foreign bindings/active intents; it does not silently overwrite ownership. The effective packet is recoverable with the existing goal-request CLI. Timeout reaches the inner `runs.run`. This is preparation, not launch authorization, product acceptance or an atomic two-operation dispatch.

## Readiness and measuring improvement

Missing declared skills are reported as `missing-declared-skill` with exact names. Distinguish professional guidance from actual executable/tool availability, inspect the role's requirement, then seek approval for remediation. Do not delete requirements or install capabilities to manufacture a PASS. Checks after a role's first failure remain unverified.

For real work, record request/accepted timestamps, main+child tokens, host durations, wait time, first-pass acceptance and each rework reason. Separate model quality, formatting, environment and stale-evidence failures. Do not infer delivery speed from fixture counts or change models/concurrency before a measured bottleneck justifies it.
