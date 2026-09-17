import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { taskToolParameters } from "../task-tool-inputs.mjs";
import {
  assertBudget,
  parentUsage,
  publicCommand,
  runRpcAttempt,
} from "../e2e/run-todo-flow.mjs";

const usage = (n) => ({
  input: n,
  output: 0,
  cacheRead: n,
  cacheWrite: 0,
  totalTokens: n * 2,
});
const row = (id, n) => ({
  type: "message",
  id,
  message: { role: "assistant", usage: usage(n), stopReason: "stop" },
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-control-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  const parent = path.join(root, "parent.jsonl");
  const entries = [
    { type: "session", version: 3, id: "parent-1", cwd },
    row("before", 999999),
    {
      type: "message",
      id: "approval",
      message: {
        role: "toolResult",
        toolName: "ask_user",
        isError: false,
        content: [],
      },
    },
    row("after", 5),
  ];
  const save = () =>
    fs.writeFileSync(parent, entries.map(JSON.stringify).join("\n") + "\n");
  save();
  return { root, cwd, parent, entries, save };
}

function fakeRpc(f) {
  const file = path.join(f.root, "fake-rpc.cjs");
  fs.writeFileSync(
    file,
    `
const fs = require('node:fs');
const reply = x => process.stdout.write(JSON.stringify(x) + '\\n');
let buffer='', spent=0, delayed=false, drained=false;
process.stdin.on('data', bytes => {
 buffer += bytes;
 let newline;
 while ((newline=buffer.indexOf('\\n')) >= 0) {
  const value=JSON.parse(buffer.slice(0,newline)); buffer=buffer.slice(newline+1);
  if(value.type==='get_state') reply({type:'response',id:value.id,success:true,data:{sessionId:'root-1',model:{provider:'antigravity',id:process.env.SCENARIO==='wrong-model'?'gemini-3.7-flash':'gemini-3.8-flash'}}});
  if(value.type==='get_session_stats') {
   if(process.env.SCENARIO==='lost-final'&&spent===30) continue;
   const answer={type:'response',id:value.id,success:true,data:{sessionId:'root-1',tokens:process.env.SCENARIO==='unknown'&&spent ? {total:spent} : {input:spent,output:0,cacheRead:0,cacheWrite:0,total:spent}}};
   if(['stale','busy'].includes(process.env.SCENARIO)&&spent===20&&!delayed) { delayed=true; setTimeout(()=>reply(answer),180); }
   else reply(answer);
  }
  if(value.type==='get_commands') reply({type:'response',id:value.id,success:true,data:{commands:process.env.SCENARIO==='drain-missing'?[]:[{name:'teams-e2e-drain'}]}});
  if(value.type==='prompt' && value.message.startsWith('/teams-e2e-drain ')) {
   const input=JSON.parse(value.message.slice('/teams-e2e-drain '.length));
   fs.writeFileSync(process.env.MARKER+'.drain', JSON.stringify(input));
   if(process.env.SCENARIO==='drain-hang') continue;
   setTimeout(()=>{ drained=true;reply({type:'extension_ui_request',method:'setWidget',widgetKey:'teams-e2e-drain',widgetLines:['TEAMS_E2E_DRAIN:'+JSON.stringify({version:1,requestId:input.requestId,ownerSessionId:'root-1',rows:process.env.SCENARIO==='drain-omitted'?[]:[{executionId:'execution-1',reservationOpen:false}],settled:true})]});},40);
   continue;
  }
  if(value.type==='prompt') {
   fs.writeFileSync(process.env.MARKER, value.message);
   if(process.env.SCENARIO.startsWith('drain') || process.env.SCENARIO.startsWith('signal-') || process.env.SCENARIO.startsWith('retry-') || process.env.SCENARIO.startsWith('summary-') || ['provider-no-retry','task-error','exit-with-task','blocked-result'].includes(process.env.SCENARIO)) {
    reply({type:'tool_execution_start',toolName:'team_task_dispatch'});
    reply({type:'tool_execution_end',toolName:'team_task_dispatch',result:{details:{executionId:'execution-1'}}});
   }
   spent=20;
   reply({type:'tool_execution_end',toolName:'create_goal',result:{details:{goal:{id:'goal-1',status:'active'}},terminate:true}});
   reply({type:'agent_end'}); reply({type:'agent_settled'});
   if(process.env.SCENARIO.startsWith('signal-')) { setTimeout(()=>process.kill(process.ppid,process.env.SCENARIO.slice(7)),40); continue; }
   if(process.env.SCENARIO==='task-error') { reply({type:'tool_execution_end',toolName:'team_task_collect',isError:true,result:{content:[{type:'text',text:'Worker exited without a result'}]}}); continue; }
   if(process.env.SCENARIO.startsWith('input-')) {
    const scenario=process.env.SCENARIO;
    const id='506392bc-5313-4787-8a40-901fd4f11420';
    reply({type:'tool_execution_end',toolName:'team_task_accept',result:{details:{receipt:{executionId:id,decision:'accepted'}}}});
    reply({type:'tool_execution_end',toolName:'update_goal_task',result:{details:{goal:{id:'goal-1',status:'active',taskList:{tasks:[{id:'todo-e2e',status:'complete'}]}}}}});
    const args={execution_id:scenario==='input-valid-failure'?id:id+'}}]} malformed tool text'};
    reply({type:'tool_execution_start',toolName:'team_task_status',toolCallId:'status-1',args});
    reply({type:'tool_execution_end',toolName:scenario==='input-foreign-tool'?'team_task_accept':'team_task_status',toolCallId:scenario==='input-unmatched'?'other':'status-1',isError:true,result:{content:[{type:'text',text:'Validation failed for tool team_task_status'}]}});
    // Even after settlement, a later Goal continuation must not inherit a fatal latch.
    reply({type:'agent_settled'});
    if(['input-unmatched','input-foreign-tool','input-valid-failure','input-deadline'].includes(scenario)) continue;
    setTimeout(()=>{
     if(scenario==='input-budget') { spent=600;return; }
     fs.writeFileSync(process.env.MARKER+'.corrected','yes');
     reply({type:'tool_execution_start',toolName:'team_task_status',toolCallId:'status-2',args:{execution_id:id}});
     reply({type:'tool_execution_end',toolName:'team_task_status',toolCallId:'status-2',result:{details:{executionId:id,state:'ACCEPTED',reservationOpen:false}}});
     reply({type:'tool_execution_end',toolName:'update_goal',result:{details:{goal:{id:'goal-1',status:'complete'}}}});
     reply({type:'agent_settled'});
    },40);
    continue;
   }
   if(process.env.SCENARIO.startsWith('review-')) {
    const valid=process.env.SCENARIO==='review-unknown';
    const args={execution_id:'506392bc-5313-4787-8a40-901fd4f11420',action:'start-review',plan_digest:'a'.repeat(64),...(valid?{key:'final-source-review'}:{})};
    reply({type:'tool_execution_start',toolName:'team_task_stage_integration',toolCallId:'review-1',args});
    reply({type:'tool_execution_end',toolName:'team_task_stage_integration',toolCallId:process.env.SCENARIO==='review-unmatched'?'other':'review-1',isError:true,result:{content:[{type:'text',text:valid?'review launch outcome unknown; reconcile before retry':'invalid review wave key'}]}});
    reply({type:'agent_settled'});
    if(valid || process.env.SCENARIO==='review-unmatched') continue;
    setTimeout(()=>{
     fs.writeFileSync(process.env.MARKER+'.corrected','yes');
     reply({type:'tool_execution_start',toolName:'team_task_stage_integration',toolCallId:'review-2',args:{...args,key:'final-source-review'}});
     reply({type:'tool_execution_end',toolName:'team_task_stage_integration',toolCallId:'review-2',result:{details:{key:'final-source-review',runId:'native-review'}}});
    },20);
   }
   if(process.env.SCENARIO==='exit-with-task') { process.exitCode=3;process.stdin.destroy();continue; }
   if(process.env.SCENARIO==='blocked-result') reply({type:'tool_execution_end',toolName:'team_task_collect',result:{details:{executionId:'execution-1',state:'RESULT_READY',candidate:{outcome:'blocked'}}}});
   if(process.env.SCENARIO==='idle') continue;
   const scenario=process.env.SCENARIO;
   if(scenario.startsWith('retry-') || scenario.startsWith('summary-') || scenario==='provider-no-retry') {
    const summary=scenario.startsWith('summary-');
    const success=scenario.endsWith('-success');
    const failure={role:'assistant',stopReason:'error',errorMessage:'fetch failed'};
    if(!summary) reply({type:'message_end',message:failure});
    reply({type:'agent_end',messages:summary?[]:[failure],willRetry:!summary&&scenario!=='provider-no-retry'});
    if(scenario==='provider-no-retry') { reply({type:'agent_settled'}); continue; }
    reply({type:summary?'summarization_retry_scheduled':'auto_retry_start',attempt:1,maxAttempts:3,delayMs:80,errorMessage:'fetch failed'});
    if(scenario==='retry-deadline') continue;
    setTimeout(()=>{
     spent=scenario==='retry-budget'?600:40;
     if(scenario==='retry-budget') { reply({type:'auto_retry_start',attempt:2,maxAttempts:3,delayMs:80,errorMessage:'fetch failed'}); return; }
     if(summary) {
      reply({type:'summarization_retry_attempt_start',source:'compaction',reason:'threshold'});
      reply({type:'summarization_retry_finished'});
      reply({type:'compaction_end',reason:'threshold',result:success?{summary:'fixture'}:null,aborted:false,willRetry:false,...(success?{}:{errorMessage:'summary fetch failed'})});
     } else {
      reply({type:'message_end',message:success?{role:'assistant',stopReason:'stop',content:[]}:failure});
      reply({type:'auto_retry_end',success,attempt:success?1:3,...(success?{}:{finalError:'fetch failed'})});
     }
     if(success) {
      fs.writeFileSync(process.env.MARKER+'.recovered','yes');
      reply({type:'tool_execution_end',toolName:'update_goal',result:{details:{goal:{id:'goal-1',status:'complete'}}}});
     }
     reply({type:'agent_end',messages:[],willRetry:false});reply({type:'agent_settled'});
    },80);
    continue;
   }
   setTimeout(() => {
    if(['stale','lost-final'].includes(process.env.SCENARIO)) spent=30;
    if(process.env.SCENARIO==='parent-cost') {
     fs.appendFileSync(process.env.PARENT_FILE, JSON.stringify({type:'message',id:'prep-later',message:{role:'assistant',usage:{input:1,output:0,cacheRead:999,cacheWrite:0,totalTokens:1000}}})+'\\n');
     return;
    }
    if(process.env.SCENARIO==='error') reply({type:'tool_execution_end',toolName:'set_goal_tasks',isError:true,result:{content:[{type:'text',text:"Cannot read properties of undefined (reading 'decision')"}]}});
    reply({type:'tool_execution_end',toolName:'update_goal',result:{details:{goal:{id:'goal-1',status:process.env.SCENARIO==='complete'?'complete':'paused',autoContinue:false}},terminate:true}});
    reply({type:'agent_end'}); reply({type:'agent_settled'});
   }, process.env.SCENARIO==='busy'?260:80);
  }
 }
});
process.stdin.on('end', () => {fs.writeFileSync(process.env.MARKER+'.closed', JSON.stringify({drained}));process.exit(0);});
`,
  );
  return file;
}
function options(f, scenario = "error") {
  return {
    command: [process.execPath, fakeRpc(f)],
    cwd: f.cwd,
    outputRoot: path.join(f.root, "attempt"),
    prompt: "authorized prepared Todo test\u2028not a delimiter",
    parentSessionFile: f.parent,
    authorizationEntryId: "approval",
    maxTokens: 1000,
    taskTokenReservation: 500,
    deadlineMs: 3000,
    sampleMs: 20,
    killGraceMs: 50,
    env: {
      ...process.env,
      PI_GOAL_AUTO_CONFIRM: "1",
      TEAMS_E2E_CANARY: "1",
      SCENARIO: scenario,
      PARENT_FILE: f.parent,
      MARKER: path.join(f.root, "prompt-sent"),
    },
  };
}

test("observer signals drain the live owner and persist final receipts", (t) => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const f = fixture(t);
    const input = { ...options(f, `signal-${signal}`), drainTimeoutMs: 250 };
    const source = new URL("../e2e/run-todo-flow.mjs", import.meta.url).href;
    const run = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {runRpcAttempt} from ${JSON.stringify(source)}; await runRpcAttempt(${JSON.stringify(input)});`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(input.outputRoot, "rpc-observation.json")),
    );
    assert.equal(receipt.stopReason, `signal-${signal}`);
    assert.equal(receipt.taskDrain.settled, true);
    assert.equal(receipt.processReaped, true);
    assert.equal(
      JSON.parse(fs.readFileSync(input.env.MARKER + ".closed")).drained,
      true,
    );
  }
});

test("uncatchable observer kill retains its last checkpoint without inventing cleanup", (t) => {
  const f = fixture(t);
  const input = { ...options(f, "signal-SIGKILL"), drainTimeoutMs: 250 };
  const source = new URL("../e2e/run-todo-flow.mjs", import.meta.url).href;
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runRpcAttempt} from ${JSON.stringify(source)}; await runRpcAttempt(${JSON.stringify(input)});`,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(run.signal, "SIGKILL", run.stderr);
  const receipt = JSON.parse(
    fs.readFileSync(path.join(input.outputRoot, "rpc-observation.json")),
  );
  assert.ok(receipt.pid > 0);
  assert.equal(receipt.sessionId, "root-1");
  assert.deepEqual(receipt.executionIds, ["execution-1"]);
  assert.equal(receipt.processReaped, false);
  assert.notEqual(receipt.taskDrain?.settled, true);
});

