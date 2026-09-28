import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { taskToolParameters } from "../task-tool-inputs.mjs";
import { CompletedCheckFailure, checkFailureReply } from "../check-failure.mjs";
import {
  TaskInputRejection,
  inputRejectionReply,
} from "../input-rejection.mjs";
import {
  assertBudget,
  buildModelAdmissionContext,
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
function observerOnly(report) {
  assert.equal(report.acceptance, "not-assessed");
  assert.equal(Object.hasOwn(report, "fullE2EPassed"), false);
  assert.ok(["captured", "incomplete"].includes(report.status));
}
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
let buffer='', spent=0, delayed=false, drained=false, settledProbes=0;
process.stdin.on('data', bytes => {
 buffer += bytes;
 let newline;
 while ((newline=buffer.indexOf('\\n')) >= 0) {
  const value=JSON.parse(buffer.slice(0,newline)); buffer=buffer.slice(newline+1);
  if(value.type==='get_state') {
   if(process.env.SCENARIO==='no-goal-state-missing' && value.id.startsWith('settled-')) continue;
   const settled=value.id.startsWith('settled-');
   const queue=process.env.SCENARIO==='no-goal-queued' && settled && ++settledProbes===1;
   reply({type:'response',id:value.id,success:true,data:{sessionId:'root-1',model:{provider:'openai-codex',id:process.env.SCENARIO==='wrong-model'?'gpt-5.6-wrong':'gpt-5.6-luna'},isStreaming:false,pendingMessageCount:queue?1:0}});
   if(queue) setTimeout(()=>reply({type:'agent_settled'}),60);
  }
  if(value.type==='get_session_stats') {
   if(process.env.SCENARIO==='lost-final'&&spent===30) continue;
   const answer={type:'response',id:value.id,success:true,data:{sessionId:'root-1',tokens:process.env.SCENARIO==='unknown'&&spent ? {total:spent} : {input:spent,output:0,cacheRead:0,cacheWrite:0,total:spent}}};
   if(process.env.SCENARIO==='exit-with-task'&&process.env.EXIT_DELAY&&spent===20) {
    process.exitCode=3;process.stdin.destroy();fs.closeSync(0);
    reply(answer); // Clear the observer's in-flight stats request before closing.
    setTimeout(()=>process.exit(3),Number(process.env.EXIT_DELAY));
   }
   else if(['stale','busy'].includes(process.env.SCENARIO)&&spent===20&&!delayed) { delayed=true; setTimeout(()=>reply(answer),180); }
   else reply(answer);
  }
  if(value.type==='get_commands') reply({type:'response',id:value.id,success:true,data:{commands:process.env.SCENARIO==='drain-missing'?[]:[{name:'teams-e2e-drain'}]}});
  if(value.type==='extension_ui_response' && process.env.SCENARIO.startsWith('ui-')) {
   fs.writeFileSync(process.env.MARKER+'.ui-response',JSON.stringify(value));
   reply({type:'tool_execution_end',toolName:'update_goal',result:{details:{goal:{id:'goal-1',status:value.confirmed===true?'complete':'paused'}}}});
   reply({type:'agent_end'});reply({type:'agent_settled'});
   continue;
  }
  if(value.type==='prompt' && value.message.startsWith('/teams-e2e-drain ')) {
   const input=JSON.parse(value.message.slice('/teams-e2e-drain '.length));
   fs.writeFileSync(process.env.MARKER+'.drain', JSON.stringify(input));
   if(process.env.SCENARIO==='drain-hang') continue;
   setTimeout(()=>{ drained=true;reply({type:'extension_ui_request',method:'setWidget',widgetKey:'teams-e2e-drain',widgetLines:['TEAMS_E2E_DRAIN:'+JSON.stringify({version:1,requestId:input.requestId,ownerSessionId:'root-1',rows:process.env.SCENARIO==='drain-omitted'?[]:[{executionId:'execution-1',reservationOpen:false}],settled:true})]});},40);
   continue;
  }
  if(value.type==='prompt') {
   fs.writeFileSync(process.env.MARKER, value.message);
   fs.writeFileSync(process.env.MARKER+'.mode',process.env.TEAMS_E2E_L0_MODE??'');
   if(process.env.SCENARIO.startsWith('drain') || process.env.SCENARIO.startsWith('signal-') || process.env.SCENARIO.startsWith('retry-') || process.env.SCENARIO.startsWith('summary-') || ['provider-no-retry','task-error','exit-with-task','blocked-result','bash-timeout'].includes(process.env.SCENARIO)) {
    reply({type:'tool_execution_start',toolName:'team_task_dispatch'});
    reply({type:'tool_execution_end',toolName:'team_task_dispatch',result:{details:{executionId:'execution-1'}}});
   }
   spent=20;
   if(process.env.SCENARIO.startsWith('no-goal')) {
    if(process.env.SCENARIO==='no-goal-child') reply({type:'tool_execution_end',toolName:'subagent',result:{details:{mode:'async',runId:'native-still-running'}}});
    if(process.env.SCENARIO==='no-goal-pending-child') reply({type:'tool_execution_start',toolName:'subagent',toolCallId:'native-pending'});
    if(process.env.SCENARIO==='no-goal-final-usage') spent=30;
    reply({type:'agent_end'}); reply({type:'agent_settled'});
    continue;
   }
   reply({type:'tool_execution_end',toolName:'create_goal',result:{details:{goal:{id:'goal-1',status:'active'}},terminate:true}});
   reply({type:'agent_end'}); reply({type:'agent_settled'});
   if(process.env.SCENARIO.startsWith('ui-')) {
    reply({type:'extension_ui_request',id:'native-ui-1',method:'confirm',title:'Apply staged integration?',
      message:'apply only the sealed patch at '+${JSON.stringify(f.cwd)}+'\\nBranch: refs/heads/main\\nHEAD remains: '+ 'c'.repeat(40)+'\\nIntegration tree: '+'b'.repeat(40)+'\\nPlan: '+'a'.repeat(64)+'\\nNo commit, ref movement or acceptance. Later edits cause refusal.'});
    continue;
   }
   if(process.env.SCENARIO.startsWith('signal-')) { setTimeout(()=>process.kill(process.ppid,process.env.SCENARIO.slice(7)),40); continue; }
   if(process.env.SCENARIO==='task-error') { reply({type:'tool_execution_end',toolName:'team_task_collect',isError:true,result:{content:[{type:'text',text:'Worker exited without a result'}]}}); continue; }
   if(process.env.SCENARIO.startsWith('check-')) {
    const args={execution_id:'12345678-1234-1234-1234-123456789abc',action:'stage'};
    const result=${JSON.stringify(checkFailureReply(new CompletedCheckFailure("check", "/fixture/check.json", "a".repeat(64), "b".repeat(64), 7), "check-1", { execution_id: "12345678-1234-1234-1234-123456789abc", action: "stage" }))};
    if(process.env.SCENARIO==='check-mismatch') result.details.checkFailure.inputDigest='f'.repeat(64);
    if(process.env.SCENARIO==='check-unclassified') delete result.details.checkFailure;
    reply({type:'tool_execution_start',toolName:'team_task_stage_integration',toolCallId:'check-1',args});
    reply({type:'tool_execution_end',toolName:'team_task_stage_integration',toolCallId:'check-1',isError:true,result});
    reply({type:'agent_settled'}); // An active Goal may continue bounded diagnosis/repair.
    setTimeout(()=>{
     fs.writeFileSync(process.env.MARKER+'.diagnosed','yes');
     reply({type:'tool_execution_end',toolName:'read',result:{content:[{type:'text',text:'check log inspected'}]}});
     reply({type:'tool_execution_end',toolName:'update_goal',result:{details:{goal:{id:'goal-1',status:process.env.SCENARIO==='check-false-completion'?'complete':'paused'}}}});
     reply({type:'agent_settled'});
    },80);
    continue;
   }
   if(process.env.SCENARIO==='bash-timeout') {
    reply({type:'tool_execution_start',toolName:'bash',toolCallId:'timed-command',args:{command:'read-only fixture search',timeout:30}});
    reply({type:'tool_execution_end',toolName:'bash',toolCallId:'timed-command',isError:true,result:{content:[{type:'text',text:'partial search output\\n\\nCommand timed out after 30 seconds'}],details:{}}});
    reply({type:'agent_settled'});
    continue;
   }
   if(process.env.SCENARIO==='bash-corrected') {
    reply({type:'tool_execution_end',toolName:'bash',toolCallId:'bad-syntax',isError:true,result:{content:[{type:'text',text:'Command timed out after 30 seconds\\nSyntaxError: invalid generated code\\n\\nCommand exited with code 1'}]}});
    reply({type:'agent_settled'});
    reply({type:'tool_execution_end',toolName:'bash',toolCallId:'correct-syntax',isError:false,result:{content:[{type:'text',text:'Command timed out after 30 seconds'}]}});
   }
   if(process.env.SCENARIO==='tool-corrected') {
    reply({type:'tool_execution_end',toolName:'read',toolCallId:'read-bad',isError:true,result:{content:[{type:'text',text:'file not found'}]}});
    reply({type:'agent_settled'});
    reply({type:'tool_execution_end',toolName:'read',toolCallId:'read-correct',result:{content:[{type:'text',text:'correct source'}]}});
   }
   if(process.env.SCENARIO.startsWith('facts-')) {
    const args={execution_id:'12345678-1234-1234-1234-123456789abc',action:'plan-review',wave:{}};
    const result=${JSON.stringify(inputRejectionReply(new TaskInputRejection("review-tools", new Error("ceiling mismatch"), { excess: ["extra_read_tool"] }), "team_task_stage_integration", "facts-1", { execution_id: "12345678-1234-1234-1234-123456789abc", action: "plan-review", wave: {} }))};
    if(process.env.SCENARIO==='facts-unknown') result.details.rejection.launchAttempted=true;
    if(process.env.SCENARIO==='facts-wrong-input') args.wave={changed:true};
    reply({type:'tool_execution_start',toolName:'team_task_stage_integration',toolCallId:'facts-1',args});
    reply({type:'tool_execution_end',toolName:'team_task_stage_integration',toolCallId:'facts-1',isError:true,result});
    reply({type:'agent_settled'});
    if(process.env.SCENARIO!=='facts-corrected') continue;
    setTimeout(()=>{
     fs.writeFileSync(process.env.MARKER+'.corrected','yes');
     reply({type:'tool_execution_end',toolName:'update_goal',result:{details:{goal:{id:'goal-1',status:'complete'}}}});
     reply({type:'agent_settled'});
    },40);
    continue;
   }
   if(process.env.SCENARIO.startsWith('seal-')) {
    const scenario=process.env.SCENARIO;
    const args={execution_id:'12345678-1234-1234-1234-123456789abc',action:'seal-review'};
    const result=${JSON.stringify(inputRejectionReply(new TaskInputRejection("review-seal", new Error("BLOCKED review cannot be sealed")), "team_task_stage_integration", "seal-1", { execution_id: "12345678-1234-1234-1234-123456789abc", action: "seal-review" }))};
    if(scenario==='seal-unknown') delete result.details.rejection;
    if(scenario==='seal-wrong-input') args.execution_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    reply({type:'tool_execution_start',toolName:'team_task_stage_integration',toolCallId:'seal-1',args});
    reply({type:'tool_execution_end',toolName:'team_task_stage_integration',toolCallId:'seal-1',isError:true,result});
    reply({type:'agent_settled'});
    if(scenario!=='seal-corrected') continue;
    setTimeout(()=>{
     fs.writeFileSync(process.env.MARKER+'.corrected','preserved BLOCKED review; no second seal');
     reply({type:'tool_execution_end',toolName:'team_task_cancel',result:{details:{executionId:args.execution_id,state:'CANCELLED',reservationOpen:false}}});
     reply({type:'tool_execution_end',toolName:'update_goal',result:{details:{goal:{id:'goal-1',status:'paused'}}}});
     reply({type:'agent_settled'});
    },40);
    continue;
   }
   if(process.env.SCENARIO.startsWith('revision-')) {
    const scenario=process.env.SCENARIO;
    const args={previous_execution_id:'12345678-1234-1234-1234-123456789abc',spec_path:'/workspace/revision.json',expected_previous_result_digest:'a'.repeat(64),failure_receipt_ref:'/workspace/previous/integration/check-browser-e2e.json',failure_receipt_sha256:'b'.repeat(64),repair_reason:'completed nonzero staged browser check'};
    const result=${JSON.stringify(inputRejectionReply(new TaskInputRejection("task-prompt", new Error("worker prompt exceeds 6 KiB")), "team_task_revise", "revision-1", { previous_execution_id: "12345678-1234-1234-1234-123456789abc", spec_path: "/workspace/revision.json", expected_previous_result_digest: "a".repeat(64), failure_receipt_ref: "/workspace/previous/integration/check-browser-e2e.json", failure_receipt_sha256: "b".repeat(64), repair_reason: "completed nonzero staged browser check" }))};
    if(scenario==='revision-unknown') delete result.details.rejection;
    if(scenario==='revision-wrong-input') args.spec_path='/workspace/other.json';
    reply({type:'tool_execution_start',toolName:'team_task_revise',toolCallId:'revision-1',args});
    reply({type:'tool_execution_end',toolName:'team_task_revise',toolCallId:'revision-1',isError:true,result});
    reply({type:'agent_settled'});
    if(scenario!=='revision-corrected') continue;
    setTimeout(()=>{
     fs.writeFileSync(process.env.MARKER+'.corrected','yes');
     reply({type:'tool_execution_end',toolName:'read',result:{content:[{type:'text',text:'same-scope spec checked'}]}});
     reply({type:'tool_execution_end',toolName:'update_goal',result:{details:{goal:{id:'goal-1',status:'paused'}}}});
     reply({type:'agent_settled'});
    },40);
    continue;
   }
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
   if(process.env.SCENARIO==='exit-with-task') {
    if(!process.env.EXIT_DELAY) { process.exitCode=3;process.stdin.destroy(); }
    continue;
   }
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
    reply({type:'tool_execution_end',toolName:'update_goal',result:{details:{goal:{id:'goal-1',status:['complete','tool-corrected','bash-corrected'].includes(process.env.SCENARIO)?'complete':'paused',autoContinue:false}},terminate:true}});
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

test("native L0 bash timeout stops and drains instead of continuing the Goal", async (t) => {
  const f = fixture(t),
    input = { ...options(f, "bash-timeout"), drainTimeoutMs: 250 };
  const report = await runRpcAttempt(input);
  assert.equal(report.stopReason, "command-timeout");
  assert.equal(report.taskDrain.settled, true);
  assert.equal(report.processReaped, true);
  assert.equal(
    JSON.parse(fs.readFileSync(input.env.MARKER + ".closed")).drained,
    true,
  );
  assert.notEqual(report.goal?.status, "complete");
  assert.equal(report.faults[0].tool, "bash");
  assert.match(
    report.faults[0].result.content[0].text,
    /Command timed out after 30 seconds$/,
  );
});

test("ordinary bash output and corrected generated syntax are not native timeout receipts", async (t) => {
  const f = fixture(t),
    report = await runRpcAttempt(options(f, "bash-corrected"));
  assert.equal(report.stopReason, "goal-complete");
  assert.equal(report.faults.length, 1);
  assert.equal(report.faults[0].tool, "bash");
  assert.equal(report.processReaped, true);
});

test("E2E observer admits a finite 90-minute window and rejects a larger window before launch", async (t) => {
  const admitted = fixture(t);
  const input = { ...options(admitted, "complete"), deadlineMs: 5_400_000 };
  await runRpcAttempt(input);
  assert.ok(fs.existsSync(input.env.MARKER));
  assert.ok(fs.existsSync(path.join(input.outputRoot, "rpc-observation.json")));

  const rejected = fixture(t);
  const tooLong = { ...options(rejected, "complete"), deadlineMs: 5_400_001 };
  await assert.rejects(runRpcAttempt(tooLong), /bounded deadline required/);
  assert.equal(fs.existsSync(tooLong.env.MARKER), false);
});

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

test("no Goal after native settlement ends promptly with final usage, not deadline or invented Task receipt", async (t) => {
  for (const [scenario, expected] of [
    ["no-goal", "no-goal-final"],
    ["no-goal-queued", "no-goal-final"],
    ["no-goal-final-usage", "no-goal-final"],
    ["no-goal-child", "no-goal-native-child-unknown"],
    ["no-goal-pending-child", "no-goal-native-child-unknown"],
    ["no-goal-state-missing", "control-failure"],
  ]) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      const report = await runRpcAttempt({
        ...options(f, scenario),
        statsTimeoutMs: 180,
      });
      assert.equal(report.stopReason, expected);
      assert.equal(report.goal, null);
      assert.deepEqual(report.executionIds, []);
      assert.equal(report.taskUsage.status, "unknown"); // No Task receipt exists.
      observerOnly(report);
      assert.equal(
        report.status,
        expected === "no-goal-final" ? "captured" : "incomplete",
      );
      assert.equal(
        report.rootUsage.total,
        scenario === "no-goal-final-usage" ? 30 : 20,
      );
      if (["no-goal-child", "no-goal-pending-child"].includes(scenario)) {
        assert.equal(report.settledState.rawNativeUnresolved, true);
        assert.match(report.faults[0], /reconcile/);
      }
      assert.ok(report.elapsedMs < 2500, "must not sit until attempt deadline");
    });
  }
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
      observerOnly(report);
    });
  }
});

