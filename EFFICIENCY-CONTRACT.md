# Team efficiency contract — 2026-09-08

Scope: parent-owned dispatch/helpers, not a new controller or an OS security gate.
Models/tools/permissions, native limits and REQUIRED gates are unchanged.

## Select work, not a ritual sequence

| Responsibility (`work.kind`) | Owner | Evidence owed |
| --- | --- | --- |
| `implementation` | implementer; docs/release within their actual tools | Minimal change and regression evidence; never self-acceptance |
| `review` | reviewer/security | Independent source/spec findings for the assigned criteria; not browser execution |
| `scenarios` | qa | User scenarios or evaluation of provided runtime artifacts; not a second full source review and not a browser pass |
| `browser` | verifier/e2e with existing capability and environment | Actual real-entrypoint interactions, raw logs/screenshots as required, cleanup |
| `mechanical` | verifier only when independence/context savings justify a child | Exact commands and raw results; prefer parent host runner for fixed checks |
| `analysis` | planner/challenger/researcher/debugger/curator | Only the material question; debugger may probe approved scratch resources |

No-shell QA remains no-shell. Do not promise browser execution from that role.
"No product-source writes" does not mean "no scratch/browser/cache writes" for a
shell-capable verifier. The parent provisions/authorizes these resources separately.
Do not change role/tools just to bypass a failed capability check.

Default small change: main + host checks. Larger work: one writer + host checks,
plus the independent judgment/real-entrypoint gates actually required. QA is useful
before implementation to define scenarios or to examine actual UX evidence. Do not
launch both reviewer and static QA to reread the same tree without distinct questions.

## New Goal dispatch contract

`goal-request.mjs --dispatch` requires `work` and validates it before saving launch
artifacts. Existing saved packets remain readable via the non-dispatch CLI; no live
Goal/mission is automatically migrated. New work is not prepared from an old packet
until the parent supplies the missing scope. `await prepareGoalDispatch(...)` and
CLI share the same work/shell and selected-role readiness checks. The non-dispatch
CLI/prepareGoalRequest export is legacy packet normalization, NOT a new-work entrypoint.

```json
{
  "work": {
    "kind": "review",
    "criteria": ["C2: reject malformed CSV without changing saved data"],
    "checks": []
  }
}
```

Keep criterion IDs/text from the approved task. Assign only the subset this role can
observe. Parent acceptance must still cover ALL original criteria and required gates;
subsetting a dispatch is not authorization to remove a criterion.

Execution work (`browser`/`mechanical`) needs explicit nonempty checks. Each check is
`{command, location:"child-safe"}` or `isolated-only` with `resource`. Parent-only
checks stay on the host. Legacy top-level `checks` without `work` are rejected rather
than silently discarded. Conflicting copies are rejected. Effective role shell
capability and selected-role skill/model/config readiness are checked once by
`prepareHandoff`, shared by ordinary and Goal preparation, including project overrides.
Invalid taskId/phase are rejected by the shared Goal normalizer before readiness or artifacts. Task-specific environment/executable checks remain separately REQUIRED;
this does not install skills or prove arbitrary shell safety. New effective packets
retain sourcePaths so recovery cannot silently shrink the original evidence scope.

The work contract is hashed into request identity and carried to the child once.
Goal outputSchema requires exact unique `criterionResults` rows for contracted work.
Summary-only, foreign/duplicate criteria, empty met-evidence, contradictory pass,
or a changed read-only source binding cannot pass. A digest echo is correlation,
not independent host source attestation. Ordinary handoffs optionally accept the same
`work`, consistent with their existing `criteria`/`checks`.

## Bounded admissions and recovery

The helper retains `goal-admissions.<taskId>.<agent>` in the EXISTING mission state.
Version 2 counts at most three parent-authorized repairs per task/role, not successful
slices. Initial work + three repairs fits attempt 1..4; phase/source changes do not reset
repair history. Every prior slice, INCLUDING child `reported`, needs parent terminal
reconciliation before another same-task/role launch. `continue` consumes zero repairs;
`retry` consumes one. A writer self-pass later rejected by host/review is still a repair.
Use the already-required reconciliation to record that decision, not another child or
invented failure reason. Native wave/session ceilings remain unchanged. Same-key replay
only returns reconciliation. Legacy count-based ledgers are not reinterpreted or reset.

Free-text `retry:{reason,evidence}` remains readable but requires an actual parent retry
disposition; it cannot borrow a free continue decision. Use `goal-recovery.mjs` as below. No automatic repair child, scheduling,
Goal completion or product-pass promotion. Direct native calls and parent state edits
are not intercepted. One owner only; this is not a CAS lock or security boundary.

### Parent recovery, no child

Save input `{statusPath,recordKey,action,reason,check,receipt}` outside source scope:
- `statusPath`: actual native workflow status.json, beside its native mission.json.
- `recordKey`: exact goal-step key; native mission state and saved request are read directly.
- `action`: `report-only` (terminal effects reconciled, report handling still pending;
  never permits another launch), `continue` (parent finished reconciliation/report
  handling; normal new work, zero repairs), or `retry` (parent diagnosed product work
  still needed; consumes a repair). After report-only, finish the report locally and
  prepare an explicit continue decision before new work; do not rerun the original work.
- `rejection`: for retry after a captured product pass, an absolute nonempty regular
  evidence artifact (host failure or independent review finding) inspected by the parent.
  Its bytes are hashed; missing/empty/credential/symlink paths fail. File existence does
  NOT prove semantic rejection. The parent must distinguish product defects from report
  formatting; a report-only failure never justifies manufacturing this artifact.
