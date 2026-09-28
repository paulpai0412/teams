// Real public Pi SDK turn with a credential-free in-memory provider. This
// observes the model request boundary; it is not model inference or live G1.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildModelAdmissionContext } from "../e2e/run-todo-flow.mjs";
import { selectTaskL0Tools } from "../../extensions/teams-orchestrator/index.mjs";

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
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const selectedSkill = path.resolve(
  new URL("../../../skills/team-flow/SKILL.md", import.meta.url).pathname,
);

function git(cwd, args) {
  const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function tool(name) {
  return {
    name,
    label: name,
    description: `Offline ${name} registration; never execute`,
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      throw new Error("offline fake tool must not execute");
    },
  };
}

for (const { mode, goalAction } of [
  { mode: "task-pi", goalAction: "create" },
  { mode: "task-pi", goalAction: "resume" },
  { mode: "ordinary", goalAction: "none" },
]) {
  test(`installed Pi SDK sends ${mode}/${goalAction} admission context and selected active tools to an offline provider`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "r31-model-boundary-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cwd = path.join(root, "workspace");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(agentDir, "skills", "team-flow"), {
      recursive: true,
    });
    fs.copyFileSync(
      selectedSkill,
      path.join(agentDir, "skills", "team-flow", "SKILL.md"),
    );
    git(cwd, ["init", "-q"]);
    git(cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "base",
    ]);
    const base = git(cwd, ["rev-parse", "HEAD"]);
    const request =
      "Implement x-request-id exactly and return 404 when missing.";
    const requestFile = path.join(root, "request.txt");
    fs.writeFileSync(requestFile, request);
    const inventory = path.join(root, "inventory.json");
    const history = {
      totals: { total: 3 },
      sources: Array.from({ length: 64 }, (_, index) => ({
        sessionId: `closed-session-${index}`,
        file: `/captured/${"long-authorized-workspace/".repeat(10)}${index}/native-session.jsonl`,
        sha256: "a".repeat(64),
      })),
      executions: [
        { executionId: "closed-execution", contractDigest: "b".repeat(64) },
      ],
    };
    const inventoryBytes = JSON.stringify({
      history,
      unknownUsage: 0,
      openReservations: 0,
    });
    fs.writeFileSync(inventory, inventoryBytes);
    const parentFile = path.join(root, "parent.jsonl");
    fs.writeFileSync(parentFile, "offline parent provenance\n");
    const admission = buildModelAdmissionContext({
      authorization: {
        mode,
        goalAction,
        delivery: "verify-only",
        parentAuthorizationEntryId: "approved",
        parentSessionFile: parentFile,
        unknownUsage: 0,
        openReservations: 0,
        historyProvenance: {
          file: inventory,
          sha256: sha(fs.readFileSync(inventory)),
        },
        deadlineMs: 3000,
      },
      parent: {
        authorizationEntryId: "approved",
        sessionId: "parent",
        file: parentFile,
        digest: sha(fs.readFileSync(parentFile)),
        usage: { total: 7 },
      },
      history,
      maxTokens: 1000,
      taskTokenReservation: 500,
      preparation: {
        mode: "request-driven",
        requestFile,
        requestSha256: sha(fs.readFileSync(requestFile)),
        sourceBase: base,
      },
      request,
      cwd,
      command: ["pi", "--no-skills", "--skill", selectedSkill],
    });
    assert.ok(
      Buffer.byteLength(request + "\n\n" + admission.context) <= 65536,
      "complete closed history must not consume the bounded model prompt",
    );
    assert.ok(admission.context.includes(inventory));
    assert.ok(admission.context.includes(sha(inventoryBytes)));
    assert.match(
      admission.context,
      /Historical closed usage 3 \(64 session sources, 1 closed executions\)/,
    );
    assert.match(
      admission.context,
      /Known committed actual 10; remaining before this L0 and Task reservations 990/,
    );
    assert.ok(
      !admission.context.includes(history.sources[0].file),
      "individual histories stay in the complete SHA-bound inventory, not duplicated inline",
    );
    assert.equal(fs.readFileSync(inventory, "utf8"), inventoryBytes);
    const modelRuntime = await sdk.ModelRuntime.create({
      credentials: new ai.InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: path.join(root, "models-store.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const model = {
      id: "offline",
      name: "offline",
      provider: "r31-no-network",
      api: "openai-responses",
      baseUrl: "http://127.0.0.1:1/never-used",
      reasoning: false,
      input: ["text"],
      contextWindow: 50000,
      maxTokens: 128,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    let received;
    let registered;
    const settingsManager = sdk.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [
        (pi) => {
          for (const name of [
            "subagent",
            "team_task_dispatch",
            "team_task_stage_integration",
          ])
            pi.registerTool(tool(name));
          pi.on("session_start", (_event, ctx) => {
            const sessionId = ctx.sessionManager.getSessionId();
            registered = selectTaskL0Tools(pi, {
              mode,
              compatible: true,
              sessionId,
              ownerSessionId: sessionId,
            });
          });
          pi.registerProvider("r31-no-network", {
            api: "openai-responses",
            baseUrl: model.baseUrl,
            apiKey: "nonsecret-fixture",
            models: [model],
            streamSimple: (_model, context) => {
              received = context;
              const message = {
                role: "assistant",
                api: model.api,
                provider: model.provider,
                model: model.id,
                content: [{ type: "text", text: "offline request observed" }],
                stopReason: "stop",
                timestamp: Date.now(),
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
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
              stream.push({ type: "done", reason: "stop", message });
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
      cwd,
      agentDir,
      modelRuntime,
      model,
      resourceLoader: loader,
      settingsManager,
      sessionManager: sdk.SessionManager.create(
        cwd,
        path.join(root, "sessions"),
      ),
    });
    t.after(() => session.dispose());
    const errors = [];
    await session.bindExtensions({
      mode: "print",
      onError: (error) => errors.push(error),
    });
    await session.prompt(`${request}\n\n${admission.context}`);
    assert.deepEqual(errors, []);
    assert.equal(
      registered.disposition,
      mode === "task-pi" ? "task-tools-only" : "unchanged",
    );
    assert.ok(received, "in-memory provider never reached");
    const user = received.messages.findLast((row) => row.role === "user");
    assert.match(JSON.stringify(user), /x-request-id/);
    assert.match(
      JSON.stringify(user),
      /Unknown campaign usage|unknown usage 0/,
    );
    assert.match(JSON.stringify(user), /SELECTED SKILL/);
    assert.match(JSON.stringify(user), /CURRENT L0 SPEC/);
    assert.match(
      JSON.stringify(user),
      /A closed FAILED\/CANCELLED execution cannot be accepted later/,
      "the closed-execution boundary must reach the model request",
    );
    assert.match(
      JSON.stringify(user),
      /Goal action expressly approved by owner/,
    );
    // Public providers now receive TranscriptContext: normalizeContext folds
    // tool declarations and prompt sections into system messages (not .tools).
    const systems = received.messages.filter((row) => row.role === "system");
    const activeTools = new Map();
    for (const system of systems) {
      for (const tool of system.toolsRemoved ?? [])
        activeTools.delete(tool.name);
      for (const tool of system.toolsAdded ?? [])
        activeTools.set(tool.name, tool);
    }
    assert.ok(activeTools.has("team_task_dispatch"));
    assert.equal(activeTools.has("subagent"), mode !== "task-pi");
    assert.ok(
      JSON.stringify(systems).includes("team-flow"),
      "selected native skill absent from Pi prompt",
    );
  });
}