test("host preflight facts permit correction but unknown or mismatched facts still stop", async (t) => {
  for (const scenario of [
    "facts-corrected",
    "facts-unknown",
    "facts-wrong-input",
  ]) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      const input = options(f, scenario);
      const report = await runRpcAttempt(input);
      const corrected = scenario === "facts-corrected";
      assert.equal(
        report.stopReason,
        corrected ? "goal-complete" : "task-tool-failure",
      );
      assert.equal(fs.existsSync(input.env.MARKER + ".corrected"), corrected);
      assert.equal(
        report.faults[0].disposition,
        corrected ? "pre-dispatch-input" : undefined,
      );
      observerOnly(report);
      if (corrected) assert.equal(report.status, "captured");
    });
  }
});

test("a BLOCKED review's rejected seal stays correctable in the original L0; unknown facts still drain", async (t) => {
  for (const scenario of [
    "seal-corrected",
    "seal-unknown",
    "seal-wrong-input",
  ]) {
    await t.test(scenario, async (t) => {
      const f = fixture(t),
        input = options(f, scenario);
      const report = await runRpcAttempt(input);
      const corrected = scenario === "seal-corrected";
      assert.equal(
        report.stopReason,
        corrected ? "goal-paused" : "task-tool-failure",
      );
      assert.equal(fs.existsSync(input.env.MARKER + ".corrected"), corrected);
      assert.equal(
        report.faults[0].disposition,
        corrected ? "review-seal-input" : undefined,
      );
      observerOnly(report);
    });
  }
});

