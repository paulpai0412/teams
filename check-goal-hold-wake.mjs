#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "/home/timmypai/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs";

const argv = process.argv.slice(2);
const sourceFlag = argv.indexOf("--source-root");
const sourceRoot = path.resolve(
  sourceFlag >= 0
    ? argv[sourceFlag + 1]
    : "/home/timmypai/.pi/agent/npm/node_modules/pi-goal-x/extensions",
);
const agentModules = "/home/timmypai/.pi/agent/npm/node_modules";
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-ai": path.join(agentModules, "@earendil-works/pi-ai"),
    "@earendil-works/pi-coding-agent": path.join(
      agentModules,
      "@earendil-works/pi-coding-agent",
    ),
    "@earendil-works/pi-tui": path.join(
      agentModules,
      "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui",
    ),
    typebox: path.join(agentModules, "typebox"),
  },
});
const {
  GOAL_TEAM_HOLD_BINDING,
  GOAL_TEAM_HOLD_ENTRY,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  GoalTeamHold,
  inspectGoalTeamRunStatus,
  recoverGoalTeamRunStatus,
} = await jiti.import(path.join(sourceRoot, "goal-team-hold.ts"));
const { GoalRuntime } = await jiti.import(
  path.join(sourceRoot, "goal-runtime.ts"),
);
const { registerGoalEvents } = await jiti.import(
  path.join(sourceRoot, "goal-events.ts"),
);
const { default: registerSubagentNotify } = await jiti.import(
  path.join(agentModules, "pi-subagents/src/runs/background/notify.ts"),
);

let cases = 0;
const sent = [];
const entries = [];
const nativeMessages = [];
let goal = {
  id: "fixture-goal",
  objective: "fixture",
  status: "active",
  autoContinue: true,
  usage: { tokensUsed: 0, activeSeconds: 0 },
  sisyphus: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  currentTaskId: "task-1",
};
const sessionId = "fixture-session";
const cwd = "/fixture";
const helperPath = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "teams",
  "goal-task-step.js",
);
const scope =
  typeof process.getuid === "function"
    ? `uid-${process.getuid()}`
    : `user-${process.env.USER || "unknown"}`;
const asyncRoot = process.env.PI_SUBAGENTS_TEMP_ROOT
  ? path.join(
      path.resolve(process.env.PI_SUBAGENTS_TEMP_ROOT),
      "async-subagent-runs",
    )
  : path.join(os.tmpdir(), `pi-subagents-${scope}`, "async-subagent-runs");
