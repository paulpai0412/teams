// Offline native launch seam; no provider, credentials, network or Task dispatch.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { nativeBudgetLaunch } from "./child-budget-fixture.mjs";
import { nativeDefinitions } from "./native-launch-fixture.mjs";
const binding = { "teams.task-budget/1": { key: "offline-marker" } };
test("parent-hosted native launch retains immutable per-session bindings without process env", () => {
  const before = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  const child = nativeBudgetLaunch(binding);
  assert.deepEqual(child.config.extensionBindings, binding);
  assert.ok(Object.isFrozen(child.config.extensionBindings));
  assert.ok(
    Object.isFrozen(child.config.extensionBindings["teams.task-budget/1"]),
  );
  assert.equal(child.session.processEnv, undefined);
  assert.equal(process.env.PI_SUBAGENT_EXTENSION_BINDINGS, before);
});
test("actual foreground executor forwards binding into native child launch", async () => {
  let captured;
  const sentinel = new Error("stop before creating child");
  const source = nativeDefinitions("src/runs/foreground/execution.ts", [
    "runSingleAttempt",
  ]);
  const execute = vm.runInNewContext(source + "\nrunSingleAttempt", {
    applyThinkingSuffix: (value) => value,
    assertThinkingWithinCeiling() {},
    resolveEffectiveThinking() {},
    deriveChildSessionName: () => "offline",
    resolveWatchdogConfig: () => ({ ok: false }),
    resolvePermissionRules() {},
    buildInProcessChildLaunch(input) {
      captured = input;
      throw sentinel;
    },
  });
  await assert.rejects(
    execute(
      process.cwd(),
      {},
      "fixture",
      undefined,
      { extensionBindings: binding },
      { launchWarnings: {} },
    ),
    (error) => error === sentinel,
  );
  assert.deepEqual(captured.extensionBindings, binding);
  assert.equal(captured.host, "parent");
});
