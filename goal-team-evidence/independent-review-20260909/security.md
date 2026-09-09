# Security static review

**verdict:** needs_decision (one P2 remediation/disposition)  
**sourceState:** Reviewed the supplied fixed candidate pinned by `source-pin.json` (manifest SHA-256 `d485a525…aab587`; 23 listed post-image hashes). This was not independently re-hashed because execution/shell is prohibited. Cwd is not a Git checkout.  
**changedFiles:** None by this reviewer.

## Scope, assets, and boundaries

Reviewed the diff, F1–F5 specification, current `goal-task-step.js`, `goal-request.mjs`, `goal-recovery.mjs`, `handoff-contract.mjs`, `host-evidence.mjs`, installed `pi-goal-x/extensions/goal-team-evidence.mjs`, and the two new regression suites. Read-only caller tracing covered the installed `pi-subagents` agent discovery, workflow state, and launch argument paths.

Assets are parent dispatch/retry authority; mission state and active marker; request/source digest; native terminal receipt; host-check receipt/log; acceptance decision; and child prompts/tools/extensions. Public preparation entrypoints are `prepareHandoff`, `prepareGoalDispatch`, and `prepareGoalRecovery`; final consumption is `goalEvidenceBlockReason`.

The intended trust model is a single inspected/approved parent and approved project control plane. Child structured output, task text, project source, and evidence descriptions are not semantic authorization. No commands, tests, scanners, credential access, live Goal changes, or exploitation were performed.

## Findings

### P2 — recovery JSON reads have a check/use race on evidence files  
**Location:** `goal-recovery.mjs:9–15, 19–55, 59–70`; downstream structural consumption at `host-evidence.mjs:442–488`.  
**Status:** Pre-existing (the changed `evidenceDigest` safely reads rejection files, but this recovery reader remains path-based).

`readJson()` first checks `realpathSync()` and `statSync()`, then reopens the pathname with `readFileSync()` without `O_NOFOLLOW` or post-read inode/metadata verification. It is used for supplied native status, sibling mission metadata, mission state, and the saved request. `prepareGoalRecovery()` uses those parsed values to construct a reconciliation script that clears the active marker. Later final acceptance only shape-checks stored recovery references/digests through `goalStepSettled`; it does not re-open the native receipt.

**Reachable sequence:** a parent invokes the public recovery helper with evidence under a directory writable by another local principal; that principal replaces a checked file between validation and read; the helper consumes substituted status/mission/request data and emits a reconciliation script. If the script’s expected state still matches at application, it can settle a record and permit subsequent handling.

**Impact/confidence:** Could incorrectly bind recovery to substituted/stale evidence, affecting launch/reconciliation integrity. Exploitability is **low-to-moderate confidence**: it requires concurrent write access to parent-native evidence files; no child-only route to those files was established, and a party able to rewrite mission state directly exceeds the supported-child threat model.

**Smallest fix:** Make `goal-recovery` use an FD-based bounded JSON reader equivalent to `host-evidence.mjs:32–67`: canonical absolute path, `O_NOFOLLOW`, regular-file/size check, read through the FD, then inode/device/size/timestamp recheck before JSON parsing. Apply it uniformly to all recovery JSON inputs.

**Regression:** In a disposable fixture, simulate replacement/symlink substitution between validation and read via an injected filesystem seam; require `prepareGoalRecovery` to reject and produce no usable setup script. Retain the existing foreign request/child identity checks.

## No P0/P1 finding in the approved trust model

`evidenceDigest` (`host-evidence.mjs:68–73`) correctly rejects non-absolute, empty, symlinked, oversized, and credential-named rejection artifacts through the hardened byte reader. Source snapshots reject traversal, symlinks, credential paths, and source drift (`host-evidence.mjs:105–169, 282–321`). Recovery also binds request digest, workflow key, agent, terminal child identity, exact source paths, and a current host receipt (`goal-recovery.mjs:25–55`). The new reconciliation tests cover foreign request/child/digest cases and report-only/retry behavior; I did not treat their PASS status as runtime proof.

## Documented trust limitation (not a new P1)

Project-local agent/skill/extension configuration has higher precedence than user/builtin configuration (`pi-subagents/src/agents/agent-selection.ts:3–14`; `agents.ts:1359–1413, 2734–2786`; `skills.ts:32–41`). Effective system prompt, resolved skills, and configured extensions are delivered to the child launch (`runs/foreground/execution.ts:405–420, 1860–1885`; `runs/shared/pi-args.ts:469–612`). The new shared readiness call (`handoff-contract.mjs:85–101, 232–245`; reached by `goal-request.mjs:95–107`) checks role conventions but is not a provenance/approval receipt.

Therefore an arbitrary checkout must **not** be treated as automatically trusted merely because readiness succeeds: parent inspection/approval of effective project overrides, skills, prompt, and extension paths remains required. Per the supplied trust decision, this is an operational control-plane limitation, not a P1 against an approved project. Untrusted-checkout dispatch requires a separately approved isolated, credential-free runner; no such testing was performed.

## Criteria and checks

- **Evidence/request/recovery binding:** statically traced; P2 exception above.
- **Authorization/prompt/tool boundaries:** traced from preparation through installed child launch; parent-approved project config remains the authority boundary.
- **Secrets/exfiltration/supply chain:** no dependency, CI, publication, or credential changes in the pinned diff. Authorized host commands can still log sensitive output; their command selection remains parent responsibility.
- **Checks:** not run, per static-only authorization.

**Artifacts:** contract, source pin, diff, audit README/spec, current helper bodies, installed mirror, and named regression sources.  
**Residual risks:** no live native/Goal/provider evidence; no independent digest recomputation; no filesystem-permission or race validation.  
**Next action:** decide whether to fix the P2 reader before live recovery use, then have the user run an approved disposable race/symlink regression and live recovery canary.  
**memoryCandidates:** None; no role memory written.