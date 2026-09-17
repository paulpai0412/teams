import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Mailbox } from "../mailbox.mjs";
import { TaskOrchestrator } from "../orchestrator.mjs";
import { RoleController } from "../role-controller.mjs";
import { WorkerRuntime } from "../worker-runtime.mjs";
import { captureWorkspace, verifyWorkspaceScope } from "../workspace-scope.mjs";
import { bytesDigest, digest, validateTaskResult } from "../contracts.mjs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  workerSessionBytes,
  measureExecutionUsage,
  measureClosedExecutionUsage,
} from "../task-usage.mjs";
import { SubagentsRpcClient } from "../capabilities.mjs";
import { readRoleLifecycle } from "../role-lifecycle.mjs";
import { failingNativeBus } from "./native-launch-fixture.mjs";
import {
  changeTaskBudget,
  taskBudgetBinding,
  readTaskBudget,
  TASK_BUDGET_BINDING,
  TASK_BUDGET_EXTENSION,
} from "../task-budget.mjs";
import teamsWorker from "../../extensions/teams-worker/index.mjs";
import { collectTaskResult } from "../../extensions/teams-orchestrator/index.mjs";

const subagents = {
  compatible: true,
  checks: { protocolV1: true, status: true, spawn: true, stop: true },
  ping: { version: 1 },
};

function runningWorker(
  policy = {},
  {
    prepareOnly = false,
    gitFixture = false,
    objective = "Produce the bounded outcome.",
    contextRefs = [],
    allowedWritePaths = ["src"],
    workerProcess = {},
    paneId = null,
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-roles-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.js"), "export default 1;\n");
  fs.writeFileSync(path.join(root, "README.md"), "baseline\n");
  let baseCommit = "b".repeat(40);
  if (gitFixture) {
    for (const args of [
      ["init", "-q"],
      ["add", "README.md", "src"],
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "baseline",
      ],
    ]) {
      const result = spawnSync("git", ["-C", root, ...args], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    }
    fs.appendFileSync(path.join(root, ".git/info/exclude"), "\n/runtime/\n");
    baseCommit = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
  }
  const orchestrator = new TaskOrchestrator({
    runtimeRoot: path.join(root, "runtime"),
    ownerSessionId: "owner-1",
  });
  const prepared = orchestrator.prepare({
    ...(policy.review ? { schemaVersion: "teams-task-runtime/3" } : {}),
    goalId: "goal-1",
    taskId: "task-1",
    taskRevision: 1,
    objective,
    nonGoals: ["Do not deploy."],
    workspace: {
      sourceRoot: root,
      worktreePath: null,
      baseCommit,
      sourcePaths: ["src"],
      allowedWritePaths,
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
      allowedRoles: ["team.implementer", "team.reviewer"],
      maxActiveRoleRuns: 2,
      maxRoleSpawnsPerTask: 3,
      maxProductRepairsPerRole: 1,
      maxReportRepairs: 1,
      maxProcessRestarts: 1,
      maxTaskTokens: 100,
      deadlineMs: 3_600_000,
      integrationMode: "verify-only",
      // Historical native fixtures intentionally exercise the old hard-member contract.
      ...(policy.review ? { tokenBudgetMode: "member-hard" } : {}),
      ...policy,
    },
    contextRefs,
  });
  if (prepareOnly) return { root, orchestrator, prepared };
  const worker = new WorkerRuntime({ executionRoot: prepared.executionRoot });
  worker.boot({
    sessionId: "worker-1",
    ...(policy.review
      ? {
          sessionFile: usageSession(
            path.join(prepared.executionRoot, "worker-sessions/worker.jsonl"),
            "worker-1",
            root,
            10,
          ),
        }
      : {}),
    cwd: root,
    activeTools: ["read", "team_role_spawn", "team_task_result"],
    extensions: ["teams-worker", "pi-subagents"],
    subagents,
    ...workerProcess,
  });
  const mailbox = Mailbox.open(prepared.executionRoot, prepared.executionId);
  if (policy.review) {
    let starting = orchestrator.ledger.transition(
      prepared.executionId,
      "RESERVED",
      0,
      "SPAWNING",
    );
    if (paneId)
      starting = orchestrator.ledger.attachPane(
        prepared.executionId,
        starting.revision,
        paneId,
      );
    const bound = orchestrator.ledger.bindWorker(
      prepared.executionId,
      starting.revision,
      "worker-1",
    );
    orchestrator.ledger.transition(
      prepared.executionId,
      "SPAWNING",
      bound.revision,
      "RUNNING",
    );
  }
  mailbox.writeCommand({
    schemaVersion: "teams-task-control/1",
    commandId: `grant-${prepared.executionId}`,
    executionId: prepared.executionId,
    ownerEpoch: prepared.ownerEpoch,
    requestDigest: prepared.requestDigest,
    type: "grant",
    payload: {},
  });
  worker.processControls();
  return { root, orchestrator, prepared, worker };
}

function usageSession(file, id, cwd, total) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${[
      { type: "session", version: 3, id, cwd },
      {
        type: "message",
        id: "message-one",
        message: {
          role: "assistant",
          usage: {
            input: 0,
            output: 0,
            cacheRead: total,
            cacheWrite: 0,
            totalTokens: total,
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
  );
  return file;
}

function appendUsage(worker, total, extra = {}) {
  const file = worker.mailbox.readJson("receipts/boot.json").workerSessionFile;
  const number = fs.readFileSync(file, "utf8").split("\n").length;
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: "message",
      id: `message-${number}`,
      message: {
        role: "assistant",
        stopReason: "error",
        usage: {
          input: 0,
          output: 0,
          cacheRead: total,
          cacheWrite: 0,
          totalTokens: total,
        },
      },
      ...extra,
    }) + "\n",
  );
}

// Actual Worker/RoleController/mailbox, synthetic public native producer and terminal events.
function meteredWorker(t, options = {}) {
  const f = runningWorker(
    {
      review: {
        authority: "l0-source-bound",
        allowedRoles: ["team.reviewer"],
        allowedTools: ["read"],
      },
      ...(options.sharedBudget
        ? { tokenBudgetMode: "shared", maxTaskTokens: 1000 }
        : {}),
    },
    options,
  );
  t.after(() => {
    f.orchestrator.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  if (options.sharedBudget) {
    const boot = f.worker.mailbox.readJson("receipts/boot.json");
    const binding = taskBudgetBinding(f.worker, "worker");
    const identity = {
      sessionId: boot.workerSessionId,
      sessionFile: boot.workerSessionFile,
    };
    changeTaskBudget(binding, { type: "bind", ...identity });
    changeTaskBudget(binding, {
      type: "request",
      ...identity,
      used: 0,
      allowance: 10,
    });
    changeTaskBudget(binding, { type: "settle", ...identity, used: 10 });
  }
  const calls = [],
    statuses = new Map();
  const rpc = {
    async request(method, params) {
      assert.equal(method, "spawn");
      calls.push(params);
      const launch = roles.snapshot().launches.at(-1);
      const runId = `native-${calls.length}`;
      const asyncDir = path.join(f.prepared.executionRoot, runId);
      fs.mkdirSync(asyncDir);
      const status = {
        runId,
        cwd: f.root,
        sessionId: "worker-1",
        state: "complete",
        processTerminal: {
          version: 1,
          state: "observed",
          runId,
          runnerProcessInstanceId: `process-${calls.length}`,
        },
        ...(params.workflowScript ? { workflow: {} } : {}),
        steps: launch.members.map((member, i) => ({
          agent: member.role,
          workflowKey: member.key,
          status: "complete",
          sessionFile: usageSession(
            path.join(params.sessionDir, `leaf-${i}.jsonl`),
            `${runId}-leaf-${i}`,
            f.root,
            5,
          ),
        })),
      };
      if (options.sharedBudget) {
        assert.equal(params.usageBudget.tokens.hard, 1000);
        const binding = params.extensionBindings[TASK_BUDGET_BINDING];
        const identity = {
          sessionId: `${runId}-leaf-0`,
          sessionFile: status.steps[0].sessionFile,
        };
        changeTaskBudget(binding, { type: "bind", ...identity });
        changeTaskBudget(binding, {
          type: "request",
          ...identity,
          used: 0,
          allowance: 10,
        });
        changeTaskBudget(binding, { type: "settle", ...identity, used: 5 });
        changeTaskBudget(binding, { type: "finish", ...identity, used: 5 });
      }
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(status),
      );
      statuses.set(runId, { status, asyncDir });
      return { runId, asyncDir };
    },
  };
  const roles = new RoleController({
    runtime: f.worker,
    rpc,
    cwd: f.root,
    resolve: async (input) => {
      assert.ok(input.extensionBindings[TASK_BUDGET_BINDING]);
      return {
        ok: true,
        contract: { tools: { extensionArgs: [TASK_BUDGET_EXTENSION] } },
      };
    },
  });
  const spawn = (maxTokens = 20) =>
    roles.spawn({
      role: "team.implementer",
      task: "Read one bounded input.",
      mode: "read-only",
      maxTokens,
    });
  function settle(launch, completion = "completed") {
    const { status, asyncDir } = statuses.get(launch.runId);
    status.state = completion === "completed" ? "complete" : completion;
    if (completion !== "completed")
      for (const step of status.steps) step.status = completion;
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify(status),
    );
    roles.finish(launch.runId, completion);
    roles.observeProcessTerminal(status.processTerminal);
    return status;
  }
  return {
    ...f,
    roles,
    rpc,
    calls,
    statuses,
    spawn,
    settle,
    workerFile:
      f.worker.mailbox.readJson("receipts/boot.json").workerSessionFile,
  };
}

test("shared Task admission dispatches a subsequent role after actual usage exceeds its soft estimate", async (t) => {
  const f = meteredWorker(t, { sharedBudget: true });
  const first = await f.spawn(2);
  f.settle(first);
  const second = await f.spawn(2);
  f.settle(second);
  const admitted = f.roles.admitTurn();
  assert.equal(admitted.usage.taskTotals.total, 20); // Worker 10 + two leaves 5 each.
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].usageBudget.tokens.hard, 1000);
  const pool = readTaskBudget(f.worker);
  assert.equal(
    Object.values(pool.members).filter(
      (row) => row.used === 5 && row.estimate === 2,
    ).length,
    2,
  );
  assert.equal(f.roles.snapshot().unresolvedRunCount, 0);
});

