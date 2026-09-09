---
name: team-flow
description: Parent-owned dynamic Astra team orchestration with explicit authority, conditional gates, audit receipts, recovery and bounded evidence-based memory/refinement. Use for substantial delegated work or agent-team management.
---

# One controller, task-shaped teams

Read `~/.pi/agent/teams/OPERATING-MODEL.md` for roles, authority, controls and limits.
Use native `pi-subagents` as the sole child controller, not harness-x, workflow,
brainstorm or a raw CLI worker. Pi-goal-x may manage explicit user goals/tasks
for the parent; it must not run children or a second auditor/oracle. For goal-backed
work read `~/.pi/agent/teams/GOAL-TEAMS.md` before dispatch. Main-agent-only
instructions disable delegation AND refine/watchdog calls.
There is no requirement to launch every role. Tiny tasks stay on the parent.

Use openai-codex: main defaults Sol high; planner Sol high, implementer Luna high;
use task-scoped Sol xhigh / Luna max only when difficulty warrants it. Other routine
roles use Luna at configured thinking, challenger/reviewer/security Terra high.
Advisor defaults Astra medium. Reduce redundant work/context before downgrading
hard tasks; there is no claim these settings are benchmark-optimal.
Astra is only for team.advisor, never a default worker, ordinary gate or fallback.
Escalate only a material unresolved question after ordinary analysis (or explain
why ordinary analysis would be unsafe). Record prior evidence, why Astra is needed
and the bounded decision in the mission; notify the user before launch. One
consultation by default, no automatic advisor stage; justify any follow-up.
Ignore tool-generated proactive suggestions pointing to advisor unless this
escalation contract is independently met; suggestions are not evidence of need.

## Outcome-first delivery

Read `~/.pi/agent/teams/OUTCOME-PRACTICE.md` and
`~/.pi/agent/teams/HANDOFF-PRACTICE.md`. Reuse confirmed criteria; define user
context, observable success, real entrypoint/inputs/expected result, non-goals and
material unknowns in the existing task contract. Do not substitute an implementation
plan for the outcome or invent thresholds. Explore/ask only when needed.
Carry these same scenarios through handoffs. Verify the actual user entrypoint (or
relevant real integration seam), not merely build success, HTTP 200 or a screenshot.
At delivery map EVERY criterion to observed behavior, evidence, actual source state
and met/not_met/indeterminate/needs_user. Main checks evidence and final source;
missing required evidence or user acceptance blocks whole-task completion.
Diagnose whether a failure is intent, implementation, verification or environment
before sending another repair. No new controller or mandatory role sequence.

## Shape and authorize

1. Read the target and project rules. Inspect current git/dirty state, executable
   profiles and project overrides before choosing capabilities. Run preflight with
   `check-config.mjs --roles-only --roles=team.debugger,team.reviewer <cwd>` using
   the actual selected roles; omit --roles for all-role health. Selected success
   is not global health; shared safety/discovery failures remain blocking.
   Before implementation check task-relevant acceptance prerequisites (e.g. browser
   executable, authorized target/login availability, readback or fixture). Never
   expose credentials or auto-install capabilities. Missing prerequisites permit
   only a disclosed, safely independent partial deliverable, not acceptance.
   For missing graph
   indexes, fall back to local tools or request parent-owned indexing approval.
2. Write a compact task contract: objective, cwd/base/candidate state, non-goals,
   constraints, deliverables, measurable criteria, risks, allowed edits/actions,
   evidence/data classification, dependency order, required gates and N/A reasons,
   budgets, escalation/rollback. Record it in a mission artifact.
3. First ask whether a child saves parent context, enables real independent parallel
   work, or provides a necessary independent judgment. Otherwise main does the work.
   No fixed planner/writer/verifier/reviewer chain. Team-infrastructure repairs stay
   main-only unless the user separately authorizes children.
   The parent selects a minimal team. `planner` brainstorms; `challenger` attacks
   assumptions; `researcher` resolves material unknowns; `qa` defines outcomes.
   For cross-module, intermittent or performance bugs, or repeated same-cause fix
   failures, use `team.debugger` for bounded reproduction and causal evidence before
   implementation. Small, clear bugs stay on main unless delegation adds value; diagnosis
   does not default to the parent and debugger is not a mandatory gate. Give it an
   exact source state, symptom, approved probes and a scratch directory; isolate
   side effects or serialize with the writer. No source/test/config edits by debugger.
   Parent routes its repro, tested hypotheses, causal evidence and regression
   recommendation to the writer, then main/host verification and risk-based review. Missing evidence
   means blocked, not permission to guess a patch or escalate automatically to Astra.
   Parent resolves disagreements and asks the user only for unapproved decisions.