test("Task tool failure drains without waiting for agent_settled", async (t) => {
  const f = fixture(t);
  const report = await runRpcAttempt({
    ...options(f, "task-error"),
    drainTimeoutMs: 250,
  });
  assert.equal(report.stopReason, "task-tool-failure");
  assert.equal(report.taskDrain.settled, true);
});

test("review selector correction reaches the next call; unknown/unmatched dispatch still stops", async (t) => {
  for (const scenario of [
    "review-corrected",
    "review-unknown",
    "review-unmatched",
  ]) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      const input = options(f, scenario);
      const report = await runRpcAttempt(input);
      const corrected = scenario === "review-corrected";
      assert.equal(
        report.stopReason,
        corrected ? "goal-paused" : "task-tool-failure",
      );
      assert.equal(fs.existsSync(input.env.MARKER + ".corrected"), corrected);
      assert.equal(
        report.faults[0].disposition,
        corrected ? "pre-dispatch-input" : undefined,
      );
      assert.equal(report.fullE2EPassed, false);
    });
  }
});

test("schema-rejected input can recover after acceptance without replay; valid-input failures and limits still stop", async (t) => {
  for (const [scenario, reason] of [
    ["input-corrected", "goal-complete"],
    ["input-valid-failure", "task-tool-failure"],
    ["input-unmatched", "task-tool-failure"],
    ["input-foreign-tool", "task-tool-failure"],
    ["input-budget", "control-failure"],
    ["input-deadline", "deadline"],
  ]) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      const input = { ...options(f, scenario), deadlineMs: 700 };
      const report = await runRpcAttempt(input);
      assert.equal(report.stopReason, reason);
      assert.equal(
        fs.existsSync(input.env.MARKER + ".corrected"),
        scenario === "input-corrected",
      );
      const knownInput = [
        "input-corrected",
        "input-budget",
        "input-deadline",
      ].includes(scenario);
      assert.equal(
        report.faults[0].disposition,
        knownInput ? "pre-dispatch-input" : undefined,
      );
      assert.equal(report.fullE2EPassed, false); // Observer is not the auditor.
      const events = fs
        .readFileSync(path.join(input.outputRoot, "stdout.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      assert.equal(
        events.filter((e) => e.toolName === "team_task_accept").length,
        scenario === "input-foreign-tool" ? 2 : 1,
      );
      assert.equal(
        events.filter(
          (e) =>
            e.toolName === "team_task_dispatch" ||
            e.toolName === "team_task_run_checks",
        ).length,
        0,
      );
      if (scenario === "input-corrected")
        assert.equal(report.goal.status, "complete");
    });
  }
});

