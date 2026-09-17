import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { inspectBackgroundHost } from "../capabilities.mjs";
import { HerdrPort } from "../herdr-port.mjs";
import { digest } from "../contracts.mjs";
import { collectRunUsage, sessionUsage } from "../e2e/usage.mjs";
import teamsOrchestrator from "../../extensions/teams-orchestrator/index.mjs";
import { deriveProjectId } from "../orchestrator.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-observability-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return file;
}

test("runtime readiness uses fresh live evidence, never a package/version allowlist", async (t) => {
  const root = fixture(t);
  const pi = write(root, "pi/cli.js", "");
  write(root, "pi/package.json", { name: "fixture-pi", version: "99.0.0" });
  const missing = inspectBackgroundHost(pi, { subagentsExtension: pi });
  assert.equal(missing.compatible, false);
  assert.equal(missing.liveVerified, false);
  let calls = 0;
  const port = new HerdrPort({
    executable: process.execPath,
    piExecutable: pi,
    workerExtension: pi,
    subagentsExtension: pi,
    environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
    run() {
      calls++;
      throw new Error("must not create a pane");
    },
  });
  await assert.rejects(
    port.start({ executionRoot: root, cwd: root, deadlineMs: 100 }),
    /background host incompatible/,
  );
  assert.equal(calls, 0);
  const evidence = write(
    root,
    "canary-evidence.json",
    "synthetic test evidence",
  );
  const receipt = {
    schemaVersion: "teams-runtime-readiness/1",
    runtimeDigest: missing.runtimeDigest,
    decision: "accepted",
    goalReadback: "live",
    evidence: [{ file: evidence, digest: digest("synthetic test evidence") }],
  };
  const readinessReceipt = write(root, "readiness.json", receipt);
  assert.equal(
    inspectBackgroundHost(pi, { subagentsExtension: pi, readinessReceipt })
      .compatible,
    true,
  );
  receipt.goalReadback = "simulation";
  write(root, "readiness.json", receipt);
  assert.equal(
    inspectBackgroundHost(pi, { subagentsExtension: pi, readinessReceipt })
      .compatible,
    false,
  );
  receipt.goalReadback = "live";
  write(root, "readiness.json", receipt);
  write(root, "pi/package.json", { name: "fixture-pi", version: "99.0.1" });
  assert.equal(
    inspectBackgroundHost(pi, { subagentsExtension: pi, readinessReceipt })
      .compatible,
    false,
  );
});