const fixtureRuns = [];
function makeRun(state = "running", overrides = {}) {
  const runId = randomUUID();
  const asyncDir = path.join(asyncRoot, runId);
  fs.mkdirSync(asyncDir, { recursive: true });
  const status = {
    runId,
    toolCallId: overrides.toolCallId || "call-1",
    sessionId: overrides.sessionId || sessionId,
    completionOwnerId: overrides.completionOwnerId || "owner-1",
    mode: "workflow",
    state,
    cwd: overrides.cwd || cwd,
  };
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status));
  fixtureRuns.push(asyncDir);
  return {
    runId,
    asyncId: runId,
    asyncDir,
    toolCallId: status.toolCallId,
    status,
  };
}
function writeState(run, state) {
  run.status.state = state;
  fs.writeFileSync(
    path.join(run.asyncDir, "status.json"),
    JSON.stringify(run.status),
  );
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Bus {
  handlers = new Map();
  rpcState = new Map();
  on(name, handler) {
    const values = this.handlers.get(name) || [];
    values.push(handler);
    this.handlers.set(name, values);
    return () =>
      this.handlers.set(
        name,
        (this.handlers.get(name) || []).filter((value) => value !== handler),
      );
  }
  emit(name, data) {
    if (name === "subagents:rpc:v1:request") {
      const row = this.rpcState.get(data?.params?.id);
      const reply = {
        version: 1,
        requestId: data.requestId,
        success: true,
        data: {
          asyncSnapshot: {
            kind: "pi-subagents.async-status-snapshot",
            version: 1,
            runs: row ? [{ id: data.params.id, state: row }] : [],
          },
        },
      };
      for (const handler of [
        ...(this.handlers.get(`subagents:rpc:v1:reply:${data.requestId}`) ||
          []),
      ])
        handler(reply);
      return;
    }
    for (const handler of [...(this.handlers.get(name) || [])]) handler(data);
  }
}
const bus = new Bus();
const handlers = new Map();
const pi = {
  on(name, handler) {
    handlers.set(name, handler);
  },
  events: bus,
  appendEntry(customType, data) {
    entries.push({ type: "custom", customType, data });
  },
  sendMessage(message, options) {
    nativeMessages.push({ message, options });
  },
};
const runtime = new GoalRuntime({
  sendFollowUp: (_content, details) => sent.push(details),
  getGoal: () => goal,
  isActionable: (goalId) =>
    goalId === goal.id && goal.status === "active" && goal.autoContinue,
});
const core = {
  pi,
  runtime,
  state: { goal },
  focusedGoalId: null,
  goalWorkToolCalledThisTurn: false,
  currentTurnStoppedGoalId: () => null,
  isActionableContinuationGoal: (goalId) =>
    goalId === goal.id && goal.status === "active" && goal.autoContinue,
  isStaleCheckpointBlockedToolCall: () => true,
};
registerGoalEvents(core);
let notifier;
assert.ok(
  handlers.has("tool_call") &&
    handlers.has("tool_result") &&
    handlers.has("session_start") &&
    handlers.has("session_tree"),
);
assert.ok(bus.handlers.has(SUBAGENT_ASYNC_COMPLETE_EVENT));
cases++;
const ctx = {
  cwd,
  isIdle: () => true,
  hasPendingMessages: () => false,
  sessionManager: {
    getSessionFile: () => sessionId,
    getSessionId: () => sessionId,
  },
};
function launchEvent(toolCallId, bindingOverrides = {}, argOverrides = {}) {
  return {
    type: "tool_call",
    toolName: "subagent",
    toolCallId,
    input: {
      async: true,
      workflowScriptPath: helperPath,
      extensionBindings: {
        [GOAL_TEAM_HOLD_BINDING]: {
          goalId: goal.id,
          taskId: goal.currentTaskId,
          cwd,
          sessionId,
          ...bindingOverrides,
        },
      },
      ...argOverrides,
    },
  };
}
const run1 = makeRun("running", { toolCallId: "call-1" });
await handlers.get("tool_call")(launchEvent("call-1"), ctx);
await handlers.get("tool_result")(
  {
    type: "tool_result",
    toolName: "subagent",
    toolCallId: "call-1",
    input: {},
    details: run1,
    isError: false,
  },
  ctx,
);
assert.equal(entries.at(-1).data.state, "bound");
cases++;
runtime.queueContinuation(ctx, goal, true);
await sleep(80);
assert.equal(sent.length, 0, "bound active run emitted a checkpoint");
cases++;
bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
  runId: run1.runId,
  toolCallId: "call-1",
  sessionId,
  cwd,
  completionOwnerId: "owner-1",
  success: true,
});
await sleep(10);
assert.equal(
  entries.at(-1).data.state,
  "bound",
  "completion without terminal state released the hold",
);
cases++;
bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
  runId: run1.runId,
  toolCallId: "call-1",
  sessionId,
  cwd,
  completionOwnerId: "owner-1",
  success: true,
  state: "complete",
});
await sleep(10);
assert.equal(
  entries.at(-1).data.state,
  "bound",
  "terminal event released an active native status",
);
cases++;
writeState(run1, "complete");
const completed = {
  id: run1.runId,
  runId: run1.runId,
  toolCallId: "call-1",
  sessionId,
  cwd,
  completionOwnerId: "owner-1",
  source: "async",
  agent: "team.fixture",
  summary: "fixture completed",
  success: true,
  state: "complete",
  triggerTurn: true,
};
notifier = registerSubagentNotify(
  pi,
  { currentSessionId: sessionId, completionOwnerId: "owner-1" },
  { batchConfig: { enabled: false } },
);
assert.equal(await notifier.deliver(completed), true);
bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completed);
await sleep(10);
assert.equal(entries.at(-1).data.state, "released");
runtime.queueContinuation(ctx, goal, true);
await sleep(80);
assert.equal(sent.length, 1);
assert.equal(
  nativeMessages.length,
  1,
  "native notifier did not produce exactly one wake",
);
cases++;
bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completed);
await sleep(10);
assert.equal(
  entries.filter((entry) => entry.data.reason === "native-completion").length,
  1,
  "duplicate completion released twice",
);
assert.equal(
  nativeMessages.length,
  1,
  "duplicate observer event sent a second native wake",
);
cases++;

