// Installed Pi/native child-binding boundary, offline deterministic provider.
// No external model, network, shell, candidate execution, credentials or Goal.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import teamsBudget from "../../extensions/teams-budget/index.mjs";
import { nativeBudgetLaunch } from "./child-budget-fixture.mjs";
import {
  RECONSTRUCTION_BINDING,
  RECONSTRUCTION_ENTRY,
  reconstructionBinding,
} from "../reconstruction-input.mjs";
import { verifyWriterReconstruction } from "../review-product-lineage.mjs";
import { bytesDigest } from "../contracts.mjs";
const { Type } = createRequire(
  "/home/timmypai/.pi/agent/npm/node_modules/pi-subagents/package.json",
)("@sinclair/typebox");
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

test("installed native binding and Pi hooks preserve recoverable input errors through successful reconstruction validation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reconstruction-sdk-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "empty-agent");
  fs.mkdirSync(agentDir);
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const command = "host-bound SDK reconstruction",
    marker = "SDK_RECONSTRUCTED\n";
  const binding = reconstructionBinding(command, marker);
  const launch = nativeBudgetLaunch(
    { [RECONSTRUCTION_BINDING]: binding },
    { cwd: root, tools: ["bash", "write"] },
  );
  const model = {
    id: "fixture",
    name: "fixture",
    provider: "reconstruction-fixture",
    api: "openai-responses",
    baseUrl: "http://127.0.0.1:1/never-used",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const steps = [
    { name: "bash", arguments: { command: "typo one" } },
    { name: "bash", arguments: { command: "typo two" } },
    { name: "bash", arguments: { command: "typo three" } },
    { name: "bash", arguments: { command } },
    { name: "write", arguments: { path: "repaired-product" } },
  ];
  const effects = [],
    errors = [];
  let cursor = 0;
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => "Offline reconstruction fixture.",
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [
      ...launch.session.hooks,
      teamsBudget,
      (pi) => {
        pi.registerTool({
          name: "bash",
          label: "Bash stub",
          description: "Never runs a shell",
          parameters: Type.Object({ command: Type.String() }),
          execute: async (_id, input) => {
            effects.push(input.command);
            return { content: [{ type: "text", text: marker }], details: {} };
          },
        });
        pi.registerTool({
          name: "write",
          label: "Write stub",
          description: "Never writes a file",
          parameters: Type.Object({ path: Type.String() }),
          execute: async (_id, input) => {
            effects.push(input.path);
            return {
              content: [{ type: "text", text: "written" }],
              details: {},
            };
          },
        });
        pi.registerProvider(model.provider, {
          api: model.api,
          baseUrl: model.baseUrl,
          apiKey: "not-a-secret-fixture",
          models: [model],
          streamSimple: () => {
            const step = steps[cursor++];
            const message = {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: Date.now(),
              content: step
                ? [{ type: "toolCall", id: `fixture-${cursor}`, ...step }]
                : [{ type: "text", text: "finished" }],
              stopReason: step ? "toolUse" : "stop",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
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
            stream.push({ type: "done", reason: message.stopReason, message });
            stream.end(message);
            return stream;
          },
        });
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime,
    model,
    resourceLoader: loader,
    settingsManager,
    tools: ["bash", "write"],
    sessionManager: sdk.SessionManager.create(
      root,
      path.join(root, "sessions"),
    ),
  });
  t.after(() => session.dispose());
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(error),
  });
  assert.deepEqual(session.getActiveToolNames().sort(), ["bash", "write"]);
  await session.prompt(
    "Exercise the original role until the reconstruction and edit finish.",
  );
  assert.deepEqual(errors, []);
  const entries = session.sessionManager.getEntries();
  assert.deepEqual(
    effects,
    [command, "repaired-product"],
    JSON.stringify({
      activeTools: session.getActiveToolNames(),
      cursor,
      messages: entries
        .filter((e) => e.type === "message")
        .map((e) => ({
          role: e.message.role,
          stopReason: e.message.stopReason,
          errorMessage: e.message.errorMessage,
          content: e.message.content,
        })),
    }),
  );
  const proofs = entries.filter(
    (e) => e.type === "custom" && e.customType === RECONSTRUCTION_ENTRY,
  );
  assert.equal(proofs.filter((e) => e.data.kind === "rejected").length, 3);
  assert.equal(proofs.filter((e) => e.data.kind === "admitted").length, 1);
  const results = entries.filter((e) => e.message?.role === "toolResult");
  assert.equal(results.filter((e) => e.message.isError).length, 3);
  assert.ok(
    results
      .slice(0, 3)
      .every((e) => e.message.content[0].text.includes("SAME role")),
  );
  const bytes = Buffer.from(
    [session.sessionManager.getHeader(), ...entries]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  const sessionFile = session.sessionManager.getSessionFile();
  assert.doesNotThrow(() =>
    verifyWriterReconstruction(
      {
        lanes: [{ mode: "mutation", runId: "fixture", sessionFile }],
        files: [{ path: sessionFile, sha256: bytesDigest(bytes), bytes }],
      },
      command,
      marker,
    ),
  );
});