test("native retry can recover without cancelling the execution; final failures and limits still drain", async (t) => {
  for (const scenario of [
    "retry-success",
    "retry-exhausted",
    "retry-budget",
    "retry-deadline",
    "summary-success",
    "summary-failed",
    "provider-no-retry",
  ]) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      const input = { ...options(f, scenario), drainTimeoutMs: 250 };
      if (scenario === "retry-deadline") input.deadlineMs = 700;
      const report = await runRpcAttempt(input);
      const success = scenario.endsWith("-success");
      assert.equal(fs.existsSync(input.env.MARKER + ".recovered"), success);
      assert.equal(
        report.stopReason,
        success
          ? "goal-complete"
          : scenario === "retry-deadline"
            ? "deadline"
            : scenario === "retry-budget"
              ? "control-failure"
              : "provider-failure",
      );
      assert.deepEqual(report.executionIds, ["execution-1"]);
      assert.equal(report.taskDrain.settled, true);
      assert.equal(report.processReaped, true);
      assert.equal(
        report.fullE2EPassed,
        false,
        "retry recovery is not acceptance",
      );
      if (success) {
        assert.deepEqual(report.faults, []);
        assert.equal(report.rootUsage.total, 40);
        assert.equal(report.reportedTokens, 50);
      } else if (["retry-exhausted", "summary-failed"].includes(scenario)) {
        assert.match(JSON.stringify(report.faults), /fetch failed/);
        assert.equal(
          report.rootUsage.total,
          40,
          "retain final failed-attempt usage",
        );
      }
      const events = fs
        .readFileSync(path.join(input.outputRoot, "stdout.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(
        events.filter(
          (e) =>
            e.toolName === "team_task_dispatch" &&
            e.type === "tool_execution_start",
        ).length,
        1,
      );
      await assert.rejects(runRpcAttempt(input), /EEXIST/);
    });
  }
});

