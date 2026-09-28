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
import { nativeBudgetLaunch } from "./child-budget-fixture.mjs";
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

async function openFixture(
  t,
  ceiling,
  retry = false,
  { consumer = true, hostKind = "parent" } = {},
) {
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
  const launch = nativeBudgetLaunch(
    { [TASK_BUDGET_BINDING]: binding },
    { cwd: f.source, host: hostKind },
  );
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
      ...launch.session.hooks,
      ...(consumer ? [teamsBudget] : []),
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
            const member = readTaskBudget(f.context).members["sdk-leaf"];
            assert.ok(
              member.sessionId && member.sessionFile,
              "bind before provider",
            );
            assert.equal(member.inFlight, true, "reserve before provider");
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

test("ordinary in-process roles ignore inherited Task env and register no Worker tools", () => {
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
        hooks = new Map();
      teamsBudget({
        registerTool: (tool) => tools.push(tool),
        events: { emit() {} },
        on: (name, handler) => hooks.set(name, handler),
      });
      hooks.get("session_start")();
      // No binding means hooks cannot access session data or charge a ledger.
      hooks.get("context")({ messages: [] }, {});
      assert.equal(tools.length, 0);
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
      ["team.implementer", "gpt-5.6-luna"],
      ["team.reviewer", "gpt-5.6-luna"],
    ]) {
      const resolution = await resolve({
        agent,
        model: `openai-codex/${id}`,
        cwd: f.source,
        context: "fresh",
        agentScope: "user",
        task: "Offline launch preflight only.",
        output: false,
        availableModels: [{ provider: "openai-codex", id, reasoning: false }],
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
  const entries = f.session.sessionManager.getEntries();
  assert.equal(
    f.calls.length,
    2,
    JSON.stringify({
      errors: f.errors,
      entryTypes: entries.map((row) => row.type),
    }),
  );
  assert.ok(entries.some((row) => row.type === "context_edit"));
  assert.ok(
    entries.some(
      (row) =>
        row.type === "message" &&
        row.message.stopReason === "error" &&
        row.message.usage.cacheRead === 100,
    ),
    "failed retry usage remains in raw history",
  );
  assert.deepEqual(f.errors, []);
  assert.equal(readTaskBudget(f.context).members["sdk-leaf"].used, 230);
});

test("missing binding consumer blocks before any provider call", async (t) => {
  const f = await openFixture(t, 1000, false, { consumer: false });
  await f.session.prompt("must not run");
  assert.equal(f.calls.length, 0);
  assert.ok(
    f.errors.some((row) =>
      String(row.error).includes("bindings were not consumed"),
    ),
  );
  assert.equal(readTaskBudget(f.context).members["sdk-leaf"].sessionId, null);
});

test("parallel sessions keep distinct bindings and leave parent env unchanged", async (t) => {
  const before = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  const [a, b] = await Promise.all([openFixture(t, 1000), openFixture(t, 200)]);
  await Promise.all([a.session.prompt("a1"), b.session.prompt("b1")]);
  await Promise.all([a.session.prompt("a2"), b.session.prompt("b2 denied")]);
  assert.equal(a.calls.length, 2);
  assert.equal(b.calls.length, 1);
  const ma = readTaskBudget(a.context).members["sdk-leaf"];
  const mb = readTaskBudget(b.context).members["sdk-leaf"];
  assert.equal(ma.used, 230);
  assert.equal(mb.used, 100);
  assert.notEqual(ma.sessionId, mb.sessionId);
  assert.notEqual(ma.sessionFile, mb.sessionFile);
  assert.equal(process.env.PI_SUBAGENT_EXTENSION_BINDINGS, before);
});

test("runner-hosted launch uses the same session-local budget binding", async (t) => {
  const f = await openFixture(t, 1000, false, { hostKind: "runner" });
  await f.session.prompt("runner fixture");
  assert.equal(f.calls.length, 1);
  assert.equal(readTaskBudget(f.context).members["sdk-leaf"].used, 100);
});

test("installed Pi SDK aborts at the next request boundary when shared funds cannot cover it", async (t) => {
  const f = await openFixture(t, 200);
  await f.session.prompt("first fixture request");
  await f.session.prompt("denied fixture request");
  assert.equal(f.calls.length, 1);
  assert.equal(readTaskBudget(f.context).members["sdk-leaf"].used, 100);
  assert.deepEqual(f.errors, []);
});