// Real WorkerRuntime processes and mailbox/ledger; Herdr UI, Pi/LLM and
// subagents capability advertisement are fixtures, not live native readiness.
async function verifyParallelWorkers(t, root, tools, handlers, ctx) {
  const children = [];
  const closedPanes = [];
  const moduleUrl = new URL("../worker-runtime.mjs", import.meta.url).href;
  const script = `
    import { WorkerRuntime } from ${JSON.stringify(moduleUrl)};
    import path from 'node:path';
    const [executionRoot, cwd] = process.argv.slice(1);
    const worker = new WorkerRuntime({executionRoot});
    worker.boot({
      sessionId: 'worker-' + path.basename(executionRoot), cwd,
      sessionFile: path.join(executionRoot, 'worker-sessions/session.jsonl'),
      activeTools: ['read', 'team_role_spawn', 'team_task_result'],
      extensions: ['teams-worker', 'pi-subagents'],
      subagents: {compatible: true, checks: {}, ping: {version: 1}}
    });
    const timer = setInterval(() => {
      if (worker.processControls().cancelRequested) {
        worker.confirmCancelled(0);
        clearInterval(timer);
      }
    }, 5);
  `;
  t.mock.method(HerdrPort.prototype, "start", async (input) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script, input.executionRoot, input.cwd],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const row = { child, stderr: "", exited: null };
    child.stderr.on("data", (data) => {
      row.stderr += data;
    });
    row.exited = new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    });
    children.push(row);
    const paneId = `w1:p${children.length + 1}`;
    input.onPane(paneId);
    return { paneId };
  });
  t.mock.method(HerdrPort.prototype, "status", () => ({ fixture: true }));
  t.mock.method(HerdrPort.prototype, "isIdle", () => true);
  t.mock.method(HerdrPort.prototype, "closeIdle", (paneId) => {
    closedPanes.push(paneId);
    return { paneId, disposition: "closed" };
  });
  const call = async (name, input) =>
    (
      await tools
        .find((tool) => tool.name === name)
        .execute(name, input, undefined, undefined, ctx)
    ).details;
  write(root, "product/readme.txt", "Read-only parallel handshake fixture.\n");
  const input = {
    schemaVersion: "teams-task-runtime/3",
    goalId: "parallel-goal",
    taskRevision: 1,
    objective: "Read the assigned source; wait for owner cancellation.",
    nonGoals: ["No product writes, native roles or acceptance."],
    workspace: {
      sourceRoot: root,
      worktreePath: null,
      baseCommit: "b".repeat(40),
      sourcePaths: ["product"],
      allowedWritePaths: [],
    },
    criteria: [
      {
        id: "outcome",
        text: "Owner verifies outcome.",
        requiredEvidenceKinds: ["host-check"],
      },
    ],
    checks: [],
    policy: {
      risk: "low",
      allowedRoles: ["team.reviewer"],
      maxActiveRoleRuns: 1,
      maxRoleSpawnsPerTask: 1,
      maxProductRepairsPerRole: 0,
      maxReportRepairs: 0,
      maxProcessRestarts: 0,
      maxTaskTokens: 100_000,
      deadlineMs: 60_000,
      integrationMode: "verify-only",
      review: {
        authority: "l0-source-bound",
        allowedRoles: ["team.reviewer"],
        allowedTools: ["read"],
      },
    },
    contextRefs: [],
  };
  // Prepare both inputs before baseline capture; dispatch calls themselves stay
  // sequential, while Worker A must remain RUNNING when Worker B starts.
  const specs = ["task-a", "task-b"].map((taskId) =>
    write(root, `${taskId}.json`, { ...input, taskId }),
  );
  const dispatch = (spec_path) =>
    call("team_task_dispatch", {
      spec_path,
      benefit: "context-isolation",
      benefit_detail:
        "Independent task-local contexts with overlapping Worker lifetimes.",
    });
  try {
    const a = await dispatch(specs[0]);
    const b = await dispatch(specs[1]);
    assert.equal(a.state, "RUNNING");
    assert.equal(b.state, "RUNNING");
    assert.equal(a.projectId, b.projectId);
    assert.equal(a.goalId, b.goalId);
    assert.notEqual(a.executionId, b.executionId);
    assert.notEqual(a.workerSessionId, b.workerSessionId);
    assert.notEqual(a.paneId, b.paneId);
    assert.equal(children.length, 2);
    assert.notEqual(children[0].child.pid, children[1].child.pid);
    assert.ok(
      children.every(({ child }) => child.pid && child.exitCode === null),
    );
    const status = (id) => call("team_task_status", { execution_id: id });
    assert.equal((await status(a.executionId)).state, "RUNNING");
    for (const execution of [a, b]) {
      const observed = await call("team_task_reconcile", {
        execution_id: execution.executionId,
      });
      assert.equal(observed.execution.state, "RUNNING");
      assert.equal(observed.processProof.terminal, false);
      t.diagnostic(
        JSON.stringify({
          executionId: execution.executionId,
          taskId: execution.taskId,
          workerSessionId: execution.workerSessionId,
          processProof: observed.processProof,
        }),
      );
    }
    const taskGate = await handlers.get("tool_call")({
      toolName: "update_goal_task",
      toolCallId: "premature-batch",
      input: {
        updates: ["task-a", "task-b"].map((task_id) => ({
          task_id,
          status: "complete",
        })),
      },
    });
    assert.equal(taskGate.block, true);
    assert.match(taskGate.reason, /AcceptanceReceipt is required/);
    const goalGate = () =>
      handlers.get("tool_call")({
        toolName: "update_goal",
        input: { status: "complete" },
      });
    assert.match((await goalGate()).reason, /2 Task Pi reservations/);
    await assert.rejects(
      dispatch(specs[0]),
      /task process restart budget exhausted/,
    );
    assert.equal(
      children.length,
      2,
      "duplicate Task must not launch a third Worker",
    );
    const cancel = (id) =>
      call("team_task_cancel", {
        execution_id: id,
        reason: "fixture owner stop",
      });
    const cancelledA = await cancel(a.executionId);
    assert.equal(cancelledA.execution.state, "CANCELLED");
    assert.equal(cancelledA.execution.reservationOpen, false);
    assert.equal(cancelledA.processProof.terminal, true);
    const stillRunning = await status(b.executionId);
    assert.equal(stillRunning.state, "RUNNING");
    assert.equal(stillRunning.reservationOpen, true);
    assert.equal(children[1].child.exitCode, null);
    assert.deepEqual(closedPanes, [a.paneId]);
    assert.match((await goalGate()).reason, /1 Task Pi reservation/);
    const cancelledB = await cancel(b.executionId);
    assert.equal(cancelledB.execution.state, "CANCELLED");
    assert.equal(cancelledB.execution.reservationOpen, false);
    assert.equal(cancelledB.processProof.terminal, true);
    assert.deepEqual(closedPanes, [a.paneId, b.paneId]);
    // Only the reservation guard clears: no Goal/task completion or acceptance
    // is requested; cancelled Tasks still do not satisfy Goal-X task criteria.
    assert.equal(await goalGate(), undefined);
    await Promise.all(children.map((row) => row.exited));
    for (const row of children) assert.equal(row.child.exitCode, 0, row.stderr);
  } finally {
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    await Promise.all(children.map((row) => row.exited));
  }
}