test("native Pi ends a review waiting turn without abort and can continue on completion", async () => {
  const { result } = await import(
    "../../extensions/teams-orchestrator/index.mjs"
  );
  const { createJiti } = createRequire(
    path.join(os.homedir(), ".pi/agent/npm/package.json"),
  )("jiti");
  const loader = createJiti(
    fs.realpathSync(process.execPath.replace(/\/node$/, "/pi")),
  );
  const { agentLoop } = await loader.import("@earendil-works/pi-agent-core");
  for (const terminate of [false, true]) {
    let requests = 0;
    const details = {
      state: "running",
      verdict: "pending",
      key: "review",
      planDigest: "a".repeat(64),
    };
    const tool = {
      name: "fixture_review",
      label: "Fixture",
      description: "No dispatch or model call",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute() {
        return result(
          "Await native completion; not acceptance.",
          details,
          terminate,
        );
      },
    };
    const streamFn = () => {
      requests++;
      const message = {
        role: "assistant",
        api: "fixture",
        provider: "fixture",
        model: "fixture",
        timestamp: Date.now(),
        content:
          requests === 1
            ? [
                {
                  type: "toolCall",
                  id: "review-1",
                  name: tool.name,
                  arguments: {},
                },
              ]
            : [{ type: "text", text: "Completion can be collected." }],
        stopReason: requests === 1 ? "toolUse" : "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: message };
          yield { type: "done", reason: message.stopReason, message };
        },
        async result() {
          return message;
        },
      };
    };
    const context = { systemPrompt: "Fixture", messages: [], tools: [tool] };
    const config = {
      model: { id: "fixture", provider: "fixture", api: "fixture" },
      convertToLlm: (messages) => messages,
    };
    let ended;
    for await (const event of agentLoop(
      [{ role: "user", content: "Review", timestamp: 1 }],
      context,
      config,
      undefined,
      streamFn,
    )) {
      if (event.type === "agent_end") ended = event.messages;
    }
    assert.equal(requests, terminate ? 1 : 2);
    assert.deepEqual(
      ended.find((message) => message.role === "toolResult").details,
      details,
    );
    assert.equal(
      ended.some((message) =>
        ["error", "aborted"].includes(message.stopReason),
      ),
      false,
    );
    if (terminate) {
      for await (const event of agentLoop(
        [{ role: "user", content: "Native completion", timestamp: 2 }],
        { ...context, messages: ended },
        config,
        undefined,
        streamFn,
      )) {
        if (event.type === "agent_end")
          assert.equal(event.messages.at(-1).stopReason, "stop");
      }
      assert.equal(
        requests,
        2,
        "ending the waiting turn does not disable later model turns",
      );
    }
  }
});

