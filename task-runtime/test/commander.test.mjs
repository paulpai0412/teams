import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { Mailbox } from "../mailbox.mjs";
import { projectGoal, projectTask, readGoalSummary } from "../commander-projection.mjs";
import { CommanderPanel, actionGuide, openCommander } from "../../extensions/teams-orchestrator/commander-panel.mjs";
import { HerdrPort } from "../herdr-port.mjs";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-commander-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, "runtime");
  const projectId = "p-fixture", goalId = "goal-fixture", executionId = "00000000-0000-4000-8000-000000000001";
  const mailbox = Mailbox.create(runtimeRoot, projectId, executionId);
  const execution = {
    projectId, goalId, taskId: "auth", executionId, taskRevision: 1,
    ownerSessionId: "owner-1", state: "RUNNING", goalCommitState: "not_requested",
    reservationOpen: true, paneId: "w1:p2", unresolvedRunCount: 0,
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const contract = { policy: { integrationMode: "verify-only", maxTaskTokens: 1000 }, identity: { executionId } };
  const orchestrator = {
    runtimeRoot,
    ledger: {
      getContract: (id) => { assert.equal(id, executionId); return contract; },
      listGoalLatest: () => [execution],
    },
  };
  return { root, runtimeRoot, projectId, goalId, executionId, mailbox, execution, contract, orchestrator };
}

function goalRecord(f, tasks) {
  const dir = path.join(f.root, ".pi", "goals");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "active_goal_fixture.md"),
    `${JSON.stringify({ version: 3, id: f.goalId, status: "active", updatedAt: "2026-01-01", currentTaskId: "auth", taskList: { tasks } })}\n\n# Goal Prompt\n`);
}

test("Commander joins focused Goal-X tasks with latest Task Pi without creating state", (t) => {
  const f = setup(t);
  goalRecord(f, [
    { id: "auth", title: "Auth", status: "pending" },
    { id: "docs", title: "Documentation", status: "pending" },
  ]);
  assert.equal(readGoalSummary(f.root, f.goalId).currentTaskId, "auth");
  const board = projectGoal(f.orchestrator, { projectId: f.projectId, goalId: f.goalId, sourceRoot: f.root, ownerSessionId: "owner-1" });
  assert.equal(board.goal.status, "active");
  assert.deepEqual(board.tasks.map((task) => task.taskId), ["auth", "docs"]);
  assert.equal(board.tasks[0].phase, "worker");
  assert.equal(board.tasks[0].ownership, "owned");
  assert.equal(board.tasks[1].phase, "goal-only");
  assert.equal(fs.existsSync(path.join(f.mailbox.root, "receipts", "progress-commander.json")), false);
});

test("Candidate, staged check, review and final Goal readback remain distinct", (t) => {
  const f = setup(t);
  f.execution.state = "RESULT_READY";
  assert.equal(projectTask(f.orchestrator, f.execution).phase, "candidate");
  const integration = path.join(f.mailbox.root, "integration");
  fs.mkdirSync(integration);
  fs.writeFileSync(path.join(integration, "receipt.json"), '{"status":"checks-passed"}');
  assert.equal(projectTask(f.orchestrator, f.execution).phase, "staged");
  const review = path.join(integration, "reviews", "review-1");
  fs.mkdirSync(review, { recursive: true });
  fs.writeFileSync(path.join(review, "started.json"), "{}");
  assert.equal(projectTask(f.orchestrator, f.execution).phase, "independent-review");
  fs.writeFileSync(path.join(review, "complete.json"), '{"verdict":"blocked"}');
  const blocked = projectTask(f.orchestrator, f.execution);
  assert.ok(blocked.alerts.some((alert) => /Review blocked/.test(alert)));
  assert.notEqual(blocked.phase, "complete");
  f.execution.state = "ACCEPTED";
  assert.equal(projectTask(f.orchestrator, f.execution).phase, "goal-readback");
  f.execution.goalCommitState = "committed";
  assert.equal(projectTask(f.orchestrator, f.execution).phase, "complete");
});

test("Invalid evidence fails visibly rather than counting as progress", (t) => {
  const f = setup(t);
  fs.mkdirSync(path.join(f.mailbox.root, "integration"));
  fs.writeFileSync(path.join(f.mailbox.root, "integration", "receipt.json"), "invalid");
  f.execution.state = "RESULT_READY";
  const status = projectTask(f.orchestrator, f.execution);
  assert.equal(status.phase, "unobservable");
  assert.match(status.alerts[0], /Projection unavailable/);
  f.execution.state = "CANCELLED";
  assert.match(actionGuide({ ...status, ownership: "read-only" }), /does not own/);
});

