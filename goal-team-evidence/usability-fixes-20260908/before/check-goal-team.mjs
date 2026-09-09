// Offline checks of installed goal settings and the actual task-step workflow.
// No goal record writes, model calls, child processes or live task execution.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { prepareGoalRequest } from "./goal-request.mjs";
import { createJiti } from "../npm/node_modules/jiti/lib/jiti.mjs";
import { DefaultResourceLoader } from "/home/timmypai/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const root = path.resolve(import.meta.dirname, "..");
const cwd = path.resolve(process.argv[2] ?? process.cwd());
const jiti = createJiti(import.meta.url);
const { loadSettingsSnapshot } = await jiti.import(
  path.join(root, "npm/node_modules/pi-goal-x/extensions/goal-settings.ts"),
);
const settings = loadSettingsSnapshot(cwd);
assert.deepEqual(settings.diagnostics, []);
assert.equal(settings.value.disabled, true, "goal auditor must be off");
assert.equal(settings.value.disableTasks, false);
assert.equal(settings.value.disableContracts, false);
assert.equal(settings.value.autoSelectSingleGoal, false);
assert.equal(settings.value.auditorProjectResources, false);
assert.equal(settings.value.oracle.enabled, false);
assert.equal(settings.value.oracle.projectResources, false);
// Effective settings are checked here. The reliability patch --check verifies
// source compatibility; check-goal-completion.mjs tests the actual completion path.
const loader = new DefaultResourceLoader({ cwd, agentDir: root });
await loader.reload();
const extensions = loader.getExtensions();
assert.deepEqual(extensions.errors, []);
assert.ok(
  extensions.extensions.some(
    (x) =>
      x.path ===
      path.join(root, "npm/node_modules/pi-goal-x/extensions/goal.ts"),
  ),
);
const tools = new Set(
  extensions.extensions.flatMap((x) => [...x.tools.keys()]),
);
for (const name of [
  "subagent",
  "create_goal",
  "get_goal",
  "set_goal_tasks",
  "update_goal_task",
  "update_goal",
])
  assert.ok(tools.has(name), "missing " + name);

