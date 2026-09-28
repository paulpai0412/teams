import assert from "node:assert/strict";
import test from "node:test";
import { selectTaskL0Tools } from "../../extensions/teams-orchestrator/index.mjs";
import {
  inspectGoalTools,
  inspectSubagentsPing,
  SubagentsRpcClient,
} from "../capabilities.mjs";

function eventBus(reply) {
  const handlers = new Map();
  return {
    on(name, handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    emit(name, payload) {
      if (name === "subagents:rpc:v1:request") {
        handlers.get(`subagents:rpc:v1:reply:${payload.requestId}`)?.({
          version: 1,
          requestId: payload.requestId,
          ...reply,
        });
      }
    },
  };
}

test("Task L0 hides only model-facing raw subagent; native RPC/review registration remains", () => {
  const registered = [
    "read",
    "write",
    "team_task_dispatch",
    "team_task_stage_integration",
    "subagent",
  ];
  let active = [...registered];
  const pi = {
    getActiveTools: () => [...active],
    getAllTools: () => registered.map((name) => ({ name })),
    setActiveTools: (names) => {
      active = [...names];
    },
  };
  const sameSession = {
    ownerSessionId: "owner",
    sessionId: "owner",
    compatible: true,
  };
  assert.equal(
    selectTaskL0Tools(pi, { ...sameSession, mode: "ordinary" }).disposition,
    "unchanged",
  );
  assert.deepEqual(active, registered);
  const result = selectTaskL0Tools(pi, { ...sameSession, mode: "task-pi" });
  assert.deepEqual(result.hiddenFromModel, ["subagent"]);
  assert.ok(active.includes("team_task_dispatch"));
  assert.ok(active.includes("team_task_stage_integration"));
  assert.ok(!active.includes("subagent"));
  assert.ok(pi.getAllTools().some((row) => row.name === "subagent"));
  assert.deepEqual(
    selectTaskL0Tools(pi, { ...sameSession, mode: "task-pi" }).hiddenFromModel,
    [],
  );
  assert.throws(
    () =>
      selectTaskL0Tools(pi, {
        ...sameSession,
        mode: "task-pi",
        sessionId: "switched",
      }),
    /owner changed/,
  );
  assert.throws(
    () =>
      selectTaskL0Tools(pi, {
        ...sameSession,
        mode: "task-pi",
        compatible: false,
      }),
    /capability unavailable/,
  );
  active = [...registered];
  assert.throws(
    () =>
      selectTaskL0Tools(pi, {
        ...sameSession,
        mode: "task-pi",
        compatible: false,
      }),
    /capability unavailable/,
  );
  assert.ok(
    !active.includes("subagent"),
    "failed Task preflight cannot expose a raw writer fallback",
  );
});

const ping = {
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
};

test("U1 pi-subagents RPC identity and required capabilities are checked", async () => {
  const received = await new SubagentsRpcClient(
    eventBus({ success: true, data: ping }),
  ).ping();
  assert.equal(inspectSubagentsPing(received).compatible, true);
  assert.equal(
    inspectSubagentsPing({
      ...ping,
      capabilities: { ...ping.capabilities, stop: false },
    }).compatible,
    false,
  );
  await assert.rejects(
    new SubagentsRpcClient(
      eventBus({ success: false, error: { message: "unavailable" } }),
    ).ping(),
    /unavailable/,
  );
});

test("U1 Goal tool capability uses structural schemas, not package hashes", () => {
  const tools = [
    {
      name: "update_goal_task",
      parameters: {
        properties: {
          task_id: { type: "string" },
          status: { anyOf: [{ const: "start" }, { const: "complete" }] },
          updates: {
            items: {
              properties: {
                task_id: { type: "string" },
                status: { enum: ["start", "complete"] },
              },
            },
          },
        },
      },
    },
    {
      name: "update_goal",
      parameters: { properties: { status: { enum: ["complete", "blocked"] } } },
    },
  ];
  const compatible = inspectGoalTools({
    getActiveTools: () => tools.map((tool) => tool.name),
    getAllTools: () => tools,
  });
  assert.equal(compatible.compatible, true);
  const incompatible = inspectGoalTools({
    getActiveTools: () => tools.map((tool) => tool.name),
    getAllTools: () => [
      { ...tools[0], parameters: { properties: {} } },
      tools[1],
    ],
  });
  assert.equal(incompatible.compatible, false);
});
