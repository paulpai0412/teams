import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createReviewLaunchScheduler } from "../review-capacity.mjs";
import { startReviewWave } from "../review-runs.mjs";

function fixture(limit, initialUsed = 0) {
  const emitter = new EventEmitter();
  const events = {
    on(name, listener) {
      emitter.on(name, listener);
      return () => emitter.off(name, listener);
    },
  };
  let used = initialUsed;
  let full;
  const fullSeen = new Promise((resolve) => {
    full = resolve;
  });
  const rpc = {
    async ping() {
      return {
        capabilities: { status: true },
        events: {
          asyncComplete: "subagent:async-complete",
          processTerminal: "subagent:process-terminal",
        },
      };
    },
    async request(method) {
      assert.equal(method, "status");
      if (limit > 0 && used >= limit) full();
      return { fleet: { topLevelAsyncCapacity: { used, limit } } };
    },
  };
  const launched = [];
  const schedule = createReviewLaunchScheduler(events);
  const start = (owner, name, signal) =>
    schedule({ owner, rpc, signal, timeoutMs: 2_000 }, async () => {
      assert.ok(limit === 0 || used < limit, "native slot must be available");
      used++;
      launched.push(name);
      return name;
    });
  return {
    launched,
    fullSeen,
    start,
    complete(event = "subagent:async-complete") {
      assert.ok(used > 0);
      used--;
      emitter.emit(event);
    },
  };
}

test("one native slot keeps two independently launched reviews sequential", {
  timeout: 3_000,
}, async () => {
  const f = fixture(1);
  assert.equal(await f.start("same-l0", "app"), "app");
  const backup = f.start("same-l0", "backup");
  await f.fullSeen;
  assert.deepEqual(f.launched, ["app"]);
  f.complete();
  assert.equal(await backup, "backup");
  assert.deepEqual(f.launched, ["app", "backup"]);
});

test("configured two-slot capacity permits parallel reviews", {
  timeout: 3_000,
}, async () => {
  const f = fixture(2);
  assert.deepEqual(
    await Promise.all([
      f.start("same-l0", "app"),
      f.start("same-l0", "backup"),
    ]),
    ["app", "backup"],
  );
  assert.deepEqual(f.launched, ["app", "backup"]);
});

test("native zero limit remains unlimited; an unrelated occupied slot waits for process proof", {
  timeout: 3_000,
}, async () => {
  const unlimited = fixture(0);
  assert.deepEqual(
    await Promise.all([
      unlimited.start("same-l0", "app"),
      unlimited.start("same-l0", "backup"),
    ]),
    ["app", "backup"],
  );
  const occupied = fixture(1, 1);
  const pending = occupied.start("same-l0", "review");
  await occupied.fullSeen;
  assert.deepEqual(occupied.launched, []);
  occupied.complete("subagent:process-terminal");
  assert.equal(await pending, "review");
});

test("a cancelled capacity wait never dispatches or consumes review intent", {
  timeout: 3_000,
}, async () => {
  const f = fixture(1, 1);
  const controller = new AbortController();
  const pending = f.start("same-l0", "review", controller.signal);
  await f.fullSeen;
  controller.abort();
  await assert.rejects(pending, /review capacity wait cancelled/);
  assert.deepEqual(f.launched, []);
});

test("a full native pool times out without starting a review or leaking listeners", {
  timeout: 3_000,
}, async () => {
  const emitter = new EventEmitter();
  const events = {
    on(name, listener) {
      emitter.on(name, listener);
      return () => emitter.off(name, listener);
    },
  };
  const rpc = {
    async ping() {
      return {
        capabilities: { status: true },
        events: { asyncComplete: "done", processTerminal: "terminal" },
      };
    },
    async request() {
      return { fleet: { topLevelAsyncCapacity: { used: 1, limit: 1 } } };
    },
  };
  let launched = false;
  await assert.rejects(
    createReviewLaunchScheduler(events)(
      { owner: "l0", rpc, timeoutMs: 20 },
      () => {
        launched = true;
      },
    ),
    /review capacity wait deadline reached/,
  );
  assert.equal(launched, false);
  assert.equal(emitter.listenerCount("done"), 0);
  assert.equal(emitter.listenerCount("terminal"), 0);
});

test("missing native capacity proof fails closed without a launch", async () => {
  let launched = false;
  const rpc = {
    async ping() {
      return {
        capabilities: { status: true },
        events: { asyncComplete: "done", processTerminal: "terminal" },
      };
    },
    async request() {
      return { fleet: {} };
    },
  };
  await assert.rejects(
    createReviewLaunchScheduler({ on: () => () => {} })(
      { owner: "l0", rpc, timeoutMs: 2_000 },
      () => {
        launched = true;
      },
    ),
    /native active-async capacity snapshot missing/,
  );
  assert.equal(launched, false);
});

test("review capacity admission runs before any review-wave launch intent", async () => {
  const blocked = new Error("native capacity unavailable");
  let called = false;
  await assert.rejects(
    startReviewWave(
      { contract: { policy: { deadlineMs: 2_000 } } },
      "review",
      "a".repeat(64),
      {
        scheduleReviewLaunch(_launch, timeoutMs) {
          assert.equal(timeoutMs, 2_000);
          called = true;
          throw blocked;
        },
      },
    ),
    (error) => error === blocked,
  );
  assert.equal(called, true);
});
