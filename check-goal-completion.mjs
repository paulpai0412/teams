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
        core.state.goal = args.mutate(structuredClone(core.state.goal));
        return { ok: true, goal: core.state.goal };
      },
      endTurn: () => {
        options.duringFlush?.(core);
      },
      isTurnBuffered: () => options.bufferHeld === true,
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
        options.duringAudit?.(core);
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
  let readPersisted = () => null;
  if (options.realService) {
    const { GoalService } = await jiti.import(
      path.join(sourceRoot, "goal-service.ts"),
    );
    const { createGoal } = await jiti.import(
      path.join(sourceRoot, "goal-record.ts"),
    );
    const { GOALS_DIR, parseGoalFile } = await jiti.import(
      path.join(sourceRoot, "storage/goal-files.ts"),
    );
    const directory = path.resolve(scratch, GOALS_DIR);
    assert.ok(directory.startsWith(scratch + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
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
      appendFocusEntry: () => {},
      onFocusedGoalLost: () => {
        core.state.goal = null;
      },
      onReconciled: (value) => {
        core.state.goal = value;
      },
      onFocusChanged: () => {},
      onDiagnostic: () => {},
    });
    service.create(ctx, {
      goal: {
        ...createGoal({ objective: goal.objective, autoContinue: true }),
        ...goal,
      },
    });
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
      parseGoalFile(path.resolve(scratch, core.state.goal.activePath));
  }
  registerTaskTools(core);
  const result = options.task
    ? await tools.get("update_goal_task").execute(
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
  return {
    auditCalls,
    commits,
    events,
    result,
    goal: core.state.goal,
    persisted: readPersisted(),
  };
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
  if (process.argv.includes("--evidence")) {
    const { runCheck, acceptanceReference, sealAcceptance } = await import(
      "./host-evidence.mjs"
    );
    const source = path.join(scratch, "source.js");
    const review = path.join(scratch, "fixture-review.md");
    fs.writeFileSync(source, "export const marker = 1;\n");
    fs.writeFileSync(review, "Fixture only; not independent review.\n");
    const input = {
      cwd: scratch,
      sourcePaths: ["source.js"],
      argv: [process.execPath, "--check", "source.js"],
      timeoutMs: 10000,
    };
    runCheck(input, path.join(scratch, "check.json"));
    const missionDir = path.join(scratch, "missions/fixture");
    fs.mkdirSync(missionDir, { recursive: true });
    const statePath = path.join(missionDir, "state.json");
    const state = {
      teamGoalBinding: { goalId: "fixture-goal", cwd: scratch },
      teamGoalActiveStep: null,
    };
    fs.writeFileSync(statePath, JSON.stringify(state));
    const contract = {
      version: "team-evidence/1",
      cwd: scratch,
      goalId: "fixture-goal",
      taskId: "t1",
      criteria: ["syntax and retained review fixture"],
      checks: [{ id: "syntax", input }],
      requiredEvidence: ["fixture-review.md"],
      decision: "decision.json",
      mission: { id: "fixture", statePath },
    };
    const file = path.join(scratch, "contract.json");
    fs.writeFileSync(file, JSON.stringify(contract));
    const reference = acceptanceReference(file);
    const protectedGoal = (status) => ({
      taskList: {
        blockCompletion: true,
        tasks: [
          {
            id: "t1",
            title: "fixture",
            status,
            verificationContract: reference,
          },
        ],
      },
    });
    for (const task of [false, true]) {
      const checked = await exercise(
        {},
        { task, goal: protectedGoal(task ? "pending" : "complete") },
      );
      assert.equal(
        checked.commits,
        0,
        "missing sealed host evidence must block the actual completion entrypoint",
      );
      assert.equal(
        checked.auditCalls,
        0,
        "reject missing evidence before starting an auditor",
      );
      cases++;
    }
    const observations = path.join(scratch, "observations.json");
    fs.writeFileSync(
      observations,
      JSON.stringify({
        checks: { syntax: "check.json" },
        criterionResults: [
          {
            criterion: contract.criteria[0],
            status: "met",
            entrypoint: "node --check source.js",
            observed: "fixture syntax checked; fixture review retained",
            evidence: ["check:syntax", "file:fixture-review.md"],
          },
        ],
      }),
    );
    sealAcceptance(file, observations);
    for (const task of [false, true]) {
      assert.equal(
        (
          await exercise(
            {},
            { task, goal: protectedGoal(task ? "pending" : "complete") },
          )
        ).commits,
        1,
      );
      cases++;
    }
    for (const task of [false, true]) {
      const real = await exercise(
        {},
        {
          task,
          realService: true,
          goal: protectedGoal(task ? "pending" : "complete"),
        },
      );
      assert.equal(
        real.persisted?.status,
        task ? "active" : "complete",
        "completion acknowledgment must match the actual native Goal file, not just its turn buffer",
      );
      assert.equal(real.persisted.taskList.tasks[0].status, "complete");
      assert.equal(
        real.persisted.usage.tokensUsed,
        7,
        "pending usage must survive the immediate completion boundary",
      );
      cases++;
    }
    for (const task of [false, true]) {
      assert.equal(
        (
          await exercise(
            {},
            {
              task,
              bufferHeld: true,
              goal: protectedGoal(task ? "pending" : "complete"),
            },
          )
        ).commits,
        0,
        "an unflushed locked buffer cannot acknowledge completion",
      );
      cases++;
      const changedWhileFlushing = await exercise(
        {},
        {
          task,
          goal: protectedGoal(task ? "pending" : "complete"),
          duringFlush: () =>
            fs.appendFileSync(source, "// changed while flushing\n"),
        },
      );
      assert.equal(
        changedWhileFlushing.commits,
        0,
        "evidence must be rechecked after flushing pending state",
      );
      cases++;
      fs.writeFileSync(source, "export const marker = 1;\n");
    }
    const raced = await exercise(
      { disabled: false },
      {
        goal: protectedGoal("complete"),
        duringAudit: () =>
          fs.appendFileSync(source, "// changed during audit\n"),
      },
    );
    assert.equal(raced.auditCalls, 1);
    assert.equal(
      raced.commits,
      0,
      "final common commit must recheck source after the audit",
    );
    cases++;
    assert.equal(
      (await exercise({}, { task: true, goal: protectedGoal("pending") }))
        .commits,
      0,
    );
    cases++;
    assert.equal(
      (
        await exercise(
          { disableContracts: true },
          { goal: protectedGoal("complete") },
        )
      ).commits,
      1,
      "explicit user contract setting remains honored",
    );
    cases++;
    fs.writeFileSync(source, "export const marker = 1;\n");
    const changedIntent = await exercise(
      { disabled: false },
      {
        goal: protectedGoal("complete"),
        duringAudit: (core) => {
          core.state.goal.objective = "changed requirements";
        },
      },
    );
    assert.equal(
      changedIntent.commits,
      0,
      "changed Goal contract/intent cancels in-flight completion",
    );
    cases++;
    fs.rmSync(review);
    assert.equal(
      (await exercise({}, { goal: protectedGoal("complete") })).commits,
      0,
      "missing required review cannot be replaced by an evidence string",
    );
    cases++;
    fs.writeFileSync(review, "Fixture only; not independent review.\n");
    state.teamGoalActiveStep = "goal-step.t1.review.1";
    fs.writeFileSync(statePath, JSON.stringify(state));
    assert.equal(
      (await exercise({}, { goal: protectedGoal("complete") })).commits,
      0,
    );
    cases++;
    state.teamGoalActiveStep = null;
    state["goal-step.t1.review.1"] = { status: "dispatching", runId: null };
    fs.writeFileSync(statePath, JSON.stringify(state));
    assert.equal(
      (await exercise({}, { goal: protectedGoal("complete") })).commits,
      0,
      "cleared active marker does not erase an unresolved retained intent",
    );
    cases++;
  }
  console.log(
    JSON.stringify({
      status: "PASS",
      cases,
      sourceRoot,
      modelCalls: 0,
      childAgents: 0,
      limitation:
        "Real completion entrypoints; --evidence also uses native GoalService, actual disposable Goal files and a buffered-state boundary. Fake auditor, no existing Goal mutation or live model.",
    }),
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
