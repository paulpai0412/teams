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
until the parent supplies the missing scope. The synchronous preparation export is
only packet construction; it is not a substitute for CLI effective-role preflight.

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
capability is checked by existing `prepareHandoff`, including project overrides.
Selected-role skill/model/environment readiness checks remain separately REQUIRED;
this does not install skills or prove arbitrary shell safety.

The work contract is hashed into request identity and carried to the child once.
Goal outputSchema requires exact unique `criterionResults` rows for contracted work.
Summary-only, foreign/duplicate criteria, empty met-evidence, contradictory pass,
or a changed read-only source binding cannot pass. A digest echo is correlation,
not independent host source attestation. Ordinary handoffs optionally accept the same
`work`, consistent with their existing `criteria`/`checks`.

## Bounded admissions and recovery

The helper retains `goal-admissions.<taskId>.<agent>` in the EXISTING mission state.
Maximum three admissions per task/role, including initial work; phase renaming or
source changes do not reset it. This is a conservative dispatch ceiling, not a quota.
A later admission requires bounded `retry:{reason,evidence}` documenting diagnosed
need. Same-key replay still reconciles without dispatch. An unresolved prior intent
blocks new work even if someone cleared the active marker.

Missing/invalid reports at unchanged source block another same-role work admission;
main repairs only the report from existing evidence. No automatic repair child is
introduced. Stop at the ceiling; never change role/task/mission identity to bypass it.
User-approved scope/budget changes require explicit reconciliation, not a hidden reset.
Legacy steps predating this counter are NOT retroactively counted. When recovering an
old mission the parent must inspect its history before any new admission. Direct native
calls and parent edits to state are not intercepted. Single owner only, not a CAS lock.

Records distinguish:
- `outcomes.execution`: completed / failed / unknown.
- `outcomes.reportDelivery`: captured / missing / invalid.
- `outcomes.product`: the well-formed report's verdict or unknown; NOT final acceptance.

A failed execution with a captured pass stays blocked. A child `blocked` stays blocked;
never infer a wrapper defect from prose. Throws preserve dispatch intent for native
status/artifact reconciliation. No fabricated root-cause attribution, automatic pass,
relaunch, or automatic marker cleanup. Keep raw reports and original statuses intact;
parent acceptance decisions cite actual evidence separately.

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

Measured offline: illegal preparation emits no dispatch artifacts; phase-renamed fourth
admission emits no child; report-only failure does not relaunch; unaffected host receipts
verify without command rerun. These are not measured live token/cost/time improvements.
No live child or TUI canary was executed for this change. Helpers are read on invocation;
existing sessions need to reread these instructions. Third-party package versions and
Goal records are unchanged. Older hash-gated patch bundles may reject changed helper
hashes; do not overwrite or bypass those checks. Use this change's backup/manifest for
recovery and rebase upgrade patches explicitly.
