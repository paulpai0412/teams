# Correctness / Spec Review

**verdict: blocked** — one unresolved P2 lifecycle dead-end needs parent disposition. No P0/P1 found by this static review. This is not evidence that tests or live workflows ran.

## Reviewed scope and evidence

Reviewed the fixed archived diff, F1–F5 specification, candidate helper bodies (`goal-task-step.js`, `goal-recovery.mjs`, `goal-request.mjs`, `handoff-contract.mjs`, `host-evidence.mjs`), installed `pi-goal-x` evidence consumer and its completion callers, plus new and legacy reconciliation/preparation tests.

`source-pin.json` binds the approved 23-file candidate set to manifest digest `d485a525…`; the contract records parent entry verification. I did not recompute hashes or execute tests/scanners, as prohibited. Historical logs were read only as claims, not treated as test proof.

## Standards

No separate newly introduced standards violation found. The F1–F5 changes retain the documented one-parent/one-controller shape, do not add a controller or authority, preserve original outcome history during supported recovery, and place the selected-role readiness check in the shared preparation path.

The P2 below is a lifecycle/recoverability defect rather than a cosmetic/style concern. Its smallest remedy should remain within the existing parent recovery helper/state model, not add a scheduler, role, or framework.

## Spec / correctness finding

### P2 — pre-launch persistence failure creates a retained record that no supported recovery can settle

**Status:** Pre-existing failure mode, **widened** by this candidate’s newly inserted budget write.

**Source proof:**  
- `goal-task-step.js:144-146` writes the durable `dispatching` record, then the admission budget, then the active marker.  
- `goal-task-step.js:191-...` reaches `runs.run` only after all three awaits.  
- `goal-recovery.mjs:31-36` requires exactly one matching terminal native child step to prepare recovery.  
- `host-evidence.mjs:442-488` accepts a retained `dispatching` record at final acceptance only when it has a valid recovery; it rejects every other retained `goal-step.*` record.

**Reachable action sequence (static control flow):**
1. Parent prepares and applies a valid public dispatch packet.
2. `state.set(recordKey, {status:"dispatching"})` at line 144 succeeds.
3. `state.set(budgetKey, ...)` at line 145 fails (or, as already possible before this diff, the marker write at line 146 fails).
4. Because these are awaited and precede line 191, no `runs.run` call is attempted and thus the terminal native status has no matching child step.
5. A retry of the same key only returns “reconcile”; `prepareGoalRecovery` rejects the zero-child status; final acceptance rejects the retained `dispatching` record.

Depending on which write failed, later work is either blocked by `budget.lastRecord` or may proceed but can never pass final acceptance because the old record remains unsettled. The documented “retain intent; reconcile” behavior therefore lacks a supported reconciliation route for this no-launch subset.

**Impact:** A transient native-state storage failure can permanently strand a task/mission under the public protocol, despite no child or external effect having been launched. Manual state surgery would be outside the documented supported helper flow.

**Smallest fix:** Add a narrowly bounded parent reconciliation path for a durable pre-launch intent: require the exact request/binding and a terminal native workflow status proving zero matching child steps, then record a distinct no-launch reconciliation/settlement without rewriting the original history. It must not authorize replay merely because status is missing or unknown.

**Regression:** Add an actual mission-state fixture where `state.set` fails separately at `goal-admissions...` and `teamGoalActiveStep`, assert `runs.run` was never called, then assert the supported recovery leaves final acceptance consumable and does not permit a second launch for the same key. `reconciliation.test.mjs:133-146` covers only failure saving the *post-launch final record*, so it does not cover this gap.

## Limitations / missing evidence

- The F1 repair-counter, F2 recovered-throw/final-save, F3 report-only→explicit-continue, F4 early identity, and F5 ordinary/Goal readiness paths have relevant static regressions and their code paths align with the requested fixes.
- I did not execute those tests, verify installed hashes independently, or perform live Goal/TUI/provider recovery; those remain user-owned/outside this static review.
- Parent-owned state and the documented single-owner/non-CAS limitation are not treated as a security bypass here. The finding concerns the supported helper lifecycle after an ordinary persistence error.