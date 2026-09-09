// Real preparation CLI + native disposable mission store; launches are stubs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createJiti } from "../npm/node_modules/jiti/lib/jiti.mjs";
import { prepareGoalDispatch } from "./goal-request.mjs";
const jiti = createJiti(import.meta.url);
const { createMissionWorkflowState } = await jiti.import(
  "../npm/node_modules/pi-subagents/src/missions/workflow-state.ts",
);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "goal-dispatch-"));
const packetFile = path.join(scratch, "input.json");
const input = {
  goalId: "fixture",
  taskId: "t1",
  phase: "review",
  attempt: 1,
  agent: "team.reviewer",
  task: 'Fixture with quotes: "; throw new Error("not executable");',
  cwd: scratch,
  goalStatus: "active",
  taskStatus: "pending",
  missionId: "fixture",
  sourcePaths: ["source.js"],
  timeoutMs: 15000,
};
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function cli(...args) {
  const result = spawnSync(
    process.execPath,
    [new URL("./goal-request.mjs", import.meta.url).pathname, ...args],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.ifError(result.error);
  return result;
}
try {
  fs.writeFileSync(
    path.join(scratch, "source.js"),
    "export const value = 1;\n",
  );
  fs.writeFileSync(packetFile, JSON.stringify(input));
  const generated = cli("--dispatch", packetFile);
  assert.equal(generated.status, 0, generated.stderr);
  const args = JSON.parse(generated.stdout);
  assert.equal(args.setupArgs.async, false);
  assert.equal(args.dispatchArgs.async, true);
  assert.equal(args.dispatchArgs.timeoutMs, 15000);
  assert.equal(args.dispatchArgs.maxSubagentSpawnsPerRun, 1);
  const setup = new AsyncFunction(
    "state",
    fs.readFileSync(args.setupArgs.workflowScriptPath, "utf8"),
  );
  const state = createMissionWorkflowState(
    { missionDir: path.join(scratch, "missions") },
    "fixture",
  );
  assert.equal((await setup(state)).status, "prepared");
  const effective = state.get("teamGoalRequest");
  const recovered = cli(effective.requestRef);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.deepEqual(
    JSON.parse(recovered.stdout),
    effective,
    "saved effective packet must be exactly recoverable with the existing CLI",
  );
  let launches = 0;
  const runs = {
    run: async (_key, options) => {
      launches++;
      assert.equal(
        options.timeoutMs,
        15000,
        "timeout must reach the actual runs.run call",
      );
      return {
        ok: true,
        runId: "fixture-run",
        outputReference: "/fixture/report.md",
        structuredOutput: {
          verdict: "pass",
          goalId: input.goalId,
          taskId: input.taskId,
          inputSourceState: effective.sourceState,
          sourceState: effective.sourceState,
          evidence: ["fixture only"],
          residualRisks: [],
        },
      };
    },
  };
  const helper = new AsyncFunction(
    "state",
    "runs",
    fs.readFileSync(args.dispatchArgs.workflowScriptPath, "utf8"),
  );
  assert.equal((await helper(state, runs)).status, "reported");
  assert.equal(launches, 1);
  await assert.rejects(setup(state), /Reconcile active intent/);
  state.set("teamGoalActiveStep", null);
  assert.equal((await helper(state, runs)).status, "reconcile");
  assert.equal(launches, 1, "preparation must not authorize replay");
  assert.throws(() =>
    prepareGoalDispatch({ ...input, timeoutMs: 0 }, packetFile),
  );
  assert.throws(() =>
    prepareGoalDispatch({ ...input, goalStatus: "paused" }, packetFile),
  );
  const writes = [];
  await assert.rejects(
    setup({
      get: async () => undefined,
      set: async (key) => {
        writes.push(key);
        throw new Error("capacity");
      },
    }),
    /capacity/,
  );
  assert.deepEqual(
    writes,
    ["teamGoalRequest"],
    "first persistence failure must not create a binding",
  );
  const mutated = JSON.parse(fs.readFileSync(effective.requestRef, "utf8"));
  mutated.task = "changed saved packet";
  fs.writeFileSync(effective.requestRef, JSON.stringify(mutated));
  assert.notEqual(cli("--dispatch", packetFile).status, 0);
  console.log(
    JSON.stringify({
      status: "PASS",
      cases: 12,
      modelCalls: 0,
      childAgents: 0,
      realMissionMutation: false,
    }),
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