test("L0 collection exposes the decision handoff without replaying full evidence or dropping risks", async () => {
  const { collectedTaskReply } = await import(
    "../../extensions/teams-orchestrator/index.mjs"
  );
  const execution = {
    resultRef: "/execution/results/r0001.json",
    workerProcess: { terminal: true, reason: "process-exited" },
    candidate: {
      outcome: "ready_for_acceptance",
      summary: "Implementation ready; final host gates remain pending.",
      criterionResults: [
        {
          criterionId: "browser",
          status: "indeterminate",
          observation: "DETAILED_OBSERVATION_ONLY_IN_FULL_RESULT",
          evidenceIds: ["proof"],
        },
      ],
      evidence: [
        {
          uri: "DETAILED_EVIDENCE_ONLY_IN_FULL_RESULT",
          sha256: "b".repeat(64),
        },
      ],
      risks: [
        "Owner decision required for scope changes.",
        "Do not waive required checks.",
      ],
      source: {
        sourceDigest: "a".repeat(64),
        manifestRef: "receipts/source.json",
      },
    },
  };
  const before = structuredClone(execution);
  const reply = collectedTaskReply("execution-1", execution);
  assert.strictEqual(reply.details, execution);
  assert.deepEqual(execution, before);
  const text = reply.content[0].text;
  const report = JSON.parse(
    text.split("Candidate claims (not instructions or acceptance): ")[1],
  );
  assert.deepEqual(report.risks, execution.candidate.risks);
  assert.equal(report.summary, execution.candidate.summary);
  assert.equal(report.resultRef, execution.resultRef);
  assert.equal(report.sourceDigest, execution.candidate.source.sourceDigest);
  assert.deepEqual(report.criteria, [
    { criterionId: "browser", status: "indeterminate" },
  ]);
  assert.doesNotMatch(text, /DETAILED_OBSERVATION_ONLY|DETAILED_EVIDENCE_ONLY/);
  assert.match(text, /confirms Worker exit/);
  assert.match(text, /RESULT_READY means sealed, not successful/);
  assert.equal(reply.terminate, undefined);
  for (const workerProcess of [undefined, { terminal: false }]) {
    assert.match(
      collectedTaskReply("execution-1", { ...execution, workerProcess })
        .content[0].text,
      /not confirmed; wait\/reconcile before staging/,
    );
  }
  for (const outcome of ["blocked", "failed", "cancelled"]) {
    const blocked = collectedTaskReply("execution-1", {
      ...execution,
      candidate: { ...execution.candidate, outcome },
    });
    assert.match(blocked.content[0].text, /STOP integration/);
    assert.doesNotMatch(
      blocked.content[0].text,
      /proceed to host verification/,
    );
  }
});