test("Goal-X symlink and blocked review cannot be presented as success", (t) => {
  const f = setup(t);
  goalRecord(f, [{ id: "auth", title: "Auth", status: "pending" }]);
  const goalFile = path.join(f.root, ".pi", "goals", "active_goal_fixture.md");
  fs.unlinkSync(goalFile);
  const outside = path.join(f.root, "outside-goal.md");
  fs.writeFileSync(outside, `${JSON.stringify({ version: 3, id: f.goalId, status: "complete" })}\n`);
  fs.symlinkSync(outside, goalFile);
  const reviewDir = path.join(f.mailbox.root, "integration", "reviews", "review-one");
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(path.join(reviewDir, "complete.json"), JSON.stringify({ verdict: "blocked" }));
  const view = projectGoal(f.orchestrator, {
    projectId: f.projectId, goalId: f.goalId, sourceRoot: f.root, ownerSessionId: "owner-1",
  });
  assert.equal(view.goal.status, "unavailable");
  assert.equal(view.tasks[0].phase, "review-blocked");
  assert.match(view.tasks[0].reviews[0].completionRef, /review-one\/complete\.json$/);
  assert.match(actionGuide(view.tasks[0]), /BLOCKED/);
});

test("Herdr navigation uses returned workspace identity, never a derived pane prefix", () => {
  const calls = [];
  const port = Object.create(HerdrPort.prototype);
  port.status = (id) => ({ result: { pane: { pane_id: id, workspace_id: "wActual" } } });
  port.run = (args) => { calls.push(args); return {}; };
  assert.deepEqual(port.focusWorkspaceForPane("wFake:p9"), { workspaceId: "wActual", paneId: "wFake:p9" });
  assert.deepEqual(calls, [["workspace", "focus", "wActual"]]);
  assert.throws(() => port.focusWorkspaceForPane("not-a-pane"), /valid Herdr pane/);
});

test("Shortcut target opens in TUI without waiting for model idle or focused Goal", async (t) => {
  const f = setup(t);
  f.orchestrator.ledger.listProjectOpen = () => [f.execution];
  const bus = new EventEmitter();
  bus.on("subagents:rpc:v1:request", (request) => {
    bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1, requestId: request.requestId, success: true,
      data: { fleet: { version: 1, entries: [{ agent: "team.scout" }], omitted: 0 } },
    });
  });
  let seen = null;
  const ctx = {
    mode: "tui", cwd: f.root,
    ui: {
      custom(factory, options) {
        assert.equal(options.overlay, true);
        const panel = factory({ requestRender() {}, terminal: { rows: 30 } }, {}, {}, () => {});
        seen = panel;
        return Promise.resolve();
      },
      notify() {},
    },
  };
  await openCommander(ctx, f.orchestrator, f.projectId, {
    getBranch: () => [], getSessionId: () => "owner-1",
  }, { emit: (...args) => bus.emit(...args), on: (...args) => { bus.on(...args); return () => bus.off(...args); } });
  assert.match(seen.render(100).join("\n"), /unfocused/);
  assert.match(seen.render(100).join("\n"), /auth/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(seen.render(100).join("\n"), /team.scout/);
  t.after(() => seen.dispose());
});

test("Panel opens, updates without model turns and closes its timer", (t) => {
  let renders = 0, closed = 0;
  const panel = new CommanderPanel({ requestRender: () => renders++ }, {}, () => closed++, () => ({
    goalId: "g", goal: { status: "active" }, capturedAt: "now", tasks: [
      { taskId: "a", executionId: "id-a", phase: "roles", state: "RUNNING", ownership: "owned", alerts: [], waves: [], reviews: [], next: "wait" },
      { taskId: "b", executionId: "id-b", phase: "candidate", state: "RESULT_READY", ownership: "owned", alerts: ["needs review"], waves: [], reviews: [], next: "review" },
    ],
  }));
  t.after(() => panel.dispose());
  assert.match(panel.render(80).join("\n"), /AGENT TEAMS COMMANDER/);
  panel.handleInput("j");
  panel.handleInput("a");
  panel.handleInput("h");
  assert.match(panel.render(80).join("\n"), /Guidance/);
  panel.handleInput("\x1b[27;1u"); // Kitty Escape emitted by the actual TUI.
  assert.equal(closed, 1);
  assert.ok(renders >= 3);
});
