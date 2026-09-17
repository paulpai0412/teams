// Offline host SDK boundary test: deterministic in-memory provider, no credentials,
// network, live Goal, Task dispatch, CLI runner or model inference.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { publicReviewResolver } from "../review-runs.mjs";
import { budgetFixture } from "./shared-budget-fixture.mjs";
import teamsBudget from "../../extensions/teams-budget/index.mjs";
import {
  registerTaskBudgetMembers,
  taskBudgetBinding,
  readTaskBudget,
  TASK_BUDGET_BINDING,
  assertBudgetHook,
} from "../task-budget.mjs";

const host = path.resolve(
  path.dirname(fs.realpathSync(process.execPath)),
  "../lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
);
const sdk = await import(pathToFileURL(host).href);
const ai = await import(
  pathToFileURL(
    path.resolve(
      path.dirname(host),
      "../node_modules/@earendil-works/pi-ai/dist/index.js",
    ),
  ).href
);

async function openFixture(t, ceiling, retry = false) {
  const f = budgetFixture(t, ceiling);
  const agentDir = path.join(f.root, "empty-agent");
  fs.mkdirSync(agentDir);
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = {
    id: "fixture",
    name: "fixture",
    provider: "task-budget-fixture",
    api: "openai-responses",
    baseUrl: "http://127.0.0.1:1/never-used",
    reasoning: false,
    input: ["text"],
    contextWindow: 100,
    maxTokens: 50,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const calls = [];
  const sessionRoot = path.join(f.prepared.executionRoot, "sdk-leaf");
  registerTaskBudgetMembers(f.context, [
    { key: "sdk-leaf", estimate: 12, sessionRoot },
  ]);
  const binding = taskBudgetBinding(f.context, "sdk-leaf");
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: f.source,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => "Offline fixture.",
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [
      (pi) => {
        const old = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
        process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({
          [TASK_BUDGET_BINDING]: binding,
        });
        try {
          teamsBudget(pi);
        } finally {
          if (old === undefined)
            delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
          else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = old;
        }
      },
      (pi) =>
        pi.registerProvider("task-budget-fixture", {
          api: "openai-responses",
          baseUrl: model.baseUrl,
          apiKey: "not-a-secret-fixture",
          models: [model],
          streamSimple: (_model, _context, options) => {
            assert.equal(
              options.signal.aborted,
              false,
              "denied request must never reach the provider",
            );
            calls.push("called");
            const total = calls.length === 1 ? 100 : 130;
            const message = {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              content: [{ type: "text", text: "fixture" }],
              stopReason: "stop",
              timestamp: Date.now(),
              usage: {
                input: 0,
                output: 0,
                cacheRead: total,
                cacheWrite: 0,
                totalTokens: total,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            };
            const stream = ai.createAssistantMessageEventStream();
            if (retry && calls.length === 1) {
              message.stopReason = "error";
              message.errorMessage = "429 rate limited (offline fixture)";
              stream.push({ type: "error", reason: "error", error: message });
            } else stream.push({ type: "done", reason: "stop", message });
            stream.end(message);
            return stream;
          },
        }),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({
    cwd: f.source,
    agentDir,
    modelRuntime,
    model,
    resourceLoader: loader,
    settingsManager,
    tools: [],
    sessionManager: sdk.SessionManager.create(f.source, sessionRoot),
  });
  const errors = [];
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(error),
  });
  t.after(() => session.dispose());
  return { ...f, session, calls, errors };
}

test("ordinary in-process roles without a Task binding install no Worker tools or hooks", () => {
  const names = [
    "PI_SUBAGENT_DEPTH",
    "PI_SUBAGENT_EXTENSION_BINDINGS",
    "TEAMS_TASK_EXECUTION_DIR",
  ];
  const old = names.map((name) => process.env[name]);
  try {
    delete process.env.PI_SUBAGENT_DEPTH;
    delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    for (const parentTask of [undefined, "/unused/inherited-parent-task"]) {
      if (parentTask === undefined) delete process.env.TEAMS_TASK_EXECUTION_DIR;
      else process.env.TEAMS_TASK_EXECUTION_DIR = parentTask;
      const tools = [],
        hooks = [];
      teamsBudget({
        registerTool: (tool) => tools.push(tool),
        on: (name) => hooks.push(name),
      });
      assert.equal(tools.length, 0);
      assert.equal(hooks.length, 0);
    }
  } finally {
    names.forEach((name, index) => {
      if (old[index] === undefined) delete process.env[name];
      else process.env[name] = old[index];
    });
  }
});

test("installed native preflight resolves Task hooks and explicit bindings for writer and reviewer profiles", async (t) => {
  const f = budgetFixture(t);
  const agentDir = fileURLToPath(new URL("../../../", import.meta.url));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const resolve = await publicReviewResolver(agentDir, host);
    for (const [agent, id] of [
      ["team.implementer", "gemini-3.7-flash"],
      ["team.reviewer", "gemini-3.8-flash"],
    ]) {
      const resolution = await resolve({
        agent,
        model: `antigravity/${id}`,
        cwd: f.source,
        context: "fresh",
        agentScope: "user",
        task: "Offline launch preflight only.",
        output: false,
        availableModels: [{ provider: "antigravity", id, reasoning: true }],
        extensionBindings: {
          [TASK_BUDGET_BINDING]: taskBudgetBinding(f.context, "probe"),
        },
      });
      assert.equal(resolution.ok, true, JSON.stringify(resolution));
      assertBudgetHook(resolution);
      assert.equal(resolution.contract.tools.fanoutAuthorized, false);
    }
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
});

test("installed Pi SDK requests consume the shared pool, not the 12-token role estimate", async (t) => {
  const f = await openFixture(t, 1000);
  await f.session.prompt("first fixture request");
  await f.session.prompt("second fixture request");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.errors, []);
  assert.equal(readTaskBudget(f.context).members["sdk-leaf"].used, 230);
  await f.session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  assert.equal(readTaskBudget(f.context).members["sdk-leaf"].finished, true);
});

test("native configured retry with known usage stays inside the same shared pool", async (t) => {
  const f = await openFixture(t, 1000, true);
  await f.session.prompt("offline retry fixture");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.errors, []);
  assert.equal(readTaskBudget(f.context).members["sdk-leaf"].used, 230);
});

test("installed Pi SDK aborts at the next request boundary when shared funds cannot cover it", async (t) => {
  const f = await openFixture(t, 200);
  await f.session.prompt("first fixture request");
  await f.session.prompt("denied fixture request");
  assert.equal(f.calls.length, 1);
  assert.equal(readTaskBudget(f.context).members["sdk-leaf"].used, 100);
  assert.deepEqual(f.errors, []);
});
