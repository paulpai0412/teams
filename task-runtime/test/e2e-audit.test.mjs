import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import {
  auditRpcAttempt,
  verifyGoalReadback,
} from "../e2e/audit-rpc-attempt.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const repo = path.resolve(import.meta.dirname, "../..");
const live = path.join(
  repo,
  "goal-team-evidence",
  "task-runtime-g1-prospective-20260924-r7",
  "live",
  "rpc-observation.json",
);
const store = path.join(os.homedir(), ".pi", "agent", "teams-task-runtime-v1");
const nativeAvailable =
  fs.existsSync(live) && fs.existsSync(path.join(store, "ledger.sqlite"));
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teams-e2e-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function command(file, args) {
  return spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

// These tests need no installed private runtime and cannot fabricate a PASS.
test("Goal readback needs complete tasks, exact receipt evidence and completion events", () => {
  const proofs = [{ taskId: "todo-app", acceptanceId: "accept-1" }];
  const goal = {
    id: "goal-1",
    status: "complete",
    taskList: {
      tasks: [
        {
          id: "todo-app",
          status: "complete",
          evidence: "task-runtime:accept-1",
        },
      ],
    },
  };
  const events = [
    {
      type: "task_complete",
      taskId: "todo-app",
      evidence: "task-runtime:accept-1",
    },
    { type: "goal_completed", goalId: "goal-1" },
  ];
  assert.doesNotThrow(() => verifyGoalReadback(goal, events, proofs, "goal-1"));
  for (const changed of [
    { ...goal, status: "paused" },
    {
      ...goal,
      taskList: {
        tasks: [
          {
            id: "todo-app",
            status: "in_progress",
            evidence: "task-runtime:accept-1",
          },
        ],
      },
    },
    {
      ...goal,
      taskList: {
        tasks: [
          {
            id: "todo-app",
            status: "complete",
            evidence: "task-runtime:foreign",
          },
        ],
      },
    },
    { ...goal, taskList: { tasks: [] } },
  ])
    assert.throws(() => verifyGoalReadback(changed, events, proofs, "goal-1"));
  assert.throws(() =>
    verifyGoalReadback(goal, events.slice(0, 1), proofs, "goal-1"),
  );
  assert.throws(() =>
    verifyGoalReadback(goal, events.slice(1), proofs, "goal-1"),
  );
});
test("captured transport without native Task evidence is not an audit verdict", (t) => {
  const dir = temporary(t);
  const file = path.join(dir, "rpc-observation.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      status: "captured",
      acceptance: "not-assessed",
      stopReason: "goal-complete",
      processReaped: true,
      exitCode: 0,
      signal: null,
      goal: { id: "g", status: "complete" },
      taskDrain: { settled: true },
      history: {
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      parent: {
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      taskUsage: {
        status: "measured",
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      rootUsage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
      reportedTokens: 1,
      maxTokens: 10,
      executionIds: [],
    }),
  );
  const audit = auditRpcAttempt(file, dir);
  assert.equal(audit.decision, "blocked");
  assert.equal(audit.fullE2EPassed, false);
  assert.match(audit.reason, /native Task executions required/);
  const cli = command(
    path.join(repo, "task-runtime/e2e/audit-rpc-attempt.mjs"),
    [file, path.join(dir, "main-audit.json"), dir],
  );
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "main-audit.json"))).decision,
    "blocked",
  );
});

test("summary does not promote observer capture or a forged audit", (t) => {
  const dir = temporary(t);
  const runRoot = path.join(dir, "attempt");
  fs.mkdirSync(path.join(runRoot, "live"), { recursive: true });
  const report = path.join(runRoot, "live", "rpc-observation.json");
  fs.writeFileSync(
    report,
    JSON.stringify({
      status: "captured",
      acceptance: "not-assessed",
      elapsedMs: 123,
      rootUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      taskUsage: {
        status: "measured",
        totals: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3 },
      },
      executionIds: ["not-native"],
    }),
  );
  const reporter = path.join(repo, "task-runtime/e2e/report-runs.mjs");
  const first = command(reporter, [dir]);
  assert.equal(first.status, 0, first.stderr);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json")));
  assert.equal(summary.fullE2EPassed, false);
  assert.equal(summary.runs[0].status, "not-assessed");
  assert.equal(summary.runs[0].harnessStatus, "captured");
  assert.equal(summary.knownRunTokens.total, 5);
  fs.writeFileSync(
    path.join(runRoot, "main-audit.json"),
    JSON.stringify({
      schemaVersion: "teams-e2e-main-audit/1",
      decision: "accepted",
      fullE2EPassed: true,
      runtimeRoot: dir,
    }),
  );
  const forged = command(reporter, [dir]);
  assert.notEqual(forged.status, 0);
  assert.match(forged.stderr, /native audit no longer matches/);
});

