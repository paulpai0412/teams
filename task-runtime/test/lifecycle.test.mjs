import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { HerdrPort, workerCommand } from "../herdr-port.mjs";
import { TaskOrchestrator } from "../orchestrator.mjs";
import { WorkerRuntime } from "../worker-runtime.mjs";
import { RoleController } from "../role-controller.mjs";
import { digest } from "../contracts.mjs";
import { collectTaskResult } from "../../extensions/teams-orchestrator/index.mjs";

const subagents = {
  compatible: true,
  checks: { protocolV1: true, status: true, spawn: true, stop: true },
  ping: { version: 1 },
};

function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-lifecycle-"));
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
        requiredEvidenceKinds: ["host-check"],
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

test("T06 worker boots without grant and cannot start product work", () => {
  const root = temp();
  const orchestrator = new TaskOrchestrator({
    runtimeRoot: path.join(root, "runtime"),
    ownerSessionId: "owner-1",
  });
  const prepared = orchestrator.prepare(spec(root));
  const worker = new WorkerRuntime({ executionRoot: prepared.executionRoot });
  const boot = worker.boot({
    sessionId: "worker-1",
    cwd: root,
    activeTools: ["read", "team_role_spawn", "team_task_result"],
    extensions: ["teams-worker", "pi-subagents"],
    subagents,
  });
  assert.equal(boot.state, "WAIT_BINDING");
  assert.equal(worker.processControls().started, false);
  assert.equal(
    fs.readFileSync(path.join(root, "src", "index.js"), "utf8"),
    "export default 1;\n",
  );
  orchestrator.close();
});

test("T19 worker refuses Goal or Herdr control tools", () => {
  const root = temp();
  const orchestrator = new TaskOrchestrator({
    runtimeRoot: path.join(root, "runtime"),
    ownerSessionId: "owner-1",
  });
  const prepared = orchestrator.prepare(spec(root));
  const worker = new WorkerRuntime({ executionRoot: prepared.executionRoot });
  assert.throws(
    () =>
      worker.boot({
        sessionId: "worker-1",
        cwd: root,
        activeTools: ["read", "create_goal"],
        extensions: ["teams-worker"],
        subagents,
      }),
    /forbidden worker tool/,
  );
  orchestrator.close();
});

test("M2 READY/grant/bound handshake reaches RUNNING exactly once", async () => {
  const root = temp();
  let interval;
  const herdr = {
    async start(input) {
      const worker = new WorkerRuntime({ executionRoot: input.executionRoot });
      worker.boot({
        sessionId: "worker-1",
        cwd: root,
        activeTools: ["read", "team_role_spawn", "team_task_result"],
        extensions: ["teams-worker", "pi-subagents"],
        subagents,
      });
      interval = setInterval(() => worker.processControls(), 5);
      return { paneId: "w1:p2", agentName: "task-worker" };
    },
  };
  const orchestrator = new TaskOrchestrator({
    runtimeRoot: path.join(root, "runtime"),
    ownerSessionId: "owner-1",
    herdr,
  });
  const prepared = orchestrator.prepare(spec(root));
  const running = await orchestrator.launch(prepared.executionId, {
    timeoutMs: 1_000,
  });
  clearInterval(interval);
  assert.equal(running.state, "RUNNING");
  assert.equal(running.paneId, "w1:p2");
  assert.equal(running.workerSessionId, "worker-1");
  const duplicate = await orchestrator.launch(prepared.executionId, {
    timeoutMs: 1_000,
  });
  assert.equal(duplicate.disposition, "already-running");
  orchestrator.close();
});