test("public entry admits only explicit canary with compatible live protocols, never promotes readiness", async (t) => {
  const root = fixture(t);
  for (const name of ["pi-subagents", "pi-goal-x"]) {
    write(root, `npm/node_modules/${name}/package.json`, {
      version: "fixture",
      pi: { extensions: ["index.mjs"] },
    });
    write(root, `npm/node_modules/${name}/index.mjs`, "");
  }
  const selectedEntry = path.join(root, "selected-subagents", "index.mjs");
  write(root, "selected-subagents/package.json", {
    name: "pi-subagents",
    version: "selected-fixture",
    pi: { extensions: ["index.mjs"] },
  });
  write(root, "selected-subagents/index.mjs", "");
  write(root, "foreign/package.json", {
    name: "not-subagents",
    pi: { extensions: ["index.mjs"] },
  });
  write(root, "foreign/index.mjs", "");
  const env = {
    PI_CODING_AGENT_DIR: root,
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_BIN: process.execPath,
    TEAMS_E2E_CANARY: undefined,
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let scenario;
  const original = HerdrPort.prototype.capabilities;
  t.mock.method(HerdrPort.prototype, "capabilities", function () {
    this.inspectHost = () => ({ compatible: false, liveVerified: false });
    this.run = () => ({
      server: {
        running: scenario.running,
        compatible: scenario.herdr,
        endpoint_compatible: scenario.endpoint,
      },
    });
    return original.call(this);
  });
  const { EventEmitter } = await import("node:events");
  for (scenario of [
    { flag: undefined },
    { flag: "true" },
    { flag: "1", admitted: true },
    { flag: "1", selected: true, admitted: true },
    { flag: "1", parallelWorkers: true, admitted: true },
    { flag: "1", foreign: true },
    { flag: "1", running: false },
    { flag: "1", herdr: false },
    { flag: "1", endpoint: false },
    { flag: "1", goal: false },
    { flag: "1", subagents: false },
  ].map((s) => ({
    running: true,
    herdr: true,
    endpoint: true,
    goal: true,
    subagents: true,
    ...s,
  }))) {
    if (scenario.flag === undefined) delete process.env.TEAMS_E2E_CANARY;
    else process.env.TEAMS_E2E_CANARY = scenario.flag;
    const bus = new EventEmitter();
    bus.on("subagents:rpc:v1:request", (request) =>
      bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: {
          version: 1,
          methods: ["status", "spawn", "stop"],
          events: { asyncComplete: "complete", processTerminal: "terminal" },
          capabilities: {
            status: true,
            asyncSpawn: scenario.subagents,
            stop: true,
            runtimeAcknowledgedExtensions: { version: 1 },
            processTerminalProof: { version: 1 },
          },
        },
      }),
    );
    const task = {
      properties: {
        task_id: { type: "string" },
        status: { enum: ["complete"] },
      },
    };
    const tools = [
      {
        name: "update_goal_task",
        parameters: {
          properties: { ...task.properties, updates: { items: task } },
        },
      },
      {
        name: "update_goal",
        parameters: { properties: { status: { enum: ["complete"] } } },
      },
    ];
    if (scenario.selected || scenario.foreign)
      tools.push({
        name: "subagent",
        sourceInfo: {
          path: scenario.foreign
            ? path.join(root, "foreign/index.mjs")
            : selectedEntry,
        },
      });
    const handlers = new Map();
    const commands = new Map();
    teamsOrchestrator({
      events: {
        emit: (...args) => bus.emit(...args),
        on: (name, fn) => {
          bus.on(name, fn);
          return () => bus.off(name, fn);
        },
      },
      registerTool: (tool) => tools.push(tool),
      registerCommand: (name, command) => commands.set(name, command),
      on: (name, fn) => handlers.set(name, fn),
      getAllTools: () =>
        scenario.goal
          ? tools
          : tools.filter((tool) => tool.name !== "update_goal"),
      getActiveTools: () => tools.map((tool) => tool.name),
    });
    let status, widget;
    const ctx = {
      cwd: root,
      sessionManager: {
        getSessionId: () => "canary-fixture",
        getSessionFile: () => undefined,
      },
      ui: {
        setStatus: (_key, value) => {
          status = value;
        },
        setWidget: (_key, value) => {
          widget = value;
        },
      },
    };
    try {
      if (scenario.foreign) {
        await assert.rejects(
          handlers.get("session_start")({}, ctx),
          /registered tool package mismatch/,
        );
        continue;
      }
      await handlers.get("session_start")({}, ctx);
      const receipt = JSON.parse(
        fs.readFileSync(
          path.join(
            root,
            "teams-task-runtime-v1",
            "capabilities",
            `${deriveProjectId(root)}.json`,
          ),
          "utf8",
        ),
      );
      assert.equal(
        receipt.decision.taskPiAvailable,
        scenario.admitted === true,
        JSON.stringify(scenario),
      );
      if (scenario.selected) {
        assert.equal(receipt.subagents.publicEntry, selectedEntry);
        assert.equal(receipt.subagents.packageVersion, "selected-fixture");
      }
      assert.equal(receipt.herdr.compatible, false);
      assert.equal(receipt.herdr.backgroundHost.liveVerified, false);
      assert.equal(
        fs.existsSync(
          path.join(
            root,
            "teams-task-runtime-v1",
            "capabilities",
            `${deriveProjectId(root)}.readiness.json`,
          ),
        ),
        false,
      );
      if (scenario.admitted) assert.match(status, /canary/);
      if (scenario.parallelWorkers)
        await t.test(
          "L0 dispatches two overlapping v3 Workers and cancels each independently",
          async (subtest) => {
            await verifyParallelWorkers(subtest, root, tools, handlers, ctx);
          },
        );
      await assert.rejects(
        tools
          .find((tool) => tool.name === "team_task_dispatch")
          .execute(
            "call",
            { spec_path: "not-absolute" },
            undefined,
            undefined,
            ctx,
          ),
        scenario.admitted
          ? /absolute spec_path required/
          : /capability handshake is incomplete/,
      );
      assert.equal(
        commands.has("teams-e2e-drain"),
        process.env.TEAMS_E2E_CANARY === "1",
      );
      if (commands.has("teams-e2e-drain")) {
        const input = JSON.stringify({
          requestId: "fixture-drain",
          reason: "fixture-stop",
        });
        await commands.get("teams-e2e-drain").handler(input, ctx);
        const receipt = JSON.parse(widget[0].slice("TEAMS_E2E_DRAIN:".length));
        assert.equal(receipt.ownerSessionId, "canary-fixture");
        assert.equal(receipt.settled, true);
        if (scenario.parallelWorkers) {
          assert.equal(receipt.rows.length, 2);
          assert.ok(
            receipt.rows.every(
              (row) => row.state === "CANCELLED" && !row.reservationOpen,
            ),
          );
        } else assert.deepEqual(receipt.rows, []);
        await assert.rejects(
          commands.get("teams-e2e-drain").handler(input, ctx),
          /drain already requested/,
        );
        await assert.rejects(
          tools
            .find((tool) => tool.name === "team_task_dispatch")
            .execute("call", {}, undefined, undefined, ctx),
          /draining/,
        );
      }
    } finally {
      handlers.get("session_shutdown")();
    }
  }
});