test("candidate revision pre-dispatch prompt correction stays in the original L0; unknown or unbound errors drain", async (t) => {
  for (const scenario of [
    "revision-corrected",
    "revision-unknown",
    "revision-wrong-input",
  ]) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      const input = options(f, scenario);
      const report = await runRpcAttempt(input);
      const corrected = scenario === "revision-corrected";
      assert.equal(
        report.stopReason,
        corrected ? "goal-paused" : "task-tool-failure",
      );
      assert.equal(fs.existsSync(input.env.MARKER + ".corrected"), corrected);
      assert.equal(
        report.faults[0].disposition,
        corrected ? "pre-dispatch-input" : undefined,
      );
      assert.deepEqual(
        report.executionIds,
        [],
        "no new execution was launched",
      );
      observerOnly(report);
    });
  }
});

test("completed check failure permits diagnosis only; unknown facts stop and false completion cannot pass", async (t) => {
  for (const scenario of [
    "check-diagnose",
    "check-false-completion",
    "check-mismatch",
    "check-unclassified",
  ]) {
    await t.test(scenario, async (t) => {
      const f = fixture(t),
        input = options(f, scenario);
      const report = await runRpcAttempt(input);
      const known = ["check-diagnose", "check-false-completion"].includes(
        scenario,
      );
      assert.equal(
        report.stopReason,
        known ? "check-failed" : "task-tool-failure",
      );
      assert.equal(fs.existsSync(input.env.MARKER + ".diagnosed"), known);
      assert.equal(
        report.faults[0].disposition,
        known ? "diagnose-only" : undefined,
      );
      observerOnly(report);
    });
  }
});