- `check` and `receipt`: existing host-check input/receipt verifying effects, artifacts
  and the full original sourcePaths; verifyCheck checks runtime, intent, log and freshness.
- `reason`: bounded parent diagnosis after inspecting actual evidence. Parent must ensure
  the check actually establishes the claimed safety/outcome; an arbitrary exit-0 is not proof.

Run `node ~/.pi/agent/teams/goal-recovery.mjs /absolute/recovery-input.json`, inspect the
result and execute its setupArgs through the existing controller with the same mission.
Preparation never executes checks or mutates mission state. The generated zero-child
script refuses changed records/bindings or another active intent, adds a requestDigest-bound
recovery decision and clears only this terminal step's marker. Original outcomes/errors
stay unchanged. A captured pass requires separate parent product-rejection evidence for
retry. The next same-task/role dispatch must match recovery sourceState. Recheck source/native status before applying; no cross-process
atomicity is claimed. Missing child identity, legacy missing scope/counter, active native
runs or stale host evidence remain blocked; do not manufacture their migration/proof.

Records distinguish:
- `outcomes.execution`: completed / failed / unknown.
- `outcomes.reportDelivery`: captured / missing / invalid / unknown (throw).
- `outcomes.product`: the well-formed report's verdict or unknown; NOT final acceptance.

A failed execution with a captured pass stays historically blocked. Parent reconciliation
may authorize a separately evidenced product repair, but never promotes that original
record to pass. A child `blocked` stays historically blocked; never infer a wrapper defect
from prose. Throws save blocked/unknown outcomes, bounded
original error and available run/artifact references, retain ownership and rethrow for
native status/artifact reconciliation. No fabricated root-cause attribution, automatic pass,
relaunch, or automatic marker cleanup. Keep raw reports and original statuses intact;
parent acceptance decisions cite actual evidence separately. Host/runtime completion and
recovery preparation share `goalStepSettled`: a terminal request-bound recovery, including
its childRunId, is required for retained reported/blocked/dispatching records. A bare runId
or cleared marker is not reconciliation. This is parent-owned evidence, not signed proof.
Historical recovery establishes terminal settlement, not current-source test freshness;
final criteria/checks still verify the candidate. Old records without the bound recovery
must be explicitly reconciled; no live records are automatically migrated.

## Shortest valid verification path

1. Finish formatting; freeze explicit source/test/config scopes. Include scripts,
   fixtures, dependencies and configuration affecting the check.
2. Use an existing deterministic check, not newly improvised browser code per run.
   Browser tests own one strict server/process, readiness, browser context and cleanup.
   Preflight environment before spending a child run. Preserve scripts/logs in durable
   evidence paths, not only `/tmp`. Never identify a floating-point/animation artifact
   as P1 without a stable reproduction and user impact.
3. Before rerunning a check, use `host-evidence.mjs verify input.json receipt.json`.
   Unchanged valid scope/log/runtime means reuse with ZERO command re-executions.
   Changed relevant scope means a new receipt. Missing dependency/unknown impact means
   invalidate; never shrink a historical receipt's scope to make it fresh.
4. For a source change, record affected criteria and checks. Re-run relevant mechanical
   checks and required independent review of the changed slice plus the prior findings.
   Do not ask every role to rediscover the whole app. Required final browser scenarios
   must still have valid evidence for the candidate. Static review is never a replacement.
5. Main inspects actual evidence and final source; duplicate complete test runs are not
   an automatic ritual when valid exact-scope host receipts already exist.

## Context and progress

- Cold packet: exact task, allowed files/actions, fixed criteria subset, source/artifact
  references, checks and stop rules. Do not paste past narratives or the entire mission.
- No second full copy of criteria in task prose when `work` already carries them.
- Keep historical reports outside mission state; retain native reference + compact outcome.
- Respond to blockers/material changes and ~10-minute progress, not every startup notice.
- A report-format problem is not a new product repair round. Repair the report locally.

## Validation and rollout

Offline regressions and RED/GREEN logs:
`goal-team-evidence/efficiency-20260908/`. Existing checks remain applicable:
`check-goal-dispatch.mjs`, `check-goal-team.mjs`, `check-goal-step-storage.mjs`,
`check-handoff-contract.mjs`, `check-team-outcomes.mjs`, `check-host-evidence.mjs`.

Current producer→consumer regressions and overlay verification are in
`goal-team-evidence/audit-fixes-20260908/`. They cover recovered throws/final-save failures,
unreconciled-record rejection, host-rejected repairs, successful continue, report-only
finalization and ordinary/Goal readiness parity. Prior fixture tests that cleared markers
without a disposition are historical, not the supported progression protocol.

The original three-admission test encoded a wrong policy; superseded by the usability
regressions in `goal-team-evidence/usability-fixes-20260908/`. Four successful slices are
allowed, a fourth repair is blocked, both dispatch entrypoints share readiness, throws
retain unknown outcomes and report-only recovery emits no child. Unaffected host receipts
verify without command rerun. These are not measured live token/cost/time improvements.
No live child or TUI canary was executed for this change. Helpers are read on invocation;
existing sessions need to reread these instructions. Third-party package versions and
Goal records are unchanged. Older hash-gated patch bundles may reject changed helper
hashes; do not overwrite or bypass those checks. Use this change's backup/manifest for
recovery and rebase upgrade patches explicitly.