test("exited Pi shell is idle only with exact foreground shell proof", (t) => {
  const cwd = fixture(t);
  const pane = { cwd, agent_status: "unknown" };
  const info = {
    shell_pid: 42,
    foreground_process_group_id: 42,
    foreground_processes: [{ pid: 42, cwd }],
  };
  const port = {
    status: () => ({ result: { pane } }),
    run: () => ({ result: { process_info: info } }),
  };
  const idle = () => HerdrPort.prototype.isIdle.call(port, "w1:p1", cwd);
  assert.equal(idle(), true);
  pane.agent = "pi";
  assert.equal(idle(), false);
  delete pane.agent;
  info.foreground_process_group_id = 43;
  assert.equal(idle(), false);
  info.foreground_process_group_id = 42;
  info.foreground_processes.push({ pid: 43, cwd });
  assert.equal(idle(), false);
  info.foreground_processes = [];
  assert.equal(idle(), false);
});

test("failure usage retains cache, deduplicates messages, and exposes unknown launches", (t) => {
  const root = fixture(t);
  const receiptRoot = "run/runtime/projects/p/executions/e/receipts";
  write(root, `${receiptRoot}/boot.json`, { workerSessionId: "worker-1" });
  write(root, `${receiptRoot}/progress-1.json`, { kind: "role-launch-intent" });
  const entry = {
    type: "message",
    id: "message-1",
    timestamp: "2026-09-10T01:00:00Z",
    message: {
      role: "assistant",
      usage: {
        input: 3,
        output: 5,
        cacheRead: 7,
        cacheWrite: 11,
        totalTokens: 26,
      },
    },
  };
  const file = write(
    root,
    "sessions/day_worker-1.jsonl",
    [
      JSON.stringify(entry),
      JSON.stringify(entry),
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", isError: true },
      }),
      "{partial",
    ].join("\n"),
  );
  const usage = sessionUsage(file);
  assert.equal(usage.total, 26);
  assert.equal(usage.messages, 1);
  assert.equal(usage.toolErrors, 1);
  assert.equal(usage.malformedLines, 1);
  assert.equal(sessionUsage(file, { since: "2026-09-10T02:00:00Z" }).total, 0);
  assert.equal(sessionUsage(null).available, false);
  const report = collectRunUsage(
    path.join(root, "run"),
    path.join(root, "sessions"),
  );
  assert.equal(report.knownTotals.total, 26);
  assert.equal(report.unknownLaunches, 1);
  assert.equal(report.complete, false);
});

