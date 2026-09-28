// Zero-model public seams. Native RPC/process/auditor outputs are controlled
// producers; registration, Agent tool validation, controllers and GoalService run.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import workerExtension from "../../extensions/teams-worker/index.mjs";
import { WorkerRuntime } from "../worker-runtime.mjs";
import { RoleController } from "../role-controller.mjs";

const host = fs.realpathSync(path.join(path.dirname(process.execPath), "pi"));
const { createJiti } = createRequire(host)("jiti");
const load = createJiti(host);
const { Agent } = await load.import("@earendil-works/pi-agent-core");
const { createAssistantMessageEventStream } = await load.import(
  "@earendil-works/pi-ai",
);
const { SessionManager } = await load.import("@earendil-works/pi-coding-agent");

// Observe the actual provider serialization boundary, not toolResult.details.
export async function modelToolOutput(agent, event) {
  const { convertResponsesMessages } = await import(
    path.resolve(
      path.dirname(fs.realpathSync(process.execPath)),
      "../lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js",
    )
  );
  const message = agent.state.messages.find(
    (row) => row.role === "toolResult" && row.toolCallId === event.toolCallId,
  );
  const assistant = agent.state.messages.find(
    (row) =>
      row.role === "assistant" &&
      row.content.some(
        (block) => block.type === "toolCall" && block.id === event.toolCallId,
      ),
  );
  assert.ok(message && assistant, "native message pair required");
  const projected = convertResponsesMessages(
    {
      id: "gpt-5.6-luna",
      provider: "openai-codex",
      api: "openai-codex-responses",
      input: ["text"],
      reasoning: true,
    },
    { messages: [assistant, message] },
    new Set(["openai", "openai-codex", "opencode"]),
    { includeSystemPrompt: false },
  );
  const output = projected.find(
    (row) => row.type === "function_call_output",
  )?.output;
  assert.equal(typeof output, "string");
  assert.equal(
    output,
    message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
  );
  return output;
}