const body = fs.readFileSync(
  path.join(root, "teams/goal-task-step.js"),
  "utf8",
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const request = {
  goalId: "fixture-goal",
  taskId: "t1",
  phase: "implement",
  attempt: 1,
  agent: "team.implementer",
  task: "Only inspect the fixture.",
  cwd: "/fixture",
  sourceState: "before-sha+diff",
  goalStatus: "active",
  taskStatus: "pending",
};
const binding = { goalId: request.goalId, cwd: request.cwd };
const report = {
  verdict: "pass",
  goalId: request.goalId,
  taskId: request.taskId,
  inputSourceState: request.sourceState,
  sourceState: "after-sha+diff",
  evidence: ["fixture: exit=0; log=fixture.log"],
  residualRisks: [],
};
const pass = {
  ok: true,
  runId: "fixture-child",
  structuredOutput: report,
  artifactPaths: ["fixture-report.md"],
};
const recordKey = "goal-step.t1.implement.1";
const clone = (value) => structuredClone(value);
function fixture(overrides = {}) {
  return {
    teamGoalRequest: {
      ...prepareGoalRequest(request, "/fixture/packet.json"),
      ...overrides,
    },
    teamGoalBinding: binding,
  };
}
async function exercise(
  data,
  result = pass,
  failSaveKey = null,
  onRun = () => {},
) {
  const calls = [];
  const state = {
    get: async (key) => data[key],
    set: async (key, value) => {
      if (key === failSaveKey) throw new Error("fixture persistence failure");
      data[key] = clone(value);
    },
  };
  const runs = {
    run: async (key, args) => {
      assert.equal(data[recordKey]?.status, "dispatching");
      assert.equal(data.teamGoalActiveStep, recordKey);
      assert.equal(args.context, "fresh");
      assert.equal(args.agent, data.teamGoalRequest.agent);
      assert.ok(args.output.startsWith("goal-steps/"));
      assert.ok(
        !("model" in args) && !("tools" in args) && !("extensions" in args),
      );
      calls.push({ key, args });
      onRun();
      if (result instanceof Error) throw result;
      return result;
    },
  };
  try {
    return {
      value: await new AsyncFunction("state", "runs", body)(state, runs),
      calls,
      data,
    };
  } catch (error) {
    return { error, calls, data };
  }
}
let cases = 0;
const first = await exercise(fixture());
assert.equal(first.value.status, "reported");
assert.equal(first.calls.length, 1);
cases++;
// JSON round-trip + a new workflow function simulates a recovered parent;
// the already-recorded step returns evidence without launching again.
const recovered = await exercise(clone(first.data));
assert.equal(recovered.value.status, "reconcile");
assert.equal(recovered.calls.length, 0);
cases++;
const changed = clone(first.data);
changed.teamGoalRequest = prepareGoalRequest(
  { ...changed.teamGoalRequest, task: "Different work" },
  "/fixture/changed.json",
);
assert.ok((await exercise(changed)).error);
cases++;
for (const overrides of [
  { goalStatus: "paused" },
  { goalStatus: "blocked" },
  { taskStatus: "complete" },
  { attempt: 0 },
  { attempt: 4 },
  { agent: "team.advisor" },
  { agent: "worker" },
  { taskId: "../t1" },
  { cwd: "relative" },
  { sourceState: "" },
]) {
  const result = await exercise(fixture(overrides));
  assert.ok(result.error);
  assert.equal(result.calls.length, 0);
  cases++;
}
const wrongGoal = fixture();
wrongGoal.teamGoalBinding = { ...binding, goalId: "other-goal" };
assert.ok((await exercise(wrongGoal)).error);
cases++;
const unbound = fixture();
delete unbound.teamGoalBinding;
const noBinding = await exercise(unbound);
assert.ok(noBinding.error);
assert.equal(noBinding.calls.length, 0);
cases++;
for (const bad of [
  null,
  { ok: false },
  { ok: true, output: "PASS" },
  { ...pass, runId: "" },
  { ...pass, structuredOutput: { ...report, goalId: "other-goal" } },
  { ...pass, structuredOutput: { ...report, taskId: "other-task" } },
  { ...pass, structuredOutput: { ...report, inputSourceState: "stale" } },
  { ...pass, structuredOutput: { ...report, sourceState: "" } },
  { ...pass, structuredOutput: { ...report, evidence: [" "] } },
  { ...pass, structuredOutput: { ...report, verdict: "blocked" } },
  { ...pass, structuredOutput: { ...report, residualRisks: [null] } },
]) {
  const result = await exercise(fixture(), bad);
  assert.equal(result.value.status, "blocked");
  const replay = await exercise(clone(result.data));
  assert.equal(replay.calls.length, 0);
  cases++;
}
const crashed = await exercise(
  fixture(),
  new Error("ambiguous launch failure"),
);
assert.ok(crashed.error);
assert.equal(crashed.data[recordKey].status, "dispatching");
assert.equal((await exercise(clone(crashed.data))).calls.length, 0);
cases++;
// Switching to a NEW key cannot bypass an unresolved active marker.
const next = clone(first.data);
next.teamGoalRequest.phase = "review";
const blockedNext = await exercise(next);
assert.ok(blockedNext.error);
assert.equal(blockedNext.calls.length, 0);
cases++;
const noSave = await exercise(fixture(), pass, recordKey);
assert.ok(noSave.error);
assert.equal(noSave.calls.length, 0);
assert.equal(noSave.data.teamGoalActiveStep, undefined);
cases++;
// The script neither marks a task complete nor clears active ownership on return.
assert.equal(first.data.teamGoalActiveStep, recordKey);
assert.equal(first.data.teamGoalRequest.taskStatus, "pending");
cases++;
// Exercise the actual helper arguments against native report/envelope validation.
const writerArgs = first.calls[0].args;
assert.deepEqual(writerArgs.acceptance, {
  level: "checked",
  evidence: ["changed-files", "commands-run", "residual-risks"],
  report: "on",
});
cases++;
const { createStructuredOutputToolParameters, validateStructuredOutputValue } =
  await jiti.import(
    path.join(
      root,
      "npm/node_modules/pi-subagents/src/runs/shared/structured-output.ts",
    ),
  );
const {
  resolveAcceptanceReportMode,
  resolveEffectiveAcceptance,
  evaluateAcceptance,
} = await jiti.import(
  path.join(
    root,
    "npm/node_modules/pi-subagents/src/runs/shared/acceptance.ts",
  ),
);
assert.equal(resolveAcceptanceReportMode(writerArgs.acceptance), "required");
cases++;
const envelope = createStructuredOutputToolParameters(writerArgs.outputSchema, {
  acceptanceReport: resolveAcceptanceReportMode(writerArgs.acceptance),
});
assert.equal(
  (await validateStructuredOutputValue(envelope, { value: report })).status,
  "invalid",
);
cases++;
const effective = resolveEffectiveAcceptance({
  agentName: "team.implementer",
  acceptanceRole: "writer",
  task: "Implement the approved fixture change",
  explicit: writerArgs.acceptance,
});
const nativeReport = {
  criteriaSatisfied: effective.criteria.map((x) => ({
    id: x.id,
    status: "satisfied",
    evidence: "offline fixture only",
  })),
  changedFiles: [],
  testsAddedOrUpdated: [],
  commandsRun: [
    {
      command: "offline fixture",
      result: "passed",
      summary: "envelope control",
    },
  ],
  residualRisks: ["Fixture only; not live writer acceptance."],
  noStagedFiles: true,
};
assert.equal(
  (
    await validateStructuredOutputValue(envelope, {
      value: report,
      acceptanceReport: nativeReport,
    })
  ).status,
  "valid",
);
cases++;
assert.equal(
  (
    await validateStructuredOutputValue(writerArgs.outputSchema, {
      ...report,
      acceptanceReport: nativeReport,
    })
  ).status,
  "invalid",
);
cases++;
const missing = await evaluateAcceptance({
  acceptance: effective,
  output: "Structured output captured.",
  cwd,
});
assert.equal(missing.status, "rejected");
assert.match(
  missing.childReportParseError,
  /Structured acceptance report not found/,
);
cases++;
const malformed = await evaluateAcceptance({
  acceptance: effective,
  output: "Structured output captured.",
  cwd,
  report: { ...nativeReport, redLog: "unsupported" },
});
assert.equal(malformed.status, "rejected");
assert.match(
  malformed.childReportParseError,
  /unsupported acceptance report field/,
);
cases++;
assert.equal(
  (
    await evaluateAcceptance({
      acceptance: effective,
      output: "Structured output captured.",
      cwd,
      report: nativeReport,
    })
  ).status,
  "checked",
);
cases++;
// Do not impose writer acceptance on any other role or replace its defaults.
for (const role of [
  "planner",
  "challenger",
  "researcher",
  "debugger",
  "verifier",
  "reviewer",
  "e2e",
  "qa",
  "security",
  "docs",
  "curator",
  "release",
]) {
  const checked = await exercise(fixture({ agent: "team." + role }));
  assert.equal(checked.value.status, "reported");
  assert.equal(checked.calls.length, 1);
  assert.ok(!("acceptance" in checked.calls[0].args));
  cases++;
}
// Disposable work survives an invalid handoff or timeout. No second writer call.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "team-handoff-replay-"));
try {
  for (const failure of [
    {
      ok: false,
      runId: "fixture-format-error",
      artifactPaths: ["fixture-report.md"],
    },
    new Error("fixture timeout after mutation"),
  ]) {
    let executions = 0;
    const artifact = path.join(scratch, "result.txt");
    const mutate = () => {
      executions++;
      fs.writeFileSync(artifact, "completed fixture work");
    };
    const firstAttempt = await exercise(fixture(), failure, null, mutate);
    const digest = createHash("sha256")
      .update(fs.readFileSync(artifact))
      .digest("hex");
    await exercise(clone(firstAttempt.data), pass, null, mutate);
    const nextAttempt = clone(firstAttempt.data);
    nextAttempt.teamGoalRequest.attempt = 2;
    assert.ok((await exercise(nextAttempt, pass, null, mutate)).error);
    assert.equal(executions, 1);
    assert.equal(
      createHash("sha256").update(fs.readFileSync(artifact)).digest("hex"),
      digest,
    );
    assert.equal(firstAttempt.data.teamGoalRequest.taskStatus, "pending");
    cases++;
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
// Version-1 history remains readable and never replays its work.
const legacy = fixture();
legacy[recordKey] = {
  status: "reported",
  request: {
    goalId: request.goalId,
    taskId: request.taskId,
    phase: request.phase,
    attempt: request.attempt,
    agent: request.agent,
    task: request.task,
    cwd: request.cwd,
    sourceState: request.sourceState,
  },
};
assert.equal((await exercise(legacy)).value.status, "reconcile");
assert.equal((await exercise(legacy)).calls.length, 0);
cases++;
const { validateWorkflowScript } = await jiti.import(
  path.join(
    root,
    "npm/node_modules/pi-subagents/src/workflows/scripted-workflow.ts",
  ),
);
assert.deepEqual(
  validateWorkflowScript(body).errors,
  [],
  "native workflow syntax must remain valid",
);
cases++;
console.log(
  JSON.stringify(
    {
      status: "PASS",
      cwd,
      modelCalls: 0,
      childAgents: 0,
      cases,
      settings: {
        global: settings.global.path,
        project: settings.project.path,
        auditorDisabled: true,
        tasksEnabled: true,
        oracleEnabled: false,
      },
      limitations: [
        "Mocked workflow runs/state; no live goal/child/TUI E2E.",
        "Goal snapshots and source identity are parent attestations, not runtime locks.",
        "Single-owner protocol, not cross-session exactly-once; hold/wake is covered separately by check-goal-hold-wake.mjs.",
        "Unrelated global extensions are outside this scoped check.",
      ],
    },
    null,
    2,
  ),
);
process.exit(0);