test("corrected general tool error remains visible without a permanent failure latch", async (t) => {
  const f = fixture(t);
  const report = await runRpcAttempt(options(f, "tool-corrected"));
  assert.equal(report.stopReason, "goal-complete");
  assert.equal(report.faults.length, 1);
  assert.equal(report.faults[0].tool, "read");
  observerOnly(report);
  assert.equal(report.status, "captured");
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
      observerOnly(report); // Observer is not the auditor.
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
      observerOnly(report);
      assert.equal(
        report.status,
        "incomplete",
        "synthetic drain lacks native usage",
      );
      if (success) {
        assert.deepEqual(
          report.faults.map((row) => row.type),
          ["task-usage-unknown"],
        );
        assert.equal(
          report.taskUsage.status,
          "unknown",
          "synthetic drain has no native cost evidence",
        );
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
    assert.match(blocked.content[0].text, /not an acceptable candidate/);
    assert.match(
      blocked.content[0].text,
      /preserve and continue independent Tasks/,
    );
    assert.match(blocked.content[0].text, /never stage\/accept/);
    assert.doesNotMatch(
      blocked.content[0].text,
      /cancel this execution and pause its Goal/,
    );
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
  const revisionTool = tools.get("team_task_revise");
  const revision = {
    previous_execution_id: "84b05b32-f783-4e48-90bc-5d8d25bc5b4e",
    spec_path: "/workspace/.git/revision.json",
    expected_previous_result_digest: "a".repeat(64),
    failure_receipt_ref: "/runtime/integration/check-check.json",
    failure_receipt_sha256: "b".repeat(64),
    repair_reason: "Repair the evidenced failed check within the sealed scope.",
  };
  const validateRevision = (args) =>
    validateToolArguments(revisionTool, {
      type: "toolCall",
      id: "revision-input",
      name: revisionTool.name,
      arguments: args,
    });
  assert.deepEqual(validateRevision(revision), revision);
  for (const field of [
    "previous_execution_id",
    "spec_path",
    "expected_previous_result_digest",
    "failure_receipt_ref",
    "failure_receipt_sha256",
    "repair_reason",
  ]) {
    const missing = { ...revision };
    delete missing[field];
    assert.throws(() => validateRevision(missing), /Validation failed/);
  }
  assert.throws(
    () => validateRevision({ ...revision, failure_receipt_sha256: "x" }),
    /Validation failed/,
  );
  const productRevision = {
    previous_execution_id: revision.previous_execution_id,
    spec_path: revision.spec_path,
    expected_previous_result_digest: revision.expected_previous_result_digest,
    origin: "blocked-review",
    review_failure_ref: "/runtime/integration/reviews/final/complete.json",
    review_failure_sha256: "b".repeat(64),
    repair_reason: "Repair the genuine sealed product BLOCKED finding.",
  };
  assert.deepEqual(validateRevision(productRevision), productRevision);
  const inherited = { ...productRevision, additional_checks: [] };
  delete inherited.spec_path;
  assert.deepEqual(validateRevision(inherited), inherited);
  const conflict = {
    ...revision,
    origin: "integration-conflict",
    additional_checks: [],
  };
  delete conflict.spec_path;
  assert.deepEqual(validateRevision(conflict), conflict);
  assert.deepEqual(
    validateRevision({ ...revision, origin: "integration-conflict" }),
    { ...revision, origin: "integration-conflict" },
  );
  const missingConflictReceipt = { ...conflict };
  delete missingConflictReceipt.failure_receipt_sha256;
  for (const invalid of [
    { ...conflict, review_failure_ref: productRevision.review_failure_ref },
    { ...conflict, spec_path: revision.spec_path },
    missingConflictReceipt,
    { ...conflict, origin: "unknown-effect" },
    { ...conflict, additional_checks: Array(31).fill({}) },
  ])
    assert.throws(
      () => validateRevision(invalid),
      /Validation failed/,
      JSON.stringify(invalid),
    );
  const missingForm = { ...inherited };
  delete missingForm.additional_checks;
  for (const invalid of [
    { ...inherited, spec_path: productRevision.spec_path },
    missingForm,
    { ...revision, additional_checks: [] },
    { ...inherited, additional_checks: [{ commandId: "incomplete" }] },
    { ...inherited, additional_checks: [], objective: "unapproved rewrite" },
  ])
    assert.throws(
      () => validateRevision(invalid),
      /Validation failed/,
      JSON.stringify(invalid),
    );
  assert.throws(
    () =>
      validateRevision({
        ...productRevision,
        failure_receipt_ref: revision.failure_receipt_ref,
      }),
    /Validation failed/,
  );
  const missingOrigin = { ...productRevision };
  delete missingOrigin.origin;
  assert.throws(() => validateRevision(missingOrigin), /Validation failed/);
  await assert.rejects(
    revisionTool.execute("revision-input", revision, undefined, undefined, {}),
    /Task Pi native capability unavailable/,
  );
  const reportTool = tools.get("team_task_revise_report");
  const report = {
    previous_execution_id: revision.previous_execution_id,
    spec_path: revision.spec_path,
    expected_previous_result_digest: revision.expected_previous_result_digest,
    review_failure_ref: "/runtime/integration/reviews/final/complete.json",
    review_failure_sha256: "b".repeat(64),
    report_reason:
      "Correct a documented report deficiency without source changes.",
  };
  const validateReport = (args) =>
    validateToolArguments(reportTool, {
      type: "toolCall",
      id: "report-revision-input",
      name: reportTool.name,
      arguments: args,
    });
  assert.deepEqual(validateReport(report), report);
  for (const field of Object.keys(report)) {
    const missing = { ...report };
    delete missing[field];
    assert.throws(() => validateReport(missing), /Validation failed/);
  }
  assert.throws(
    () => validateReport({ ...report, review_failure_sha256: "x" }),
    /Validation failed/,
  );
  await assert.rejects(
    reportTool.execute(
      "report-revision-input",
      report,
      undefined,
      undefined,
      {},
    ),
    /Task Pi native capability unavailable/,
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

test("unexpected host exit preserves failure whether pipe error or process close is observed first", async (t) => {
  for (const holdClosedInput of [false, true]) {
    await t.test(
      holdClosedInput ? "closed-pipe-first" : "immediate-exit",
      async (t) => {
        const f = fixture(t);
        const input = {
          ...options(f, "exit-with-task"),
          drainTimeoutMs: 250,
          sampleMs: 1,
        };
        if (holdClosedInput) input.env.EXIT_DELAY = "80";
        const report = await runRpcAttempt(input);
        t.diagnostic(
          JSON.stringify({
            stopReason: report.stopReason,
            faults: report.faults,
            exitCode: report.exitCode,
            cleanup: report.cleanup,
          }),
        );
        if (holdClosedInput) assert.equal(report.stopReason, "control-failure");
        if (report.stopReason === "control-failure")
          assert.match(
            JSON.stringify(report.faults),
            /EPIPE/,
            "only the observed closed-pipe transport failure explains this classification",
          );
        else assert.equal(report.stopReason, "unexpected-process-exit");
        assert.equal(report.exitCode, 3);
        assert.equal(report.processReaped, true);
        observerOnly(report);
        assert.equal(report.status, "incomplete");
        assert.deepEqual(report.executionIds, ["execution-1"]);
        assert.equal(report.sessionId, "root-1");
        assert.match(report.cleanup, /unresolved/);
        assert.notEqual(report.taskDrain?.settled, true);
      },
    );
  }
});

test("blocked candidate is recorded separately from RESULT_READY and Goal acceptance", async (t) => {
  const f = fixture(t);
  const report = await runRpcAttempt({
    ...options(f, "blocked-result"),
    drainTimeoutMs: 250,
  });
  assert.equal(report.candidateOutcome, "blocked");
  assert.equal(report.stopReason, "goal-paused");
  observerOnly(report);
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
  observerOnly(report);
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
      assert.equal(report.status, "incomplete");
      observerOnly(report);
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

test("parent sampler streams a large pre-approval history without resetting costs or prefix integrity", (t) => {
  const f = fixture(t);
  f.entries.push({
    type: "message",
    id: "unicode-window",
    message: { role: "user", content: "資料☃".repeat(22000) },
  });
  f.save();
  const small = parentUsage(f.parent, "approval");
  const prefix = f.entries.slice(0, 2).map(JSON.stringify).join("\n") + "\n";
  fs.writeFileSync(f.parent, prefix);
  const content = "x".repeat(512 * 1024) + "資料☃";
  for (let i = 0; i < 130; i++)
    fs.appendFileSync(
      f.parent,
      JSON.stringify({
        type: "message",
        id: `old-${i}`,
        message: { role: "user", content },
      }) + "\n",
    );
  fs.appendFileSync(
    f.parent,
    f.entries.slice(2).map(JSON.stringify).join("\n") + "\n",
  );
  assert.ok(fs.statSync(f.parent).size > 64 * 1024 * 1024);
  const snapshot = parentUsage(f.parent, "approval");
  assert.deepEqual(
    snapshot.usage,
    small.usage,
    "pre-window history changes neither charged bytes nor costs",
  );
  assert.equal(snapshot.bytes, fs.statSync(f.parent).size);
  assert.equal(
    snapshot.digest,
    createHash("sha256").update(fs.readFileSync(f.parent)).digest("hex"),
  );
  const next = JSON.stringify(row("large-later", 7));
  fs.appendFileSync(f.parent, next.slice(0, 17));
  assert.deepEqual(parentUsage(f.parent, "approval", snapshot), snapshot);
  fs.appendFileSync(f.parent, next.slice(17) + "\n");
  const finished = parentUsage(f.parent, "approval", snapshot);
  assert.equal(finished.usage.total, small.usage.total + 14);
  const fd = fs.openSync(f.parent, "r+");
  try {
    fs.writeSync(fd, Buffer.from("y"), 0, 1, 1000);
  } finally {
    fs.closeSync(fd);
  }
  assert.throws(
    () => parentUsage(f.parent, "approval", finished),
    /prefix changed/,
  );
  // Streaming the lifetime prefix does not remove the original in-memory bound
  // on the complete charged window, and a duplicate anchor remains invalid.
  f.save();
  fs.appendFileSync(f.parent, JSON.stringify(f.entries[2]) + "\n");
  assert.throws(
    () => parentUsage(f.parent, "approval"),
    /unique parent authorization/,
  );
  f.save();
  for (let i = 0; i < 130; i++)
    fs.appendFileSync(
      f.parent,
      JSON.stringify({
        type: "message",
        id: `new-${i}`,
        message: { role: "user", content },
      }) + "\n",
    );
  assert.throws(
    () => parentUsage(f.parent, "approval"),
    /bounded parent accounting window/,
  );
});

test("parent sampler defers only an unfinished appended JSONL line after a proven prefix", (t) => {
  const f = fixture(t);
  const baseline = parentUsage(f.parent, "approval");
  const later = JSON.stringify(row("later", 7));
  fs.appendFileSync(f.parent, later.slice(0, 16));
  const pending = parentUsage(f.parent, "approval", baseline);
  assert.equal(pending.bytes, baseline.bytes);
  assert.equal(pending.digest, baseline.digest);
  assert.equal(pending.usage.total, baseline.usage.total);

  fs.appendFileSync(f.parent, later.slice(16) + "\n");
  const finished = parentUsage(f.parent, "approval", pending);
  assert.equal(finished.usage.total, baseline.usage.total + 14);
  assert.ok(finished.bytes > baseline.bytes);

  fs.appendFileSync(f.parent, '{"type":\n');
  assert.throws(
    () => parentUsage(f.parent, "approval", finished),
    /Invalid parent session JSON/,
  );
  const changed = fs
    .readFileSync(f.parent)
    .subarray(0, finished.bytes)
    .toString("utf8")
    .replace('"input":999999', '"input":999998');
  fs.writeFileSync(f.parent, changed + later.slice(0, 16));
  assert.throws(
    () => parentUsage(f.parent, "approval", finished),
    /prefix changed/,
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
  assert.equal(report.expectedModel, "openai-codex/gpt-5.6-luna");
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

test("request-driven public prompt carries the same verified authority, budget, source and full selected skill bytes", async (t) => {
  const f = fixture(t);
  for (const [args] of [
    [["init", "-q"]],
    [
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        "base",
      ],
    ],
  ]) {
    assert.equal(spawnSync("git", ["-C", f.cwd, ...args]).status, 0);
  }
  const base = spawnSync("git", ["-C", f.cwd, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  const requestFile = path.join(f.root, "request.txt");
  const request =
    "Implement the requested behavior without a prepared Task or solution.";
  fs.writeFileSync(requestFile, request);
  const skill = path.join(f.root, "selected-skill.md");
  fs.writeFileSync(
    skill,
    "---\nname: team-flow\ndescription: current\n---\nUNIQUE_SKILL_INSTRUCTIONS_31\n",
  );
  const inventory = path.join(f.root, "inventory.json");
  fs.writeFileSync(
    inventory,
    JSON.stringify({ status: "operator-attested", sessions: [] }),
  );
  const sha = (file) =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const authorization = {
    mode: "task-pi",
    goalAction: "create",
    delivery: "verify-only",
    parentAuthorizationEntryId: "approval",
    parentSessionFile: f.parent,
    unknownUsage: 0,
    openReservations: 0,
    historyProvenance: { file: inventory, sha256: sha(inventory) },
    deadlineMs: 3000,
  };
  const input = {
    ...options(f, "no-goal"),
    command: [process.execPath, fakeRpc(f), "--skill", skill],
    prompt: request,
    preparation: {
      mode: "request-driven",
      requestFile,
      requestSha256: sha(requestFile),
      sourceBase: base,
      noTaskSpecsProvided: true,
    },
    authorization,
  };
  const report = await runRpcAttempt(input);
  const sent = fs.readFileSync(input.env.MARKER, "utf8");
  assert.equal(fs.readFileSync(input.env.MARKER + ".mode", "utf8"), "task-pi");
  assert.equal(report.stopReason, "no-goal-final");
  assert.match(sent, /UNIQUE_SKILL_INSTRUCTIONS_31/);
  assert.match(sent, /CURRENT L0 SPEC/);
  assert.match(sent, /pre-apply source-bound review/);
  assert.match(sent, /post-review apply\/confirmation evidence/);
  assert.match(
    sent,
    /Execution mode: task-pi; Goal action expressly approved by owner: create/,
  );
  assert.match(sent, /Historical sources:/);
  assert.match(sent, /remaining before this L0 and Task reservations/);
  assert.equal(report.promptAdmission.inventorySha256, sha(inventory));
  assert.equal(report.promptAdmission.sourceBase, base);
  assert.equal(report.promptAdmission.requestSha256, sha(requestFile));
  const contextInput = {
    authorization,
    parent: parentUsage(f.parent, "approval"),
    history: { totals: { total: 0 }, sources: [], executions: [] },
    maxTokens: 1000,
    taskTokenReservation: 500,
    preparation: input.preparation,
    request,
    cwd: f.cwd,
    command: input.command,
  };
  assert.equal(
    buildModelAdmissionContext(contextInput).evidence.goalAction,
    "create",
  );
  for (const [change, message] of [
    [
      { authorization: { ...authorization, goalAction: "none" } },
      /needs an authorized Goal/,
    ],
    [
      { authorization: { ...authorization, unknownUsage: null } },
      /unknown campaign usage/,
    ],
    [
      { authorization: { ...authorization, openReservations: 1 } },
      /open campaign reservation/,
    ],
    [
      {
        authorization: {
          ...authorization,
          historyProvenance: { file: inventory, sha256: "f".repeat(64) },
        },
      },
      /inventory evidence changed/,
    ],
    [
      { preparation: { ...input.preparation, requestSha256: "f".repeat(64) } },
      /request source changed/,
    ],
    [
      { preparation: { ...input.preparation, sourceBase: "f".repeat(40) } },
      /source base changed/,
    ],
    [{ command: [process.execPath, fakeRpc(f)] }, /selected skill/],
  ])
    assert.throws(
      () => buildModelAdmissionContext({ ...contextInput, ...change }),
      message,
    );
  const missing = {
    ...input,
    outputRoot: path.join(f.root, "missing"),
    authorization: null,
  };
  await assert.rejects(runRpcAttempt(missing), /authorization/);
  assert.equal(
    fs.existsSync(missing.outputRoot),
    false,
    "no model process or evidence attempt before authorization",
  );
  const direct = {
    ...contextInput,
    authorization: { ...authorization, mode: "direct", goalAction: "none" },
  };
  assert.equal(buildModelAdmissionContext(direct).evidence.goalAction, "none");
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
  const selectedSkill = path.join(f.root, "skills", "team-flow", "SKILL.md");
  fs.mkdirSync(path.dirname(selectedSkill), { recursive: true });
  fs.writeFileSync(
    selectedSkill,
    "---\nname: team-flow\ndescription: fixture\n---\n",
  );
  const command = publicCommand(f.root, path.join(f.root, "sessions"));
  assert.equal(command[command.indexOf("--skill") + 1], selectedSkill);
  assert.ok(
    command.includes("--no-skills"),
    "unrelated skill discovery stays disabled",
  );
  assert.deepEqual(command.slice(1, 5), [
    "--model",
    "openai-codex/gpt-5.6-luna",
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

test("native target confirmation stays denied by default and requires approved-integration relay", async (t) => {
  const f = fixture(t);
  const denied = await runRpcAttempt({
    ...options(f, "ui-denied"),
    deadlineMs: 1000,
  });
  assert.equal(denied.stopReason, "control-failure");
  const response = JSON.parse(
    fs.readFileSync(path.join(f.root, "prompt-sent.ui-response"), "utf8"),
  );
  assert.equal(response.cancelled, true);
  const allowed = fixture(t);
  const accepted = await runRpcAttempt({
    ...options(allowed, "ui-allowed"),
    authorization: { delivery: "approved-integration" },
    targetConfirm: async (ui, { ownerSessionId }) => {
      assert.equal(ownerSessionId, "root-1");
      assert.equal(ui.title, "Apply staged integration?");
      return true;
    },
  });
  assert.equal(accepted.stopReason, "goal-complete");
  assert.equal(accepted.targetConfirmation.status, "approved");
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(allowed.root, "prompt-sent.ui-response"),
        "utf8",
      ),
    ).confirmed,
    true,
  );
  const wrong = fixture(t);
  await assert.rejects(
    runRpcAttempt({
      ...options(wrong, "ui-allowed"),
      targetConfirm: async () => true,
    }),
    /approved-integration/,
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
    observerOnly(report);
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
        `goal-${scenario === "complete" ? "complete" : "paused"}`,
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