test("M5 cancellation releases only after worker terminal receipt", () => {
  const root = temp();
  const orchestrator = new TaskOrchestrator({
    runtimeRoot: path.join(root, "runtime"),
    ownerSessionId: "owner-1",
  });
  const prepared = orchestrator.prepare(spec(root));
  const worker = new WorkerRuntime({ executionRoot: prepared.executionRoot });
  worker.boot({
    sessionId: "worker-1",
    cwd: root,
    activeTools: ["read", "team_role_spawn", "team_task_result"],
    extensions: ["teams-worker", "pi-subagents"],
    subagents,
    processId: 99_999_999,
    processStartedAtTicks: "1",
  });
  let execution = orchestrator.ledger.getExecution(prepared.executionId);
  execution = orchestrator.ledger.transition(
    prepared.executionId,
    "RESERVED",
    execution.revision,
    "SPAWNING",
  );
  execution = orchestrator.ledger.attachPane(
    prepared.executionId,
    execution.revision,
    "w1:p2",
  );
  execution = orchestrator.ledger.bindWorker(
    prepared.executionId,
    execution.revision,
    "worker-1",
  );
  orchestrator.ledger.transition(
    prepared.executionId,
    "SPAWNING",
    execution.revision,
    "RUNNING",
  );
  const requested = orchestrator.requestCancel(
    prepared.executionId,
    "user requested cancellation",
  );
  assert.equal(requested.state, "CANCEL_REQUESTED");
  assert.equal(worker.processControls().cancelRequested, true);
  assert.equal(
    orchestrator.ledger.getExecution(prepared.executionId).reservationOpen,
    true,
  );
  worker.confirmCancelled(0);
  assert.throws(
    () => orchestrator.reconcile(prepared.executionId),
    /pane closure/,
  );
  assert.equal(
    orchestrator.ledger.getExecution(prepared.executionId).reservationOpen,
    true,
  );
  orchestrator.herdr = {
    closeIdle: (paneId) => ({ paneId, disposition: "closed" }),
  };
  const reconciled = orchestrator.reconcile(prepared.executionId);
  assert.equal(reconciled.execution.state, "CANCELLED");
  assert.equal(reconciled.execution.reservationOpen, false);
  orchestrator.close();
});

