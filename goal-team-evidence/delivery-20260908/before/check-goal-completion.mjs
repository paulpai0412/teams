// Completion entrypoint/settings regression; fake auditor and in-memory mutations.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "../npm/node_modules/jiti/lib/jiti.mjs";
const sourceRoot = path.resolve(
  process.argv[2] ??
    new URL("../npm/node_modules/pi-goal-x/extensions", import.meta.url)
      .pathname,
);
const modules = new URL("../npm/node_modules/", import.meta.url).pathname;
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-ai": path.join(modules, "@earendil-works/pi-ai"),
    "@earendil-works/pi-coding-agent": path.join(
      modules,
      "@earendil-works/pi-coding-agent",
    ),
    "@earendil-works/pi-tui": path.join(
      modules,
      "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui",
    ),
    typebox: path.join(modules, "typebox"),
  },
});
const { runGoalCompletionFlow } = await jiti.import(
  path.join(sourceRoot, "goal-completion.ts"),
);
const { registerTaskTools } = await jiti.import(
  path.join(sourceRoot, "goal-task-tools.ts"),
);
const { invalidateGoalSettingsCache } = await jiti.import(
  path.join(sourceRoot, "goal-settings.ts"),
);
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "goal-completion-check-"),
);
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(scratch, "global.json");
process.env.PI_GOAL_SETTINGS_FILE = path.join(scratch, "project.json");
process.env.PI_SUBAGENTS_TEMP_ROOT = scratch;
let cases = 0;
async function exercise(projectSettings, options = {}) {
  fs.writeFileSync(
    process.env.PI_GOAL_GLOBAL_SETTINGS_FILE,
    JSON.stringify({ disabled: true }),
  );
  fs.writeFileSync(
    process.env.PI_GOAL_SETTINGS_FILE,
    JSON.stringify(projectSettings),
  );
  invalidateGoalSettingsCache();
  let auditCalls = 0;
  let commits = 0;
  const events = [];
  const tools = new Map();
  const goal = {
    id: "fixture-goal",
    objective: "Completion fixture",
    status: "active",
    autoContinue: true,
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
    usage: { tokensUsed: 0, activeSeconds: 0 },
    ...options.goal,
  };
  const core = {
    state: { goal },
    runningGoalId: goal.id,
    goalWidgetComponentRef: { current: null },
    pi: {
      sendMessage: () => {},
      registerTool: (tool) => tools.set(tool.name, tool),
    },
    reconcileFocusedGoalFromDisk: () => {},
    focusedOperationToken: (id) => ({ goalId: id, revision: 1 }),
    isFocusedOperationCurrent: (token) => core.state.goal?.id === token.goalId,
    focusedOperationCancelledResult: () => ({
      content: [{ type: "text", text: "fixture focus changed" }],
    }),
    accountProgress: () => {},
    updateUI: () => {},
    setAuditResult: () => {},
    goalService: {
      appendEvents: (_ctx, added) => events.push(...added),
      apply: (_ctx, args) => {
        commits++;
        core.state.goal = args.mutate();
        return { ok: true, goal: core.state.goal };
      },
      updateTask: (_ctx, args) => {
        const task = core.state.goal.taskList.tasks[0];
        const valid = args.validate(task);
        if (!valid.ok) return valid;
        commits++;
        core.state.goal.taskList.tasks[0] = args.update(task);
        return { ok: true, goal: core.state.goal };
      },
    },
    runtime: { markTurnStopped: () => {} },
    stopAuditAnimation: () => {
      clearInterval(core.auditAnimationTimer);
    },
    dependencies: {
      runCompletionAuditor: async () => {
        auditCalls++;
        return { approved: true, output: "fixture approval only" };
      },
    },
  };
  const ctx = {
    cwd: scratch,
    sessionManager: {
      getBranch: () => {
        if (options.duringObservation)
          core.state.goal.status = options.duringObservation;
        if (options.switchFocus) core.state.goal.id = "foreign-goal";
        return options.entries ?? [];
      },
    },
  };
  registerTaskTools(core);
  const result = options.task
    ? await tools
        .get("update_goal_task")
        .execute(
          "fixture-tool",
          {
            task_id: "t1",
            status: "complete",
            evidence: "fixture evidence only",
          },
          undefined,
          undefined,
          ctx,
        )
    : await runGoalCompletionFlow(core, ctx, "Untrusted fixture claim");
  return { auditCalls, commits, events, result, goal: core.state.goal };
}
try {
  const inherited = await exercise({});
  assert.equal(
    inherited.auditCalls,
    0,
    "global disabled must govern the real completion entrypoint",
  );
  assert.equal(inherited.commits, 1);
  assert.ok(inherited.events.some((event) => event.type === "audit_skipped"));
  cases++;
  assert.equal(
    (await exercise({ disabled: false })).auditCalls,
    1,
    "explicit project opt-in must win",
  );
  cases++;
  assert.equal(
    (await exercise({ disabled: false }, { goal: { skipAuditor: true } }))
      .auditCalls,
    0,
    "existing per-goal user choice remains honored",
  );
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

  for (const race of [{ duringObservation: "paused" }, { switchFocus: true }]) {
    const raced = await exercise(
      {},
      {
        ...race,
        task: true,
        goal: {
          taskList: {
            tasks: [{ id: "t1", title: "fixture", status: "pending" }],
          },
        },
      },
    );
    assert.equal(
      raced.commits,
      0,
      "task lifecycle/focus must be rechecked after awaiting native observation",
    );
    cases++;
  }

  const binding = {
    version: 1,
    goalId: "fixture-goal",
    taskId: "t1",
    sessionId: "fixture-session",
    cwd: scratch,
    toolCallId: "fixture-call",
    runId: "fixture-run",
    completionOwnerId: "fixture-owner",
    asyncDir: path.join(scratch, "async-subagent-runs/fixture-run"),
  };
  fs.mkdirSync(binding.asyncDir, { recursive: true });
  const entry = {
    customType: "pi-goal-team-hold",
    data: { version: 1, state: "bound", binding, at: Date.now() },
  };
  for (const state of ["running", null, "complete"]) {
    const file = path.join(binding.asyncDir, "status.json");
    if (state) fs.writeFileSync(file, JSON.stringify({ ...binding, state }));
    else fs.rmSync(file, { force: true });
    const checked = await exercise({}, { entries: [entry] });
    assert.equal(
      checked.commits,
      state === "complete" ? 1 : 0,
      "native team run must be quiescent before completion",
    );
    assert.equal(checked.auditCalls, 0);
    cases++;
    const task = await exercise(
      {},
      {
        entries: [entry],
        task: true,
        goal: {
          taskList: {
            blockCompletion: true,
            tasks: [{ id: "t1", title: "fixture task", status: "pending" }],
          },
        },
      },
    );
    assert.equal(
      task.commits,
      state === "complete" ? 1 : 0,
      "task completion must also reject active/unknown native runs",
    );
    cases++;
  }
  fs.writeFileSync(
    path.join(binding.asyncDir, "status.json"),
    JSON.stringify({
      ...binding,
      state: "complete",
      completionOwnerId: "foreign-owner",
    }),
  );
  assert.equal(
    (await exercise({}, { entries: [entry] })).commits,
    0,
    "terminal with a different completion owner is not proof",
  );
  cases++;
  const unrelated = {
    ...entry,
    data: { ...entry.data, binding: { ...binding, goalId: "different-goal" } },
  };
  assert.equal(
    (await exercise({}, { entries: [unrelated] })).commits,
    1,
    "unrelated Goal history does not change ordinary completion",
  );
  cases++;
  fs.rmSync(path.join(binding.asyncDir, "status.json"));
  const terminal = {
    ...entry,
    data: { ...entry.data, state: "released", reason: "native-completion" },
  };
  assert.equal(
    (await exercise({}, { entries: [entry, terminal] })).commits,
    1,
    "persisted host terminal observation survives artifact cleanup",
  );
  cases++;
  const unknown = {
    ...terminal,
    data: { ...terminal.data, reason: "reconcile-required-unknown" },
  };
  assert.equal(
    (await exercise({}, { entries: [entry, unknown] })).commits,
    0,
    "unknown-release is never terminal proof",
  );
  cases++;
  console.log(
    JSON.stringify({
      status: "PASS",
      cases,
      sourceRoot,
      modelCalls: 0,
      childAgents: 0,
      limitation:
        "Real completion function with fake auditor/mutations and disposable settings/status; no real Goal or live model.",
    }),
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
