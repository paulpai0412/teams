// Real patch CLI, disposable package; no live Goal, model, child or reload.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
const bundle = process.argv[2]
  ? path.resolve(process.argv[2])
  : new URL("./patches/goal-team-reliability/", import.meta.url).pathname;
const installed = new URL("../npm/node_modules/pi-goal-x/", import.meta.url)
  .pathname;
function parseReceipt(text) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error("Invalid patch-check manifest or CLI receipt", { cause });
  }
}
const manifest = parseReceipt(
  fs.readFileSync(path.join(bundle, "manifest.json"), "utf8"),
);
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "team-reliability-package-"),
);
const target = path.join(scratch, "pi-goal-x");
const sha = (file) =>
  fs.existsSync(file)
    ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    : null;
const liveBefore = manifest.files.map((item) =>
  sha(path.join(installed, item.path)),
);
let cases = 0;
function run(args, env = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(bundle, "apply.mjs"), "--target", target, ...args],
    {
      encoding: "utf8",
      timeout: 150000,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_MEMORY_EXIT_SUMMARY: "off",
        ...env,
      },
    },
  );
  assert.ifError(result.error);
  return result;
}
function success(args, status) {
  const result = run(args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = parseReceipt(result.stdout);
  assert.equal(receipt.status, status);
  cases++;
  return receipt;
}
function assertPre() {
  for (const item of manifest.files)
    assert.equal(sha(path.join(target, item.path)), item.preSha256);
}
try {
  fs.cpSync(installed, target, { recursive: true });
  for (const item of manifest.files) {
    if (item.preimage === null)
      fs.rmSync(path.join(target, item.path), { force: true });
    else
      fs.copyFileSync(
        path.join(bundle, item.preimage),
        path.join(target, item.path),
      );
  }
  assert.equal(success(["--check"], "COMPATIBLE").state, "pre");
  const prerequisite = path.join(target, manifest.requiredFiles[0].path);
  const prerequisiteBytes = fs.readFileSync(prerequisite);
  fs.appendFileSync(prerequisite, "\n// fixture tamper\n");
  assert.match(run(["--check"]).stderr, /Required base patch hash mismatch/);
  fs.writeFileSync(prerequisite, prerequisiteBytes);
  cases++;
  const first = manifest.files[0];
  fs.appendFileSync(path.join(target, first.path), "\n// fixture tamper\n");
  const badHash = sha(path.join(target, first.path));
  assert.match(run([]).stderr, /Unsupported source; no files changed/);
  assert.equal(sha(path.join(target, first.path)), badHash);
  fs.copyFileSync(
    path.join(bundle, first.preimage),
    path.join(target, first.path),
  );
  cases++;
  const failure = run([], { PI_GOAL_HOLD_TEST_FAIL_VALIDATION: "1" });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /Forced validation failure/);
  assertPre();
  cases++;
  const applied = success([], "APPLIED");
  success([], "ALREADY_APPLIED");
  success(["--verify"], "VERIFIED");
  fs.copyFileSync(
    path.join(bundle, first.preimage),
    path.join(target, first.path),
  );
  assert.match(run(["--check"]).stderr, /Mixed pre\/post/);
  cases++;
  success(["--revert", applied.backup], "REVERTED");
  assertPre();
  assert.notEqual(
    run(["--revert", applied.backup]).status,
    0,
    "revert cannot consume the same receipt twice",
  );
  cases++;
  const packageFile = path.join(target, "package.json");
  const metadata = parseReceipt(fs.readFileSync(packageFile, "utf8"));
  fs.writeFileSync(
    packageFile,
    JSON.stringify({ ...metadata, version: "0.0.0-fixture" }),
  );
  assert.match(run(["--check"]).stderr, /Unsupported target/);
  cases++;
  assert.deepEqual(
    manifest.files.map((item) => sha(path.join(installed, item.path))),
    liveBefore,
  );
  console.log(
    JSON.stringify({
      status: "PASS",
      cases,
      modelCalls: 0,
      childAgents: 0,
      limitation:
        "Disposable target only; retained test backup manifests are not live installation receipts.",
    }),
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