test("D1 v3 single mutation uses the managed workflow and shared mutation rejects before RPC", async (t) => {
  const f = runningWorker(
    {
      review: {
        authority: "l0-source-bound",
        allowedRoles: ["team.reviewer"],
        allowedTools: ["read"],
      },
    },
    { gitFixture: true },
  );
  t.after(() => {
    f.orchestrator.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const calls = [];
  const roles = new RoleController({
    runtime: f.worker,
    cwd: f.root,
    rpc: {
      async request(method, params) {
        assert.equal(method, "spawn");
        calls.push(params);
        return {
          runId: "managed-role-1",
          asyncDir: path.join(f.prepared.executionRoot, "native"),
        };
      },
    },
  });
  const task = {
    role: "team.implementer",
    task: "Implement within the managed checkout.",
    mode: "mutation",
    maxTokens: 20,
  };
  await assert.rejects(
    roles.spawnWave({
      key: "unsafe",
      reason: "Must not write the target",
      runs: [{ key: "writer", ...task, isolation: "shared" }],
    }),
    /managed worktree/,
  );
  assert.equal(calls.length, 0);
  assert.equal(roles.snapshot().reservedTokens, 0);
  const launched = await roles.spawn(task);
  assert.equal(calls.length, 1);
  assert.equal(launched.members[0].isolation, "worktree");
  assert.equal(launched.hostedWorkflow.pid, process.pid);
  assert.equal(calls[0].agent, undefined);
  let children;
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction("runs", calls[0].workflowScript)({
    all: async (items) => {
      children = items;
      return items.map(() => ({ ok: true }));
    },
  });
  assert.equal(children.length, 1);
  assert.equal(children[0].worktree, true);
  assert.equal(children[0].async, false);
  assert.equal(children[0].model, "antigravity/gemini-3.7-flash");
  assert.equal(children[0].cwd, f.root);
  assert.doesNotMatch(children[0].task, /Optional memory: confirm/);
  assert.match(children[0].task, /do not invent a mock DOM/);
  assert.match(children[0].task, /value\.residualRisks/);
  assert.match(children[0].task, /Report correction ceiling: 1/);
  assert.match(
    children[0].task,
    /never replay implementation or checks to fix a report/,
  );
  assert.equal(
    children[0].outputSchema.required.includes("residualRisks"),
    true,
  );
  assert.equal(
    spawnSync("git", ["-C", f.root, "status", "--porcelain"], {
      encoding: "utf8",
    }).stdout,
    "",
  );
});

test("D6 role dispatch checks the entire workspace before RPC", async (t) => {
  for (const [name, mutate, error] of [
    [
      "addition",
      (root) => fs.writeFileSync(path.join(root, "outside.txt"), "no"),
      /workspace.*scope/,
    ],
    [
      "modification",
      (root) => fs.writeFileSync(path.join(root, "README.md"), "changed"),
      /workspace.*scope/,
    ],
    [
      "deletion",
      (root) => fs.unlinkSync(path.join(root, "README.md")),
      /workspace.*scope/,
    ],
    [
      "mode",
      (root) => fs.chmodSync(path.join(root, "README.md"), 0o700),
      /workspace.*scope/,
    ],
    [
      "empty directory",
      (root) => fs.mkdirSync(path.join(root, "outside")),
      /workspace.*scope/,
    ],
    [
      "prefix lookalike",
      (root) => fs.mkdirSync(path.join(root, "src-backup")),
      /workspace.*scope/,
    ],
    [
      "report lookalike",
      (root) => fs.writeFileSync(path.join(root, "task-role-fake.json"), "{}"),
      /workspace.*scope/,
    ],
    [
      "symlink",
      (root) => fs.symlinkSync("/tmp", path.join(root, "src/link")),
      /symlink/,
    ],
    [
      "sensitive path",
      (root) => fs.writeFileSync(path.join(root, "src/.env"), "synthetic"),
      /credential/,
    ],
  ]) {
    await t.test(name, async (t) => {
      const f = meteredWorker(t);
      mutate(f.root);
      await assert.rejects(f.spawn(), error);
      assert.equal(f.calls.length, 0);
      assert.equal(f.roles.snapshot().reservedTokens, 0);
    });
  }
});

test("D6 permits authorized adds, binary edits and deletes; runtime artifacts are explicit", async (t) => {
  for (const change of [
    (root) =>
      fs.writeFileSync(
        path.join(root, "src/new.bin"),
        Buffer.from([0, 255, 1]),
      ),
    (root) => fs.writeFileSync(path.join(root, "src/index.js"), "changed"),
    (root) => fs.unlinkSync(path.join(root, "src/index.js")),
  ]) {
    const f = meteredWorker(t);
    const baseline = f.worker.mailbox.readJson(
      "receipts/workspace-baseline.json",
    );
    assert.deepEqual(baseline.workspaces[0].excludedPaths, [
      ".git",
      ".pi/goals",
      ".pi/.goals-pool-snapshot.json",
      "runtime",
    ]);
    change(f.root);
    const launch = await f.spawn();
    f.settle(launch);
    await f.spawn(); // Native status and session files remain in the runtime tree.
    assert.equal(f.calls.length, 2);
  }
});

test("D6 missing, altered and foreign baselines cannot be recaptured", (t) => {
  const f = meteredWorker(t);
  const box = f.worker.mailbox;
  const file = path.join(box.root, "receipts/workspace-baseline.json");
  const baseline = box.readJson("receipts/workspace-baseline.json");
  const bootstrap = box.readJson("bootstrap.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ ...baseline, requestDigest: "a".repeat(64) }),
  );
  assert.throws(
    () => verifyWorkspaceScope(f.prepared.contract, box),
    /baseline changed/,
  );
  fs.writeFileSync(
    path.join(box.root, "bootstrap.json"),
    JSON.stringify({
      ...bootstrap,
      workspaceBaselineDigest: digest(
        JSON.parse(fs.readFileSync(file, "utf8")),
      ),
    }),
  );
  assert.throws(
    () => verifyWorkspaceScope(f.prepared.contract, box),
    /another task/,
  );
  delete bootstrap.workspaceBaselineDigest;
  fs.writeFileSync(
    path.join(box.root, "bootstrap.json"),
    JSON.stringify(bootstrap),
  );
  assert.throws(
    () => verifyWorkspaceScope(f.prepared.contract, box),
    /baseline missing/,
  );
});

test("D6 baseline admission rejects harness overlap and unsafe trees before reservation", (t) => {
  const f = meteredWorker(t);
  const { identity, ...specification } = f.prepared.contract;
  const spec = {
    ...specification,
    goalId: identity.goalId,
    taskId: "scope-negative",
    taskRevision: 1,
  };
  spec.workspace = { ...spec.workspace, allowedWritePaths: ["runtime"] };
  assert.throws(() => f.orchestrator.prepare(spec), /overlaps harness/);
  spec.workspace.allowedWritePaths = ["src"];
  fs.writeFileSync(
    path.join(f.root, ".env"),
    "synthetic fixture, not credentials",
  );
  assert.throws(() => f.orchestrator.prepare(spec), /credential/);
  assert.ok(
    !f.orchestrator.ledger.findLatestTask(
      f.prepared.projectId,
      identity.goalId,
      spec.taskId,
    ),
  );
});

test("D6 workspace scanning rejects FIFOs without blocking the host", (t) => {
  const f = meteredWorker(t);
  const pipe = path.join(f.root, "src/pipe");
  assert.equal(spawnSync("mkfifo", [pipe]).status, 0);
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        `import assert from 'node:assert/strict';`,
        `import { captureWorkspace } from ${JSON.stringify(new URL("../workspace-scope.mjs", import.meta.url).href)};`,
        `assert.throws(() => captureWorkspace(${JSON.stringify(f.prepared.contract)}, ${JSON.stringify(f.orchestrator.runtimeRoot)}), /bounded regular file/);`,
      ].join("\n"),
    ],
    { timeout: 2000, encoding: "utf8" },
  );
  assert.equal(
    probe.error,
    undefined,
    "workspace scan must not block on a FIFO",
  );
  assert.equal(probe.status, 0, probe.stderr);
});

test("D6 captures an explicit second checkout and empty workspace without guessing exclusions", (t) => {
  const f = meteredWorker(t);
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "teams-scope-second-"));
  t.after(() => fs.rmSync(second, { recursive: true, force: true }));
  const contract = structuredClone(f.prepared.contract);
  contract.workspace.worktreePath = second;
  const baseline = captureWorkspace(contract, f.orchestrator.runtimeRoot);
  assert.deepEqual(
    baseline.workspaces.map((row) => row.cwd),
    [f.root, second],
  );
  assert.deepEqual(
    baseline.workspaces[1].files.map((row) => row.path),
    [""],
  );
});