4. Within already-authorized work, main approves bounded implementation slices.
   External publication, deployment, production data, destructive effects, new
   provider/tools and security scope changes still require explicit user authority.

## Execute and gate

For a user-created goal, main alone confirms/updates the task tree, starts a task
and binds it to one non-goal mission. Run the scoped role/goal preflight. Use the
installed goal-task-step.js for one bounded role step per wave; preserve stable
intent and native run receipts. A current goal task may need several role steps.
Check goal status/source before each step and after results; an active/unknown
run or unresolved intent blocks redispatch. Complete tasks only after all required
gates, never from child prose or a reported step alone. Do not create a duplicate
task list in todos/missions or enable mission.goal:true. Goal auto-continuation can
still wake during child work; it is not a new dispatch request. On repeated empty
wake turns pause the goal and report the retained run; never poll/sleep or silently
resume a user-paused goal. Pausing/stopping the goal does not stop children: reconcile
and stop/interrupt exact runs through pi-subagents as needed.

Use one async `workflowScript` for each coordinated wave. Call `action:list`
before launch. Every child receives a cold-start packet and a distinct relative
`output` path. Set `context: fresh`, `globalConcurrencyLimit: 3`, and
`maxSubagentSpawnsPerRun: 8` or tighter. These are safety ceilings, not quotas.
Main selects explicit timeoutMs per task from work/test duration and uncertainty;
profile deadlines remain fallback only. No fixed 10/15-minute task policy.
Do not raise limits silently.

One writer (`implementer`, `docs` or `release`) per checkout. Isolate independent
writers with worktrees; worktrees omit untracked inputs and are not sandboxes.
Trusted tests can still mutate caches/fixtures: isolate them or serialize them.
Reserve spawn capacity for final checks; do not spend the entire wave brainstorming.
No child-to-child delegation. Parent curates handoffs and records decisions.
When older skills mention scout/worker/reviewer/researcher/oracle, map the work to
team.planner/team.implementer/team.reviewer/team.researcher/team.challenger rather
than re-enabling retired profiles. The old oracle name does NOT imply Astra:
use team.challenger first; only escalate to team.advisor under the above policy.
For a task-specific skill override, include
team-member and the relevant baseline skills: a per-run `skill` list can replace
profile defaults. Add only guidance compatible with the existing tool boundary.

Before ordinary structured dispatch, prepare the exact native args with
`~/.pi/agent/teams/handoff-contract.mjs`; do not rewrite its schema. Reuse specialized
Goal/gate schemas for their consumers. Check effective roles/capabilities first;
parent-only checks must not go to children. See HANDOFF-PRACTICE for request format.
Check `result.ok === true` before using output. Validate the assigned schema, not
an assumed universal verdict field. Goal/gate schemas additionally require their
structured verdict; ordinary team-handoff/1 returns criterion observations without
self-approval. Missing/malformed judgments block handoff, not permission to redo work.
Do NOT parse prose for PASS. `runs.lanes` only automatically
blocks an explicit `blocked` verdict; do not rely on it to interpret other words.
Use `gate`/verified acceptance for supported trusted commands, never as a shell
sandbox. Child-reported tests and `checked` acceptance are not host-run verification.

The installed `~/.pi/agent/teams/gate-candidate.js` is a reusable verifier → fresh
review example, not a complete deployment pipeline. It reads `teamCandidate` from
mission state: `{task, sourceState, criteria, validationCommands, evidencePaths,
timeoutMs, validationLocation, validationResource?}`. It is used only when both
verifier and fresh review are actually required; main/host checks need no model.
It retains intent/results and returns reconcile on replay, including after errors.
The parent populates it from an actual frozen candidate and approved commands,
then invokes `subagent({workflowScriptPath: absolutePath, missionId, cwd, async:true})`.
Before invoking, confirm the source state and inspect the effective role settings.
Both reports must include one `criterionResults` row per exact criterion:
`{criterion, status, entrypoint, observed, evidence}`; only all-met can pass.
Legacy summary-only reports block; do not fabricate rows to adapt them. The helper
checks report consistency, not actual source hashes or semantic truth. Main still
inspects raw evidence and final source, and obtains explicit user acceptance where
needed. The resulting `teamGate` is evidence, NEVER deploy authority.