function cancelFixture(t, { alive = false, review = false } = {}) {
  const root = temp();
  const orchestrator = new TaskOrchestrator({
    runtimeRoot: path.join(root, "runtime"),
    ownerSessionId: "owner-1",
  });
  t.after(() => {
    orchestrator.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const input = spec(root);
  if (review) {
    input.schemaVersion = "teams-task-runtime/3";
    input.policy.allowedRoles.push("team.reviewer");
    input.policy.review = {
      authority: "l0-source-bound",
      allowedRoles: ["team.reviewer"],
      allowedTools: ["read"],
    };
  }
  const prepared = orchestrator.prepare(input);
  const worker = new WorkerRuntime({ executionRoot: prepared.executionRoot });
  worker.boot({
    sessionId: "worker-1",
    cwd: root,
    ...(review
      ? {
          sessionFile: path.join(
            prepared.executionRoot,
            "worker-sessions/worker.jsonl",
          ),
        }
      : {}),
    activeTools: ["read", "team_role_spawn", "team_task_result"],
    extensions: ["teams-worker", "pi-subagents"],
    subagents,
    ...(alive ? {} : { processId: 99_999_999, processStartedAtTicks: "1" }),
  });
  let execution = orchestrator.ledger.transition(
    prepared.executionId,
    "RESERVED",
    0,
    "SPAWNING",
  );
  execution = orchestrator.ledger.attachPane(
    prepared.executionId,
    execution.revision,
    "w1:p2",
  );
  execution = orchestrator.ledger.bindWorker(
    prepared.executionId,
    execution.revision,
    "worker-1",
  );
  orchestrator.ledger.transition(
    prepared.executionId,
    "SPAWNING",
    execution.revision,
    "RUNNING",
  );
  return { root, orchestrator, prepared, worker };
}

function publishCandidate(f, outcome = "blocked") {
  const contract = f.worker.contract;
  f.worker.mailbox.writeResult(1, {
    schemaVersion: "teams-task-result/1",
    identity: contract.identity,
    requestDigest: digest(contract),
    resultRevision: 1,
    outcome,
    summary: "Synthetic result for real mailbox collection regression.",
    criterionResults: [
      {
        criterionId: "criterion-1",
        status: "indeterminate",
        observation: "Not host accepted",
        evidenceIds: [],
      },
    ],
    evidence: [],
    risks: [],
    childRunRefs: [],
    unresolvedRunCount: 0,
    usage: { inputTokens: null, outputTokens: null },
    source: {
      baseCommit: contract.workspace.baseCommit,
      sourceDigest: "a".repeat(64),
      manifestRef: "receipts/fixture.json",
    },
  });
}

test("collect waits on the canonical mailbox and returns blocked even while Worker exits", async (t) => {
  const f = cancelFixture(t, { alive: true });
  const timer = setTimeout(() => publishCandidate(f), 20);
  t.after(() => clearTimeout(timer));
  const value = await collectTaskResult(
    f.orchestrator,
    f.prepared.executionId,
    { waitMs: 1000 },
  );
  assert.equal(value.state, "RESULT_READY");
  assert.equal(value.candidate.outcome, "blocked");
  assert.equal(value.workerProcess.terminal, false);
  assert.equal(value.reservationOpen, true);
  assert.equal(
    f.orchestrator.ledger.getAcceptance(f.prepared.executionId),
    null,
  );
});

test("collect reports ready candidate only after observed Worker exit when waiting", async (t) => {
  const alive = cancelFixture(t, { alive: true });
  publishCandidate(alive, "ready_for_acceptance");
  await assert.rejects(
    collectTaskResult(alive.orchestrator, alive.prepared.executionId, {
      waitMs: 20,
    }),
    /wait timed out/,
  );
  const exited = cancelFixture(t);
  publishCandidate(exited, "ready_for_acceptance");
  const value = await collectTaskResult(
    exited.orchestrator,
    exited.prepared.executionId,
    { waitMs: 100 },
  );
  assert.equal(value.candidate.outcome, "ready_for_acceptance");
  assert.equal(value.workerProcess.terminal, true);
  assert.equal(value.reservationOpen, true);
});

test("collect stops on dead Worker without result and supports bounded cancellation", async (t) => {
  const dead = cancelFixture(t);
  await assert.rejects(
    collectTaskResult(dead.orchestrator, dead.prepared.executionId, {
      waitMs: 1000,
    }),
    /Worker exited without a result/,
  );
  const alive = cancelFixture(t, { alive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  t.after(() => clearTimeout(timer));
  await assert.rejects(
    collectTaskResult(alive.orchestrator, alive.prepared.executionId, {
      waitMs: 1000,
      signal: controller.signal,
    }),
    /abort/i,
  );
  await assert.rejects(
    collectTaskResult(alive.orchestrator, alive.prepared.executionId, {
      waitMs: 1200001,
    }),
    /bounded/,
  );
});

test("collect refuses unknown native launch before waiting or consuming a blocked result", async (t) => {
  const f = cancelFixture(t, { alive: true });
  const mailbox = f.worker.mailbox;
  mailbox.writeReceipt("progress-unknown", {
    kind: "role-launch-unknown",
    error: "synthetic ambiguous launch",
  });
  const previous = mailbox.listEvents().at(-1);
  mailbox.writeEvent({
    ...previous,
    eventId: "unknown-2",
    sequence: previous.sequence + 1,
    type: "progress",
    payloadRef: "receipts/progress-unknown.json",
    payloadDigest: mailbox.digestRelative("receipts/progress-unknown.json"),
  });
  publishCandidate(f);
  await assert.rejects(
    collectTaskResult(f.orchestrator, f.prepared.executionId, { waitMs: 1000 }),
    /native launch unknown/,
  );
  assert.equal(
    f.orchestrator.ledger.getExecution(f.prepared.executionId).reservationOpen,
    true,
  );
});

test("collect surfaces durable Worker admission failure without waiting or releasing reservations", async (t) => {
  const f = cancelFixture(t, { alive: true });
  // The real Worker has already received its grant when admission runs.
  f.worker.state = "RUNNING";
  const failure = new Error("actual leaf usage exceeds member budget");
  f.worker.failAdmission(failure);
  const mailbox = f.worker.mailbox;
  const event = mailbox.listEvents().at(-1);
  assert.equal(event.type, "failed");
  const payload = mailbox.readJson(event.payloadRef);
  assert.equal(payload.error, failure.message);
  assert.equal(payload.stack, failure.stack);
  assert.equal(event.payloadDigest, mailbox.digestRelative(event.payloadRef));
  assert.equal(f.worker.state, "QUIESCENT");
  assert.throws(() => f.worker.assertAdmission(), /not running/);
  f.worker.failAdmission(new Error("Task Pi is not running"));
  assert.equal(
    mailbox.listEvents().filter((row) => row.type === "failed").length,
    1,
  );
  assert.equal(mailbox.listResults().length, 0);
  // waitMs=0 discriminates failure handoff from a generic wait timeout.
  await assert.rejects(
    collectTaskResult(f.orchestrator, f.prepared.executionId),
    /Worker admission failed: actual leaf usage exceeds member budget/,
  );
  assert.equal(
    f.orchestrator.ledger.getExecution(f.prepared.executionId).reservationOpen,
    true,
  );
  assert.equal(
    f.orchestrator.ledger.getAcceptance(f.prepared.executionId),
    null,
  );
  f.orchestrator.requestCancel(
    f.prepared.executionId,
    "observed admission failure",
  );
  assert.equal(f.worker.processControls().cancelRequested, true);
  f.worker.confirmCancelled();
  assert.equal(f.worker.state, "CANCELLED");
  assert.equal(
    f.orchestrator.reconcile(f.prepared.executionId).execution.reservationOpen,
    true,
    "Worker cancellation acknowledgement alone cannot release a live process",
  );
});

test("D7 cancellation wait expires without releasing a live Worker", async (t) => {
  const f = cancelFixture(t, { alive: true });
  let closes = 0;
  f.orchestrator.herdr = {
    closeIdle() {
      closes++;
      throw Error("must not close");
    },
  };
  const result = await f.orchestrator.cancel(f.prepared.executionId, "stop", {
    timeoutMs: 0,
  });
  assert.equal(result.disposition, "draining");
  assert.equal(result.execution.reservationOpen, true);
  assert.equal(result.processProof.terminal, false);
  assert.equal(closes, 0);
  assert.equal(
    f.orchestrator.requestCancel(f.prepared.executionId, "another reason")
      .state,
    "CANCEL_REQUESTED",
  );
});

test("D7 a pane still settling to idle does not consume the close intent", async (t) => {
  const f = cancelFixture(t);
  let idle = false,
    closes = 0;
  f.orchestrator.herdr = new HerdrPort({
    executable: process.execPath,
    piExecutable: process.execPath,
    workerExtension: process.execPath,
    subagentsExtension: process.execPath,
    environment: { HERDR_ENV: "1", HERDR_PANE_ID: "fixture:parent" },
    run(_executable, args) {
      assert.equal(args[0], "pane");
      if (args[1] === "get")
        return {
          result: {
            pane: { cwd: f.root, agent_status: idle ? "idle" : "working" },
          },
        };
      assert.deepEqual(args, ["pane", "close", "w1:p2"]);
      closes++;
      return {};
    },
  });
  const waiting = await f.orchestrator.cancel(f.prepared.executionId, "stop", {
    timeoutMs: 0,
  });
  assert.equal(waiting.paneClosure.disposition, "waiting-for-idle");
  assert.equal(closes, 0);
  assert.ok(
    !fs.existsSync(
      path.join(f.prepared.executionRoot, "receipts/cancel-pane-intent.json"),
    ),
  );
  idle = true;
  const done = await f.orchestrator.cancel(f.prepared.executionId, "stop", {
    timeoutMs: 0,
  });
  assert.equal(done.execution.reservationOpen, false);
  assert.equal(closes, 1);
});

test("D7 ambiguous pane closure is preserved, never replayed", (t) => {
  for (const response of ["throw", "wrong-pane", "pending"]) {
    const f = cancelFixture(t);
    let closes = 0;
    f.orchestrator.herdr = {
      closeIdle(paneId) {
        closes++;
        if (response === "throw")
          throw new Error("close timed out after possible effect");
        return {
          paneId: response === "wrong-pane" ? "foreign" : paneId,
          disposition: "pending",
        };
      },
    };
    f.orchestrator.requestCancel(f.prepared.executionId, "stop");
    assert.throws(
      () => f.orchestrator.reconcile(f.prepared.executionId),
      /close|closure/,
    );
    assert.throws(
      () => f.orchestrator.reconcile(f.prepared.executionId),
      /outcome unknown/,
    );
    assert.equal(closes, 1);
    assert.equal(
      f.orchestrator.ledger.getExecution(f.prepared.executionId)
        .reservationOpen,
      true,
    );
  }
});

test("D7 ownership changes preserve the close reply but cannot release the reservation", (t) => {
  const f = cancelFixture(t);
  f.orchestrator.requestCancel(f.prepared.executionId, "stop");
  let closes = 0;
  f.orchestrator.herdr = {
    closeIdle(paneId) {
      closes++;
      f.orchestrator.ledger.takeoverController(
        f.prepared.projectId,
        "owner-2",
        "owner-1",
        f.prepared.ownerEpoch,
        path.join(f.root, "fixture-takeover-proof.json"),
      );
      return { paneId, disposition: "closed" };
    },
  };
  assert.throws(
    () => f.orchestrator.reconcile(f.prepared.executionId),
    /ownership changed/,
  );
  assert.equal(
    f.worker.mailbox.readJson("receipts/cancel-pane.json").result.disposition,
    "closed",
  );
  assert.equal(
    f.orchestrator.ledger.getExecution(f.prepared.executionId).reservationOpen,
    true,
  );
  assert.throws(
    () => f.orchestrator.reconcile(f.prepared.executionId),
    /ownership changed/,
  );
  assert.equal(closes, 1);
});

test("D7 completed pane receipt survives controller reconstruction and CAS failure", (t) => {
  const f = cancelFixture(t);
  let closes = 0;
  f.orchestrator.herdr = {
    closeIdle(paneId) {
      closes++;
      return { paneId, disposition: "closed" };
    },
  };
  f.orchestrator.requestCancel(f.prepared.executionId, "stop");
  const finish = f.orchestrator.ledger.finishCancellation.bind(
    f.orchestrator.ledger,
  );
  f.orchestrator.ledger.finishCancellation = () => {
    throw Error("fixture crash before ledger commit");
  };
  assert.throws(
    () => f.orchestrator.reconcile(f.prepared.executionId),
    /fixture crash/,
  );
  f.orchestrator.ledger.finishCancellation = finish;
  const recovered = new TaskOrchestrator({
    runtimeRoot: f.orchestrator.runtimeRoot,
    ownerSessionId: "owner-1",
  });
  t.after(() => recovered.close());
  const result = recovered.reconcile(f.prepared.executionId); // No second Herdr call is needed.
  assert.equal(result.execution.state, "CANCELLED");
  assert.equal(result.execution.reservationOpen, false);
  assert.equal(
    recovered.reconcile(f.prepared.executionId).disposition,
    "already-cancelled",
  );
  assert.equal(closes, 1);
});

test("D7 a crashed Worker can be reconciled from retained native proof without impersonation", async (t) => {
  const f = cancelFixture(t);
  const mailbox = f.worker.mailbox;
  mailbox.writeCommand({
    schemaVersion: "teams-task-control/1",
    commandId: "grant-fixture",
    executionId: f.prepared.executionId,
    ownerEpoch: f.prepared.ownerEpoch,
    requestDigest: f.prepared.requestDigest,
    type: "grant",
    payload: {},
  });
  f.worker.processControls();
  const asyncDir = path.join(mailbox.root, "native-worker-role");
  fs.mkdirSync(asyncDir);
  const roles = new RoleController({
    runtime: f.worker,
    cwd: f.root,
    rpc: {
      async request(method) {
        assert.equal(method, "spawn");
        return { runId: "native-role", asyncDir };
      },
    },
  });
  await roles.spawn({
    role: "team.implementer",
    task: "Read one file",
    mode: "read-only",
    maxTokens: 20,
  });
  fs.writeFileSync(
    path.join(asyncDir, "status.json"),
    JSON.stringify({
      runId: "native-role",
      sessionId: "worker-1",
      state: "failed",
      processTerminal: {
        version: 1,
        state: "observed",
        runId: "native-role",
        runnerProcessInstanceId: "native-process",
      },
      steps: [{ agent: "team.implementer", status: "failed" }],
    }),
  );
  f.orchestrator.requestCancel(f.prepared.executionId, "Worker crashed");
  let closes = 0;
  f.orchestrator.herdr = {
    closeIdle(paneId) {
      closes++;
      return { paneId, disposition: "closed" };
    },
  };
  f.orchestrator.ledger.finishCancellation = () => {
    throw Error("crash after close");
  };
  assert.throws(
    () => f.orchestrator.reconcile(f.prepared.executionId),
    /crash after close/,
  );
  fs.rmSync(asyncDir, { recursive: true, force: true });
  const recovered = new TaskOrchestrator({
    runtimeRoot: f.orchestrator.runtimeRoot,
    ownerSessionId: "owner-1",
  });
  try {
    assert.equal(
      recovered.reconcile(f.prepared.executionId).execution.reservationOpen,
      false,
    );
  } finally {
    recovered.close();
  }
  assert.equal(closes, 1);
  assert.ok(
    !mailbox.listEvents().some((event) => ["cancelled"].includes(event.type)),
  );
  assert.ok(
    !mailbox
      .listEvents()
      .filter((event) => event.type === "progress")
      .some(
        (event) => mailbox.readJson(event.payloadRef).kind === "role-terminal",
      ),
  );
});

test("D7 cancellation during launch records the pane but never issues a late grant", async (t) => {
  const root = temp();
  const f = {
    root,
    orchestrator: new TaskOrchestrator({
      runtimeRoot: path.join(root, "runtime"),
      ownerSessionId: "owner-1",
    }),
  };
  t.after(() => {
    f.orchestrator.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const prepared = f.orchestrator.prepare(spec(root));
  f.orchestrator.herdr = {
    async start({ onPane }) {
      onPane("w1:p3");
      f.orchestrator.requestCancel(
        prepared.executionId,
        "cancel during startup",
      );
      return { paneId: "w1:p3" };
    },
  };
  const result = await f.orchestrator.launch(prepared.executionId);
  assert.equal(result.state, "CANCEL_REQUESTED");
  assert.equal(result.disposition, "launch-not-granted");
  const { Mailbox } = await import("../mailbox.mjs");
  assert.deepEqual(
    Mailbox.open(prepared.executionRoot, prepared.executionId)
      .listCommands()
      .map((command) => command.type),
    ["cancel"],
  );
  assert.equal(
    f.orchestrator.reconcile(prepared.executionId).execution.reservationOpen,
    true,
  );
});

test("D7 parent drains its registered review once and preserves an ambiguous stop", async (t) => {
  const f = cancelFixture(t, { review: true });
  const mailbox = f.worker.mailbox;
  const dir = "integration/reviews/review-one";
  const sessionDir = path.join(mailbox.root, dir, "sessions");
  // Minimal native-format transport fixture. The full public plan/start/capture
  // producer is separately exercised by the integration cancellation tests.
  const body = {
    schemaVersion: "teams-review-wave-plan/1",
    key: "review-one",
    wave: { runs: [{ key: "view", role: "team.reviewer" }] },
    sessionDir,
    ownerSessionId: "owner-1",
    nativeOwner: "owner-1",
    contractDigest: digest(f.prepared.contract),
  };
  const planDigest = digest(body),
    params = { sessionDir };
  mailbox.writeJson(`${dir}/plan.json`, { ...body, planDigest });
  mailbox.writeJson(`${dir}/launch-intent.json`, {
    schemaVersion: "teams-review-launch-intent/2",
    planDigest,
    params,
    paramsDigest: digest(params),
  });
  const asyncDir = path.join(mailbox.root, "native-review");
  mailbox.writeJson(`${dir}/started.json`, {
    schemaVersion: "teams-review-started/1",
    planDigest,
    runId: "review-run",
    nativeOwner: "owner-1",
    asyncDir,
  });
  const status = {
    runId: "review-run",
    sessionId: "owner-1",
    state: "running",
    processTerminal: {
      version: 1,
      state: "observed",
      runId: "review-run",
      runnerProcessInstanceId: "review-process",
    },
    steps: [{ workflowKey: "view", agent: "team.reviewer", status: "stopped" }],
  };
  fs.mkdirSync(asyncDir);
  const save = () =>
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify(status),
    );
  save();
  let stops = 0,
    closes = 0;
  const reviewAdapter = {
    nativeOwner: "owner-1",
    rpc: {
      async request(method, input) {
        assert.equal(method, "stop");
        assert.equal(input.id, "review-run");
        stops++;
        throw Error("reply lost");
      },
    },
  };
  f.orchestrator.herdr = {
    closeIdle(paneId) {
      closes++;
      return { paneId, disposition: "closed" };
    },
  };
  const pending = await f.orchestrator.cancel(f.prepared.executionId, "stop", {
    timeoutMs: 0,
    reviewAdapter,
  });
  assert.equal(pending.execution.reservationOpen, true);
  assert.equal(closes, 0);
  await f.orchestrator.cancel(f.prepared.executionId, "stop again", {
    timeoutMs: 0,
    reviewAdapter,
  });
  assert.equal(stops, 1);
  status.sessionId = "foreign-owner";
  save();
  assert.equal(
    f.orchestrator.reconcile(f.prepared.executionId).execution.reservationOpen,
    true,
  );
  status.sessionId = "owner-1";
  status.state = "stopped";
  save();
  const done = await f.orchestrator.cancel(
    f.prepared.executionId,
    "finish drain",
    { timeoutMs: 0, reviewAdapter },
  );
  assert.equal(done.execution.reservationOpen, false);
  assert.equal(stops, 1);
  assert.equal(closes, 1);
  assert.equal(
    mailbox.readJson(`${dir}/cancel-stop-result.json`).disposition,
    "unknown",
  );
});

test("D7 real disposable Worker exits before pane closure and reservation release", async (t) => {
  const root = temp();
  let child,
    closed = 0;
  const runtimeModule = new URL("../worker-runtime.mjs", import.meta.url).href;
  const herdr = {
    async start({ executionRoot, onPane }) {
      onPane("fixture:p1");
      const script = `import { WorkerRuntime } from ${JSON.stringify(runtimeModule)};
        const worker = new WorkerRuntime({ executionRoot: ${JSON.stringify(executionRoot)} });
        worker.boot({ sessionId: 'real-worker', cwd: ${JSON.stringify(root)},
          activeTools: ['read','team_role_spawn','team_task_result'], extensions: ['teams-worker','pi-subagents'],
          subagents: ${JSON.stringify(subagents)} });
        setInterval(() => { if (worker.processControls().cancelRequested) {
          worker.confirmCancelled(0); process.exit(0);
        } }, 10);`;
      child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      return { paneId: "fixture:p1" };
    },
    closeIdle(paneId) {
      assert.equal(
        child.exitCode,
        0,
        "Worker must actually exit before closing the pane",
      );
      closed++;
      return { paneId, disposition: "closed" };
    },
  };
  const orchestrator = new TaskOrchestrator({
    runtimeRoot: path.join(root, "runtime"),
    ownerSessionId: "owner-1",
    herdr,
  });
  t.after(() => {
    child?.kill();
    orchestrator.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const prepared = orchestrator.prepare(spec(root));
  await orchestrator.launch(prepared.executionId, { timeoutMs: 30_000 });
  const cancelled = await orchestrator.cancel(
    prepared.executionId,
    "stop disposable Worker",
    { timeoutMs: 30_000 },
  );
  assert.equal(cancelled.execution.state, "CANCELLED");
  assert.equal(cancelled.execution.reservationOpen, false);
  assert.equal(closed, 1);
});

test("controller takeover fences the stale root session", () => {
  const root = temp();
  const runtimeRoot = path.join(root, "runtime");
  const stale = new TaskOrchestrator({
    runtimeRoot,
    ownerSessionId: "owner-1",
  });
  const prepared = stale.prepare(spec(root));
  const current = stale.ledger.getController(prepared.projectId);
  const recovered = new TaskOrchestrator({
    runtimeRoot,
    ownerSessionId: "owner-2",
  });
  const preparedProof = recovered.prepareTakeover(prepared.executionId);
  assert.equal(preparedProof.proof.requiresUserConfirmation, true);
  const takeover = recovered.takeover(
    prepared.projectId,
    current.ownerSessionId,
    current.ownerEpoch,
    preparedProof.proofRef,
  );
  assert.equal(takeover.ownerSessionId, "owner-2");
  assert.equal(takeover.ownerEpoch, current.ownerEpoch + 1);
  assert.throws(
    () => stale.assertController(prepared.projectId),
    /ownership changed/,
  );
  assert.equal(
    recovered.assertController(prepared.projectId).ownerSessionId,
    "owner-2",
  );
  stale.close();
  recovered.close();
});

test("Herdr native runner accepts successful commands with no JSON body", () => {
  const root = temp();
  const worker = path.join(root, "worker.mjs");
  const subagentsEntry = path.join(root, "subagents.mjs");
  fs.writeFileSync(worker, "export default () => {};\n");
  fs.writeFileSync(subagentsEntry, "export default () => {};\n");
  const herdr = new HerdrPort({
    executable: "/usr/bin/true",
    piExecutable: process.execPath,
    workerExtension: worker,
    subagentsExtension: subagentsEntry,
    environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
  });
  assert.deepEqual(herdr.status("w1:p2"), { ok: true });
});

test("Herdr adapter names the owned pane before agent registration and preserves worker identity", async () => {
  const root = temp();
  const executionRoot = path.join(root, "runtime");
  fs.mkdirSync(path.join(executionRoot, "receipts"), { recursive: true });
  fs.writeFileSync(path.join(executionRoot, "receipts", "boot.json"), "{}\n");
  const workerExtension = path.resolve("extensions/teams-worker/index.mjs");
  const subagentsExtension =
    "/home/timmypai/.pi/agent/npm/node_modules/pi-subagents/index.ts";
  const command = workerCommand({
    piExecutable: "/home/timmypai/.nvm/versions/node/v24.18.0/bin/pi",
    workerExtension,
    subagentsExtension,
    executionRoot,
  });
  assert.match(command, /^env '/);
  assert.match(command, /--no-extensions/);
  assert.doesNotMatch(command, /pi-goal-x/);
  assert.doesNotMatch(command, /,subagent,/);
  const calls = [];
  const port = new HerdrPort({
    workerExtension,
    subagentsExtension,
    inspectHost: () => ({ compatible: true, simulated: true }),
    environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
    run(_executable, args) {
      calls.push(args);
      if (args[0] === "agent" && args[1] === "rename")
        throw new Error(
          "agent_not_found: boot receipt is not agent registration",
        );
      if (args[0] === "status") {
        return {
          client: { version: "0.9.0", protocol: 22 },
          server: {
            running: true,
            compatible: true,
            endpoint_compatible: true,
            version: "0.9.0",
            protocol: 22,
          },
        };
      }
      return args[0] === "pane" && args[1] === "split"
        ? { result: { pane: { pane_id: "w1:p2" } } }
        : { result: {} };
    },
  });
  const started = await port.start({
    executionRoot,
    cwd: root,
    deadlineMs: 30_000,
  });
  assert.equal(started.paneId, "w1:p2");
  assert.match(JSON.stringify(calls[1]), /--session-dir/);
  assert.match(JSON.stringify(calls[1]), /worker-sessions/);
  assert.equal(port.capabilities().compatible, true);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["pane", "split"],
      ["pane", "run"],
      ["pane", "rename"],
      ["status", "--json"],
    ],
  );
});