test("D5b1 role admission counts worker cache before any native call", async (t) => {
  const f = meteredWorker(t);
  usageSession(f.workerFile, "worker-1", f.root, 90);
  await assert.rejects(f.spawn(), /usage|budget/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.roles.snapshot().reservedTokens, 0);
});

test("D5b1 complete failed native session costs cannot be omitted", async (t) => {
  const f = meteredWorker(t);
  const first = await f.spawn();
  const status = f.settle(first, "failed");
  usageSession(
    status.steps[0].sessionFile,
    `${first.runId}-leaf-0`,
    f.root,
    15,
  );
  fs.appendFileSync(
    f.workerFile,
    `${JSON.stringify({ type: "message", id: "more", message: { role: "assistant", usage: { input: 55, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 55 } } })}\n`,
  );
  await assert.rejects(f.spawn(30), /budget/);
  assert.equal(f.calls.length, 1);
});

test("D5b1 a fresh controller cannot reset existing role history", async (t) => {
  const f = meteredWorker(t);
  f.settle(await f.spawn());
  const restarted = new RoleController({
    runtime: f.worker,
    rpc: f.rpc,
    cwd: f.root,
  });
  await assert.rejects(
    restarted.spawn({
      role: "team.implementer",
      task: "Not a recovery grant.",
      mode: "read-only",
      maxTokens: 20,
    }),
    /history|reconcile/,
  );
  assert.equal(f.calls.length, 1);
});

test("D5b1 incomplete, altered or foreign usage stops admission without spending a new reservation", async (t) => {
  for (const fault of [
    "worker-truncate",
    "worker-unknown",
    "native-missing",
    "native-proof",
    "member-cap",
    "checkpoint",
    "prior",
    "partial-plan",
  ])
    await t.test(fault, async (sub) => {
      const f = meteredWorker(sub);
      const first = await f.spawn();
      const status = f.settle(first);
      if (fault === "worker-truncate")
        usageSession(f.workerFile, "worker-1", f.root, 0);
      if (fault === "worker-unknown")
        fs.appendFileSync(f.workerFile, "{partial");
      if (fault === "native-missing")
        fs.unlinkSync(status.steps[0].sessionFile);
      if (fault === "native-proof") {
        status.processTerminal.runnerProcessInstanceId = "some-other-process";
        fs.writeFileSync(
          path.join(first.asyncDir, "status.json"),
          JSON.stringify(status),
        );
      }
      if (fault === "member-cap")
        usageSession(
          status.steps[0].sessionFile,
          `${first.runId}-leaf-0`,
          f.root,
          21,
        );
      if (fault === "checkpoint")
        fs.writeFileSync(
          path.join(f.prepared.executionRoot, first.usageAdmissionRef),
          "{}",
        );
      if (fault === "prior") {
        f.worker.bootstrap.priorExecutionId = "previous-execution";
        fs.writeFileSync(
          path.join(f.prepared.executionRoot, "bootstrap.json"),
          JSON.stringify(f.worker.bootstrap),
        );
      }
      if (fault === "partial-plan")
        f.worker.mailbox.writeReceipt("wave-plan-incomplete", {});
      await assert.rejects(
        f.spawn(),
        /usage|session|budget|history|reconcile|ENOENT/,
      );
      assert.equal(f.calls.length, 1);
      assert.equal(f.roles.snapshot().reservedTokens, 20);
    });
});

test("D5b1 already charged native bytes cannot shrink on a later wave", async (t) => {
  const f = meteredWorker(t);
  const first = await f.spawn();
  const firstStatus = f.settle(first);
  f.settle(await f.spawn());
  usageSession(
    firstStatus.steps[0].sessionFile,
    `${first.runId}-leaf-0`,
    f.root,
    1,
  );
  await assert.rejects(f.spawn(), /previously measured session/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.roles.snapshot().reservedTokens, 40);
});

test("D5b1 cancellation is consumed before metered native dispatch", async (t) => {
  const f = meteredWorker(t);
  f.worker.mailbox.writeCommand({
    schemaVersion: "teams-task-control/1",
    commandId: "cancel-before-role",
    executionId: f.prepared.executionId,
    ownerEpoch: f.prepared.ownerEpoch,
    requestDigest: f.prepared.requestDigest,
    type: "cancel",
    payload: {},
  });
  await assert.rejects(f.spawn(), /not running/);
  assert.equal(f.worker.state, "CANCEL_REQUESTED");
  assert.equal(f.calls.length, 0);
});

test("D5b1 missing native directory leaves an unknown run, never a retry grant", async (t) => {
  const f = meteredWorker(t);
  const original = f.rpc.request;
  f.rpc.request = async (...args) => {
    const response = await original(...args);
    delete response.asyncDir;
    return response;
  };
  await assert.rejects(f.spawn(), /unknown/);
  assert.equal(f.roles.snapshot().unresolvedRunCount, 1);
  await assert.rejects(f.spawn(), /active native wave/);
  assert.equal(f.calls.length, 1);
});

test("D5b1 sequential and parallel role starts preserve measured checkpoints", async (t) => {
  const f = meteredWorker(t);
  const first = await f.spawn();
  f.settle(first);
  fs.appendFileSync(
    f.workerFile,
    `${JSON.stringify({ type: "message", id: "worker-more", message: { role: "assistant", usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } })}\n`,
  );
  const wave = await f.roles.spawnWave({
    key: "two-readers",
    reason: "Independent reads.",
    runs: [0, 1].map((i) => ({
      key: `reader-${i}`,
      role: "team.reviewer",
      task: "Read independently.",
      mode: "read-only",
      isolation: "shared",
      maxTokens: 20,
    })),
  });
  const receipt = f.worker.mailbox.readJson(wave.usageAdmissionRef);
  assert.equal(receipt.totals.total, 17);
  assert.equal(receipt.nextReservation, 40);
  assert.equal(receipt.acceptance, "not-assessed");
  assert.equal(f.calls[1].usageBudget.tokens.hard, 40);
  assert.equal(f.roles.snapshot().reservedTokens, 60);
});

test("D5 Worker turns charge failed/cache/summary usage and stop before another model request", (t) => {
  const f = meteredWorker(t);
  assert.equal(f.roles.admitTurn().usage.totals.total, 10);
  appendUsage(f.worker, 5);
  assert.equal(f.roles.admitTurn().usage.totals.total, 15);
  appendUsage(f.worker, 0, {
    type: "compaction",
    usage: {
      input: 5,
      output: 0,
      cacheRead: 75,
      cacheWrite: 5,
      totalTokens: 85,
    },
  });
  assert.throws(() => f.roles.admitTurn(), /budget exhausted/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.roles.turnCount, 2);
});

test("D5 Worker waits for native termination then meters it without a completion callback", async (t) => {
  const f = meteredWorker(t);
  f.roles.admitTurn();
  const launch = await f.spawn();
  const { status, asyncDir } = f.statuses.get(launch.runId);
  status.state = "running";
  const file = path.join(asyncDir, "status.json");
  fs.writeFileSync(file, JSON.stringify(status));
  const coordination = f.roles.admitTurn();
  assert.equal(coordination.waiting, true);
  assert.equal(coordination.usage.totals.total, 10);
  assert.equal(coordination.usage.nextReservation, 20);
  assert.equal(f.roles.turnCount, 2);
  status.state = "failed";
  status.steps[0].status = "failed";
  fs.writeFileSync(file, JSON.stringify(status));
  const next = f.roles.admitTurn();
  assert.equal(next.waiting, false);
  assert.equal(next.usage.totals.total, 15);
  assert.equal(f.roles.snapshot().unresolvedRunCount, 0);
  assert.equal(f.calls.length, 1);
});

test("D5 settled hosted leaf over budget hands failure to collect, not another Worker turn", async (t) => {
  const f = meteredWorker(t);
  f.roles.admitTurn();
  const launch = await f.roles.spawnWave({
    key: "bounded-hosted-role",
    reason: "Single hosted completion regression.",
    runs: [
      {
        key: "role",
        role: "team.implementer",
        task: "Report a bounded finding.",
        mode: "read-only",
        isolation: "shared",
        maxTokens: 12,
      },
    ],
  });
  const { status, asyncDir } = f.statuses.get(launch.runId);
  delete status.processTerminal;
  status.pid = process.pid;
  status.mode = "workflow";
  status.state = "running";
  status.steps[0].async = false;
  status.steps[0].runId = "hosted-child";
  status.steps[0].status = "running";
  status.workflowChildren = {
    version: 1,
    workflowRunId: launch.runId,
    inventoryComplete: false,
    workflowState: "running",
    children: [
      {
        childId: "role",
        runId: "hosted-child",
        agent: "team.implementer",
        state: "running",
      },
    ],
  };
  const statusFile = path.join(asyncDir, "status.json");
  fs.writeFileSync(statusFile, JSON.stringify(status));
  const waiting = f.roles.admitTurn();
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.usage.nextReservation, 12);
  usageSession(
    status.steps[0].sessionFile,
    `${launch.runId}-leaf-0`,
    f.root,
    21,
  );
  status.state = "complete";
  status.steps[0].status = "completed";
  status.workflowChildren.inventoryComplete = true;
  status.workflowChildren.workflowState = "completed";
  status.workflowChildren.children[0].state = "completed";
  fs.writeFileSync(statusFile, JSON.stringify(status));
  let failure;
  try {
    f.roles.admitTurn();
  } catch (error) {
    failure = error;
  }
  assert.match(
    failure?.message ?? "",
    /actual leaf usage exceeds member budget/,
  );
  assert.equal(f.roles.snapshot().unresolvedRunCount, 0);
  assert.equal(f.roles.snapshot().launches[0].hostedTerminal.state, "settled");
  f.worker.failAdmission(failure);
  await assert.rejects(
    collectTaskResult(f.orchestrator, f.prepared.executionId),
    /Worker admission failed: actual leaf usage exceeds member budget/,
  );
  assert.equal(f.calls.length, 1, "no retry or extra native/model call");
  assert.equal(f.worker.mailbox.listResults().length, 0);
  assert.equal(
    f.orchestrator.ledger.getExecution(f.prepared.executionId).reservationOpen,
    true,
  );
  assert.equal(
    f.orchestrator.ledger.getAcceptance(f.prepared.executionId),
    null,
  );
});