export function nativeToolDriver(
  tools,
  ctx,
  before = async () => {},
  after = async () => {},
) {
  const model = {
    id: "fixture",
    name: "fixture",
    api: "openai-responses",
    provider: "offline",
    baseUrl: "http://127.0.0.1:1/never-used",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let queued = null,
    sequence = 0;
  const events = [];
  const agent = new Agent({
    initialState: {
      model,
      tools: [...tools.values()].map((tool) => ({
        ...tool,
        execute: (id, input, signal, update) =>
          tool.execute(id, input, signal, update, ctx),
      })),
    },
    streamFn() {
      const call = queued;
      queued = null;
      const message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: call
          ? [call]
          : [{ type: "text", text: "offline observation" }],
        stopReason: call ? "toolUse" : "stop",
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
  agent.beforeToolCall = ({ toolCall, args }) =>
    before(
      { toolName: toolCall.name, toolCallId: toolCall.id, input: args },
      ctx,
    );
  agent.afterToolCall = ({ toolCall, args, result, isError }) =>
    after(
      {
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        input: args,
        content: result.content,
        details: result.details,
        isError,
      },
      ctx,
    );
  agent.subscribe((event) => events.push(event));
  return {
    agent,
    events,
    async call(name, args) {
      const id = `public-${++sequence}`;
      queued = { type: "toolCall", id, name, arguments: structuredClone(args) };
      await agent.prompt("Execute this one offline fixture call.");
      const event = events.find(
        (row) => row.type === "tool_execution_end" && row.toolCallId === id,
      );
      assert.ok(event, "native tool completion absent");
      return event;
    },
  };
}

export async function installNativeGoalFixture(
  t,
  { root, source, tools, ctx },
) {
  const goalRoot =
    "/home/timmypai/.pi/agent/npm/node_modules/pi-goal-x/extensions";
  const { createGoalCore } = await load.import(
    path.join(goalRoot, "goal-state.ts"),
  );
  const { registerGoalTools } = await load.import(
    path.join(goalRoot, "goal-tools.ts"),
  );
  const { parseGoalFile } = await load.import(
    path.join(goalRoot, "storage/goal-files.ts"),
  );
  ctx.sessionManager = SessionManager.open(ctx.sessionManager.getSessionFile());
  ctx.hasUI = false;
  ctx.ui.notify = () => {};
  ctx.isIdle = () => true;
  ctx.hasPendingMessages = () => false;
  ctx.getSessionStats = () => ({ tokens: { total: 0 } });
  let auditCalls = 0;
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
    appendEntry: (type, data) =>
      ctx.sessionManager.appendCustomEntry(type, data),
    sendMessage() {},
    sendUserMessage() {
      assert.fail("No automatic fixture continuation");
    },
  };
  const core = createGoalCore(pi, {
    async runCompletionAuditor({ goal }) {
      auditCalls++;
      assert.ok(
        goal.taskList.tasks.every(
          (task) =>
            task.status === "complete" &&
            task.evidence.startsWith("task-runtime:"),
        ),
      );
      return {
        approved: true,
        output:
          "SYNTHETIC auditor producer: wiring only, not independent model review.",
      };
    },
  });
  registerGoalTools(core);
  fs.appendFileSync(
    path.join(source, ".git/info/exclude"),
    "\n.pi/goals/\n.pi/.goals-pool-snapshot.json\n",
  );
  fs.writeFileSync(
    path.join(root, "pi-goal-x-settings.json"),
    JSON.stringify({ disabled: false, disableTasks: false }),
  );
  core.replaceGoal(
    {
      objective:
        "Recover the failed beta branch without rerunning alpha or the independent Task.",
      autoContinue: false,
      sisyphus: false,
      taskList: {
        blockCompletion: true,
        proposedAt: new Date().toISOString(),
        tasks: ["task", "independent"].map((id) => ({
          id,
          title: id,
          status: "pending",
          verificationContract:
            "Requires a revalidated Task AcceptanceReceipt.",
        })),
      },
    },
    ctx,
    false,
  );
  t.after(() => {
    core.clearContinuationTimer();
    core.stopAuditAnimation();
    core.clearAuditResult();
  });
  return {
    core,
    get auditCalls() {
      return auditCalls;
    },
    get id() {
      return core.focusedGoalId;
    },
    readDisk() {
      const goal = core.state.goal;
      const disk = parseGoalFile(
        path.resolve(source, goal.archivedPath ?? goal.activePath),
      );
      assert.ok(disk, "native Goal file readback absent");
      return disk;
    },
  };
}

export async function publicWorkerFixture(
  t,
  { executionRoot, source, sessionFile, stoppedWorker },
) {
  const tools = new Map(),
    handlers = new Map(),
    listeners = new Map();
  let runtime,
    controller,
    aborts = 0,
    rpcHandler = () => assert.fail("Unexpected native RPC");
  const notices = [];
  const boot = WorkerRuntime.prototype.boot;
  const bootMock = t.mock.method(
    WorkerRuntime.prototype,
    "boot",
    function (input) {
      runtime = this;
      return boot.call(this, {
        ...input,
        ...(stoppedWorker
          ? { processId: 99_999_999, processStartedAtTicks: "1" }
          : {}),
      });
    },
  );
  const control = RoleController.prototype.control;
  t.mock.method(RoleController.prototype, "control", function (...args) {
    if (this.runtime === runtime) controller = this;
    return control.apply(this, args);
  });
  const ctx = {
    cwd: source,
    sessionManager: SessionManager.open(sessionFile),
    modelRegistry: { getAvailable: () => [] },
    isIdle: () => false,
    hasPendingMessages: () => false,
    shutdown() {},
    abort() {
      aborts++;
    },
    ui: {
      setStatus(_name, message) {
        notices.push(message);
      },
      notify(message) {
        assert.fail(message);
      },
    },
  };
  workerExtension({
    registerTool: (tool) => tools.set(tool.name, tool),
    on(name, fn) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    getActiveTools: () => ["read", ...tools.keys()],
    getAllTools: () =>
      [...tools.values()].map((tool) => ({
        ...tool,
        sourceInfo: { path: "teams-worker/index.mjs" },
      })),
    setActiveTools() {},
    sendUserMessage() {
      assert.fail("unexpected Worker wake");
    },
    events: {
      on(name, fn) {
        listeners.set(name, fn);
        return () => listeners.delete(name);
      },
      emit(_name, request) {
        const reply = listeners.get(
          `subagents:rpc:v1:reply:${request.requestId}`,
        );
        Promise.resolve()
          .then(() =>
            request.method === "ping"
              ? {
                  version: 1,
                  methods: ["status", "spawn", "stop"],
                  events: {
                    asyncComplete: "complete",
                    processTerminal: "terminal",
                  },
                  capabilities: {
                    status: true,
                    asyncSpawn: true,
                    stop: true,
                    runtimeAcknowledgedExtensions: { version: 1 },
                    processTerminalProof: { version: 1 },
                  },
                }
              : rpcHandler(request.method, request.params),
          )
          .then(
            (data) =>
              reply({
                version: 1,
                requestId: request.requestId,
                success: true,
                data,
              }),
            (error) =>
              reply({
                version: 1,
                requestId: request.requestId,
                success: false,
                error: String(error.message),
              }),
          );
      },
    },
  });
  const env = process.env.TEAMS_TASK_EXECUTION_DIR;
  process.env.TEAMS_TASK_EXECUTION_DIR = executionRoot;
  try {
    for (const fn of handlers.get("session_start")) await fn({}, ctx);
  } finally {
    bootMock.mock.restore();
    if (env === undefined) delete process.env.TEAMS_TASK_EXECUTION_DIR;
    else process.env.TEAMS_TASK_EXECUTION_DIR = env;
  }
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const fn of handlers.get("session_shutdown") ?? []) await fn({}, ctx);
    assert.equal(aborts, 0, JSON.stringify(notices));
  }
  t.after(close);
  const driver = nativeToolDriver(tools, ctx, async (event) => {
    for (const fn of handlers.get("tool_call") ?? []) {
      const result = await fn(event, ctx);
      if (result?.block) return result;
    }
  });
  return {
    ...driver,
    runtime,
    close,
    get controller() {
      return controller;
    },
    setRpc(fn) {
      rpcHandler = fn;
    },
  };
}