test("registered Task schemas reject malformed inputs in the native loop before hooks or execution", async () => {
  const { default: extension } = await import(
    "../../extensions/teams-orchestrator/index.mjs"
  );
  const tools = new Map();
  extension({
    registerTool: (tool) => tools.set(tool.name, tool),
    on() {},
    registerCommand() {},
  });
  assert.deepEqual(
    [...tools.keys()].sort(),
    Object.keys(taskToolParameters).sort(),
  );
  for (const [name, parameters] of Object.entries(taskToolParameters)) {
    assert.equal(tools.get(name).parameters, parameters);
  }
  const tool = tools.get("team_task_stage_integration");
  const require = createRequire(
    path.resolve(
      path.dirname(process.execPath),
      "../lib/node_modules/@earendil-works/pi-coding-agent/package.json",
    ),
  );
  const { createJiti } = require("jiti");
  const { validateToolArguments } = await createJiti(
    path.resolve(
      path.dirname(process.execPath),
      "../lib/node_modules/@earendil-works/pi-coding-agent/package.json",
    ),
  ).import("@earendil-works/pi-ai");
  const validate = (args) =>
    validateToolArguments(tool, {
      type: "toolCall",
      id: "review-input",
      name: tool.name,
      arguments: args,
    });
  for (const action of ["start-review", "collect-review"]) {
    const args = {
      execution_id: "84b05b32-f783-4e48-90bc-5d8d25bc5b4e",
      action,
      key: "final-source-review",
      plan_digest: "a".repeat(64),
    };
    assert.deepEqual(validate(args), args);
    for (const field of ["key", "plan_digest"]) {
      const missing = { ...args };
      delete missing[field];
      assert.throws(() => validate(missing), /Validation failed/);
    }
    await assert.rejects(
      tool.execute("good", args, undefined, undefined, {}),
      /Integration unavailable/,
    );
  }
  assert.doesNotThrow(() =>
    validate({
      execution_id: "84b05b32-f783-4e48-90bc-5d8d25bc5b4e",
      action: "stage",
    }),
  );
});

test("native schema failure never calls authorization hooks or the tool; next valid input uses them normally", async () => {
  const host = fs.realpathSync(path.join(path.dirname(process.execPath), "pi"));
  const { createJiti } = createRequire(host)("jiti");
  const { runAgentLoop } = await createJiti(host).import(
    "@earendil-works/pi-agent-core",
  );
  const id = "506392bc-5313-4787-8a40-901fd4f11420";
  let executions = 0,
    hooks = 0,
    turn = 0;
  const events = [];
  const tool = {
    name: "team_task_status",
    description: "fixture ledger read",
    parameters: taskToolParameters.team_task_status,
    execute: async (_id, args) => {
      executions++;
      assert.equal(args.execution_id, id);
      return {
        content: [{ type: "text", text: "ACCEPTED, reservation closed" }],
        details: {},
      };
    },
  };
  await runAgentLoop(
    [{ role: "user", content: "fixture", timestamp: 1 }],
    { systemPrompt: "fixture", messages: [], tools: [tool] },
    {
      model: { provider: "fixture", api: "fixture" },
      convertToLlm: (messages) => messages,
      beforeToolCall: () => {
        hooks++;
      },
    },
    (event) => {
      events.push(event);
    },
    undefined,
    () => {
      const n = turn++;
      assert.ok(n < 3, "bounded zero-provider script");
      const message = {
        role: "assistant",
        api: "fixture",
        provider: "fixture",
        model: "fixture",
        timestamp: 1,
        content:
          n < 2
            ? [
                {
                  type: "toolCall",
                  id: `call-${n}`,
                  name: tool.name,
                  arguments: {
                    execution_id: n === 0 ? id + "}}]} malformed text" : id,
                  },
                },
              ]
            : [],
        stopReason: n < 2 ? "toolUse" : "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
      };
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => message,
      };
    },
  );
  const results = events.filter((e) => e.type === "tool_execution_end");
  assert.equal(results.length, 2);
  assert.equal(results[0].isError, true);
  assert.match(results[0].result.content[0].text, /Validation failed/);
  assert.equal(results[1].isError, false);
  assert.equal(executions, 1);
  assert.equal(hooks, 1);
});

test("unexpected host exit persists identity and does not claim Task cleanup", async (t) => {
  const f = fixture(t);
  const report = await runRpcAttempt({
    ...options(f, "exit-with-task"),
    drainTimeoutMs: 250,
  });
  assert.equal(report.stopReason, "unexpected-process-exit");
  assert.deepEqual(report.executionIds, ["execution-1"]);
  assert.equal(report.sessionId, "root-1");
  assert.match(report.cleanup, /unresolved/);
  assert.notEqual(report.taskDrain?.settled, true);
});

test("blocked candidate is recorded separately from RESULT_READY and Goal acceptance", async (t) => {
  const f = fixture(t);
  const report = await runRpcAttempt({
    ...options(f, "blocked-result"),
    drainTimeoutMs: 250,
  });
  assert.equal(report.candidateOutcome, "blocked");
  assert.equal(report.stopReason, "goal-paused");
  assert.equal(report.fullE2EPassed, false);
});

