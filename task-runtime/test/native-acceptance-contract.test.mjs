import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const agent = path.join(os.homedir(), ".pi/agent");
const source = path.join(
  agent,
  "npm/node_modules/pi-subagents/src/runs/shared/acceptance.ts",
);
const { createJiti } = createRequire(path.join(agent, "npm/package.json"))(
  "jiti",
);
const native = await createJiti(source).import(source);

test("installed native API accepts optional acceptance=false without an outputSchema", () => {
  assert.deepEqual(
    native.validateExecutionAcceptance({ acceptance: false }),
    [],
  );
  assert.deepEqual(native.validateExecutionAcceptance({}), []);
  assert.deepEqual(
    native.validateExecutionAcceptance({ tasks: [{ acceptance: false }] }),
    [],
  );
  assert.equal(native.normalizeAcceptanceInput(false).level, "none");
});

test("only selected native report mode requires a structured output schema", () => {
  assert.ok(
    native
      .validateExecutionAcceptance({ acceptance: { report: "on" } })
      .some((error) => /report requires outputSchema/.test(error)),
  );
  assert.deepEqual(
    native.validateExecutionAcceptance({
      acceptance: { report: "on" },
      outputSchema: { type: "object", properties: {} },
    }),
    [],
  );
  assert.ok(
    native
      .validateExecutionAcceptance({
        tasks: [{ acceptance: { report: "on" } }],
      })
      .some((error) =>
        /tasks\[0\].acceptance.report requires outputSchema/.test(error),
      ),
  );
});

test("current general L0 SPEC preserves required Task review without imposing native acceptance on ordinary handoff", () => {
  const spec = fs.readFileSync(
    new URL("../../extensions/teams-orchestrator/SPEC.md", import.meta.url),
    "utf8",
  );
  assert.match(spec, /acceptance:false.*valid/);
  assert.match(
    spec,
    /required checks, independent source-bound review or AcceptanceReceipt/,
  );
  assert.doesNotMatch(spec, /For request-driven G1\/canary flows/);
});
