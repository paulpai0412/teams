import assert from "node:assert/strict";
import test from "node:test";
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
