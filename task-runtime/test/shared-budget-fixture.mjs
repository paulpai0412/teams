import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TaskOrchestrator } from "../orchestrator.mjs";
import { Mailbox } from "../mailbox.mjs";
import { changeTaskBudget, taskBudgetBinding } from "../task-budget.mjs";

export function budgetFixture(t, ceiling = 1000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-shared-budget-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "a.txt"), "baseline\n");
  for (const args of [
    ["init", "-q"],
    ["add", "a.txt"],
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
    const result = spawnSync("git", ["-C", source, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const baseCommit = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  const orchestrator = new TaskOrchestrator({
    runtimeRoot: path.join(root, "runtime"),
    ownerSessionId: "owner-fixture",
  });
  t.after(() => {
    orchestrator.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const prepared = orchestrator.prepare({
    schemaVersion: "teams-task-runtime/3",
    goalId: "goal-fixture",
    taskId: "task-fixture",
    taskRevision: 1,
    objective: "Exercise shared accounting without a model or live task.",
    nonGoals: ["No network or deployment."],
    workspace: {
      sourceRoot: source,
      worktreePath: null,
      baseCommit,
      sourcePaths: ["a.txt"],
      allowedWritePaths: ["a.txt"],
    },
    criteria: [
      {
        id: "outcome",
        text: "Evidence remains bound.",
        requiredEvidenceKinds: ["host-check"],
      },
    ],
    checks: [
      {
        commandId: "check",
        executable: process.execPath,
        argv: ["--version"],
        cwd: source,
        timeoutMs: 1000,
        expectedExitCode: 0,
        criterionIds: ["outcome"],
      },
    ],
    policy: {
      risk: "low",
      allowedRoles: ["team.implementer", "team.reviewer"],
      maxActiveRoleRuns: 2,
      maxRoleSpawnsPerTask: 5,
      maxProductRepairsPerRole: 0,
      maxReportRepairs: 0,
      maxProcessRestarts: 1,
      maxTaskTokens: ceiling,
      deadlineMs: 60_000,
      integrationMode: "verify-only",
      review: {
        authority: "l0-source-bound",
        allowedRoles: ["team.reviewer"],
        allowedTools: ["read"],
      },
    },
    contextRefs: [],
  });
  assert.equal(
    prepared.contract.policy.tokenBudgetMode,
    "shared",
    "fresh v3 defaults to shared policy",
  );
  const { ledger } = orchestrator;
  ledger.transition(prepared.executionId, "RESERVED", 0, "SPAWNING");
  ledger.bindWorker(prepared.executionId, 1, "worker-fixture");
  ledger.transition(prepared.executionId, "SPAWNING", 2, "RUNNING");
  const context = {
    contract: prepared.contract,
    mailbox: Mailbox.open(prepared.executionRoot, prepared.executionId),
  };
  const workerFile = path.join(
    prepared.executionRoot,
    "worker-sessions/session.jsonl",
  );
  const worker = {
    sessionId: "worker-fixture",
    sessionFile: workerFile,
    used: 0,
  };
  const binding = taskBudgetBinding(context, "worker");
  changeTaskBudget(binding, { type: "bind", ...worker });
  return {
    root,
    source,
    orchestrator,
    ledger,
    prepared,
    context,
    worker,
    binding,
  };
}

export function hookSession(id, cwd, file) {
  const header = { type: "session", version: 3, id, cwd };
  const entries = [];
  const manager = {
    getHeader: () => header,
    getEntries: () => entries,
    getSessionId: () => id,
    getSessionFile: () => file,
  };
  const hooks = new Map(),
    errors = [];
  const ctx = {
    sessionManager: manager,
    model: { contextWindow: 100, maxTokens: 50 },
    abort() {
      errors.push("aborted");
    },
    ui: {
      setStatus(_key, value) {
        errors.push(value);
      },
    },
  };
  const pi = {
    on(name, handler) {
      const rows = hooks.get(name) ?? [];
      rows.push(handler);
      hooks.set(name, rows);
    },
  };
  function addUsage(total, extra = {}) {
    entries.push({
      type: "message",
      id: `message-${entries.length}`,
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: total,
          cacheWrite: 0,
          totalTokens: total,
        },
        ...extra,
      },
    });
  }
  function bytes() {
    return Buffer.from(
      [header, ...entries].map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
  }
  async function emit(name, event = {}) {
    const results = [];
    for (const callback of hooks.get(name) ?? [])
      results.push(await callback(event, ctx));
    return results;
  }
  return { pi, ctx, entries, errors, addUsage, bytes, emit };
}