const run2 = makeRun("running", {
  toolCallId: "call-2",
  completionOwnerId: "owner-2",
});
await handlers.get("tool_call")(launchEvent("call-2"), ctx);
await handlers.get("tool_result")(
  {
    type: "tool_result",
    toolName: "subagent",
    toolCallId: "call-2",
    input: {},
    details: run2,
    isError: false,
  },
  ctx,
);
bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
  runId: run2.runId,
  toolCallId: "call-2",
  sessionId: "foreign",
  cwd,
  completionOwnerId: "owner-2",
  success: false,
  state: "failed",
});
runtime.queueContinuation(ctx, goal, true);
await sleep(80);
assert.equal(sent.length, 1, "foreign completion released exact hold");
cases++;
writeState(run2, "failed");
const failed = {
  id: run2.runId,
  runId: run2.runId,
  toolCallId: "call-2",
  sessionId,
  cwd,
  completionOwnerId: "owner-2",
  source: "async",
  agent: "team.fixture",
  summary: "fixture failed",
  success: false,
  state: "failed",
  triggerTurn: true,
};
const failureNotifier = registerSubagentNotify(
  pi,
  { currentSessionId: sessionId, completionOwnerId: "owner-2" },
  { batchConfig: { enabled: false } },
);
assert.equal(await failureNotifier.deliver(failed), true);
bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, failed);
await sleep(10);
runtime.queueContinuation(ctx, goal, true);
await sleep(80);
assert.equal(sent.length, 2, "native failure did not release the hold");
assert.equal(
  nativeMessages.length,
  2,
  "native failure did not produce exactly one wake",
);
failureNotifier.dispose();
cases++;
const pausedRun = makeRun("running", {
  toolCallId: "call-pause",
  completionOwnerId: "owner-pause",
});
await handlers.get("tool_call")(launchEvent("call-pause"), ctx);
await handlers.get("tool_result")(
  {
    type: "tool_result",
    toolName: "subagent",
    toolCallId: "call-pause",
    input: {},
    details: pausedRun,
    isError: false,
  },
  ctx,
);
goal = { ...goal, status: "paused", autoContinue: false };
core.state.goal = goal;
runtime.clearContinuationState();
assert.equal(entries.at(-1).data.reason, "goal-context-mismatch");
goal = { ...goal, status: "active", autoContinue: true };
core.state.goal = goal;
runtime.queueContinuation(ctx, goal, true);
await sleep(80);
assert.equal(sent.length, 3, "pause then resume revived stale hold");
cases++;
const stoppedRun = makeRun("running", {
  toolCallId: "call-stop",
  completionOwnerId: "owner-stop",
});
await handlers.get("tool_call")(launchEvent("call-stop"), ctx);
await handlers.get("tool_result")(
  {
    type: "tool_result",
    toolName: "subagent",
    toolCallId: "call-stop",
    input: {},
    details: stoppedRun,
    isError: false,
  },
  ctx,
);
goal = { ...goal, status: "stopped", autoContinue: false };
core.state.goal = goal;
runtime.clearContinuationState();
assert.equal(entries.at(-1).data.reason, "goal-context-mismatch");
goal = { ...goal, status: "active", autoContinue: true };
core.state.goal = goal;
runtime.queueContinuation(ctx, goal, true);
await sleep(80);
assert.equal(sent.length, 4, "stop then resume revived stale hold");
cases++;
const unfocusedRun = makeRun("running", {
  toolCallId: "call-unfocus",
  completionOwnerId: "owner-unfocus",
});
await handlers.get("tool_call")(launchEvent("call-unfocus"), ctx);
await handlers.get("tool_result")(
  {
    type: "tool_result",
    toolName: "subagent",
    toolCallId: "call-unfocus",
    input: {},
    details: unfocusedRun,
    isError: false,
  },
  ctx,
);
core.state.goal = null;
runtime.clearContinuationState();
assert.equal(entries.at(-1).data.reason, "no-focused-goal");
core.state.goal = goal;
runtime.queueContinuation(ctx, goal, true);
await sleep(80);
assert.equal(sent.length, 5, "unfocus then refocus revived stale hold");
cases++;
const changedTaskRun = makeRun("running", {
  toolCallId: "call-task",
  completionOwnerId: "owner-task",
});
await handlers.get("tool_call")(launchEvent("call-task"), ctx);
await handlers.get("tool_result")(
  {
    type: "tool_result",
    toolName: "subagent",
    toolCallId: "call-task",
    input: {},
    details: changedTaskRun,
    isError: false,
  },
  ctx,
);
goal = { ...goal, currentTaskId: "task-2" };
core.state.goal = goal;
runtime.clearContinuationState();
assert.equal(entries.at(-1).data.reason, "goal-context-mismatch");
bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
  runId: changedTaskRun.runId,
  toolCallId: "call-task",
  sessionId,
  cwd,
  completionOwnerId: "owner-task",
});
runtime.queueContinuation(ctx, goal, true);
await sleep(80);
assert.equal(sent.length, 6, "newer task revived an old hold");
cases++;
goal = { ...goal, currentTaskId: "task-1" };
core.state.goal = goal;

