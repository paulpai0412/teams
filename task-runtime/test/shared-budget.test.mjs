import assert from "node:assert/strict";
import test from "node:test";
import { createPool, changePool, poolTotals } from "../budget-pool.mjs";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { budgetFixture, hookSession } from "./shared-budget-fixture.mjs";
import {
  installTaskBudgetHooks,
  taskBudgetBinding,
  changeTaskBudget,
  registerTaskBudgetMembers,
  assertTaskBudgetUsage,
  readTaskBudget,
  assertBudgetHook,
  requestAllowance,
} from "../task-budget.mjs";
import { measureSessionBytes } from "../task-usage.mjs";

function launchRequest(binding, operation) {
  return new Promise((resolve, reject) => {
    const code = `import { changeTaskBudget } from ${JSON.stringify(new URL("../task-budget.mjs", import.meta.url).href)}; try { changeTaskBudget(${JSON.stringify(binding)}, ${JSON.stringify(operation)}); console.log("admitted"); } catch(e) { console.log("denied:"+e.message); }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      error = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (error += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error(error)),
    );
  });
}

function pool() {
  const p = createPool("a".repeat(64), 1000, 100);
  changePool(p, {
    type: "register",
    members: [
      { key: "writer", estimate: 120, sessionRoot: "/sessions/writer" },
      { key: "review", estimate: 200, sessionRoot: "/sessions/review" },
    ],
  });
  return p;
}
const identity = {
  key: "writer",
  sessionId: "writer-session",
  sessionFile: "/sessions/writer/session.jsonl",
};

test("soft role estimate grows from shared remainder, retaining sibling reservation and prior costs", () => {
  const p = pool();
  changePool(p, { type: "bind", ...identity });
  changePool(p, { type: "request", ...identity, used: 0, allowance: 230 });
  assert.equal(p.members.writer.hold, 230);
  assert.equal(p.members.review.hold, 200);
  changePool(p, { type: "settle", ...identity, used: 230 });
  changePool(p, { type: "request", ...identity, used: 230, allowance: 250 });
  changePool(p, { type: "settle", ...identity, used: 400 });
  changePool(p, { type: "finish", ...identity, used: 400 });
  assert.deepEqual(poolTotals(p), { used: 500, held: 200, available: 300 });
  assert.equal(p.members.writer.estimate, 120);
  assert.equal(p.members.writer.used, 400);
});

test("no borrowing another active member's hold; task ceiling cannot increase", () => {
  const p = pool();
  changePool(p, { type: "bind", ...identity });
  assert.throws(
    () =>
      changePool(p, { type: "request", ...identity, used: 0, allowance: 701 }),
    /task budget/,
  );
  assert.equal(p.ceiling, 1000);
});

test("unknown and in-flight usage cannot be reset, refunded or rebound", () => {
  const p = pool();
  changePool(p, { type: "bind", ...identity });
  changePool(p, { type: "request", ...identity, used: 0, allowance: 200 });
  assert.throws(
    () =>
      changePool(p, { type: "request", ...identity, used: 0, allowance: 10 }),
    /in.flight/,
  );
  assert.throws(
    () => changePool(p, { type: "bind", ...identity, sessionId: "another" }),
    /identity/,
  );
  changePool(p, { type: "unknown", ...identity });
  assert.equal(p.members.writer.hold, 200);
  assert.throws(
    () => changePool(p, { type: "settle", ...identity, used: 0 }),
    /unknown/,
  );
});

test("reported overshoot is retained, never silently clamped or erased", () => {
  const p = pool();
  changePool(p, { type: "bind", ...identity });
  changePool(p, { type: "request", ...identity, used: 0, allowance: 200 });
  changePool(p, { type: "settle", ...identity, used: 1100 });
  assert.equal(p.members.writer.used, 1100);
  assert.equal(poolTotals(p).used, 1200);
  assert.throws(
    () =>
      changePool(p, { type: "request", ...identity, used: 1100, allowance: 1 }),
    /task budget/,
  );
});

test("two real processes cannot reserve the same shared remainder", async (t) => {
  const f = budgetFixture(t);
  const members = ["a", "b"].map((key) => ({
    key,
    estimate: 10,
    sessionRoot: path.join(f.prepared.executionRoot, key),
  }));
  registerTaskBudgetMembers(f.context, members);
  for (const member of members)
    changeTaskBudget(taskBudgetBinding(f.context, member.key), {
      type: "bind",
      sessionId: member.key,
      sessionFile: path.join(member.sessionRoot, "session.jsonl"),
    });
  const outcomes = await Promise.all(
    members.map((member) =>
      launchRequest(taskBudgetBinding(f.context, member.key), {
        type: "request",
        sessionId: member.key,
        sessionFile: path.join(member.sessionRoot, "session.jsonl"),
        used: 0,
        allowance: 600,
      }),
    ),
  );
  assert.equal(outcomes.filter((row) => row === "admitted").length, 1);
  assert.equal(
    outcomes.filter((row) => row.startsWith("denied:task budget")).length,
    1,
  );
  assert.equal(poolTotals(readTaskBudget(f.context)).held, 610);
  assert.throws(
    () =>
      f.ledger.createTaskPool(
        f.prepared.executionId,
        f.prepared.requestDigest,
        0,
        "/new",
      ),
    /precede launch/,
  );
});

test("real ledger + request hooks allow successive turns beyond role estimate; usage-bound completion", async (t) => {
  const f = budgetFixture(t);
  const root = path.join(f.prepared.executionRoot, "leaf");
  registerTaskBudgetMembers(f.context, [
    { key: "leaf", estimate: 12, sessionRoot: root },
  ]);
  const leaf = hookSession(
    "leaf-session",
    f.source,
    path.join(root, "session.jsonl"),
  );
  installTaskBudgetHooks(leaf.pi, () => taskBudgetBinding(f.context, "leaf"));
  await leaf.emit("turn_start");
  await leaf.emit("context");
  leaf.addUsage(100);
  await leaf.emit("turn_end");
  await leaf.emit("turn_start");
  await leaf.emit("context");
  leaf.addUsage(130, { stopReason: "error" }); // Known error counters do not disable native retry.
  await leaf.emit("turn_end");
  await leaf.emit("session_shutdown");
  assert.deepEqual(leaf.errors, []);
  const measured = measureSessionBytes(leaf.bytes());
  const source = {
    ...measured,
    kind: "leaf",
    sessionFile: leaf.ctx.sessionManager.getSessionFile(),
  };
  const pool = assertTaskBudgetUsage(f.context, [source]);
  assert.equal(pool.members.leaf.used, 230);
  assert.equal(pool.members.leaf.estimate, 12);
  assert.equal(pool.members.leaf.hold, 0);
  assert.throws(
    () =>
      assertTaskBudgetUsage(f.context, [
        { ...source, usage: { ...source.usage, total: 229 } },
      ]),
    /differs/,
  );
});

test("request hooks abort before a denied next call and preserve unknown consumption", async (t) => {
  const f = budgetFixture(t, 200);
  const root = path.join(f.prepared.executionRoot, "leaf");
  registerTaskBudgetMembers(f.context, [
    { key: "leaf", estimate: 12, sessionRoot: root },
  ]);
  const leaf = hookSession(
    "leaf-session",
    f.source,
    path.join(root, "session.jsonl"),
  );
  installTaskBudgetHooks(leaf.pi, () => taskBudgetBinding(f.context, "leaf"));
  await leaf.emit("turn_start");
  await leaf.emit("context");
  leaf.addUsage(100);
  await leaf.emit("turn_end");
  await leaf.emit("turn_start");
  await leaf.emit("context");
  assert.ok(leaf.errors.includes("aborted"));
  assert.equal(readTaskBudget(f.context).members.leaf.used, 100);
  assert.equal(readTaskBudget(f.context).members.leaf.inFlight, false);
});

test("an interrupted request with no new report cannot refund its reservation", async (t) => {
  const f = budgetFixture(t);
  const root = path.join(f.prepared.executionRoot, "leaf");
  registerTaskBudgetMembers(f.context, [
    { key: "leaf", estimate: 12, sessionRoot: root },
  ]);
  const leaf = hookSession(
    "leaf-session",
    f.source,
    path.join(root, "session.jsonl"),
  );
  installTaskBudgetHooks(leaf.pi, () => taskBudgetBinding(f.context, "leaf"));
  await leaf.emit("context");
  await leaf.emit("turn_end"); // No assistant usage report arrived.
  assert.equal(readTaskBudget(f.context).members.leaf.unknown, true);
  assert.equal(readTaskBudget(f.context).members.leaf.hold, 150);
});

test("missing usage retains in-flight reservation and blocks another member", async (t) => {
  const f = budgetFixture(t);
  const root = path.join(f.prepared.executionRoot, "leaf");
  registerTaskBudgetMembers(f.context, [
    { key: "leaf", estimate: 12, sessionRoot: root },
  ]);
  const leaf = hookSession(
    "leaf-session",
    f.source,
    path.join(root, "session.jsonl"),
  );
  installTaskBudgetHooks(leaf.pi, () => taskBudgetBinding(f.context, "leaf"));
  await leaf.emit("turn_start");
  await leaf.emit("context");
  leaf.addUsage(10, { usage: undefined });
  await leaf.emit("turn_end");
  await leaf.emit("session_shutdown");
  const pool = readTaskBudget(f.context);
  assert.equal(pool.members.leaf.unknown, true);
  assert.equal(pool.members.leaf.hold, 150);
  assert.throws(
    () =>
      changeTaskBudget(f.binding, {
        type: "request",
        ...f.worker,
        allowance: 1,
      }),
    /unknown/,
  );
});

test("text request headroom uses input size instead of reserving an unused million-token window", () => {
  const model = { contextWindow: 1_000_000, maxTokens: 10_000 };
  const text = {
    messages: [{ role: "user", content: "短訊息" }],
    tools: [],
    systemPrompt: "fixture",
  };
  assert.equal(
    requestAllowance(model, text),
    Buffer.byteLength(JSON.stringify(text)) + 10_000,
  );
  assert.equal(
    requestAllowance(model, { messages: [{ type: "image", data: "fixture" }] }),
    1_010_000,
  );
  assert.equal(requestAllowance(model), 1_010_000);
});

test("compaction is charged to the same pool; an unmeasured summary retains its hold", async (t) => {
  const f = budgetFixture(t);
  const root = path.join(f.prepared.executionRoot, "leaf");
  registerTaskBudgetMembers(f.context, [
    { key: "leaf", estimate: 12, sessionRoot: root },
  ]);
  const leaf = hookSession(
    "leaf-session",
    f.source,
    path.join(root, "session.jsonl"),
  );
  installTaskBudgetHooks(leaf.pi, () => taskBudgetBinding(f.context, "leaf"));
  await leaf.emit("session_before_compact");
  assert.equal(readTaskBudget(f.context).members.leaf.hold, 300);
  leaf.entries.push({
    type: "compaction",
    id: "summary",
    usage: {
      input: 200,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 200,
    },
  });
  await leaf.emit("session_compact");
  assert.equal(readTaskBudget(f.context).members.leaf.used, 200);
  await leaf.emit("context");
  leaf.addUsage(30);
  await leaf.emit("turn_end");
  assert.equal(readTaskBudget(f.context).members.leaf.used, 230);
  await leaf.emit("session_before_compact");
  await leaf.emit("session_compact_failed", {
    errorMessage: "unknown summary usage",
  });
  assert.equal(readTaskBudget(f.context).members.leaf.unknown, true);
  assert.equal(readTaskBudget(f.context).members.leaf.hold, 300);
});

test("hook reload cannot reset an in-flight request or move its session", async (t) => {
  const f = budgetFixture(t);
  const root = path.join(f.prepared.executionRoot, "leaf");
  registerTaskBudgetMembers(f.context, [
    { key: "leaf", estimate: 12, sessionRoot: root },
  ]);
  const leaf = hookSession(
    "same-session",
    f.source,
    path.join(root, "session.jsonl"),
  );
  installTaskBudgetHooks(leaf.pi, () => taskBudgetBinding(f.context, "leaf"));
  await leaf.emit("context");
  const reloaded = hookSession(
    "same-session",
    f.source,
    path.join(root, "session.jsonl"),
  );
  installTaskBudgetHooks(reloaded.pi, () =>
    taskBudgetBinding(f.context, "leaf"),
  );
  await reloaded.emit("turn_start");
  assert.ok(reloaded.errors.includes("aborted"));
  assert.equal(readTaskBudget(f.context).members.leaf.hold, 150);
  assert.equal(readTaskBudget(f.context).members.leaf.inFlight, true);
  for (const event of [
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
  ])
    assert.deepEqual(await reloaded.emit(event), [{ cancel: true }]);
});

test("pooled requests keep existing owner, deadline and cancellation gates while retaining settled costs", async (t) => {
  for (const fault of ["ended", "process", "deadline", "cancel"])
    await t.test(fault, (t) => {
      const f = budgetFixture(t);
      changeTaskBudget(f.binding, {
        type: "request",
        ...f.worker,
        allowance: 100,
      });
      if (fault === "ended") f.orchestrator.close();
      if (fault === "process") {
        const file = path.join(f.prepared.executionRoot, "bootstrap.json");
        const bootstrap = JSON.parse(fs.readFileSync(file));
        bootstrap.controller.processId = 99_999_999;
        fs.writeFileSync(file, JSON.stringify(bootstrap));
      }
      if (fault === "deadline")
        f.ledger.db
          .prepare(
            "UPDATE executions SET created_at = ? WHERE execution_id = ?",
          )
          .run("2000-01-01T00:00:00.000Z", f.prepared.executionId);
      if (fault === "cancel")
        f.orchestrator.requestCancel(
          f.prepared.executionId,
          "disposable cancellation fixture",
        );
      changeTaskBudget(f.binding, { type: "settle", ...f.worker, used: 25 });
      assert.throws(
        () =>
          changeTaskBudget(f.binding, {
            type: "request",
            ...f.worker,
            used: 25,
            allowance: 1,
          }),
        /admission ended|granted owner|deadline exhausted|not admitting requests/,
      );
      assert.equal(readTaskBudget(f.context).members.worker.used, 25);
    });
});

test("unhooked native launch and fenced owner fail closed", (t) => {
  const f = budgetFixture(t);
  assert.throws(
    () =>
      assertBudgetHook({
        ok: true,
        contract: { tools: { extensionArgs: [] } },
      }),
    /lacks/,
  );
  f.ledger.db
    .prepare("UPDATE controllers SET owner_epoch = owner_epoch + 1")
    .run(); // Disposable fencing fixture only.
  assert.throws(
    () =>
      changeTaskBudget(f.binding, {
        type: "request",
        ...f.worker,
        allowance: 1,
      }),
    /fenced/,
  );
  // A coherent owner adoption changes both ledger rows. The old sealed
  // contract/binding still must not acquire another model request.
  f.ledger.db
    .prepare("UPDATE executions SET owner_epoch = owner_epoch + 1")
    .run();
  assert.throws(
    () =>
      changeTaskBudget(f.binding, {
        type: "request",
        ...f.worker,
        allowance: 1,
      }),
    /fenced/,
  );
});
