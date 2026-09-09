# Outcome practice — bounded acceptance

User request: strengthen outcome definition, real-entrypoint verification, per-criterion delivery judgments in existing agent teams.

- Shared team-flow/team-member and /team prompt now point to OUTCOME-PRACTICE.md. Existing task/mission content is reused; no new scheduler, role or task store.
- Existing gate-candidate requires a unique result per requested criterion, actual-entrypoint/observation/evidence fields, and all-met alongside original report checks. Both verifier and review paths reject summary-only, missing/duplicate/extra rows, non-met statuses, empty evidence and stale reported source state. Failure preserves blocked state.
- Red: red.log shows old helper accepting summary-only pass. Green: gate-check.json, 43 mock cases against the actual saved workflow body, zero models/children. check-config delegates to the same regression; its full global extension scan was NOT run for this change.
- Three primary JS LSP checks clean; node syntax checks clean for the .mjs files. Workflow body is parsed/executed by AsyncFunction in the regression. Scoped lens cache has no errors; not a project-wide proof.
- No live model/TUI E2E, native controller validation or independent child review in this bounded parent-owned change. No claim that actual outcome quality has improved.
- Report consistency only: no direct checkout hashing, evidence-content verification, user-attestation enforcement or universal completion hook. Main must inspect actual source/evidence and obtain user decisions; a plausible but false report can still pass structural checks.
- No model/tool/permission/budget/provider configuration changes. No Harness-X source changes for this request.

Final files: source-sha256.txt. Backup of existing files: /home/timmypai/.pi/backups/team-outcomes-20260905-234620 (new files have no previous version). Revert only these scoped files after checking for subsequent edits; do not overwrite newer team configuration.

Retrospective: a global configuration scan can be blocked by unrelated extensions; share one gate regression between standalone and full checks instead of weakening the global check. Next evaluation should inspect a real task's delivery and user rework, not add more mandatory roles or claim model quality from mock passes.
