import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import teamsOrchestrator, {
  readSpec,
} from "../../extensions/teams-orchestrator/index.mjs";
import {
  TaskInputRejection,
  validateInput,
  inputRejectionReply,
  isInputRejection,
  taskExecutionSelector,
} from "../input-rejection.mjs";

const id = "12345678-1234-1234-1234-123456789abc";

test("native Agent loop preserves rejection details and error flag through the public tool_result hook", async () => {
  const host = fs.realpathSync(path.join(path.dirname(process.execPath), "pi"));
  const { createJiti } = createRequire(host)("jiti");
  const load = createJiti(host);
  const { Agent } = await load.import("@earendil-works/pi-agent-core");
  const { createAssistantMessageEventStream } = await load.import(
    "@earendil-works/pi-ai",
  );
  const handlers = new Map();
  teamsOrchestrator({
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    on: (name, fn) => handlers.set(name, fn),
  });
  const model = {
    id: "fixture",
    name: "fixture",
    api: "openai-responses",
    provider: "offline",
    baseUrl: "http://127.0.0.1:1/never-used",
    reasoning: false,
    input: ["text"],
    contextWindow: 10000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const toolName = "team_task_dispatch";
  let requests = 0;
  const agent = new Agent({
    initialState: {
      model,
      tools: [
        {
          name: toolName,
          label: "fixture",
          description: "offline input rejection",
          parameters: { type: "object", properties: {} },
          execute: async (callId, input) =>
            inputRejectionReply(
              new TaskInputRejection(
                "task-spec",
                new Error("missing criterion"),
              ),
              toolName,
              callId,
              input,
            ),
        },
      ],
    },
    streamFn() {
      const first = requests++ === 0;
      const message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: first
          ? [
              {
                type: "toolCall",
                id: "native-call",
                name: toolName,
                arguments: {},
              },
            ]
          : [{ type: "text", text: "observed rejection" }],
        stopReason: first ? "toolUse" : "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
      return stream;
    },
  });
  agent.afterToolCall = ({ toolCall, args, result, isError }) =>
    handlers.get("tool_result")({
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      input: args,
      content: result.content,
      details: result.details,
      isError,
    });
  const events = [];
  agent.subscribe((event) => events.push(event));
  await agent.prompt("offline fixture");
  const result = events.find((event) => event.type === "tool_execution_end");
  assert.equal(result.isError, true);
  assert.equal(result.result.details.rejection.phase, "task-spec");
  const message = agent.state.messages.find((row) => row.role === "toolResult");
  assert.equal(message.isError, true);
  assert.equal(message.details.rejection.launchAttempted, false);
  assert.equal(
    requests,
    2,
    "same agent loop can continue without a new Task launch",
  );
});

test("missing draft spec path is a bound pre-dispatch input correction, not a Task retry", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-spec-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = {
    spec_path: path.join(root, "absent.json"),
    benefit: "context-isolation",
    benefit_detail:
      "A bounded independent review of the source candidate is needed.",
  };
  let missing;
  try {
    readSpec(root, input.spec_path);
  } catch (error) {
    missing = error;
  }
  assert.ok(missing instanceof TaskInputRejection);
  assert.equal(missing.phase, "task-spec-file");
  assert.equal(missing.cause?.code, "ENOENT");
  const reply = inputRejectionReply(
    missing,
    "team_task_dispatch",
    "call",
    input,
  );
  assert.equal(
    isInputRejection(
      reply.details.rejection,
      { tool: "team_task_dispatch", input },
      "team_task_dispatch",
      "call",
    ),
    true,
  );
  assert.equal(reply.details.rejection.executionId, null);
  assert.equal(reply.details.rejection.launchAttempted, false);
});

test("only explicit validation failures carry an input rejection, never arbitrary runtime exceptions", () => {
  assert.throws(
    () => validateInput("task-spec", () => assert.fail("missing criterion")),
    TaskInputRejection,
  );
  const runtime = new TypeError("unexpected runtime state");
  assert.throws(
    () =>
      validateInput("task-spec", () => {
        throw runtime;
      }),
    (error) => error === runtime,
  );
  assert.throws(
    () =>
      inputRejectionReply(
        new Error("Validation failed before dispatch"),
        "team_task_dispatch",
        "call",
        {},
      ),
    /Validation failed/,
  );
});

