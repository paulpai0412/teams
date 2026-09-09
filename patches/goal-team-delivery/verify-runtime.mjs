// Exact candidate/installed package checks; no live Goal or model.
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
assert.equal(args[0], "--source-root");
assert.equal(args.length, 2);
const root = path.resolve(args[1]);
assert.deepEqual(
  fs.readFileSync(path.join(root, "goal-team-evidence.mjs")),
  fs.readFileSync(new URL("../../host-evidence.mjs", import.meta.url)),
  "installed receipt validator must match the parent helper",
);
const results = [];
for (const [file, argv] of [
  ["../../check-goal-hold-wake.mjs", ["--source-root", root]],
  ["../../check-goal-completion.mjs", [root, "--evidence"]],
  [
    "../../check-host-evidence.mjs",
    [path.join(root, "goal-team-evidence.mjs")],
  ],
]) {
  const result = spawnSync(
    process.execPath,
    [new URL(file, import.meta.url).pathname, ...argv],
    {
      encoding: "utf8",
      timeout: 90000,
      env: { ...process.env, PI_OFFLINE: "1", PI_MEMORY_EXIT_SUMMARY: "off" },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  try {
    results.push(JSON.parse(result.stdout));
  } catch (cause) {
    throw new Error("Invalid verification receipt: " + file, { cause });
  }
}
console.log(
  JSON.stringify({
    status: "PASS",
    checks: results,
    modelCalls: 0,
    childAgents: 0,
  }),
);