test("leaf usage follows native steps.sessionFile rather than guessing async directory names", (t) => {
  const root = fixture(t);
  const receipts = "run/runtime/projects/p/executions/e/receipts";
  const row = (id, input) =>
    JSON.stringify({
      type: "message",
      id,
      message: {
        role: "assistant",
        usage: { input, output: 2, cacheRead: 10 },
      },
    });
  write(root, `${receipts}/boot.json`, { workerSessionId: "worker-1" });
  write(root, "sessions/day_worker-1.jsonl", row("w", 3));
  const leaf = write(root, "sessions/nested/run-0/session.jsonl", row("l", 7));
  const asyncDir = path.join(root, "async");
  write(root, `${receipts}/progress-started.json`, {
    kind: "role-started",
    runId: "run-1",
    asyncDir,
  });
  write(root, "async/status.json", {
    runId: "run-1",
    state: "complete",
    steps: [{ sessionFile: leaf }, { sessionFile: leaf }],
    usageBudget: { exhausted: true },
  });
  const report = collectRunUsage(
    path.join(root, "run"),
    path.join(root, "sessions"),
  );
  assert.equal(report.leaves[0].sessions.length, 1);
  assert.equal(report.knownTotals.total, 34);
  assert.equal(report.complete, true);
  assert.equal(report.anomalies[0].kind, "native-budget-exhausted");
  write(root, `${receipts}/progress-wave.json`, {
    kind: "role-wave-launch-intent",
  });
  write(root, `${receipts}/progress-member-1.json`, {
    kind: "role-launch-intent",
    rootLaunchId: "wave",
  });
  write(root, `${receipts}/progress-member-2.json`, {
    kind: "role-launch-intent",
    rootLaunchId: "wave",
  });
  write(root, `${receipts}/progress-started.json`, {
    kind: "role-started",
    runId: "run-1",
    asyncDir,
    members: [{ key: "first" }, { key: "second" }],
  });
  const partialWave = collectRunUsage(
    path.join(root, "run"),
    path.join(root, "sessions"),
  );
  assert.equal(
    partialWave.unknownLaunches,
    0,
    "member intents are not separate native roots",
  );
  assert.equal(
    partialWave.complete,
    false,
    "one session cannot stand in for two members",
  );
  assert.ok(
    partialWave.anomalies.some(
      (row) => row.kind === "wave-session-count-mismatch",
    ),
  );
});