test("live owner drains before observer closes L0 stdin", async (t) => {
  const f = fixture(t);
  const input = { ...options(f, "drain"), drainTimeoutMs: 250 };
  const report = await runRpcAttempt(input);
  assert.equal(report.taskDrain.settled, true);
  assert.equal(report.taskDrain.rows[0].executionId, "execution-1");
  assert.equal(
    JSON.parse(fs.readFileSync(input.env.MARKER + ".closed")).drained,
    true,
  );
  assert.equal(report.processReaped, true);
  assert.equal(report.fullE2EPassed, false);
});

test("unknown or incomplete owner drain cannot become successful cleanup", async (t) => {
  for (const scenario of ["drain-hang", "drain-omitted"]) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      const report = await runRpcAttempt({
        ...options(f, scenario),
        drainTimeoutMs: 180,
      });
      assert.equal(report.taskDrain.settled, false);
      assert.equal(report.taskDrain.disposition, "unknown-timeout");
      assert.match(report.cleanup, /unresolved/);
    });
  }
});

test("missing owner drain capability is rejected before any model prompt", async (t) => {
  const f = fixture(t);
  const input = { ...options(f, "drain-missing"), drainTimeoutMs: 180 };
  const report = await runRpcAttempt(input);
  assert.equal(report.modelPromptSent, false);
  assert.equal(fs.existsSync(input.env.MARKER), false);
  assert.ok(
    report.faults.some((value) =>
      String(value).includes("drain command unavailable"),
    ),
  );
});

test("parent accounting starts at the approved entry and includes cache, tools and compaction", (t) => {
  const f = fixture(t);
  f.entries.push({
    type: "message",
    id: "nested",
    message: { role: "toolResult", usage: usage(3) },
  });
  f.entries.push({ type: "compaction", id: "summary", usage: usage(4) });
  f.save();
  const snapshot = parentUsage(f.parent, "approval");
  assert.equal(snapshot.usage.total, 24);
  assert.equal(snapshot.usage.cacheRead, 12);
  assert.throws(
    () => assertBudget(snapshot, 20, 100, 144),
    /aggregate budget exhausted/,
  );
  assert.equal(assertBudget(snapshot, 20, 100, 145), 144);
  f.entries.push(row("later", 2));
  f.save();
  assert.equal(parentUsage(f.parent, "approval", snapshot).usage.total, 28);
  f.entries[1].message.usage = usage(1);
  f.save();
  assert.throws(
    () => parentUsage(f.parent, "approval", snapshot),
    /shrank|prefix changed/,
  );
});

test("missing approval, partial data and unknown costs cannot become zero", (t) => {
  const f = fixture(t);
  assert.throws(
    () => parentUsage(f.parent, "missing"),
    /unique parent authorization/,
  );
  f.entries.push({ type: "compaction", id: "unknown" });
  f.save();
  assert.throws(() => parentUsage(f.parent, "approval"), /missing or unknown/);
  fs.appendFileSync(f.parent, '{"type":');
  assert.throws(
    () => parentUsage(f.parent, "approval"),
    /Invalid parent session JSON/,
  );
});

test("unexpected L0 model is rejected before the first model prompt", async (t) => {
  const f = fixture(t);
  const input = options(f, "wrong-model");
  const report = await runRpcAttempt(input);
  assert.equal(report.modelPromptSent, false);
  assert.equal(fs.existsSync(input.env.MARKER), false);
  assert.equal(report.expectedModel, "antigravity/gemini-3.8-flash");
  assert.ok(
    report.faults.some((value) => String(value).includes("L0 model differs")),
  );
});

test("explicit native confirmation and total-budget admission precede Pi spawn", async (t) => {
  const f = fixture(t);
  const input = options(f);
  await assert.rejects(
    runRpcAttempt({
      ...input,
      env: { ...input.env, PI_GOAL_AUTO_CONFIRM: undefined },
    }),
    /explicitly approved PI_GOAL_AUTO_CONFIRM=1/,
  );
  await assert.rejects(
    runRpcAttempt({ ...input, maxTokens: 510 }),
    /aggregate budget exhausted/,
  );
  assert.equal(fs.existsSync(input.outputRoot), false);
  assert.equal(fs.existsSync(input.env.MARKER), false);
  fs.mkdirSync(path.join(f.cwd, ".pi", "goals"), { recursive: true });
  await assert.rejects(runRpcAttempt(input), /without existing Goals/);
});

