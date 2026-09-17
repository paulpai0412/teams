// Current Goal-X completion/settings seam. Legacy private hold/delivery assertions
// are preserved in goal-team-evidence/task-runtime-readiness-memory-20260914/
// check-goal-completion.before.txt, not treated as installed public capabilities.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "../npm/node_modules/jiti/lib/jiti.mjs";
const args = process.argv.slice(2);
assert.ok(
  args.length <= 1 && !args[0]?.startsWith("-"),
  "optional source-root directory only; this checks current Goal-X, not legacy --evidence patches",
);
const sourceRoot = path.resolve(
  args[0] ??
    new URL("../npm/node_modules/pi-goal-x/extensions", import.meta.url)
      .pathname,
);
const hostLoader = createJiti(
  fs.realpathSync(path.join(path.dirname(process.execPath), "pi")),
);
const jiti = createJiti(import.meta.url, {
  alias: Object.fromEntries(
    [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "typebox",
    ].map((name) => [name, hostLoader.esmResolve(name)]),
  ),
});
const { runGoalCompletionFlow } = await jiti.import(
  path.join(sourceRoot, "goal-completion.ts"),
);
const { invalidateGoalSettingsCache } = await jiti.import(
  path.join(sourceRoot, "goal-settings.ts"),
);
const { GoalService } = await jiti.import(
  path.join(sourceRoot, "goal-service.ts"),
);
const { createGoal } = await jiti.import(
  path.join(sourceRoot, "goal-record.ts"),
);
const { GOALS_DIR, parseGoalFile } = await jiti.import(
  path.join(sourceRoot, "storage/goal-files.ts"),
);
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "goal-completion-check-"),
);
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(scratch, "global.json");
process.env.PI_GOAL_SETTINGS_FILE = path.join(scratch, "project.json");
process.env.PI_SUBAGENTS_TEMP_ROOT = scratch;
let cases = 0;
async function exercise(projectSettings, options = {}) {
  const cwd = fs.mkdtempSync(path.join(scratch, "case-"));
  fs.mkdirSync(path.join(cwd, GOALS_DIR), { recursive: true });
  fs.writeFileSync(
    process.env.PI_GOAL_GLOBAL_SETTINGS_FILE,
    JSON.stringify(options.global ?? { disabled: true }),
  );
  fs.writeFileSync(
    process.env.PI_GOAL_SETTINGS_FILE,
    JSON.stringify(projectSettings),
  );
  invalidateGoalSettingsCache();
  let auditCalls = 0,
    commits = 0;
  const events = [];
  const messages = [];
  const goal = {
    ...createGoal({ objective: "Completion fixture", autoContinue: true }),
    ...options.goal,
  };
  const core = {
    state: { goal },
    runningGoalId: goal.id,
    goalWidgetComponentRef: { current: null },
    auditMessages: { enqueue: (_ctx, value) => messages.push(value) },
    reconcileFocusedGoalFromDisk() {},
    focusedOperationToken: (id) => ({ goalId: id, revision: 1 }),
    isFocusedOperationCurrent: (token) => core.state.goal?.id === token.goalId,
    focusedOperationCancelledResult: () => ({
      content: [{ type: "text", text: "fixture focus changed" }],
    }),
    accountProgress() {},
    updateUI() {},
    setAuditResult() {},
    goalService: {
      flushForAudit: () => options.flushError ?? null,
      appendEvents: (_ctx, added) => events.push(...added),
      apply: (_ctx, input) => {
        if (options.rejectWrite)
          return { ok: false, message: "fixture write denied" };
        commits++;
        core.state.goal = input.mutate(structuredClone(core.state.goal));
        return { ok: true, goal: core.state.goal };
      },
    },
    runtime: { markTurnStopped() {} },
    stopAuditAnimation: () => clearInterval(core.auditAnimationTimer),
    dependencies: {
      runCompletionAuditor: async () => {
        auditCalls++;
        options.duringAudit?.(core);
        return (
          options.audit ?? { approved: true, output: "fixture approval only" }
        );
      },
    },
  };
  const ctx = { cwd, sessionManager: { getBranch: () => [] } };
  let readPersisted = () => null;
  if (options.realService) {
    let pool = new Map();
    const service = new GoalService({
      getFocused: () => core.state.goal,
      setFocused: (value) => {
        core.state.goal = value;
        if (value) pool.set(value.id, value);
      },
      getPool: () => pool,
      replacePool: (value) => {
        pool = value;
      },
      getFocusedGoalId: () => core.state.goal?.id ?? null,
      assignFocusedGoalId: (id) => {
        core.state.goal = id ? (pool.get(id) ?? core.state.goal) : null;
      },
      focusToken: core.focusedOperationToken,
      isTokenCurrent: core.isFocusedOperationCurrent,
      appendFocusEntry() {},
      onFocusedGoalLost: () => {
        core.state.goal = null;
      },
      onReconciled: (value) => {
        core.state.goal = value;
      },
      onFocusChanged() {},
      onDiagnostic: (event) => {
        throw new Error(JSON.stringify(event));
      },
    });
    service.create(ctx, { goal });
    service.beginTurn(ctx, goal.id);
    service.apply(ctx, {
      reconcile: false,
      mutate: (current) => ({
        ...current,
        usage: { ...current.usage, tokensUsed: 7 },
      }),
    });
    core.goalService = service;
    core.reconcileFocusedGoalFromDisk = () => service.reconcileFocused(ctx);
    readPersisted = () =>
      parseGoalFile(path.resolve(cwd, core.state.goal.activePath));
  }
  const result = await runGoalCompletionFlow(
    core,
    ctx,
    "Untrusted fixture claim",
  );
  return {
    auditCalls,
    commits,
    events,
    messages,
    result,
    goal: core.state.goal,
    persisted: readPersisted(),
  };
}
try {
  for (const [global, project, expected] of [
    [{ disabled: true }, {}, 0],
    [{ disabled: true }, { disabled: false }, 1],
    [{ disabled: false }, { disabled: true }, 0],
    [{ disabled: false }, {}, 1],
  ]) {
    const r = await exercise(project, { global });
    assert.equal(
      r.auditCalls,
      expected,
      "completion must use effective global/project settings",
    );
    assert.equal(r.commits, 1);
    assert.equal(r.goal.status, "complete");
    assert.equal(
      r.events.some((e) => e.type === "audit_skipped"),
      expected === 0,
    );
    cases++;
  }
  const skipped = await exercise(
    { disabled: false },
    { goal: { skipAuditor: true } },
  );
  assert.equal(skipped.auditCalls, 0);
  assert.equal(skipped.commits, 1);
  cases++;
  const pending = await exercise(
    {},
    {
      goal: {
        taskList: {
          blockCompletion: true,
          tasks: [{ id: "t1", title: "unfinished", status: "pending" }],
        },
      },
    },
  );
  assert.equal(pending.commits, 0);
  assert.equal(pending.auditCalls, 0);
  cases++;
  const completeTasks = await exercise(
    {},
    {
      goal: {
        taskList: {
          blockCompletion: true,
          tasks: [{ id: "t1", title: "finished", status: "complete" }],
        },
      },
    },
  );
  assert.equal(completeTasks.commits, 1);
  cases++;
  const paused = await exercise(
    { disabled: false },
    { goal: { status: "paused", autoContinue: false } },
  );
  assert.equal(paused.auditCalls, 1);
  assert.equal(paused.commits, 1);
  cases++;
  for (const options of [
    { audit: { approved: false, output: "rejected" } },
    {
      audit: {
        approved: false,
        error: "fixture auditor failure",
        output: "failed",
      },
    },
    {
      duringAudit: (core) => {
        core.state.goal.id = "foreign-goal";
      },
    },
    { rejectWrite: true },
    { flushError: "fixture flush held" },
  ]) {
    const r = await exercise({ disabled: false }, options);
    assert.equal(r.commits, 0, "rejection/uncertainty cannot complete a Goal");
    assert.notEqual(r.goal.status, "complete");
    cases++;
  }
  for (const project of [{}, { disabled: false }]) {
    const r = await exercise(project, { realService: true });
    assert.equal(
      r.persisted.status,
      "complete",
      "reported completion must match the native Goal file",
    );
    assert.equal(
      r.persisted.usage.tokensUsed,
      7,
      "buffered usage survives completion",
    );
    assert.equal(r.auditCalls, project.disabled === false ? 1 : 0);
    cases++;
  }
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        scope: "current-goal-completion-settings-and-storage",
        cases,
        sourceRoot,
        modelCalls: 0,
        childAgents: 0,
        limitations: [
          "Actual installed completion and GoalService; auditor is a fixture, not live independent review.",
          "Task Pi native ownership/acceptance/Goal readback is checked by task-runtime/test suites; legacy private hold/delivery patches are not supported or certified.",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
