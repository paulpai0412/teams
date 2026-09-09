# Usability re-review — 2026-09-08

Verdict: NOT ready for unattended/general long-running team use. Prior offline
implementation completion does not establish overall usability. Parent-only review,
no product/helper patches, no real child/model calls, no live Goal/mission mutation.

## Reproduced findings

1. **High — success admissions are mistaken for retries.**
   `goal-task-step.js:110-127` counts every admission for task+role, regardless of
   prior success, criterion slice or new source. Four legitimate successful slice
   reviews reject the fourth after 3 fake launches. This is not the promised maximum
   three evidence-driven repair rounds. Separate logical work from repair retries,
   retain native wave limits and avoid accepting phase renaming as new logical work.

2. **High — preflight is not uniform across supported entrypoints.**
   `goal-request.mjs:76` public prepareGoalDispatch export omits effective role checks;
   those occur only in CLI at :178-188. A no-shell team.docs with an execution check
   generated setup and reached stubbed runs.run; workflow accepted its report.
   Unify supported preparation entrypoints; explicitly mark pure serialization as
   non-dispatchable legacy data rather than exporting a competing preparation path.

3. **High — selected-role readiness remains disconnected from CLI preparation.**
   `roles.log` reports docs/e2e/release/security missing declared skills, but real CLI
   --dispatch successfully produces team.e2e browser work with missing browser-automation.
   Hand-off only checks shell here; combine existing selected-role readiness instead
   of requiring the parent to remember an unrelated command. No auto-install or removal.
   This is an integration gap, not proof that a missing guidance file equals a missing
   browser executable. Executable/browser readiness also requires task-specific checks.

4. **High — captured-report finalization failure still permits repeat work.**
   `goal-task-step.js:121` blocks only delivery != captured. A returned ok:false with
   a valid captured report, followed by retry reason 'repair report finalization only',
   launches the same-source work again (2 launches). Bounded free-text reason/evidence
   does not classify the failure. Need structured, receipt-linked reconciliation;
   report-only action cannot carry writer/execution replay authority.

5. **High — thrown failure path bypasses outcome classification.**
   `await runs.run` at :171 has no catch; a native throw leaves only dispatching intent
   and no execution/report/product classification (:211 onward never runs).
   This is conservative against same-key replay, not silent data loss, but it leaves
   the exact prior WebSocket/throw scenario dependent on manual marker editing and
   report reconstruction. Preserve actual native error/run/artifact references, classify
   unknown honestly, and provide one bounded recovery route without auto-pass/relaunch.

6. **Operational blocker — upgrade/patch health is still failed.**
   Actual delivery --check exits 1: required base hash mismatch at
   extensions/goal-team-hold.ts. Predates this review; do not attribute it solely to
   this delta or bypass hashes. Need reconcile the installed patch stack and its
   complete current manifest/rollback before claiming an upgradeable system.

## Evidence
- `probes.mjs` exercises actual exported functions/workflow body with disposable
  state/runs fixtures and the real preparation CLI. `results.json` records outcomes.
- `roles.log`: actual selected/all-role health, four roles failed declared-skill checks.
- `patch-health.log`: actual read-only --check failure.
- All scripted launch counts are fixtures; zero real children and zero model calls.

## Why earlier green tests were insufficient
The admission test encoded the mistaken policy as expected behavior. Outcome tests
covered returned envelopes, not thrown errors. Preflight tests favored CLI rejection
and omitted equivalence across exported API/CLI and full readiness. No realistic
multiple-success slices followed by repairs, no actual native recovery canary, and
no measured end-to-end token/time savings. More assertions around the same assumptions
would not establish usability.

## Required next steps
Reopen TODO-73b0ff5e. TDD counterexamples for legitimate progression, entrypoint
parity, connected readiness, returned-vs-thrown failures and report-only recovery;
then reconcile patch provenance. Preserve permissions/models and REQUIRED gates.
Only after offline behavior is sound, seek explicit authorization for a bounded live
canary: one small task, one writer, required independent check, controlled failure
recovery, raw receipts and actual token/elapsed measurements. Do not repeat the full
vocab workflow just to validate these changes.