test("history is charged at admission, running samples and final stats without resetting the ceiling", async (t) => {
  for (const [scenario, maxTokens, reason] of [
    ["complete", 1000, "goal-complete"],
    ["stale", 640, "control-failure"],
    ["complete", 610, "pre-spawn"],
  ]) {
    const f = fixture(t);
    const file = path.join(f.root, "previous-worker.jsonl");
    const bytes = Buffer.from(
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "previous-worker",
          cwd: f.cwd,
        }),
        JSON.stringify(row("old-usage", 50)),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(file, bytes);
    const input = {
      ...options(f, scenario),
      maxTokens,
      historicalSessions: [
        { file, sha256: createHash("sha256").update(bytes).digest("hex") },
      ],
    };
    if (reason === "pre-spawn") {
      await assert.rejects(runRpcAttempt(input), /aggregate budget exhausted/);
      assert.equal(fs.existsSync(input.env.MARKER), false);
      continue;
    }
    const report = await runRpcAttempt(input);
    assert.equal(report.stopReason, reason);
    assert.equal(report.history.totals.total, 100);
    assert.equal(report.maxTokens, maxTokens);
    assert.equal(
      report.committedTokens,
      100 + report.parent.usage.total + report.rootUsage.total + 500,
    );
    assert.equal(
      report.reportedTokens,
      100 + report.parent.usage.total + report.rootUsage.total,
    );
  }
});

test("public launch uses package entries and explicit persistent L0 model selection", (t) => {
  const f = fixture(t);
  for (const name of ["pi-goal-x", "pi-subagents"]) {
    const root = path.join(f.root, "npm", "node_modules", name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ pi: { extensions: ["entry.ts"] } }),
    );
    fs.writeFileSync(path.join(root, "entry.ts"), "");
  }
  const command = publicCommand(f.root, path.join(f.root, "sessions"));
  assert.deepEqual(command.slice(1, 5), [
    "--model",
    "antigravity/gemini-3.8-flash",
    "--mode",
    "rpc",
  ]);
  assert.ok(
    command.includes(
      path.join(f.root, "npm", "node_modules", "pi-goal-x", "entry.ts"),
    ),
  );
  assert.equal(command.filter((value) => value === "--model").length, 1);
  const selectedRoot = path.join(f.root, "selected");
  fs.mkdirSync(selectedRoot);
  const manifest = path.join(selectedRoot, "package.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({ name: "pi-subagents", pi: { extensions: ["entry.mjs"] } }),
  );
  const entry = path.join(selectedRoot, "entry.mjs");
  fs.writeFileSync(entry, "");
  const selected = publicCommand(f.root, path.join(f.root, "sessions"), entry);
  assert.ok(selected.includes(entry));
  assert.ok(
    !selected.includes(
      path.join(f.root, "npm/node_modules/pi-subagents/entry.ts"),
    ),
  );
  fs.writeFileSync(
    manifest,
    JSON.stringify({ name: "foreign", pi: { extensions: ["entry.mjs"] } }),
  );
  assert.throws(
    () => publicCommand(f.root, path.join(f.root, "sessions"), entry),
    /public subagents package required/,
  );
});

test("running host work may delay stats without triggering the final-readback deadline", async (t) => {
  const f = fixture(t);
  const report = await runRpcAttempt({
    ...options(f, "busy"),
    statsTimeoutMs: 100,
  });
  assert.equal(report.stopReason, "goal-paused");
  assert.equal(report.processReaped, true);
});

for (const scenario of [
  "error",
  "pause",
  "complete",
  "unknown",
  "parent-cost",
  "idle",
  "stale",
  "lost-final",
]) {
  test(`RPC ${scenario}: reaps only its process, never waits for prose or certifies E2E`, async (t) => {
    const f = fixture(t);
    const input = options(f, scenario);
    if (scenario === "idle") input.deadlineMs = 600;
    if (scenario === "lost-final") input.statsTimeoutMs = 100;
    const report = await runRpcAttempt(input);
    assert.equal(report.processReaped, true);
    assert.equal(report.fullE2EPassed, false);
    assert.equal(
      fs.existsSync(path.join(input.outputRoot, "l0-result.md")),
      false,
    );
    assert.equal(report.taskDispatchStarted, false);
    assert.equal(fs.readFileSync(input.env.MARKER, "utf8"), input.prompt);
    if (["error", "pause", "complete", "stale"].includes(scenario)) {
      assert.equal(report.rootUsage.total, scenario === "stale" ? 30 : 20);
      assert.equal(report.reportedTokens, scenario === "stale" ? 40 : 30);
      assert.equal(
        report.stopReason,
        scenario === "error"
          ? "tool-failure"
          : `goal-${scenario === "complete" ? "complete" : "paused"}`,
      );
    } else if (scenario === "idle") assert.equal(report.stopReason, "deadline");
    else {
      assert.equal(report.stopReason, "control-failure");
      assert.ok(
        report.faults.some((x) =>
          String(x).includes(
            scenario === "unknown"
              ? "unknown native usage"
              : scenario === "lost-final"
                ? "native usage response timed out"
                : "aggregate budget exhausted",
          ),
        ),
      );
    }
    await assert.rejects(
      runRpcAttempt(input),
      scenario === "parent-cost" ? /aggregate budget exhausted/ : /EEXIST/,
    );
  });
}
