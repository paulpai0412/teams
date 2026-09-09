# Reliability repair checkpoint

> FINAL UPDATE: the historical checkpoint below is superseded by report.md,
> applied.json, verified.json and final-source.sha256. Reliability v2 is installed
> (backup 2026-09-08T01-22-53-572Z-4db4f67e), not reloaded. No live child/Goal/mission
> runs were created. Final checks: hold30/completion16/storage8+50 steps (25454B),
> Goal54×2, role regression11×2, handoff43, outcomes54, package11. Role health still
> fails four missing-skill roles; full product-evidence gate/review/live canary remain
> pending. Initial apply was named-reverted before fixing the new task-await race;
> initial-* receipts are historical. Next: obtain read-only reviewer authorization,
> do not dispatch or focus any Goal merely from this checkpoint.

User authority: 2026-09-08「開始修正」following design-audit. Main-only infrastructure repair; no children, new capabilities, models/permission/budget changes, existing Goal/mission mutations, publication or reload.

## Source/work state

- Native installed pi-goal-x still at old hold-wake v1 (not modified yet).
- New delta patch candidate: ../../patches/goal-team-reliability (preimages are exact installed v1; postimages add hold reconciliation, effective completion settings and active/unknown native-run completion guards).
- Full disposable package candidate: candidate/pi-goal-x; only four TS targets modified. Runs zero-model fixtures, not live E2E.
- Team source changed with before copies in before/: goal-task-step.js stores compact v2 records, saves intent before active marker; goal-request.mjs is parent-only SHA256 preparation of a saved packet. CLI output must be used unchanged; sandbox cannot verify bytes/digest itself. Legacy v1 replay remains non-dispatching.
- check-config.mjs aggregates role failures. No missing skill removed/replaced/installed; four roles remain unavailable.
- Regression additions: check-goal-step-storage.mjs (50 x 8KiB packets + 8KiB reports, state 37195 bytes); hold check now30; goal helper54; completion check12; selected-role regression11.
- RED logs record actual storage overflow, wrong global auditor behavior, task completion while native run active, missing new reconciliation seam. One initial completion test-fixture error was corrected before recording the meaningful RED.

## Acceptance and remaining work

Required: targeted mechanical regression, valid native workflow syntax, patch apply/idempotence/revert/failure rollback in disposable target, LSP on complete target (partial postimage files cannot resolve sibling modules alone), final source hashes and documentation.
Required but not available this round: independent lifecycle/security review and authorized live child/TUI canary. Do not waive them or claim full acceptance.

P1-4 scope: native run-state guards do not validate required product-evidence contents or source freshness. The current Goal contract has prose evidence, not an agreed host acceptance-receipt schema. Do not invent one silently or call this a full evidence gate; disclose this remaining integration gap and seek the bounded next decision. New team task lists should request block_completion:true; do not change existing tasks.

Next safe actions: finalize packet/guard negative cases; package/recovery tests; apply checked delta without reload; update GOAL-TEAMS/HANDOFF/OPERATING and checker settings assumption; final evidence/report with pending skill/restored capability and full acceptance-guard decisions.
