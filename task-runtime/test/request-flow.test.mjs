import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import teamsOrchestrator from "../../extensions/teams-orchestrator/index.mjs";
import { taskToolParameters } from "../task-tool-inputs.mjs";

// Real extension registration, no session initialization/model/Goal/Herdr.
// This checks the model-facing tool surface, not semantic model compliance.
test("ordinary dispatch exposes request-driven authoring without requiring a harness or a new tool", () => {
  const tools = new Map();
  const events = new Map();
  teamsOrchestrator({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand() {},
    on: (event, handler) => events.set(event, handler),
  });
  assert.deepEqual(
    [...tools.keys()].sort(),
    Object.keys(taskToolParameters).sort(),
  );
  for (const [name, tool] of tools)
    assert.deepEqual(tool.parameters, taskToolParameters[name]);
  const dispatch = tools.get("team_task_dispatch");
  const specPath = fileURLToPath(
    new URL("../../extensions/teams-orchestrator/SPEC.md", import.meta.url),
  );
  const instructions = fs.readFileSync(specPath, "utf8");
  assert.ok(dispatch.description.includes(specPath)); // available even with custom system prompts
  assert.match(dispatch.promptSnippet, /L0-authored/);
  assert.ok(dispatch.promptGuidelines.some((line) => line.includes(specPath)));
  assert.match(dispatch.promptGuidelines.join("\n"), /user's request/);
  assert.match(dispatch.promptGuidelines.join("\n"), /sum of Task ceilings/);
  assert.match(instructions, /requirements → tasks → checks/);
  assert.match(instructions, /combined deliverable/);
  assert.match(instructions, /semantic.*coverage/);
  assert.doesNotMatch(instructions, /Todo|G1|500000|approved-todo\.patch/);
  assert.equal(events.has("before_agent_start"), false); // no extra injected controller/prompt loop
});
