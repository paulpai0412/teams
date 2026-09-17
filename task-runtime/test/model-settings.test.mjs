import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readTaskModels, taskRoleModel, modelId } from "../capabilities.mjs";
import { workerCommand } from "../herdr-port.mjs";
import { prepareRoleWave } from "../role-wave.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-models-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("persistent defaults use Antigravity Flash models with explicit planner and no inherited model", () => {
  const models = readTaskModels();
  assert.equal(models.l0, "antigravity/gemini-3.8-flash");
  assert.equal(models.taskPi, "antigravity/gemini-3.7-flash");
  for (const role of [
    "team.planner",
    "team.reviewer",
    "team.security",
    "team.challenger",
  ])
    assert.equal(taskRoleModel(role, models), "antigravity/gemini-3.8-flash");
  for (const role of [
    "team.implementer",
    "team.verifier",
    "team.e2e",
    "team.qa",
  ])
    assert.equal(taskRoleModel(role, models), "antigravity/gemini-3.7-flash");
  assert.throws(() => taskRoleModel("team.advisor", models), /no configured/);
  assert.throws(() => modelId("luna"), /explicit/);
  assert.throws(
    () => modelId("openai-codex/gpt-5.6-luna;echo bad"),
    /explicit/,
  );
});

test("model settings are editable data; malformed, missing and linked settings never fall back", (t) => {
  const root = fixture(t),
    file = path.join(root, "models.json");
  const config = readTaskModels();
  config.taskPi = "antigravity/gemini-3.8-flash";
  fs.writeFileSync(file, JSON.stringify(config));
  assert.equal(readTaskModels(file).taskPi, config.taskPi);
  for (const value of [
    { ...config, extra: true },
    { ...config, version: 2 },
    { ...config, roles: [] },
    { ...config, l0: "terra" },
  ]) {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => readTaskModels(file));
  }
  fs.writeFileSync(file, "{");
  assert.throws(() => readTaskModels(file));
  const link = path.join(root, "linked.json");
  fs.symlinkSync(file, link);
  assert.throws(() => readTaskModels(link), /canonical/);
  assert.throws(() => readTaskModels(path.join(root, "missing.json")));
});

test("Task Pi shell command passes the selected model to the actual argv consumer", (t) => {
  const root = fixture(t),
    binary = path.join(root, "pi fixture");
  fs.writeFileSync(
    binary,
    `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),execution:process.env.TEAMS_TASK_EXECUTION_DIR}));\n`,
    { mode: 0o700 },
  );
  const extension = path.join(root, "extension.mjs");
  fs.writeFileSync(extension, "");
  for (const selected of [undefined, "antigravity/gemini-3.8-flash"]) {
    const command = workerCommand({
      piExecutable: binary,
      workerExtension: extension,
      subagentsExtension: extension,
      executionRoot: root,
      ...(selected ? { model: selected } : {}),
    });
    const run = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      timeout: 2000,
    });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(
      receipt.args[receipt.args.indexOf("--model") + 1],
      selected ?? "antigravity/gemini-3.7-flash",
    );
    assert.equal(receipt.execution, root);
    assert.equal(
      receipt.args[receipt.args.indexOf("--tools") + 1],
      "read,team_role_spawn,team_task_result,subagent_supervisor",
    );
  }
});

test("role waves explicitly pass configured models without changing roles or authority", (t) => {
  const root = fixture(t);
  const contract = {
    workspace: { sourceRoot: root, allowedWritePaths: [] },
    criteria: [{ text: "Fixture" }],
    policy: {
      allowedRoles: ["team.planner", "team.reviewer", "team.qa"],
      maxActiveRoleRuns: 3,
      maxTaskTokens: 100,
      deadlineMs: 1000,
    },
  };
  const wave = {
    key: "readers",
    reason: "Independent bounded readers",
    runs: contract.policy.allowedRoles.map((role, index) => ({
      key: `r${index}`,
      role,
      task: "Read only",
      mode: "read-only",
      isolation: "shared",
      maxTokens: 10,
    })),
  };
  const plan = prepareRoleWave(contract, root, wave);
  assert.deepEqual(
    plan.children.map((child) => child.model),
    [
      "antigravity/gemini-3.8-flash",
      "antigravity/gemini-3.8-flash",
      "antigravity/gemini-3.7-flash",
    ],
  );
  assert.deepEqual(
    plan.children.map((child) => child.agent),
    contract.policy.allowedRoles,
  );
  assert.ok(
    plan.workflowScript.includes('"model":"antigravity/gemini-3.8-flash"'),
  );
  assert.ok(
    plan.children.every(
      (child) => child.context === "fresh" && child.worktree === false,
    ),
  );
  assert.equal(plan.reservedTokens, 30);
});