test("D5 active coordination retains allocations, meters Worker turns and forbids another wave", async (t) => {
  const f = meteredWorker(t);
  const launch = await f.spawn(80);
  const { status, asyncDir } = f.statuses.get(launch.runId);
  status.state = "running";
  const file = path.join(asyncDir, "status.json");
  fs.writeFileSync(file, JSON.stringify(status));
  const first = f.roles.admitTurn();
  assert.equal(first.waiting, true);
  assert.equal(first.usage.nextReservation, 80);
  assert.equal(
    first.usage.sources.length,
    1,
    "in-flight leaf is reserved, not falsely measured as terminal",
  );
  appendUsage(f.worker, 5);
  assert.equal(f.roles.admitTurn().usage.totals.total, 15);
  await assert.rejects(f.spawn(), /one active native wave/);
  status.sessionId = "unrelated-owner";
  fs.writeFileSync(file, JSON.stringify(status));
  assert.throws(() => f.roles.admitTurn(), /owner mismatch/);
  status.sessionId = "worker-1";
  fs.writeFileSync(file, JSON.stringify(status));
  appendUsage(f.worker, 6);
  assert.throws(() => f.roles.admitTurn(), /reservation exceeds budget/);
  assert.equal(f.calls.length, 1);
  f.settle(launch);
  const finished = f.roles.admitTurn();
  assert.equal(finished.waiting, false);
  assert.equal(finished.usage.nextReservation, 0);
  assert.equal(finished.usage.totals.total, 26);
});

test("D5 Worker turn checkpoints cannot disappear, change or reset with a new controller", async (t) => {
  for (const failure of ["recreate", "truncate", "checkpoint", "unknown"]) {
    await t.test(failure, (t) => {
      const f = meteredWorker(t);
      f.roles.admitTurn();
      let roles = f.roles;
      if (failure === "recreate")
        roles = new RoleController({
          runtime: f.worker,
          rpc: { request() {} },
          cwd: f.root,
        });
      if (failure === "truncate")
        usageSession(
          f.worker.mailbox.readJson("receipts/boot.json").workerSessionFile,
          "worker-1",
          f.root,
          0,
        );
      if (failure === "checkpoint")
        fs.unlinkSync(
          path.join(
            f.prepared.executionRoot,
            "receipts/worker-usage-000001.json",
          ),
        );
      if (failure === "unknown")
        appendUsage(f.worker, 0, { type: "branch_summary", usage: undefined });
      assert.throws(() => roles.admitTurn(), /usage|checkpoint/);
    });
  }
});

test("D5 fresh L0 ownership and liveness gate Worker turns and role dispatch", async (t) => {
  for (const failure of ["fenced", "dead", "deadline", "state"]) {
    await t.test(failure, async (t) => {
      const f = meteredWorker(t);
      if (failure === "fenced")
        f.orchestrator.ledger.takeoverController(
          f.prepared.projectId,
          "owner-2",
          "owner-1",
          f.prepared.ownerEpoch,
          path.join(f.root, "fixture-proof.json"),
        );
      if (failure === "dead") {
        f.worker.bootstrap.controller.processId = 999999999;
        fs.writeFileSync(
          path.join(f.prepared.executionRoot, "bootstrap.json"),
          JSON.stringify(f.worker.bootstrap),
        );
      }
      if (failure === "deadline")
        f.orchestrator.ledger.db
          .prepare(
            "UPDATE executions SET created_at = ? WHERE execution_id = ?",
          )
          .run("2000-01-01T00:00:00Z", f.prepared.executionId);
      if (failure === "state") {
        const execution = f.orchestrator.ledger.getExecution(
          f.prepared.executionId,
        );
        f.orchestrator.ledger.transition(
          execution.executionId,
          execution.state,
          execution.revision,
          "UNKNOWN",
        );
      }
      assert.throws(() => f.roles.admitTurn(), /L0|deadline/);
      await assert.rejects(f.spawn(), /L0|deadline/);
      assert.equal(f.calls.length, 0);
    });
  }
});