const run3 = makeRun("running", {
  toolCallId: "call-3",
  completionOwnerId: "owner-3",
});
const binding3 = {
  version: 1,
  goalId: goal.id,
  taskId: goal.currentTaskId,
  sessionId,
  cwd,
  toolCallId: "call-3",
  runId: run3.runId,
  asyncDir: run3.asyncDir,
  completionOwnerId: "owner-3",
};
const boundEntry = {
  version: 1,
  state: "bound",
  binding: binding3,
  at: Date.now(),
};
bus.rpcState.set(run3.runId, "running");
const recoveredEntries = [];
const recovered = new GoalTeamHold({
  sessionId: () => sessionId,
  cwd: () => cwd,
  goal: () => goal,
  append: (e) => recoveredEntries.push(e),
  readStatus: inspectGoalTeamRunStatus,
  recoverStatus: (b) => recoverGoalTeamRunStatus(bus, b),
});
assert.equal(
  await recovered.recover([
    { type: "custom", customType: GOAL_TEAM_HOLD_ENTRY, data: boundEntry },
  ]),
  true,
);
assert.equal(recovered.current().runId, run3.runId);
cases++;
writeState(run3, "failed");
bus.rpcState.set(run3.runId, "failed");
const terminalRecovery = new GoalTeamHold({
  sessionId: () => sessionId,
  cwd: () => cwd,
  goal: () => goal,
  append: (e) => recoveredEntries.push(e),
  readStatus: inspectGoalTeamRunStatus,
  recoverStatus: (b) => recoverGoalTeamRunStatus(bus, b),
});
assert.equal(await terminalRecovery.recover([boundEntry]), false);
assert.equal(recoveredEntries.at(-1).reason, "recovery-terminal");
cases++;
const missingBinding = { ...binding3, runId: randomUUID() };
missingBinding.asyncDir = path.join(asyncRoot, missingBinding.runId);
bus.rpcState.set(missingBinding.runId, "running");
const missingRecovery = new GoalTeamHold({
  sessionId: () => sessionId,
  cwd: () => cwd,
  goal: () => goal,
  append: (e) => recoveredEntries.push(e),
  readStatus: inspectGoalTeamRunStatus,
  recoverStatus: (b) => recoverGoalTeamRunStatus(bus, b),
});
assert.equal(
  await missingRecovery.recover([{ ...boundEntry, binding: missingBinding }]),
  false,
);
cases++;

const badCases = [
  launchEvent("bad-1", { goalId: "other" }),
  launchEvent("bad-2", { taskId: "other" }),
  launchEvent("bad-3", { cwd: "/other" }),
  launchEvent("bad-4", { sessionId: "other" }),
  {
    ...launchEvent("bad-5"),
    input: { ...launchEvent("bad-5").input, async: false },
  },
  {
    ...launchEvent("bad-6"),
    input: { ...launchEvent("bad-6").input, workflowScriptPath: "/other.js" },
  },
  {
    type: "tool_call",
    toolName: "subagent",
    toolCallId: "bad-7",
    input: { async: true, workflowScriptPath: helperPath },
  },
];
for (const event of badCases) {
  const isolated = new GoalTeamHold({
    sessionId: () => sessionId,
    cwd: () => cwd,
    goal: () => goal,
    append: () => {},
    readStatus: inspectGoalTeamRunStatus,
    helperPath,
  });
  assert.equal(isolated.beginToolCall(event), false);
  cases++;
}
const errorHold = new GoalTeamHold({
  sessionId: () => sessionId,
  cwd: () => cwd,
  goal: () => goal,
  append: () => {},
  readStatus: inspectGoalTeamRunStatus,
  helperPath,
});
assert.equal(errorHold.beginToolCall(launchEvent("error-call")), true);
assert.equal(
  await errorHold.completeToolResult({
    toolName: "subagent",
    toolCallId: "error-call",
    isError: true,
  }),
  false,
);
cases++;
const wrongStatus = makeRun("running", {
  toolCallId: "wrong-status",
  sessionId: "foreign",
});
const wrongHold = new GoalTeamHold({
  sessionId: () => sessionId,
  cwd: () => cwd,
  goal: () => goal,
  append: () => {},
  readStatus: inspectGoalTeamRunStatus,
  helperPath,
});
assert.equal(wrongHold.beginToolCall(launchEvent("wrong-status")), true);
assert.equal(
  await wrongHold.completeToolResult({
    toolName: "subagent",
    toolCallId: "wrong-status",
    details: wrongStatus,
    isError: false,
  }),
  false,
);
cases++;

