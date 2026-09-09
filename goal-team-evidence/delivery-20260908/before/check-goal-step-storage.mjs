// Real helper + native state store, fake launches, disposable filesystem only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createJiti } from "../npm/node_modules/jiti/lib/jiti.mjs";
import { prepareGoalRequest } from "./goal-request.mjs";
const jiti = createJiti(import.meta.url);
const { createMissionWorkflowState } = await jiti.import(
  "../npm/node_modules/pi-subagents/src/missions/workflow-state.ts",
);
const body = fs.readFileSync(
  new URL("./goal-task-step.js", import.meta.url),
  "utf8",
);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const helper = new AsyncFunction("state", "runs", body);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "goal-step-storage-"));
let launches = 0;
try {
  const state = createMissionWorkflowState({ missionDir: scratch }, "fixture");
  state.set("teamGoalBinding", { goalId: "fixture", cwd: scratch });
  const runs = {
    run: async () => {
      launches++;
      const input = state.get("teamGoalRequest");
      return {
        ok: true,
        runId: "fixture-child-" + launches,
        outputReference: "/fixture/report.md",
        artifactPaths: ["/fixture/report.md"],
        structuredOutput: {
          verdict: "pass",
          goalId: input.goalId,
          taskId: input.taskId,
          inputSourceState: input.sourceState,
          sourceState: input.sourceState,
          evidence: ["x".repeat(8192)],
          residualRisks: [],
        },
      };
    },
  };
  let previous;
  for (let n = 1; n <= 50; n++) {
    const packet = {
      goalId: "fixture",
      taskId: "t" + n,
      phase: "review",
      attempt: 1,
      agent: "team.reviewer",
      task: "task-" + n + ":" + "x".repeat(8192),
      cwd: scratch,
      sourceState: "fixture-source",
      goalStatus: "active",
      taskStatus: "pending",
    };
    const file = path.join(scratch, "packet-" + n + ".json");
    fs.writeFileSync(file, JSON.stringify(packet));
    const input = prepareGoalRequest(packet, file);
    if (n === 1) {
      const cli = spawnSync(
        process.execPath,
        [new URL("./goal-request.mjs", import.meta.url).pathname, file],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.ifError(cli.error);
      assert.equal(cli.status, 0, cli.stderr);
      assert.deepEqual(
        JSON.parse(cli.stdout),
        input,
        "real packet CLI must match the imported preparation contract",
      );
    }
    state.set("teamGoalRequest", input);
    const result = await helper(state, runs);
    assert.equal(result.status, "reported");
    state.set("teamGoalActiveStep", null); // simulated parent terminal reconciliation
    previous = input;
  }
  assert.equal(launches, 50);
  assert.ok(
    fs.statSync(state.path).size < 80 * 1024,
    "step history must retain references, not packets/reports",
  );
  const stateBytes = fs.statSync(state.path).size;
  const replay = await helper(state, runs);
  assert.equal(replay.status, "reconcile");
  assert.equal(launches, 50);
  state.set(
    "teamGoalRequest",
    prepareGoalRequest(
      { ...previous, task: "changed contract" },
      previous.requestRef,
    ),
  );
  await assert.rejects(helper(state, runs), /different contract/);
  assert.equal(launches, 50);

  // Fail saving the first intent: no child and no orphan active marker.
  const next = prepareGoalRequest(
    { ...previous, taskId: "t51" },
    previous.requestRef,
  );
  state.set("teamGoalRequest", next);
  const noSave = {
    get: (key) => state.get(key),
    set: (key, value) => {
      if (key === "goal-step.t51.review.1")
        throw new Error("fixture persistence failure");
      return state.set(key, value);
    },
  };
  await assert.rejects(helper(noSave, runs), /persistence failure/);
  assert.equal(state.get("teamGoalActiveStep"), null);
  assert.equal(launches, 50);

  // Exercise real store exhaustion before dispatch, not just an injected failure.
  const remaining = 262144 - fs.statSync(state.path).size;
  state.set("fixturePadding", "x".repeat(remaining - 128));
  await assert.rejects(helper(state, runs), /Mission state exceeds/);
  assert.equal(state.get("teamGoalActiveStep"), null);
  assert.equal(launches, 50);
  const bad = path.join(scratch, "invalid-packet.json");
  for (const text of [
    "{",
    JSON.stringify({ ...previous, task: "x".repeat(72 * 1024) }),
  ]) {
    fs.writeFileSync(bad, text);
    const cli = spawnSync(
      process.execPath,
      [new URL("./goal-request.mjs", import.meta.url).pathname, bad],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.ifError(cli.error);
    assert.notEqual(cli.status, 0);
    assert.equal(cli.stdout, "");
  }
  console.log(
    JSON.stringify({
      status: "PASS",
      cases: 8,
      steps: launches,
      stateBytes,
      modelCalls: 0,
      childAgents: 0,
      limitation:
        "Synthetic packets and fake launches; actual packet CLI/helper/native state persistence, including real capacity rejection.",
    }),
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
