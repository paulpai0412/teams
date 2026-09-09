# Team-flow correction — 2026-09-07

## Authority and scope

User explicitly requested correction of the four team-flow problems discussed in this session. Main-only; no children, model calls, permissions/model/provider changes, browser/skill installation, Goal changes or Grafana code edits in this turn. Existing Grafana dirty work preserved.

## Delivered

1. `teams/check-config.mjs`: new `--roles-only --roles=team.debugger,team.reviewer <cwd>` checks only selected role contracts while retaining shared safety settings and discovery diagnostics. Unknown, duplicate, empty, repeated or incorrectly scoped selections fail. Missing selected skills remain failures. Receipts distinguish selected scope and unchecked roles. Existing all-role/full modes retained.
2. `teams/HANDOFF-PRACTICE.md`: task-relevant acceptance prerequisites checked before implementation; safe partial work is allowed with disclosed gaps. Main-only fallback cannot retroactively waive required review/E2E.
3. `teams/OUTCOME-PRACTICE.md`: separate source/build, installation, persistence, intent/readback and actual rendering evidence as applicable. Fixture improvement is not proof of an unreproduced user symptom; prompt guidance is not a runtime gate.
4. `skills/team-flow/SKILL.md`, `teams/OPERATING-MODEL.md`: matching operational guidance. No fixed workflow or mandatory all-role sequence added.
5. `teams/check-selected-role-preflight.mjs`: runnable offline integration regression against the actual checker.

## Evidence

- `selected-roles.log`: debugger/reviewer selected check passes in Grafana cwd.
- `regression.json`: 10 cases pass in Grafana cwd.
- `regression-home.json`: 10 cases pass in home cwd.
- In both cwd tests the all-role health check still fails on the actual missing skill; explicitly selecting that role still fails. This preserves fail-closed behavior rather than hiding the missing dependency.
- `handoff.log`: 43 existing handoff cases pass.
- `outcomes.log`: 54 existing outcome consistency cases pass.
- Primary LSP: two edited JS files clean. File hashes in `sha256.txt`.

## Limits

- `team.docs` missing skill is not repaired/installed. Full health is not PASS.
- Shared discovery errors and global safety checks intentionally still block selected mode.
- Environment readiness and honest fallback are operating contracts, not new mandatory runtime hooks. No claim of live child compliance, visual improvement, or improved task latency from these offline tests.
- No independent child review, per main-only scope. Grafana installation and actual visual acceptance remain separate outstanding work.

## Recovery

Pre-change copies are adjacent: `check-config.before.mjs`, `HANDOFF-PRACTICE.md.before`, `OUTCOME-PRACTICE.md.before`, `OPERATING-MODEL.md.before`, `team-flow.before.md`. Compare current hashes and any subsequent edits before restoring only these files. The regression file is new; no third-party package source was changed. CLI changes are effective on next invocation; reload/new session is needed for other sessions to consume updated skill instructions.

## Lesson

Use selected-role capability preflight for admission, full health for inventory. A dependency missing from an unused role is not evidence that the selected role cannot execute. Keep resulting limitations explicit; narrowing check scope is not narrowing acceptance criteria.