// A missed/unreadable completion observation must not strand the next parent run.
for (const restoredState of ["complete", null, "running"]) {
  const run = makeRun("running", { toolCallId: "reconcile-" + restoredState });
  const saved = [];
  const hold = new GoalTeamHold({
    sessionId: () => sessionId,
    cwd: () => cwd,
    goal: () => goal,
    append: (entry) => saved.push(entry),
    readStatus: inspectGoalTeamRunStatus,
    helperPath,
  });
  assert.equal(hold.beginToolCall(launchEvent(run.toolCallId)), true);
  assert.equal(
    await hold.completeToolResult({
      toolName: "subagent",
      toolCallId: run.toolCallId,
      details: run,
    }),
    true,
  );
  fs.unlinkSync(path.join(run.asyncDir, "status.json"));
  assert.equal(
    await hold.onNativeCompletion({ ...run.status, state: "complete" }),
    false,
  );
  if (restoredState) writeState(run, restoredState);
  const observed = await hold.reconcile();
  assert.equal(
    observed.kind,
    restoredState === "complete"
      ? "terminal"
      : restoredState === "running"
        ? "active"
        : "unknown",
  );
  assert.equal(hold.shouldHold(ctx, goal), restoredState === "running");
  if (!restoredState) {
    assert.equal(observed.runId, run.runId);
    assert.equal(saved.at(-1).reason, "reconcile-required-unknown");
  }
  if (restoredState !== "running") assert.equal(await hold.reconcile(), null);
  cases++;
}
// Actual tool_result integration: explicit status inspection reconciles, even
// when native completion was lost. It never clears mission ownership or wakes.
const statusRun = makeRun("running", { toolCallId: "status-reconcile" });
await handlers.get("tool_call")(launchEvent(statusRun.toolCallId), ctx);
await handlers.get("tool_result")(
  {
    toolName: "subagent",
    toolCallId: statusRun.toolCallId,
    details: statusRun,
  },
  ctx,
);
writeState(statusRun, "complete");
await handlers.get("tool_result")(
  {
    toolName: "subagent",
    toolCallId: "inspect-status",
    input: { action: "status", id: statusRun.runId },
    details: {},
  },
  ctx,
);
assert.equal(entries.at(-1).data.reason, "reconcile-terminal");
assert.equal(nativeMessages.length, 2);
cases++;

const runtimeSource = fs.readFileSync(
  path.join(sourceRoot, "goal-runtime.ts"),
  "utf8",
);
const holdSource = fs.readFileSync(
  path.join(sourceRoot, "goal-team-hold.ts"),
  "utf8",
);
const eventsSource = fs.readFileSync(
  path.join(sourceRoot, "goal-events.ts"),
  "utf8",
);
assert.match(runtimeSource, /setContinuationHold/);
assert.match(eventsSource, /SUBAGENT_ASYNC_COMPLETE_EVENT/);
assert.doesNotMatch(holdSource, /_goalCore|setInterval\s*\(|sendMessage\s*\(/);
assert.doesNotMatch(eventsSource, /teamGoalActiveStep/);
cases++;

notifier.dispose();
for (const dir of fixtureRuns) fs.rmSync(dir, { recursive: true, force: true });
console.log(
  JSON.stringify({
    status: "PASS",
    cases,
    sourceRoot,
    measurements: {
      checkpointWhileHeld: 0,
      nativeWakeCount: nativeMessages.length,
      nativeWakeSuccess: 1,
      nativeWakeFailure: 1,
      bridgeWakeCount: 0,
      checkpointAfterRelease: 1,
    },
    boundaries: [
      "Actual installed GoalRuntime, GoalTeamHold, registerGoalEvents, and pi-subagents notifier are loaded through jiti.",
      "The helper launch/result binding and native notifier-before-observer sequence use deterministic local session/status fixtures; no model child is launched.",
    ],
  }),
);
