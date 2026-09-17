import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import teamsOrchestratorExtension from "../../extensions/teams-orchestrator/index.mjs";
import { snapshot } from "../../host-evidence.mjs";
import { HostAcceptance } from "../acceptance.mjs";
import { createGoalGuard } from "../goal-guard.mjs";
import { Mailbox } from "../mailbox.mjs";
import { TaskOrchestrator } from "../orchestrator.mjs";
import { WorkerRuntime } from "../worker-runtime.mjs";

function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-acceptance-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.js"), "export default 1;\n");
  return root;
}

function spec(root) {
  return {
    goalId: "goal-1",
    taskId: "task-1",
    taskRevision: 1,
    objective: "Produce the bounded outcome.",
    nonGoals: ["Do not deploy."],
    workspace: {
      sourceRoot: root,
      worktreePath: null,
      baseCommit: "b".repeat(40),
      sourcePaths: ["src"],
      allowedWritePaths: ["src"],
    },
    criteria: [
      {
        id: "criterion-1",
        text: "The outcome is observable.",
        requiredEvidenceKinds: ["host-check", "artifact"],
      },
    ],
    checks: [
      {
        commandId: "check-1",
        executable: process.execPath,
        argv: ["--version"],
        cwd: root,
        timeoutMs: 30_000,
        expectedExitCode: 0,
        criterionIds: ["criterion-1"],
      },
    ],
    policy: {
      risk: "medium",
      allowedRoles: ["team.implementer"],
      maxActiveRoleRuns: 1,
      maxRoleSpawnsPerTask: 8,
      maxProductRepairsPerRole: 3,
      maxReportRepairs: 1,
      maxProcessRestarts: 1,
      maxTaskTokens: 100_000,
      deadlineMs: 3_600_000,
      integrationMode: "verify-only",
    },
    contextRefs: [],
  };
}

