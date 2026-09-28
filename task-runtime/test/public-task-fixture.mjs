// Offline public-tool seam: real registration/handlers, native Agent loop and
// real Task ledger. Only Herdr/LLM/provider capability advertisement are fixtures.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import extension from "../../extensions/teams-orchestrator/index.mjs";
import { TaskOrchestrator } from "../orchestrator.mjs";
import { HerdrPort } from "../herdr-port.mjs";
import { runRpcAttempt } from "../e2e/run-todo-flow.mjs";
import { installNativeGoalFixture } from "./public-recovery-fixture.mjs";

// Transport-only replay of ACTUAL native public-handler events captured below.
// It cannot execute tools or supply an ideal rejection. This checks the same RPC
// observer used live, while external Goal/model/Herdr protocols remain fixtures.
export async function observePublicTaskEvents(
  root,
  cwd,
  events,
  name,
  { finalStatus = "paused" } = {},
) {
  const parent = path.join(root, "observer-parent.jsonl");
  fs.writeFileSync(
    parent,
    [
      { type: "session", version: 3, id: "fixture-parent", cwd },
      {
        type: "message",
        id: "approval",
        message: { role: "user", content: "offline observer test" },
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  const captured = path.join(root, `${name}-events.json`);
  fs.writeFileSync(
    captured,
    JSON.stringify(
      events.filter((e) =>
        ["tool_execution_start", "tool_execution_end"].includes(e.type),
      ),
    ),
  );
  const rpc = path.join(root, "observer-replay.cjs");
  fs.writeFileSync(
    rpc,
    `
const fs=require('node:fs');const reply=x=>process.stdout.write(JSON.stringify(x)+'\\n');let buffer='';
process.stdin.on('data',bytes=>{buffer+=bytes;let n;while((n=buffer.indexOf('\\n'))>=0){const x=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);
if(x.type==='get_state')reply({type:'response',id:x.id,success:true,data:{sessionId:'owner',model:{provider:'openai-codex',id:'gpt-5.6-luna'},isStreaming:false,pendingMessageCount:0}});
if(x.type==='get_session_stats')reply({type:'response',id:x.id,success:true,data:{sessionId:'owner',tokens:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
if(x.type==='get_commands')reply({type:'response',id:x.id,success:true,data:{commands:[]}});
if(x.type==='prompt'){
reply({type:'tool_execution_end',toolName:'create_goal',result:{details:{goal:{id:'observer-fixture',status:'active'}}}});
for(const event of JSON.parse(fs.readFileSync(process.argv[2],'utf8'))){reply(event);if(event.type==='tool_execution_end'&&event.isError)reply({type:'agent_settled'});}
reply({type:'tool_execution_end',toolName:'update_goal',result:{details:{goal:{id:'observer-fixture',status:${JSON.stringify(finalStatus)}}}}});
reply({type:'agent_settled'});
}}});`,
  );
  return runRpcAttempt({
    command: [process.execPath, rpc, captured],
    cwd,
    outputRoot: path.join(root, `${name}-observation`),
    prompt: "Observe already executed offline tool events only.",
    parentSessionFile: parent,
    authorizationEntryId: "approval",
    maxTokens: 1000,
    taskTokenReservation: 0,
    deadlineMs: 5000,
    sampleMs: 20,
    statsTimeoutMs: 500,
    killGraceMs: 30,
    env: { ...process.env, PI_GOAL_AUTO_CONFIRM: "1", TEAMS_E2E_CANARY: "1" },
  });
}

export function publicTaskPackages(root) {
  const host = fs.realpathSync(path.join(path.dirname(process.execPath), "pi"));
  const require = createRequire(host);
  for (const name of ["pi-subagents", "pi-goal-x"]) {
    const dir = path.join(root, "npm/node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name,
        version: "offline-fixture",
        pi: { extensions: ["index.mjs"] },
        peerDependencies: {},
        exports: { "./preflight": "./preflight.cjs" },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "index.mjs"),
      "// Capability fixture; never launched.\n",
    );
    fs.writeFileSync(
      path.join(dir, "preflight.cjs"),
      `exports.resolveSubagentLaunchContract = async input => ({ok:true,contract:{version:2,agent:{name:input.agent,source:'user'},context:'fresh',roots:{cwd:input.cwd},diagnostics:[],tools:{explicitAllowlist:true,effectiveAllowlist:['read','structured_output'],effectiveMcpTools:[],internalTools:['structured_output'],disableAmbientExtensions:true,fanoutAuthorized:false}}});\n`,
    );
  }
  // Some capability tests deliberately use root as the source workspace.
  // Copy the installed trusted loader: a source-root symlink must stay forbidden.
  fs.cpSync(
    path.dirname(require.resolve("jiti/package.json")),
    path.join(root, "npm/node_modules/jiti"),
    { recursive: true, dereference: true },
  );
}

export async function publicTaskFixture(
  t,
  { root, source, herdr, owner = "owner", nativeGoal = false },
) {
  const host = fs.realpathSync(path.join(path.dirname(process.execPath), "pi"));
  const { createJiti } = createRequire(host)("jiti");
  const load = createJiti(host);
  const { Agent } = await load.import("@earendil-works/pi-agent-core");
  const { createAssistantMessageEventStream } = await load.import(
    "@earendil-works/pi-ai",
  );
  publicTaskPackages(root);
  const env = {
    PI_CODING_AGENT_DIR: root,
    HERDR_ENV: "1",
    HERDR_PANE_ID: "fixture:parent",
    TEAMS_E2E_CANARY: "1",
    TEAMS_E2E_L0_MODE: undefined,
  };
  const before = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(HerdrPort.prototype, "capabilities", () => ({
    compatible: true,
  }));
  t.mock.method(HerdrPort.prototype, "start", (input) => herdr.start(input));
  t.mock.method(HerdrPort.prototype, "closeIdle", (paneId) => ({
    paneId,
    disposition: "closed",
  }));
  t.mock.method(HerdrPort.prototype, "status", () => ({ fixture: true }));
  t.mock.method(HerdrPort.prototype, "isIdle", () => true);
  let orchestrator, prepared;
  const prepare = TaskOrchestrator.prototype.prepare;
  t.mock.method(TaskOrchestrator.prototype, "prepare", function (...args) {
    orchestrator = this; // Observe the real instance; do not replace admission.
    prepared = prepare.apply(this, args);
    return prepared;
  });
  const tools = new Map(),
    handlers = new Map(),
    listeners = new Map();
  const goals = [
    {
      name: "update_goal",
      parameters: { properties: { status: { enum: ["complete"] } } },
    },
    {
      name: "update_goal_task",
      parameters: {
        properties: {
          task_id: { type: "string" },
          status: { enum: ["complete"] },
          updates: {
            items: {
              properties: {
                task_id: { type: "string" },
                status: { enum: ["complete"] },
              },
            },
          },
        },
      },
    },
  ];
  extension({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand() {},
    registerShortcut() {},
    on: (name, handler) => handlers.set(name, handler),
    getActiveTools: () => [...tools.keys(), ...goals.map((x) => x.name)],
    getAllTools: () => [...tools.values(), ...goals],
    events: {
      on(name, fn) {
        listeners.set(name, fn);
        return () => listeners.delete(name);
      },
      emit(_name, request) {
        assert.equal(
          request.method,
          "ping",
          "no native role/provider RPC in this fixture",
        );
        listeners.get(`subagents:rpc:v1:reply:${request.requestId}`)({
          version: 1,
          requestId: request.requestId,
          success: true,
          data: {
            version: 1,
            methods: ["status", "spawn", "stop"],
            events: { asyncComplete: "complete", processTerminal: "terminal" },
            capabilities: {
              status: true,
              asyncSpawn: true,
              stop: true,
              runtimeAcknowledgedExtensions: { version: 1 },
              processTerminalProof: { version: 1 },
            },
          },
        });
      },
    },
  });
  const ownerSessionFile = path.join(root, "owner-sessions", `${owner}.jsonl`);
  fs.mkdirSync(path.dirname(ownerSessionFile), { recursive: true });
  fs.writeFileSync(
    ownerSessionFile,
    JSON.stringify({
      type: "session",
      version: 3,
      id: owner,
      cwd: source,
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  let sessionFocus = "goal";
  const ctx = {
    cwd: source,
    sessionManager: {
      getSessionId: () => owner,
      getSessionFile: () => ownerSessionFile,
      getBranch: () => [
        {
          type: "custom",
          customType: "pi-goal-focus",
          data: { version: 1, focusedGoalId: sessionFocus, reason: "selected" },
        },
      ],
    },
    modelRegistry: { getAvailable: () => [] },
    ui: { setStatus() {} },
  };
  const goalFixture = nativeGoal
    ? await installNativeGoalFixture(t, { root, source, tools, ctx })
    : null;
  await handlers.get("session_start")({}, ctx);
  t.after(() => handlers.get("session_shutdown")());
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
    handlers.get("tool_call")(
      { toolName: toolCall.name, toolCallId: toolCall.id, input: args },
      ctx,
    );
  agent.afterToolCall = ({ toolCall, args, result, isError }) =>
    handlers.get("tool_result")(
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
    get orchestrator() {
      return orchestrator;
    },
    get prepared() {
      return prepared;
    },
    tools,
    events,
    agent,
    goalFixture,
    setGoalFocus(id) {
      sessionFocus = id;
    },
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