test("strict review usage includes nested tools and compaction, never retained-tail duplicates", (t) => {
  const root = fixture(t);
  const usage = {
    input: 4,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 10,
  };
  const entries = [
    { type: "message", id: "a", message: { role: "assistant", usage } },
    {
      type: "message",
      id: "t",
      message: { role: "toolResult", usage, isError: false },
    },
    {
      type: "compaction",
      id: "c",
      usage,
      retainedTail: [{ role: "assistant", usage }],
    },
    { type: "branch_summary", id: "b", usage },
  ];
  const file = write(
    root,
    "review.jsonl",
    entries.map(JSON.stringify).join("\n"),
  );
  assert.equal(sessionUsage(file, { strict: true }).total, 40);
  assert.equal(sessionUsage(file, { strict: true }).messages, 1);
  delete entries[2].usage;
  write(root, "review.jsonl", entries.map(JSON.stringify).join("\n"));
  assert.equal(
    sessionUsage(file, { strict: true }).missingUsage,
    1,
    "unknown compaction cost must block review",
  );
  write(
    root,
    "review.jsonl",
    [
      {
        type: "message",
        id: "a",
        message: {
          role: "assistant",
          usage: {
            ...usage,
            input: Number.MAX_SAFE_INTEGER,
            totalTokens: Number.MAX_SAFE_INTEGER + 6,
          },
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  assert.equal(sessionUsage(file, { strict: true }).missingUsage, 1);
});