test("execution selector rejection is exact-call bound and cannot soften runtime or foreign-tool errors", () => {
  for (const tool of [
    "team_task_collect",
    "team_task_stage_integration",
    "team_task_target_integration",
    "team_task_run_checks",
    "team_task_accept",
    "team_task_prepare_takeover",
    "team_task_reconcile",
    "team_task_cancel",
    "team_task_status",
    "team_task_revise",
    "team_task_revise_report",
  ]) {
    const field = tool.includes("revise")
      ? "previous_execution_id"
      : "execution_id";
    const input = { [field]: id };
    assert.equal(taskExecutionSelector(tool, input), id);
    const reply = inputRejectionReply(
      new TaskInputRejection(
        "execution-selector",
        new Error("unknown selector"),
      ),
      tool,
      "exact-call",
      input,
    );
    const rejection = reply.details.rejection;
    assert.equal(
      isInputRejection(rejection, { tool, input }, tool, "exact-call"),
      true,
    );
    for (const changed of [
      { executionId: "other" },
      { preparationEffects: "controller-claim-possible" },
      { launchAttempted: true },
      { toolCallId: "other" },
      { inputDigest: "0".repeat(64) },
    ])
      assert.equal(
        isInputRejection(
          { ...rejection, ...changed },
          { tool, input },
          tool,
          "exact-call",
        ),
        false,
      );
    assert.equal(
      isInputRejection(
        rejection,
        { tool, input: { [field]: "other" } },
        tool,
        "exact-call",
      ),
      false,
    );
    assert.throws(
      () =>
        inputRejectionReply(
          new Error("execution not found: " + id),
          tool,
          "exact-call",
          input,
        ),
      /execution not found/,
    );
  }
  for (const tool of ["read", "team_task_dispatch", "team_task_takeover"]) {
    assert.equal(taskExecutionSelector(tool, { execution_id: id }), null);
    assert.throws(
      () =>
        inputRejectionReply(
          new TaskInputRejection(
            "execution-selector",
            new Error("not a selector tool"),
          ),
          tool,
          "call",
          { execution_id: id },
        ),
      /not a selector tool/,
    );
  }
});

test("host input rejection is bound to exact tool call, input and non-launch phase", () => {
  for (const [tool, phase, input] of [
    ["team_task_dispatch", "task-spec", { spec_path: "/workspace/spec.json" }],
    [
      "team_task_dispatch",
      "task-context-ref",
      { spec_path: "/workspace/spec.json" },
    ],
    [
      "team_task_revise",
      "task-prompt",
      { previous_execution_id: id, spec_path: "/workspace/revision.json" },
    ],
    [
      "team_task_stage_integration",
      "review-tools",
      { execution_id: id, action: "plan-review", wave: {} },
    ],
    [
      "team_task_stage_integration",
      "review-seal",
      { execution_id: id, action: "seal-review" },
    ],
  ]) {
    const error = new TaskInputRejection(phase, new Error("rejected"), {
      excess: ["unapproved_tool"],
    });
    const reply = inputRejectionReply(error, tool, "call", input);
    const rejection = reply.details.rejection;
    const call = { tool, input };
    assert.equal(reply.isError, true);
    assert.equal(isInputRejection(rejection, call, tool, "call"), true);
    if (phase === "review-seal") {
      assert.equal(rejection.preparationEffects, "review-completion-preserved");
      assert.match(reply.content[0].text, /Do not repeat the seal/);
    }
    assert.equal(isInputRejection(rejection, null, tool, "call"), false);
    for (const changed of [
      { ...rejection, toolCallId: "other" },
      { ...rejection, inputDigest: "0".repeat(64) },
      { ...rejection, launchAttempted: true },
      { ...rejection, executionId: "foreign" },
      { ...rejection, phase: "usage-admission" },
    ])
      assert.equal(isInputRejection(changed, call, tool, "call"), false);
    assert.equal(
      isInputRejection(
        rejection,
        { ...call, input: { ...input, extra: true } },
        tool,
        "call",
      ),
      false,
    );
  }
  const error = new TaskInputRejection(
    "review-tools",
    new Error("ceiling mismatch"),
  );
  assert.throws(
    () =>
      inputRejectionReply(error, "team_task_stage_integration", "call", {
        execution_id: id,
        action: "start-review",
      }),
    (e) => e === error,
  );
  assert.throws(
    () =>
      inputRejectionReply(error, "team_task_accept", "call", {
        execution_id: id,
      }),
    (e) => e === error,
  );
  const wrongSeal = new TaskInputRejection(
    "review-seal",
    new Error("not a seal action"),
  );
  assert.throws(
    () =>
      inputRejectionReply(wrongSeal, "team_task_stage_integration", "call", {
        execution_id: id,
        action: "collect-review",
      }),
    (e) => e === wrongSeal,
  );
  assert.throws(
    () =>
      inputRejectionReply(
        new TaskInputRejection("usage-admission", new Error("unknown usage")),
        "team_task_revise",
        "call",
        { previous_execution_id: id, spec_path: "/workspace/revision.json" },
      ),
    /unknown usage/,
  );
});