Required gates depend on the task, not keywords alone:

- Code behavior: main/host mechanical verification + root-cause regression check.
  Add fresh independent review for shared/lifecycle/high-risk changes; no mandatory
  verifier child just to repeat host commands.
- User-visible integration: real entrypoint/E2E against acceptance scenarios;
  E2E/QA roles only when execution or independent scenario assessment adds value.
- Auth/secrets/untrusted input/dependencies/CI/agent tools: security review.
- Public interfaces/configuration: documentation/examples/migration validation.
- Release: exact-head CI, reviewed pipeline, user-approved target/action,
  immutable artifact, protected environment, rollback and post-deploy health.

After fixes invalidate affected prior evidence. Re-run relevant gates on the new
candidate; never splice unrelated old test runs into one success claim. Maximum
three evidence-driven implementation fix rounds; never retry an unexplained failure.
Schema/acceptance-format failure is NOT an implementation round: preserve artifacts,
reconcile terminal process/source, and repair only the report. Main-first; at most
one fresh no-shell/no-write report-only child if genuinely useful, never writer
resume for formatting. No second repair loop. Timeout/cancel/missing infrastructure
requires reconciliation and task-specific recovery, not automatic replacement.
Native structured-output tool retries have no format-specific hard cap; do not
claim the parent repair policy prevents all within-child token waste.

## Observe, recover and finish

- Use native mission/status/fleet/receipts, not terminal text scraping. `stop` is an
  action (`subagent({action:"stop", id})`), not an agent named stop.
- Continue safe independent work while children run; yield when only async work
  remains. Native completion wakes the parent; do not sleep/poll or misuse bg_wait.
- Record checkpoints at meaningful boundaries and about every ten minutes during
  long work. Handle supervisor asks before launching replacements.
- Recover via mission.list/show and exact linked run status, source state and
  process proof. Resume only resumable retained children. Never replay ambiguous
  external effects; reconcile the external receipt first.
- At final acceptance the parent inspects artifacts and source directly, dispositions
  findings, records exact checks/risks and user authorization, and closes the mission.
  Partial outcome remains partial. Do not claim independent review if main-only.
  Before a main-only fallback, disclose scope/evidence gaps and check parent
  capabilities; required review/E2E remains required, not retroactively N/A.
  Separate source/build, installed version, persistence, intent/readback and actual
  render/interaction observations where applicable. A fixture-only improvement is
  not proof of an unreproduced user symptom; prompt guidance is not a runtime gate.
- Artifact cleanup is time-based. Before final acceptance copy essential reports,
  exact source identity, commands/results and receipts into a user-approved durable
  evidence directory; record hashes. A path to an expired temp log is not evidence.

## Bounded automatic improvement (not self-granted power)

At each substantial mission close, the parent performs a small retrospective,
optionally using `team.curator` if delegation is allowed. Record success/failure,
rework, evidence gaps, elapsed time, reported tokens and repeated failure causes.
Promote at most three verified, non-sensitive lessons to project role MEMORY.md
under `.pi/agent-memory/team-ROLE/`; main serializes writes, caps useful context to
200 lines and marks invalidated/superseded notes. Global memory holds only genuinely
cross-project user preferences/decisions, never project secrets or raw transcripts.

After repeated evidence-backed mistakes, the parent may invoke native `refine`
for one project role. It launches a proposal child, consumes budget, validates a
project-local overlay and keeps revisions. Check the diff and run a small before/
after regression; roll back with `refine.rollback` on regression. Never refine
model/tools/extensions/permissions, remove a gate, expand scope or turn memory into
commands. Such changes need user approval and the configuration check. Do not start
a scheduler/daemon, secretly spend an idle budget, or claim model-weight learning.