test("D5 public SessionManager admits a fresh zero-usage Worker before its first disk flush", (t) => {
  const { createJiti } = createRequire(
    path.join(os.homedir(), ".pi/agent/npm/package.json"),
  )("jiti");
  const loader = createJiti(
    fs.realpathSync(process.execPath.replace(/\/node$/, "/pi")),
  );
  return import(loader.esmResolve("@earendil-works/pi-coding-agent")).then(
    ({ SessionManager }) => {
      const f = meteredWorker(t);
      const manager = SessionManager.create(
        f.root,
        path.join(f.prepared.executionRoot, "worker-sessions"),
      );
      const boot = {
        ...f.worker.mailbox.readJson("receipts/boot.json"),
        workerSessionId: manager.getSessionId(),
        workerSessionFile: manager.getSessionFile(),
      };
      f.worker.workerSessionId = manager.getSessionId();
      fs.writeFileSync(
        path.join(f.prepared.executionRoot, "receipts/boot.json"),
        JSON.stringify(boot),
      );
      f.orchestrator.ledger.db
        .prepare(
          "UPDATE executions SET worker_session_id = ? WHERE execution_id = ?",
        )
        .run(manager.getSessionId(), f.prepared.executionId);
      manager.appendMessage({
        role: "user",
        content: "Fixture only; no model request.",
        timestamp: 1,
      });
      assert.ok(!fs.existsSync(manager.getSessionFile()));
      f.roles.readWorker = (boot) => workerSessionBytes(manager, boot);
      assert.equal(f.roles.admitTurn().usage.totals.total, 0);
      manager.appendMessage({
        role: "assistant",
        content: [],
        api: "fixture",
        provider: "fixture",
        model: "fixture",
        stopReason: "stop",
        timestamp: 2,
        usage: {
          input: 1,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          totalTokens: 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      assert.equal(f.roles.admitTurn().usage.totals.total, 10);
      fs.unlinkSync(manager.getSessionFile());
      assert.throws(() => f.roles.admitTurn(), /not persisted/);
    },
  );
});

test("D5 ending L0 in a still-live process revokes Worker admission without releasing its reservation", (t) => {
  const f = meteredWorker(t);
  f.orchestrator.close();
  assert.throws(() => f.roles.admitTurn(), /L0 session admission ended/);
  const replacement = new TaskOrchestrator({
    runtimeRoot: f.orchestrator.runtimeRoot,
    ownerSessionId: f.orchestrator.ownerSessionId,
  });
  t.after(() => replacement.close());
  assert.equal(
    replacement.ledger.getExecution(f.prepared.executionId).reservationOpen,
    true,
  );
  assert.throws(
    () =>
      replacement.assertControllerAdmission(
        replacement.ledger.getExecution(f.prepared.executionId),
      ),
    /L0 session admission ended/,
  );
});

test("D5 only a never-launched cancellation can carry zero missing-session usage", (t) => {
  for (const altered of [false, true]) {
    const f = runningWorker(
      {
        review: {
          authority: "l0-source-bound",
          allowedRoles: ["team.reviewer"],
          allowedTools: ["read"],
        },
      },
      { prepareOnly: true },
    );
    t.after(() => {
      f.orchestrator.close();
      fs.rmSync(f.root, { recursive: true, force: true });
    });
    f.orchestrator.requestCancel(
      f.prepared.executionId,
      "fixture before launch",
    );
    if (altered)
      f.orchestrator.ledger.db
        .prepare("UPDATE executions SET revision = 3 WHERE execution_id = ?")
        .run(f.prepared.executionId);
    const next = () =>
      f.orchestrator.prepare({
        ...f.prepared.contract,
        ...f.prepared.contract.identity,
        taskRevision: 2,
      });
    if (altered) assert.throws(next, /previous Worker usage missing/);
    else {
      const prepared = next();
      const prior = JSON.parse(
        fs.readFileSync(
          path.join(prepared.executionRoot, "receipts/prior-usage.json"),
          "utf8",
        ),
      );
      assert.equal(prior.totals.total, 0);
      assert.deepEqual(prior.sources, []);
    }
  }
});

for (const scenario of [
  "success",
  "budget",
  "shared",
  "oversized-prompt",
  "send-error",
])
  test(`D5 actual Worker extension ${scenario}`, async (t) => {
    const denied = scenario === "budget";
    const shared = scenario === "shared";
    const startupFailure =
      scenario === "oversized-prompt" || scenario === "send-error";
    const { createJiti } = createRequire(
      path.join(os.homedir(), ".pi/agent/npm/package.json"),
    )("jiti");
    const loader = createJiti(
      fs.realpathSync(process.execPath.replace(/\/node$/, "/pi")),
    );
    const { SessionManager } = await import(
      loader.esmResolve("@earendil-works/pi-coding-agent")
    );
    const f = runningWorker(
      {
        review: {
          authority: "l0-source-bound",
          allowedRoles: ["team.reviewer"],
          allowedTools: ["read"],
        },
        ...(shared ? { tokenBudgetMode: "shared", maxTaskTokens: 1000 } : {}),
      },
      {
        prepareOnly: true,
        objective:
          scenario === "oversized-prompt"
            ? "x".repeat(3500)
            : "Produce the bounded outcome.",
      },
    );
    const manager = SessionManager.create(
      f.root,
      path.join(f.prepared.executionRoot, "worker-sessions"),
    );
    const callbacks = new Map(),
      tools = new Map(),
      listeners = new Map();
    let aborted = 0,
      shutdown = 0,
      prompts = 0;
    const ctx = {
      cwd: f.root,
      sessionManager: manager,
      model: { contextWindow: 100, maxTokens: 50 },
      getSystemPrompt: () => "Offline Worker fixture.",
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort() {
        aborted++;
      },
      shutdown() {
        shutdown++;
      },
      ui: { setStatus() {}, notify() {} },
    };
    const pi = {
      on(name, handler) {
        const previous = callbacks.get(name);
        // Pi keeps multiple handlers and short-circuits cancellation. These
        // composed budget/lifecycle callbacks are synchronous in this fixture.
        callbacks.set(
          name,
          previous
            ? (...args) => {
                const result = previous(...args);
                if (result?.cancel || result?.block) return result;
                return handler(...args) ?? result;
              }
            : handler,
        );
      },
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      getAllTools: () => [],
      getActiveTools: () => ["read", "team_role_spawn", "team_task_result"],
      setActiveTools() {},
      sendUserMessage(content) {
        prompts++;
        if (scenario === "send-error")
          throw new Error("fixture sendUserMessage failed");
        manager.appendMessage({ role: "user", content, timestamp: Date.now() });
        callbacks.get("turn_start")({}, ctx);
        if (shared) callbacks.get("context")({ messages: [] }, ctx);
      },
      events: {
        on(name, callback) {
          listeners.set(name, callback);
          return () => listeners.delete(name);
        },
        emit(name, request) {
          assert.equal(name, "subagents:rpc:v1:request");
          assert.equal(
            request.method,
            "ping",
            "no native/model dispatch in this extension test",
          );
          listeners.get(`subagents:rpc:v1:reply:${request.requestId}`)({
            version: 1,
            requestId: request.requestId,
            success: true,
            data: {
              version: 1,
              methods: ["spawn", "stop", "status"],
              capabilities: {
                status: true,
                asyncSpawn: true,
                stop: true,
                runtimeAcknowledgedExtensions: { version: 1 },
                processTerminalProof: { version: 1 },
              },
              events: {
                asyncComplete: "fixture:complete",
                processTerminal: "fixture:terminal",
              },
            },
          });
        },
      },
    };
    const old = process.env.TEAMS_TASK_EXECUTION_DIR;
    process.env.TEAMS_TASK_EXECUTION_DIR = f.prepared.executionRoot;
    teamsWorker(pi);
    t.after(() => {
      callbacks.get("session_shutdown")({}, ctx);
      if (old === undefined) delete process.env.TEAMS_TASK_EXECUTION_DIR;
      else process.env.TEAMS_TASK_EXECUTION_DIR = old;
      f.orchestrator.close();
      fs.rmSync(f.root, { recursive: true, force: true });
    });
    f.orchestrator.herdr = {
      async start() {
        await callbacks.get("session_start")({}, ctx);
        return { paneId: "fixture:pane" };
      },
    };
    await f.orchestrator.launch(f.prepared.executionId, { timeoutMs: 2000 });
    if (startupFailure) {
      const mailbox = Mailbox.open(
        f.prepared.executionRoot,
        f.prepared.executionId,
      );
      const expected =
        scenario === "oversized-prompt"
          ? /worker prompt exceeds 6 KiB/
          : /fixture sendUserMessage failed/;
      const failed = mailbox
        .listEvents()
        .filter((event) => event.type === "failed");
      assert.equal(
        failed.length,
        1,
        "startup rejection must reach the owner, not only the UI",
      );
      assert.match(mailbox.readJson(failed[0].payloadRef).error, expected);
      await assert.rejects(
        collectTaskResult(f.orchestrator, f.prepared.executionId),
        expected,
      );
      assert.equal(
        f.orchestrator.ledger.getExecution(f.prepared.executionId)
          .reservationOpen,
        true,
      );
      assert.equal(mailbox.listResults().length, 0);
      assert.equal(aborted, 0, "no model turn began");
      assert.equal(
        shutdown,
        0,
        "failure keeps existing cancellation controls alive",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        mailbox.listEvents().filter((event) => event.type === "failed").length,
        1,
      );
      assert.equal(
        prompts,
        scenario === "oversized-prompt" ? 0 : 1,
        "no prompt replay after failure",
      );
      f.orchestrator.requestCancel(
        f.prepared.executionId,
        "fixture startup rejection",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        shutdown,
        1,
        "startup failure still drains through owner cancellation",
      );
      assert.equal(
        f.orchestrator.ledger.getAcceptance(f.prepared.executionId),
        null,
      );
      return;
    }
    assert.equal(prompts, 1);
    if (!shared)
      assert.equal(
        callbacks.get("tool_call")({ toolName: "subagent_supervisor" }, ctx),
        undefined,
      );
    assert.deepEqual(callbacks.get("session_before_switch")({}, ctx), {
      cancel: true,
    });
    assert.deepEqual(callbacks.get("session_before_fork")({}, ctx), {
      cancel: true,
    });
    assert.equal(
      aborted,
      0,
      "the first model admission works before any assistant file flush",
    );
    manager.appendMessage({
      role: "assistant",
      content: [],
      api: "fixture",
      provider: "fixture",
      model: "fixture",
      timestamp: 2,
      stopReason: "error",
      usage: {
        input: 0,
        output: 0,
        cacheRead: denied ? 100 : shared ? 50 : 1,
        cacheWrite: 0,
        totalTokens: denied ? 100 : shared ? 50 : 1,
      },
    });
    if (shared) callbacks.get("turn_end")({}, ctx);
    callbacks.get("turn_start")({}, ctx);
    if (shared) {
      const context = {
        contract: f.prepared.contract,
        mailbox: Mailbox.open(f.prepared.executionRoot, f.prepared.executionId),
      };
      assert.equal(
        aborted,
        0,
        fs.existsSync(
          path.join(f.prepared.executionRoot, "receipts/admission-failed.json"),
        )
          ? JSON.stringify(
              context.mailbox.readJson("receipts/admission-failed.json"),
            )
          : "no admission-failed receipt",
      );
      assert.equal(readTaskBudget(context).members.worker.used, 50);
      assert.equal(readTaskBudget(context).members.worker.inFlight, false);
      assert.equal(
        callbacks.get("tool_call")({ toolName: "subagent_supervisor" }, ctx),
        undefined,
      );
      assert.deepEqual(callbacks.get("session_before_tree")({}, ctx), {
        cancel: true,
      });
      callbacks.get("session_shutdown")({}, ctx);
      assert.equal(readTaskBudget(context).members.worker.finished, true);
      return;
    }
    if (denied) {
      assert.equal(aborted, 1);
      const mailbox = Mailbox.open(
        f.prepared.executionRoot,
        f.prepared.executionId,
      );
      const events = mailbox
        .listEvents()
        .filter((event) => event.type === "failed");
      assert.equal(events.length, 1);
      const failure = mailbox.readJson(events[0].payloadRef);
      assert.match(
        failure.error,
        /task budget exhausted before Worker model request/,
      );
      assert.match(failure.stack, /RoleController.admitTurn/);
      assert.deepEqual(callbacks.get("session_before_compact")({}, ctx), {
        cancel: true,
      });
      assert.deepEqual(callbacks.get("session_before_tree")({}, ctx), {
        cancel: true,
      });
      callbacks.get("turn_start")({}, ctx);
      assert.equal(
        mailbox.listEvents().filter((event) => event.type === "failed").length,
        1,
      );
      assert.equal(
        callbacks.get("tool_call")({ toolName: "subagent_supervisor" }, ctx)
          .block,
        true,
      );
      assert.equal(mailbox.listResults().length, 0);
      await assert.rejects(
        collectTaskResult(f.orchestrator, f.prepared.executionId),
        /Worker admission failed: task budget exhausted before Worker model request/,
      );
      assert.equal(
        f.orchestrator.ledger.getExecution(f.prepared.executionId)
          .reservationOpen,
        true,
      );
      assert.equal(
        shutdown,
        0,
        "failure alone must not abandon hosted roles or control handling",
      );
      f.orchestrator.requestCancel(
        f.prepared.executionId,
        "fixture admission failure",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        shutdown,
        1,
        "existing cancellation still drains the quiescent Worker",
      );
      assert.equal(
        prompts,
        1,
        "failed admission must not schedule a second model wake",
      );
      assert.equal(
        f.orchestrator.ledger.getAcceptance(f.prepared.executionId),
        null,
      );
      return;
    }
    assert.equal(aborted, 0);
    assert.equal(callbacks.get("session_before_compact")({}, ctx), undefined);
    assert.equal(callbacks.get("session_before_tree")({}, ctx), undefined);
    await tools.get("team_task_result").execute(
      "fixture-result",
      {
        resultRevision: 1,
        outcome: "ready_for_acceptance",
        summary:
          "Fixture admitted; host acceptance still pending. No model ran.",
        criterionResults: [
          {
            criterionId: "criterion-1",
            status: "indeterminate",
            observation: "Pending host.",
            evidenceIds: [],
          },
        ],
        evidence: [],
        risks: [],
        usage: { inputTokens: null, outputTokens: null },
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(shutdown, 1);
    const collected = await collectTaskResult(
      f.orchestrator,
      f.prepared.executionId,
    );
    assert.equal(collected.candidate.outcome, "ready_for_acceptance");
    assert.equal(collected.state, "RESULT_READY");
    assert.equal(
      f.orchestrator.ledger.getAcceptance(f.prepared.executionId),
      null,
    );
    callbacks.get("turn_start")({}, ctx);
    assert.equal(aborted, 1, "queued turns after result cannot start a model");
    assert.equal(
      callbacks.get("tool_call")({ toolName: "subagent_supervisor" }, ctx)
        .block,
      true,
      "native replies after result cannot bypass the Worker admission fence",
    );
  });

test("M3 public RPC role controller enforces one writer and bounded budgets", async () => {
  const { root, orchestrator, prepared, worker } = runningWorker();
  let next = 0;
  const sessionDirs = [];
  const rpc = {
    async request(method, params) {
      assert.equal(method, "spawn");
      assert.equal(params.async, true);
      assert.equal(params.context, "fresh");
      assert.equal(
        path.dirname(params.sessionDir),
        path.join(prepared.executionRoot, "role-sessions"),
      );
      sessionDirs.push(params.sessionDir);
      assert.equal(params.outputSchema.type, "object");
      assert.deepEqual(params.outputSchema.required, [
        "summary",
        "criterionResults",
        "residualRisks",
      ]);
      assert.equal(params.outputSchema.properties.acceptanceReport, undefined);
      assert.match(params.task, /acceptanceReport is a sibling/);
      assert.equal(params.timeoutMs, worker.contract.policy.deadlineMs);
      next += 1;
      return { runId: `run-${next}`, asyncDir: `${root}/native/../native` };
    },
  };
  const roles = new RoleController({ runtime: worker, rpc, cwd: root });
  const writer = await roles.spawn({
    role: "team.implementer",
    task: "Implement the bounded change.",
    mode: "mutation",
    maxTokens: 40,
  });
  await assert.rejects(
    roles.spawn({
      role: "team.implementer",
      task: "Duplicate writer.",
      mode: "mutation",
      maxTokens: 10,
    }),
    /active native wave/,
  );
  roles.finish(writer.runId);
  assert.equal(roles.snapshot().unresolvedRunCount, 1);
  roles.observeProcessTerminal({
    version: 1,
    state: "observed",
    runId: writer.runId,
    runnerProcessInstanceId: "process-1",
  });
  const reviewer = await roles.spawn({
    role: "team.reviewer",
    task: "Review independently.",
    mode: "review",
    maxTokens: 30,
  });
  await assert.rejects(
    roles.spawn({
      role: "team.reviewer",
      task: "Third active role.",
      mode: "review",
      maxTokens: 10,
    }),
    /active native wave/,
  );
  roles.finish(reviewer.runId, "failed");
  roles.observeProcessTerminal({
    version: 1,
    state: "observed",
    runId: reviewer.runId,
    runnerProcessInstanceId: "process-2",
  });
  await assert.rejects(
    roles.spawn({
      role: "team.implementer",
      task: "Exceed aggregate budget.",
      mode: "mutation",
      maxTokens: 31,
    }),
    /token budget/,
  );
  assert.deepEqual(roles.snapshot().childRunRefs, ["run-1", "run-2"]);
  assert.equal(roles.snapshot().unresolvedRunCount, 0);
  orchestrator.ingestEvents(
    Mailbox.open(prepared.executionRoot, prepared.executionId),
  );
  const budget = orchestrator.ledger.getTaskBudget(
    prepared.projectId,
    prepared.contract.identity.goalId,
    prepared.contract.identity.taskId,
  );
  assert.equal(budget.spawns, 2);
  assert.equal(budget.reservedTokens, 70);
  const started = worker.mailbox
    .listEvents()
    .filter((event) => event.type === "progress")
    .map((event) => worker.mailbox.readJson(event.payloadRef))
    .filter((row) => row.kind === "role-started");
  assert.deepEqual(
    started.map((row) => row.sessionDir),
    sessionDirs,
  );
  assert.equal(new Set(sessionDirs).size, 2);
  orchestrator.close();
});

test("D1 dynamic read-only wave uses one native root, stable keys and every member's budget", async () => {
  const { root, orchestrator, prepared, worker } = runningWorker({
    allowedRoles: ["team.qa", "team.researcher", "team.security"],
    maxActiveRoleRuns: 3,
    maxRoleSpawnsPerTask: 4,
  });
  const calls = [];
  const roles = new RoleController({
    runtime: worker,
    cwd: root,
    rpc: {
      async request(method, params) {
        calls.push({ method, params });
        return { runId: "wave-run" };
      },
    },
  });
  const runs = worker.contract.policy.allowedRoles.map((role, i) => ({
    key: `angle-${i}`,
    role,
    task: `Investigate independent question ${i}.`,
    mode: "read-only",
    isolation: "shared",
    maxTokens: 20,
  }));
  const wave = await roles.spawnWave({
    key: "discovery",
    reason: "Independent source questions on the same frozen checkout.",
    runs,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "spawn");
  assert.equal(calls[0].params.agent, undefined);
  assert.deepEqual(calls[0].params.usageBudget, { tokens: { hard: 60 } });
  const observed = [];
  const execute = new (Object.getPrototypeOf(async () => {}).constructor)(
    "runs",
    calls[0].params.workflowScript,
  );
  const output = await execute({
    async all(items) {
      observed.push(...items);
      return items.map(() => ({ ok: true, artifactPaths: ["native-handoff"] }));
    },
  });
  assert.equal(observed.length, 3);
  assert.deepEqual(
    observed.map((item) => item.agent),
    runs.map((item) => item.role),
  );
  assert.ok(
    observed.every(
      (item) =>
        item.context === "fresh" &&
        item.output &&
        item.outputSchema &&
        !item.worktree,
    ),
  );
  assert.equal(output.length, 3);
  await assert.rejects(
    roles.spawnWave({
      key: "again",
      reason: "Wait for the first wave.",
      runs: [runs[0]],
    }),
    /active.*wave/,
  );
  roles.finish(wave.runId);
  roles.observeProcessTerminal({
    version: 1,
    state: "observed",
    runId: wave.runId,
    runnerProcessInstanceId: "process-wave",
  });
  await assert.rejects(
    roles.spawnWave({
      key: "discovery",
      reason: "Do not replay a consumed key.",
      runs,
    }),
    /wave key/,
  );
  orchestrator.ingestEvents(
    Mailbox.open(prepared.executionRoot, prepared.executionId),
  );
  const budget = orchestrator.ledger.getTaskBudget(
    prepared.projectId,
    worker.contract.identity.goalId,
    worker.contract.identity.taskId,
  );
  assert.equal(budget.spawns, 3);
  assert.equal(budget.reservedTokens, 60);
  assert.deepEqual(roles.snapshot().childRunRefs, ["wave-run"]);
  orchestrator.close();
});

test("D1 invalid shared-writer and mixed review waves fail before any native call", async () => {
  const { root, orchestrator, worker } = runningWorker();
  let calls = 0;
  const roles = new RoleController({
    runtime: worker,
    cwd: root,
    rpc: {
      async request() {
        calls++;
      },
    },
  });
  const writer = {
    key: "first",
    role: "team.implementer",
    task: "Bounded change.",
    mode: "mutation",
    isolation: "shared",
    maxTokens: 20,
  };
  const reader = {
    key: "second",
    role: "team.reviewer",
    task: "Read final source.",
    mode: "review",
    isolation: "shared",
    maxTokens: 20,
  };
  await assert.rejects(
    roles.spawnWave({
      key: "unsafe",
      reason: "Cannot read a changing source.",
      runs: [writer, reader],
    }),
    /shared checkout/,
  );
  await assert.rejects(
    roles.spawnWave({
      key: "unsafe",
      reason: "No duplicate writer.",
      runs: [writer, { ...writer, key: "second" }],
    }),
    /shared checkout/,
  );
  await assert.rejects(
    roles.spawnWave({
      key: "invalid",
      reason: "Reject all before launch.",
      runs: [reader, { ...reader, key: "other", role: "team.unknown" }],
    }),
    /role not allowed/,
  );
  assert.equal(calls, 0);
  assert.equal(roles.snapshot().reservedTokens, 0);
  orchestrator.close();
});

test("M5 cancellation requests public RPC stop and waits for terminal event", async () => {
  const { root, orchestrator, worker } = runningWorker();
  const calls = [];
  const roles = new RoleController({
    runtime: worker,
    cwd: root,
    rpc: {
      async request(method, params) {
        calls.push({ method, params });
        return method === "spawn"
          ? { runId: "run-1" }
          : { runId: "run-1", state: "stopping" };
      },
    },
  });
  await roles.spawn({
    role: "team.implementer",
    task: "Start bounded work.",
    mode: "mutation",
    maxTokens: 20,
  });
  const stopping = await roles.stopAll();
  assert.equal(stopping.unresolvedRunCount, 1);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["spawn", "stop"],
  );
  roles.finish("run-1", "stopped");
  assert.equal(roles.snapshot().unresolvedRunCount, 1);
  roles.observeProcessTerminal({
    version: 1,
    state: "observed",
    runId: "run-1",
    runnerProcessInstanceId: "process-1",
  });
  assert.equal(roles.snapshot().unresolvedRunCount, 0);
  assert.equal((await roles.stopAll()).outcomes.length, 0);
  orchestrator.close();
});

test("M3 ambiguous spawn failure remains unresolved and cannot be retried blindly", async () => {
  const { root, orchestrator, worker } = runningWorker();
  const roles = new RoleController({
    runtime: worker,
    cwd: root,
    rpc: {
      async request() {
        throw new Error("reply lost");
      },
    },
  });
  await assert.rejects(
    roles.spawn({
      role: "team.implementer",
      task: "Attempt once.",
      mode: "mutation",
      maxTokens: 20,
    }),
    /unknown; reconcile before retry: reply lost/,
  );
  const mailbox = worker.mailbox;
  const progress = mailbox
    .listEvents()
    .filter((event) => event.type === "progress")
    .map((event) => mailbox.readJson(event.payloadRef, 16 * 1024));
  assert.ok(
    progress.some(
      (event) =>
        event.kind === "role-launch-unknown" && event.error === "reply lost",
    ),
  );
  assert.equal(roles.snapshot().unresolvedRunCount, 1);
  assert.equal(roles.snapshot().reservedTokens, 20);
  orchestrator.close();
});

function cancelWorker(f, consume = true) {
  f.worker.mailbox.writeCommand({
    schemaVersion: "teams-task-control/1",
    commandId: "cancel-drain",
    executionId: f.prepared.executionId,
    ownerEpoch: f.prepared.ownerEpoch,
    requestDigest: f.prepared.requestDigest,
    type: "cancel",
    payload: { reason: "fixture cancel" },
  });
  if (consume) f.worker.processControls();
}

test("D7 reconstructed controller reads native terminal evidence, not empty RAM", async (t) => {
  const f = meteredWorker(t);
  await f.spawn(); // Native status is complete; notification was deliberately not delivered.
  const recovered = new RoleController({
    runtime: f.worker,
    rpc: f.rpc,
    cwd: f.root,
  });
  assert.equal(recovered.snapshot().unresolvedRunCount, 0);
  cancelWorker(f);
  assert.throws(() => f.worker.confirmCancelled(0), /durable unresolved/);
  const drained = await recovered.stopAll();
  assert.equal(drained.unresolvedRunCount, 0);
  assert.equal(drained.outcomes.length, 0); // No stop or new spawn for an observed terminal run.
  assert.equal(f.calls.length, 1);
  f.worker.confirmCancelled(0);
  await assert.rejects(
    recovered.spawn({
      role: "team.implementer",
      task: "No restart",
      mode: "read-only",
      maxTokens: 1,
    }),
    /not running/,
  );
});

test("D7 timed-out stop is not repeated after controller reconstruction", async (t) => {
  const f = meteredWorker(t);
  const launched = await f.spawn();
  const { status, asyncDir } = f.statuses.get(launched.runId);
  status.state = "running";
  const save = () =>
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify(status),
    );
  save();
  let stops = 0;
  const rpc = {
    async request(method, params) {
      assert.equal(method, "stop");
      assert.equal(params.id, launched.runId);
      stops++;
      throw new Error("ambiguous stop timeout");
    },
  };
  f.roles.rpc = rpc;
  cancelWorker(f);
  assert.equal((await f.roles.stopAll()).outcomes[0].disposition, "unknown");
  const recovered = new RoleController({ runtime: f.worker, rpc, cwd: f.root });
  assert.equal((await recovered.stopAll()).unresolvedRunCount, 1);
  assert.equal(stops, 1);
  assert.throws(() => f.worker.confirmCancelled(0), /durable unresolved/);
  status.state = "stopped";
  save();
  assert.equal((await recovered.stopAll()).unresolvedRunCount, 0);
  assert.equal(stops, 1);
  f.worker.confirmCancelled(0);
});

test("native no-start crosses RPC, preserves prior usage, and permits Worker cancellation without replay", async (t) => {
  // Same absent-process fixture used by lifecycle.test; pane closure is an IO
  // double, not proof that a live Herdr pane was closed.
  const f = meteredWorker(t, {
    workerProcess: { processId: 99_999_999, processStartedAtTicks: "1" },
    paneId: "w1:p2",
  });
  const first = await f.spawn();
  f.settle(first);
  const bus = failingNativeBus();
  f.roles.rpc = new SubagentsRpcClient(bus);
  await assert.rejects(
    f.roles.spawn({
      role: "team.reviewer",
      task: "Review candidate",
      mode: "review",
      maxTokens: 20,
    }),
    /failed before runner spawn/,
  );
  assert.equal(bus.count(), 1);
  assert.equal(f.worker.state, "QUIESCENT");
  const launches = f.roles.snapshot().launches;
  const failed = launches.at(-1);
  assert.equal(failed.completion, "failed");
  assert.equal(failed.processTerminal.reason, "spawn-not-attempted");
  assert.equal(f.roles.snapshot().unresolvedRunCount, 0);
  assert.equal(
    readRoleLifecycle(f.worker.mailbox, f.worker.contract, "worker-1").length,
    2,
  );
  const context = {
    mailbox: f.worker.mailbox,
    contract: f.worker.contract,
    result: { childRunRefs: f.roles.snapshot().childRunRefs },
    assertOwner() {},
  };
  const usage = measureExecutionUsage(context, { expectedRuns: launches });
  assert.equal(usage.totals.total, 15); // Worker 10 + prior successful leaf 5; no phantom session.
  assert.equal(usage.sources.length, 2);
  assert.equal(usage.sources.filter((s) => s.kind === "leaf").length, 1);
  await assert.rejects(f.spawn(), /not running/);
  f.orchestrator.requestCancel(f.prepared.executionId, "native startup failed");
  f.worker.processControls();
  const recovered = new RoleController({
    runtime: f.worker,
    rpc: f.roles.rpc,
    cwd: f.root,
  });
  assert.equal((await recovered.stopAll()).unresolvedRunCount, 0);
  assert.equal(bus.count(), 1);
  f.worker.confirmCancelled(0);
  assert.equal(f.worker.state, "CANCELLED");
  let closures = 0;
  f.orchestrator.herdr = {
    closeIdle(paneId) {
      closures++;
      return { paneId, disposition: "closed" };
    },
  };
  const reconciled = f.orchestrator.reconcile(f.prepared.executionId);
  assert.equal(reconciled.execution.state, "CANCELLED");
  assert.equal(reconciled.execution.reservationOpen, false);
  assert.equal(
    f.orchestrator.reconcile(f.prepared.executionId).disposition,
    "already-cancelled",
  );
  assert.equal(closures, 1);
  // Native temp status may be gone after cleanup; the existing SHA-bound
  // cancellation capture must still support historical accounting.
  fs.rmSync(failed.asyncDir, { recursive: true });
  const closed = measureClosedExecutionUsage({
    ...context,
    execution: f.orchestrator.ledger.getExecution(f.prepared.executionId),
    ownerSessionId: "owner-1",
    assertStopped() {},
  });
  assert.equal(closed.totals.total, 15);
});

test("unproven or mismatched no-start replies remain unknown, not zero-usage failures", async (t) => {
  const mutations = [
    (s) => {
      s.processTerminal.reason = undefined;
    },
    (s) => {
      s.pid = 12345;
    },
    (s) => {
      s.runId = "different-run";
    },
    (s) => {
      s.sessionId = "different-owner";
    },
    (s) => {
      s.sessionRoot = "/different-task";
    },
    (s) => {
      s.steps[0].sessionFile = "/some/session.jsonl";
    },
    (s) => {
      s.steps[0].status = "running";
    },
    (s) => {
      s.steps[0].children = [{ state: "running" }];
    },
  ];
  for (const mutateStatus of mutations)
    await t.test(String(mutateStatus), async (t) => {
      const f = meteredWorker(t),
        bus = failingNativeBus({ mutateStatus });
      f.roles.rpc = new SubagentsRpcClient(bus);
      await assert.rejects(f.spawn(), /unknown/);
      cancelWorker(f);
      const recovered = new RoleController({
        runtime: f.worker,
        rpc: f.roles.rpc,
        cwd: f.root,
      });
      assert.equal((await recovered.stopAll()).unresolvedRunCount, 1);
      assert.throws(() => f.worker.confirmCancelled(0), /durable unresolved/);
      assert.equal(bus.count(), 1);
    });
});

test("D7 an ambiguous spawn stays unresolved after reconstruction", async (t) => {
  const f = meteredWorker(t);
  f.roles.rpc = {
    async request() {
      throw new Error("spawn timeout");
    },
  };
  await assert.rejects(f.spawn(), /unknown/);
  cancelWorker(f);
  const recovered = new RoleController({
    runtime: f.worker,
    rpc: f.rpc,
    cwd: f.root,
  });
  assert.equal((await recovered.stopAll()).unresolvedRunCount, 1);
  assert.throws(() => f.worker.confirmCancelled(0), /durable unresolved/);
  assert.equal(f.calls.length, 0);
});

test("public Worker schemas match exclusive spawn shapes and execution-relative evidence", async () => {
  const tools = new Map();
  teamsWorker({ registerTool: (tool) => tools.set(tool.name, tool), on() {} });
  const { createJiti } = createRequire(
    path.join(os.homedir(), ".pi/agent/npm/package.json"),
  )("jiti");
  const loader = createJiti(
    fs.realpathSync(process.execPath.replace(/\/node$/, "/pi")),
  );
  const { validateToolArguments } = await loader.import(
    "@earendil-works/pi-ai",
  );
  const validate = (tool, args) =>
    validateToolArguments(tool, {
      type: "toolCall",
      id: "schema-regression",
      name: tool.name,
      arguments: args,
    });
  const spawn = tools.get("team_role_spawn");
  const single = {
    role: "team.implementer",
    task: "Bounded work",
    mode: "mutation",
    max_tokens: 500000,
  };
  const wave = {
    key: "wave",
    reason: "Independent work",
    runs: [{ ...single, key: "writer", isolation: "worktree" }],
  };
  for (const args of [single, wave])
    assert.deepEqual(validate(spawn, args), args);
  for (const extra of [
    { reason: "The recorded failing single request" },
    { key: "wrong" },
    { runs: wave.runs },
  ]) {
    assert.throws(
      () => validate(spawn, { ...single, ...extra }),
      /Validation failed/,
    );
  }
  for (const key of Object.keys(single))
    assert.throws(
      () => validate(spawn, { ...wave, [key]: single[key] }),
      /Validation failed/,
    );
  const oldParameters = structuredClone(spawn.parameters);
  oldParameters.oneOf.forEach((branch) => delete branch.not);
  assert.doesNotThrow(() =>
    validate(
      { ...spawn, parameters: oldParameters },
      { ...single, reason: "Previously admitted by public schema" },
    ),
  );
  const result = tools.get("team_task_result");
  assert.match(
    result.parameters.properties.outcome.description,
    /candidate\/handoff is ready for host verification, NOT accepted/,
  );
  assert.match(
    result.parameters.properties.outcome.description,
    /pending gates alone are not blocked/,
  );
  assert.match(
    result.parameters.properties.criterionResults.items.properties.status
      .description,
    /indeterminate for untested host-check behavior/,
  );
  const args = {
    resultRevision: 1,
    outcome: "ready_for_acceptance",
    summary: "Candidate only",
    criterionResults: [
      {
        criterionId: "criterion-1",
        status: "indeterminate",
        observation: "Pending host",
        evidenceIds: [],
      },
    ],
    evidence: [],
    risks: [],
    usage: { inputTokens: null, outputTokens: null },
  };
  assert.deepEqual(validate(result, args), args);
  for (const uri of [
    "receipts/proof.json",
    "worker-sessions/subagent-artifacts/file.patch",
    ".visible/file",
  ]) {
    assert.doesNotThrow(() =>
      validate(result, {
        ...args,
        evidence: [
          {
            evidenceId: "proof",
            kind: "fixture",
            uri,
            sha256: "a".repeat(64),
            producedBy: "worker",
          },
        ],
      }),
    );
  }
  for (const uri of [
    "/old/file.patch",
    "../old/file.patch",
    "a/../file",
    "a/./file",
    "a//file",
    "a/",
    "",
    "a\\..\\file",
    "a\\\\file",
  ]) {
    assert.throws(
      () =>
        validate(result, {
          ...args,
          evidence: [
            {
              evidenceId: "proof",
              kind: "fixture",
              uri,
              sha256: "a".repeat(64),
              producedBy: "worker",
            },
          ],
        }),
      /Validation failed/,
      uri,
    );
  }
});

test("L0-authored task scope and context refs reach the Worker without a patch or fixture-specific objective", (t) => {
  const contextRefs = [
    { uri: "README.md", sha256: bytesDigest(Buffer.from("baseline\n")) },
  ];
  const objective =
    "Reject invalid records with an actionable error while preserving valid input behavior.";
  const f = runningWorker(
    {
      review: {
        authority: "l0-source-bound",
        allowedRoles: ["team.reviewer"],
        allowedTools: ["read"],
      },
    },
    {
      objective,
      contextRefs,
      allowedWritePaths: ["src/index.js"],
    },
  );
  t.after(() => {
    f.orchestrator.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  assert.deepEqual(f.worker.contract.contextRefs, contextRefs);
  const prompt = f.worker.taskPrompt();
  assert.ok(prompt.includes(objective));
  assert.ok(prompt.includes(f.root));
  assert.match(prompt, /Source paths.*src/);
  assert.match(prompt, /Allowed writes.*src\/index\.js/);
  assert.deepEqual(
    JSON.parse(prompt.match(/Context refs[^\n]*?: (\[.*\])\. Read/)[1]),
    contextRefs,
  );
  assert.doesNotMatch(
    prompt,
    /see task specification|specification file named in the objective/,
  );
  assert.doesNotMatch(
    prompt,
    /approved.patch|Todo|G1|team_task_dispatch|create_goal/,
  );
  assert.ok(Buffer.byteLength(prompt) <= 6144);
});

test("prepared C3 candidate objective survives the actual Task mailbox and Worker prompt without L0 control instructions", (t) => {
  const objective = fs
    .readFileSync(
      new URL("../e2e/c3-task-objective.txt", import.meta.url),
      "utf8",
    )
    .replaceAll(
      "{{patchPath}}",
      "/home/timmypai/apps/task-pi-todo-c3-20260914-r14/.git/task-pi-approved.patch",
    )
    .replaceAll("{{patchSha256}}", "a".repeat(64));
  const f = runningWorker(
    {
      review: {
        authority: "l0-source-bound",
        allowedRoles: ["team.reviewer"],
        allowedTools: ["read"],
      },
      maxTaskTokens: 5_000_000,
    },
    { objective },
  );
  t.after(() => {
    f.orchestrator.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  assert.equal(f.worker.contract.objective, objective);
  const prompt = f.worker.taskPrompt();
  assert.ok(Buffer.byteLength(prompt) <= 6 * 1024);
  assert.match(
    prompt,
    /\/task-pi-todo-c3-20260914-r14\/\.git\/task-pi-approved\.patch/,
  );
  assert.match(
    f.worker.contract.objective,
    /team\.implementer with max_tokens=500000/,
  );
  assert.equal(f.worker.contract.policy.maxTaskTokens, 5_000_000);
  assert.ok(prompt.includes("a".repeat(64)));
  assert.match(prompt, /pipe it to node --check on stdin/);
  assert.doesNotMatch(
    prompt,
    /Create exactly one|create_goal|spec_path|team_task_dispatch|\{\{patch/,
  );
});

test("Worker evidence keeps exact-byte verification and accepts a correctly paired current file", (t) => {
  const f = runningWorker({
    review: {
      authority: "l0-source-bound",
      allowedRoles: ["team.reviewer"],
      allowedTools: ["read"],
    },
  });
  t.after(() => {
    f.orchestrator.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const prompt = f.worker.taskPrompt();
  assert.match(
    prompt,
    /seal outcome=ready_for_acceptance when only L0 gates remain/,
  );
  assert.match(
    prompt,
    /untested host-check criteria indeterminate, even if static checks passed/,
  );
  assert.match(prompt, /outcome=blocked.*concrete impediment/);
  assert.match(prompt, /Report correction ceiling: 1/);
  assert.match(
    prompt,
    /includes Worker usage, all role allocations and final review/,
  );
  assert.match(prompt, /not a leaf quota/);
  assert.match(prompt, /Audit rejection is not product-failure proof/);
  assert.match(prompt, /never resume a Goal or reopen a terminal execution/);
  const noRepair = new WorkerRuntime({
    executionRoot: f.prepared.executionRoot,
  });
  noRepair.contract = {
    ...noRepair.contract,
    policy: { ...noRepair.contract.policy, maxReportRepairs: 0 },
  };
  assert.match(noRepair.taskPrompt(), /Report correction ceiling: 0/);
  const source = f.worker.captureSource(1);
  const bytes = Buffer.from(JSON.stringify({ patchHash: "a".repeat(64) }));
  fs.writeFileSync(
    path.join(f.prepared.executionRoot, "receipts/proof.json"),
    bytes,
  );
  const input = {
    schemaVersion: "teams-task-result/1",
    identity: f.worker.contract.identity,
    requestDigest: f.worker.bootstrap.requestDigest,
    resultRevision: 1,
    outcome: "ready_for_acceptance",
    summary: "Candidate awaits host checks",
    source,
    criterionResults: [
      {
        criterionId: "criterion-1",
        status: "indeterminate",
        observation: "Host pending",
        evidenceIds: ["proof"],
      },
    ],
    evidence: [
      {
        evidenceId: "proof",
        kind: "fixture",
        uri: "receipts/proof.json",
        sha256: "a".repeat(64),
        producedBy: "worker",
        sourceDigest: source.sourceDigest,
      },
    ],
    childRunRefs: [],
    unresolvedRunCount: 0,
    risks: [],
    usage: { inputTokens: null, outputTokens: null },
  };
  assert.throws(() => f.worker.sealResult(input), /evidence changed/);
  assert.deepEqual(f.worker.mailbox.listResults(), []);
  const pendingOnly = {
    ...input,
    evidence: [],
    criterionResults: input.criterionResults.map((row) => ({
      ...row,
      evidenceIds: [],
    })),
  };
  assert.doesNotThrow(() =>
    validateTaskResult(
      pendingOnly,
      f.worker.contract,
      f.worker.bootstrap.requestDigest,
    ),
  );
  input.evidence[0].sha256 = bytesDigest(bytes);
  assert.equal(f.worker.sealResult(input).state, "QUIESCENT");
  assert.equal(f.worker.mailbox.listResults().length, 1);
});

test("D7 persisted cancellation rejects a late result before publication", (t) => {
  const f = meteredWorker(t);
  cancelWorker(f, false);
  assert.throws(() => f.worker.captureSource(1), /not running/);
  assert.throws(() => f.worker.sealResult({}), /not accepting results/);
  assert.deepEqual(f.worker.mailbox.listResults(), []);
  assert.equal(f.calls.length, 0);
});
