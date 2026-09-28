import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Mailbox } from "./mailbox.mjs";
import { readRoleLifecycle } from "./role-lifecycle.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_GOALS = 64;
const MAX_TASKS = 256;
const MAX_EVENTS = 1024;

function regularJson(file, limit = 1024 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(stat.isFile() && stat.size <= limit, "bounded regular evidence required");
    const bytes = Buffer.alloc(stat.size + 1);
    assert.equal(fs.readSync(fd, bytes, 0, bytes.length, 0), stat.size);
    assert.equal(fs.fstatSync(fd).size, stat.size);
    return JSON.parse(bytes.subarray(0, stat.size).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function fileExists(file) {
  try {
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile(), "expected regular evidence file");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Goal-X's versioned on-disk first object is authoritative for persisted task
// status. A buffered in-turn update may not yet be on disk: mark its freshness.
// Do not import Goal-X's private in-memory core or create a second Goal writer.
export function readGoalSummary(sourceRoot, goalId) {
  assert.match(goalId, ID);
  const root = path.join(sourceRoot, ".pi", "goals");
  if (!fs.existsSync(root)) return { status: "unavailable", tasks: [], reason: "Goal-X storage absent" };
  assert.ok(fs.lstatSync(root).isDirectory(), "Goal-X directory must not be a symlink");
  const files = fs.readdirSync(root).filter((name) => /^active_goal_[A-Za-z0-9._-]+\.md$/.test(name));
  assert.ok(files.length <= MAX_GOALS, "Goal-X inventory exceeds display bound");
  for (const name of files) {
    const file = path.join(root, name);
    let text;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      assert.ok(stat.isFile() && stat.size <= 1024 * 1024, "bounded Goal-X record required");
      text = fs.readFileSync(fd, "utf8");
      assert.equal(fs.fstatSync(fd).size, stat.size);
    } finally {
      fs.closeSync(fd);
    }
    // Goal-X v3 stores a JSON object followed by human-readable Markdown.
    // Locate its end with JSON string/escape awareness, not a regex over braces.
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) throw new Error("Goal-X record is incomplete");
    const goal = JSON.parse(text.slice(0, end));
    if (goal.id !== goalId) continue;
    assert.equal(goal.version, 3, "unknown Goal-X record version");
    const roots = goal.taskList?.tasks ?? [];
    assert.ok(Array.isArray(roots), "Goal-X task list invalid");
    const tasks = [];
    const pending = roots.map((task) => ({ task, depth: 0 }));
    while (pending.length) {
      const { task, depth } = pending.shift();
      assert.ok(depth <= 16 && tasks.length < MAX_TASKS, "Goal-X task tree exceeds display bound");
      assert.ok(typeof task.id === "string" && typeof task.title === "string", "Goal-X task identity invalid");
      tasks.push({ id: task.id, title: task.title, status: task.status });
      if (task.subtasks !== undefined) {
        assert.ok(Array.isArray(task.subtasks), "Goal-X subtask list invalid");
        pending.push(...task.subtasks.map((child) => ({ task: child, depth: depth + 1 })));
        assert.ok(pending.length + tasks.length <= MAX_TASKS, "Goal-X task tree exceeds display bound");
      }
    }
    return {
      status: goal.status ?? "unknown",
      currentTaskId: goal.currentTaskId ?? null,
      updatedAt: goal.updatedAt ?? null,
      tasks,
    };
  }
  return { status: "unavailable", tasks: [], reason: "Goal-X record not found; may be archived or pending flush" };
}

function roleRows(mailbox, contract, execution) {
  if (!execution.workerSessionId) return [];
  return readRoleLifecycle(mailbox, contract, execution.workerSessionId).map((launch) => {
    let status = launch.terminal ? launch.completion : launch.runId ? "running" : "launching";
    let members = launch.members.map(({ key, role, mode, isolation }) => ({ key, role, mode, isolation, status }));
    // Live status is display-only and never establishes termination. Durable
    // mailbox terminal proof remains the only Task lifecycle authority.
    if (launch.runId && launch.asyncDir) {
      try {
        assert.ok(path.isAbsolute(launch.asyncDir) && ID.test(path.basename(launch.asyncDir)));
        assert.equal(path.basename(launch.asyncDir), launch.runId);
        const native = regularJson(path.join(launch.asyncDir, "status.json"));
        assert.equal(native.runId, launch.runId);
        if (Array.isArray(native.steps) && native.steps.length <= launch.members.length) {
          members = members.map((member) => {
            const step = native.steps.find((row) => row.workflowKey === member.key ||
              (launch.members.length === 1 && row.agent === member.role));
            return step?.agent === member.role ? { ...member, status: step.status ?? status } : member;
          });
        }
      } catch {
        if (!launch.terminal) status = "unobserved";
      }
    }
    return {
      key: launch.waveKey, runId: launch.runId, asyncDir: launch.asyncDir ?? null,
      status, terminal: launch.terminal, stopRequested: launch.stopRequested,
      members,
    };
  });
}

function reviewRows(root) {
  const dir = path.join(root, "integration", "reviews");
  if (!fs.existsSync(dir)) return [];
  assert.ok(fs.lstatSync(dir).isDirectory(), "review directory must not be a symlink");
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  assert.ok(entries.length <= 64, "review inventory exceeds display bound");
  return entries.filter((entry) => entry.isDirectory() && ID.test(entry.name)).map((entry) => {
    const folder = path.join(dir, entry.name);
    let status = "planned", completionRef = null;
    if (fileExists(path.join(folder, "unknown.json"))) status = "unknown";
    else if (fileExists(path.join(folder, "complete.json"))) {
      completionRef = `integration/reviews/${entry.name}/complete.json`;
      const complete = regularJson(path.join(folder, "complete.json"));
      status = complete.verdict ?? complete.status ?? "complete";
    } else if (fileExists(path.join(folder, "started.json"))) status = "running";
    return { key: entry.name, status, completionRef };
  });
}

export function projectTask(orchestrator, execution) {
  const base = {
    goalId: execution.goalId, taskId: execution.taskId, executionId: execution.executionId,
    revision: execution.taskRevision, state: execution.state, reservationOpen: execution.reservationOpen,
    goalCommitState: execution.goalCommitState, paneId: execution.paneId,
    ownerSessionId: execution.ownerSessionId, updatedAt: execution.updatedAt,
    unresolvedRunCount: execution.unresolvedRunCount, waves: [], reviews: [],
    phase: "execution", next: "inspect execution", alerts: [], recentAt: execution.updatedAt,
  };
  try {
    const contract = orchestrator.ledger.getContract(execution.executionId);
    base.taskTokenCeiling = contract.policy.maxTaskTokens;
    const root = path.join(orchestrator.runtimeRoot, "projects", execution.projectId, "executions", execution.executionId);
    const mailbox = Mailbox.open(root, execution.executionId);
    const events = mailbox.listEvents();
    assert.ok(events.length <= MAX_EVENTS, "event inventory exceeds display bound");
    const last = events.at(-1);
    if (last) {
      assert.equal(mailbox.digestRelative(last.payloadRef), last.payloadDigest);
      const payload = mailbox.readJson(last.payloadRef, 16 * 1024);
      base.recentAt = payload.recordedAt ?? execution.updatedAt;
      if (last.type === "failed") base.alerts.push("Worker admission failed; reconcile exact evidence");
    }
    base.waves = roleRows(mailbox, contract, execution);
    base.reviews = reviewRows(root);
    if (base.waves.some((wave) => wave.status === "unobserved")) base.alerts.push("Native role status unobservable; no inferred success");
    if (base.waves.some((wave) => wave.status === "failed" || wave.status === "stopped")) base.alerts.push("Role failed or stopped; diagnose before repair");
    const reviewBlocked = base.reviews.some((review) => ["blocked", "unknown"].includes(review.status));
    if (reviewBlocked) base.alerts.push("Review blocked or unknown; inspect findings");
    if (execution.state === "ACCEPTED") {
      base.phase = execution.goalCommitState === "committed" ? "complete" : "goal-readback";
      base.next = execution.goalCommitState === "committed" ? "accepted; no further action" : "verify Goal-X task readback";
    } else if (["CANCELLED", "FAILED", "REJECTED", "UNKNOWN"].includes(execution.state)) {
      base.phase = "reconcile";
      base.next = "inspect failure/owner evidence; do not replay";
      base.alerts.push(`Execution ${execution.state}; not accepted`);
    } else if (reviewBlocked) {
      base.phase = "review-blocked"; base.next = "inspect complete findings; no seal or acceptance";
    } else if (base.reviews.some((review) => review.status === "running")) {
      base.phase = "independent-review"; base.next = "await exact native review completion";
    } else if (base.reviews.some((review) => review.status === "pass")) {
      const sealed = fileExists(path.join(root, "integration", "review-candidate.json"));
      const applyRoot = path.join(root, "integration", "target-apply");
      const applied = fileExists(path.join(applyRoot, "apply-receipt.json"));
      const planned = fileExists(path.join(applyRoot, "plan.json"));
      if (!sealed) {
        base.phase = "review-passed"; base.next = "seal the complete PASS review set before target planning";
      } else if (contract.policy.integrationMode !== "approved-integration") {
        base.phase = "final-checks"; base.next = "verify final host checks and AcceptanceReceipt";
      } else if (applied) {
        base.phase = "target-applied"; base.next = "read applied review, run final target checks, then accept";
      } else if (planned) {
        base.phase = "awaiting-confirmation"; base.next = "inspect immutable target plan; request separate per-plan user confirmation";
      } else {
        base.phase = "target-plan"; base.next = "prepare and inspect exact target apply plan";
      }
    } else if (fileExists(path.join(root, "integration", "receipt.json"))) {
      const staged = regularJson(path.join(root, "integration", "receipt.json"));
      base.phase = "staged";
      base.next = staged.status === "checks-passed" ? "independent source-bound review" : "complete staged checks then review";
    } else if (execution.state === "RESULT_READY") {
      base.phase = "candidate"; base.next = "stage isolated candidate; not yet accepted";
    } else if (base.waves.some((wave) => !wave.terminal)) {
      base.phase = "roles"; base.next = "await native wave terminal proof";
    } else if (execution.state === "RUNNING") {
      base.phase = "worker"; base.next = "Worker preparing next role or candidate";
    }
    const lastEvidence = Date.parse(base.recentAt);
    if (execution.state === "RUNNING" && Number.isFinite(lastEvidence) &&
        Date.now() - lastEvidence > 15 * 60 * 1000)
      base.alerts.push("No durable progress for 15m; inspect native state (advisory, not hang/timeout proof)");
    return base;
  } catch (error) {
    return { ...base, phase: "unobservable", next: "inspect bound evidence; do not infer completion",
      alerts: [...base.alerts, `Projection unavailable: ${String(error.message ?? error).slice(0, 180)}`] };
  }
}

export function projectGoal(orchestrator, { projectId, goalId, sourceRoot, ownerSessionId }) {
  assert.match(projectId, ID);
  assert.match(goalId, ID);
  const executions = orchestrator.ledger.listGoalLatest(projectId, goalId);
  assert.ok(executions.length <= MAX_TASKS, "Task inventory exceeds display bound");
  let goal;
  try { goal = readGoalSummary(sourceRoot, goalId); }
  catch (error) { goal = { status: "unavailable", tasks: [], reason: String(error.message ?? error).slice(0, 180) }; }
  const tasks = executions.map((execution) => ({
    ...projectTask(orchestrator, execution),
    ownership: execution.ownerSessionId === ownerSessionId ? "owned" : "read-only",
  }));
  for (const task of goal.tasks) {
    if (!tasks.some((row) => row.taskId === task.id)) tasks.push({
      goalId, taskId: task.id, executionId: null, state: task.status,
      phase: "goal-only", next: "no Task Pi execution", alerts: [], waves: [], reviews: [],
      ownership: "read-only", title: task.title,
    });
  }
  assert.ok(tasks.length <= MAX_TASKS, "Combined Goal-X / Task Pi inventory exceeds display bound");
  return { goalId, goal, tasks, capturedAt: new Date().toISOString() };
}
