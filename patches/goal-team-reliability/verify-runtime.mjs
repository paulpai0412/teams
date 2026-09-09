// Reuse the team's offline checks against an exact candidate package root.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
assert.equal(args[0], "--source-root");
assert.equal(args.length, 2);
const checks = [
  ["../../check-goal-hold-wake.mjs", ["--source-root", args[1]]],
  ["../../check-goal-completion.mjs", [args[1]]],
];
const results = [];
for (const [file, argv] of checks) {
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
  } catch {
    throw new Error("Offline check returned invalid JSON: " + file);
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