test("sealed native r7 readback accepts only a new observer-shaped copy", {
  skip: !nativeAvailable && "optional local native corpus unavailable",
}, (t) => {
  const dir = temporary(t);
  const before = hash(fs.readFileSync(live));
  const historical = auditRpcAttempt(live, store);
  assert.equal(historical.decision, "blocked");
  assert.match(historical.reason, /transport not captured/);
  const runRoot = path.join(dir, "attempt");
  fs.mkdirSync(path.join(runRoot, "live"), { recursive: true });
  fs.copyFileSync(
    path.join(path.dirname(live), "admission.json"),
    path.join(runRoot, "live", "admission.json"),
  );
  const original = JSON.parse(fs.readFileSync(live, "utf8"));
  const input = { ...original, status: "captured", acceptance: "not-assessed" };
  delete input.fullE2EPassed;
  const report = path.join(runRoot, "live", "rpc-observation.json");
  fs.writeFileSync(report, JSON.stringify(input));
  const accepted = auditRpcAttempt(report, store);
  assert.equal(accepted.decision, "accepted", accepted.reason);
  assert.equal(accepted.evidence.executions.length, 1);
  for (const [change, reason] of [
    [
      (item) => {
        item.taskDrain.settled = false;
      },
      /owner drain incomplete/,
    ],
    [
      (item) => {
        item.executionIds = [];
      },
      /native Task executions required/,
    ],
    [
      (item) => {
        item.taskUsage.totals.input--;
        item.taskUsage.totals.total--;
        item.reportedTokens--;
      },
      /Task usage differs/,
    ],
    [
      (item) => {
        item.goal.id = "foreign";
      },
      /Goal identity changed/,
    ],
    [
      (item) => {
        item.maxTokens--;
      },
      /admission maxTokens changed/,
    ],
    [
      (item) => {
        item.status = "incomplete";
      },
      /transport not captured/,
    ],
  ]) {
    const invalid = structuredClone(input);
    change(invalid);
    fs.writeFileSync(report, JSON.stringify(invalid));
    const blocked = auditRpcAttempt(report, store);
    assert.equal(blocked.decision, "blocked");
    assert.match(blocked.reason, reason);
  }
  fs.writeFileSync(report, JSON.stringify(input));
  const output = path.join(runRoot, "main-audit.json");
  const auditor = path.join(repo, "task-runtime/e2e/audit-rpc-attempt.mjs");
  const first = command(auditor, [report, output, store]);
  assert.equal(first.status, 0, first.stderr);
  const second = command(auditor, [report, output, store]);
  assert.notEqual(second.status, 0, "audit cannot overwrite prior evidence");
  assert.equal(JSON.parse(fs.readFileSync(output)).fullE2EPassed, true);
  const reporter = command(
    path.join(repo, "task-runtime/e2e/report-runs.mjs"),
    [dir],
  );
  assert.equal(reporter.status, 0, reporter.stderr);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "summary.json"))).fullE2EPassed,
    true,
  );
  fs.writeFileSync(report, JSON.stringify({ ...input, status: "incomplete" }));
  const stale = command(path.join(repo, "task-runtime/e2e/report-runs.mjs"), [
    dir,
  ]);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /native audit no longer matches/);
  assert.equal(
    hash(fs.readFileSync(live)),
    before,
    "original observation was changed",
  );
});

test("missing receipt and open reservation block a copied native ledger", {
  skip: !nativeAvailable && "optional local native corpus unavailable",
}, async (t) => {
  const dir = temporary(t);
  const input = JSON.parse(fs.readFileSync(live, "utf8"));
  input.status = "captured";
  input.acceptance = "not-assessed";
  delete input.fullE2EPassed;
  const report = path.join(dir, "observation.json");
  fs.writeFileSync(report, JSON.stringify(input));
  fs.copyFileSync(
    path.join(path.dirname(live), "admission.json"),
    path.join(dir, "admission.json"),
  );
  const projectId = "p-9650c9e0b35f797005862093ad69313f";
  const executionId = input.executionIds[0];
  const copied = path.join(dir, "runtime");
  const executionRelative = path.join(
    "projects",
    projectId,
    "executions",
    executionId,
  );
  fs.mkdirSync(path.dirname(path.join(copied, executionRelative)), {
    recursive: true,
  });
  fs.cpSync(
    path.join(store, executionRelative),
    path.join(copied, executionRelative),
    {
      recursive: true,
    },
  );
  const nativeDb = new DatabaseSync(path.join(store, "ledger.sqlite"), {
    readOnly: true,
  });
  try {
    await backup(nativeDb, path.join(copied, "ledger.sqlite")); // Include WAL frames.
  } finally {
    nativeDb.close();
  }
  const db = new DatabaseSync(path.join(copied, "ledger.sqlite"));
  try {
    db.prepare("DELETE FROM acceptances WHERE execution_id = ?").run(
      executionId,
    );
  } finally {
    db.close();
  }
  const noReceipt = auditRpcAttempt(report, copied);
  assert.equal(noReceipt.decision, "blocked");
  assert.match(noReceipt.reason, /native acceptance missing/);
  const db2 = new DatabaseSync(path.join(copied, "ledger.sqlite"));
  try {
    db2
      .prepare(
        "UPDATE executions SET reservation_open = 1 WHERE execution_id = ?",
      )
      .run(executionId);
  } finally {
    db2.close();
  }
  const open = auditRpcAttempt(report, copied);
  assert.equal(open.decision, "blocked");
  assert.match(
    open.reason,
    /project remains open|historical execution is not closed/,
  );
});
