// Parent-only regression: invokes the real offline checker; zero children/models.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const checker = fileURLToPath(new URL("./check-config.mjs", import.meta.url));
const cwd = process.argv[2] || process.cwd();
let checks = 0;
function parseReceipt(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error("Role checker did not return a JSON receipt", { cause });
  }
}
function run(args) {
  const result = spawnSync(process.execPath, [checker, ...args, cwd], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, PI_OFFLINE: "1", PI_MEMORY_EXIT_SUMMARY: "off" },
  });
  assert.ifError(result.error);
  return result;
}
for (const args of [
  ["--roles-only", "--roles="],
  ["--roles-only", "--roles=team.debugger,team.debugger"],
  ["--roles-only", "--roles=team.nonexistent"],
  ["--roles=team.debugger"],
  ["--roles-only", "--roles=team.debugger", "--roles=team.reviewer"],
  ["--roles-only", "--role=team.debugger"],
  ["--roles-only", "--models-only"],
]) {
  const result = run(args);
  assert.notEqual(result.status, 0, `invalid selection accepted: ${args}`);
  assert.match(result.stderr, /AssertionError/);
  checks++;
}
const selected = run(["--roles-only", "--roles=team.debugger,team.reviewer"]);
assert.equal(selected.status, 0, selected.stderr);
const receipt = parseReceipt(selected);
assert.equal(receipt.scope, "selected-role-contracts-only");
assert.deepEqual(receipt.roles.map((r) => r.name).sort(), [
  "team.debugger",
  "team.reviewer",
]);
assert.ok(receipt.uncheckedRoles.includes("team.docs"));
assert.equal(receipt.modelCalls, 0);
assert.equal(receipt.childAgents, 0);
checks++;
const all = run(["--roles-only"]);
if (all.status === 0) {
  const full = parseReceipt(all);
  assert.equal(full.scope, "role-contracts-only");
  assert.equal(full.roles.length, 14);
  assert.deepEqual(full.uncheckedRoles, []);
} else {
  const health = parseReceipt(all);
  assert.equal(health.status, "FAIL");
  assert.equal(
    health.roles.length + health.failures.length,
    14,
    "health must inspect every role, not stop at the first failure",
  );
  assert.equal(
    new Set([...health.roles, ...health.failures].map((row) => row.name)).size,
    14,
  );
  checks++;
  // When the real installation has a missing skill, it must still fail when
  // that role is selected. Other global failures are not silently accepted.
  const match = all.stderr.match(/(team\.[a-z]+) missing skill/);
  assert.ok(match, all.stderr);
  const broken = run(["--roles-only", `--roles=${match[1]}`]);
  assert.notEqual(broken.status, 0);
  assert.ok(broken.stderr.includes(`${match[1]} missing skill`), broken.stderr);
  const failure = parseReceipt(broken).failures.find(
    (row) => row.name === match[1],
  );
  assert.equal(failure.kind, "missing-declared-skill");
  assert.ok(
    Array.isArray(failure.missingSkills) && failure.missingSkills.length,
  );
  checks++;
}
checks++;
console.log(
  JSON.stringify(
    {
      status: "PASS",
      checks,
      cwd,
      modelCalls: 0,
      childAgents: 0,
      allRoleHealth:
        all.status === 0 ? "PASS" : "FAIL (missing skill preserved)",
      limitation:
        "Offline preflight behavior only; not live dispatch or product acceptance.",
    },
    null,
    2,
  ),
);