test("TaskResult remains a candidate until host checks and acceptance receipt", async () => {
  const root = temp();
  let worker;
  let interval;
  const herdr = {
    async start(input) {
      worker = new WorkerRuntime({ executionRoot: input.executionRoot });
      worker.boot({
        sessionId: "worker-1",
        cwd: root,
        activeTools: ["read", "team_role_spawn", "team_task_result"],
        extensions: ["teams-worker", "pi-subagents"],
        subagents: {
          compatible: true,
          checks: { protocolV1: true, status: true, spawn: true, stop: true },
          ping: { version: 1 },
        },
      });
      interval = setInterval(() => worker.processControls(), 5);
      return { paneId: "w1:p2", agentName: "task-worker" };
    },
  };
  const agentDir = path.join(root, "agent");
  const packageRoot = path.join(agentDir, "npm", "node_modules");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.symlinkSync(
    "/home/timmypai/.pi/agent/npm/node_modules/pi-subagents",
    path.join(packageRoot, "pi-subagents"),
  );
  fs.symlinkSync(
    "/home/timmypai/.pi/agent/npm/node_modules/pi-goal-x",
    path.join(packageRoot, "pi-goal-x"),
  );
  const orchestrator = new TaskOrchestrator({
    runtimeRoot: path.join(agentDir, "teams-task-runtime-v1"),
    ownerSessionId: "owner-1",
    herdr,
  });
  const prepared = orchestrator.prepare(spec(root));
  await orchestrator.launch(prepared.executionId, { timeoutMs: 1_000 });
  clearInterval(interval);
  const box = Mailbox.open(prepared.executionRoot, prepared.executionId);
  const source = snapshot(root, ["src"]);
  box.writeJson("evidence/source.json", source);
  fs.writeFileSync(
    path.join(prepared.executionRoot, "evidence", "artifact.txt"),
    "observed outcome\n",
  );
  const artifactDigest = box.digestRelative("evidence/artifact.txt");
  const asyncDir = path.join(root, "native-run");
  fs.mkdirSync(asyncDir);
  const nativeStatus = {
    runId: "native-run-1",
    cwd: root,
    state: "complete",
    processTerminal: { version: 1, state: "observed", runId: "native-run-1" },
    usageBudget: { exhausted: false },
    steps: [
      {
        status: "complete",
        acceptance: {
          status: "review-required",
          effectiveAcceptance: { review: { required: true } },
        },
      },
    ],
  };
  const saveNative = () =>
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify(nativeStatus),
    );
  saveNative();
  worker.recordProgress("native-started", {
    kind: "role-started",
    runId: "native-run-1",
    role: "team.implementer",
    mode: "mutation",
    asyncDir,
  });
  worker.sealResult({
    schemaVersion: "teams-task-result/1",
    identity: prepared.contract.identity,
    requestDigest: prepared.requestDigest,
    resultRevision: 1,
    outcome: "ready_for_acceptance",
    summary: "Candidate outcome produced.",
    source: {
      baseCommit: prepared.contract.workspace.baseCommit,
      sourceDigest: source.digest,
      manifestRef: "evidence/source.json",
    },
    criterionResults: [
      {
        criterionId: "criterion-1",
        status: "indeterminate",
        observation:
          "Artifact records the outcome; host validation is pending.",
        evidenceIds: ["artifact-1"],
      },
    ],
    evidence: [
      {
        evidenceId: "artifact-1",
        kind: "artifact",
        uri: "evidence/artifact.txt",
        sha256: artifactDigest,
        producedBy: "worker",
        sourceDigest: source.digest,
      },
    ],
    childRunRefs: ["native-run-1"],
    unresolvedRunCount: 0,
    risks: [],
    usage: { inputTokens: null, outputTokens: null },
  });
  const ready = orchestrator.collect(prepared.executionId);
  assert.equal(ready.state, "RESULT_READY");
  const goalGuard = createGoalGuard(orchestrator, root);
  assert.equal(
    goalGuard.beforeTaskCompletion({ goalId: "goal-1", taskId: "task-1" }).ok,
    false,
  );
  const acceptance = new HostAcceptance({ orchestrator });
  assert.equal(prepared.contract.schemaVersion, "teams-task-runtime/2");
  assert.throws(
    () => acceptance.accept(prepared.executionId),
    /native review gate/,
  );
  nativeStatus.steps[0].acceptance.status = "reviewed";
  saveNative();
  assert.throws(
    () => acceptance.accept(prepared.executionId),
    /missing host check/,
  );
  nativeStatus.steps[0].acceptance.status = "review-required";
  saveNative();
  const checks = acceptance.runChecks(prepared.executionId);
  assert.equal(checks.length, 1);
  assert.throws(
    () => acceptance.accept(prepared.executionId),
    /native review gate/,
  );
  assert.equal(
    orchestrator.ledger.getExecution(prepared.executionId).state,
    "RESULT_READY",
  );
  nativeStatus.steps[0].acceptance.status = "reviewed";
  nativeStatus.usageBudget.exhausted = true;
  saveNative();
  assert.throws(
    () => acceptance.accept(prepared.executionId),
    /native usage budget/,
  );
  nativeStatus.usageBudget.exhausted = false;
  saveNative();
  const accepted = acceptance.accept(prepared.executionId);
  assert.equal(accepted.execution.state, "ACCEPTED");
  assert.equal(accepted.receipt.decision, "accepted");
  assert.equal(
    box.listResults()[0].criterionResults[0].status,
    "indeterminate",
    "host acceptance must not rewrite producer observations",
  );
  assert.throws(
    () => orchestrator.ledger.releaseReservation(prepared.executionId),
    /Goal commit/,
  );
  const taskGate = goalGuard.beforeTaskCompletion({
    goalId: "goal-1",
    taskId: "task-1",
  });
  assert.deepEqual(taskGate, {
    ok: true,
    evidence: `task-runtime:${accepted.receipt.acceptanceId}`,
  });

  const handlers = new Map();
  const eventHandlers = new Map();
  const tools = [
    {
      name: "update_goal_task",
      parameters: {
        properties: {
          task_id: { type: "string" },
          status: { enum: ["start", "complete", "skipped", "pending"] },
          updates: {
            items: {
              properties: {
                task_id: { type: "string" },
                status: { enum: ["start", "complete", "skipped", "pending"] },
              },
            },
          },
        },
      },
    },
    {
      name: "update_goal",
      parameters: {
        properties: { status: { enum: ["complete", "blocked", "paused"] } },
      },
    },
  ];
  const events = {
    on(name, handler) {
      const entries = eventHandlers.get(name) ?? new Set();
      entries.add(handler);
      eventHandlers.set(name, entries);
      return () => entries.delete(handler);
    },
    emit(name, payload) {
      for (const handler of eventHandlers.get(name) ?? []) handler(payload);
      if (name === "subagents:rpc:v1:request" && payload.method === "ping") {
        this.emit(`subagents:rpc:v1:reply:${payload.requestId}`, {
          version: 1,
          requestId: payload.requestId,
          success: true,
          data: {
            version: 1,
            methods: ["status", "spawn", "stop"],
            events: {
              asyncComplete: "subagent:async-complete",
              processTerminal: "subagent:process-terminal",
            },
            capabilities: {
              status: true,
              asyncSpawn: true,
              stop: true,
              runtimeAcknowledgedExtensions: { version: 1 },
              processTerminalProof: { version: 1 },
            },
          },
        });
      }
    },
  };
  const pi = {
    events,
    registerTool(tool) {
      tools.push(tool);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    getActiveTools() {
      return tools.map((tool) => tool.name);
    },
    getAllTools() {
      return tools;
    },
  };
  teamsOrchestratorExtension(pi);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHerdr = process.env.HERDR_ENV;
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_PANE_ID;
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => "owner-1" },
    ui: { setStatus() {} },
  };
  await handlers.get("session_start")({}, ctx);
  const capabilityReceipt = JSON.parse(
    fs.readFileSync(
      path.join(
        agentDir,
        "teams-task-runtime-v1",
        "capabilities",
        `${prepared.projectId}.json`,
      ),
      "utf8",
    ),
  );
  assert.equal(capabilityReceipt.goalX.compatible, true);
  assert.equal(capabilityReceipt.subagents.compatible, true);
  assert.equal(capabilityReceipt.decision.taskPiAvailable, false);
  assert.equal(capabilityReceipt.decision.fallback, "direct-only");
  const input = {
    task_id: "task-1",
    status: "complete",
    evidence: "model claim",
  };
  const blocked = await handlers.get("tool_call")({
    toolName: "update_goal_task",
    toolCallId: "call-1",
    input,
  });
  assert.equal(blocked, undefined);
  assert.equal(input.evidence, taskGate.evidence);
  await handlers.get("tool_result")({
    toolName: "update_goal_task",
    toolCallId: "call-1",
    input,
    isError: false,
    content: [],
    details: {
      goal: {
        id: "goal-1",
        taskList: {
          tasks: [
            { id: "task-1", status: "complete", evidence: input.evidence },
          ],
        },
      },
    },
  });
  assert.equal(
    orchestrator.ledger.getExecution(prepared.executionId).reservationOpen,
    false,
  );
  handlers.get("session_shutdown")();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousHerdr === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = previousHerdr;
  if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = previousPane;
  orchestrator.close();
});
