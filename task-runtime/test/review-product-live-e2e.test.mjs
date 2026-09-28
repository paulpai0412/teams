import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { auditReviewProductRevision } from "../e2e/audit-review-product-revision.mjs";

const prepare = fileURLToPath(
  new URL("../e2e/prepare-review-product-fixture.mjs", import.meta.url),
);
const check = fileURLToPath(
  new URL("../e2e/run-review-product-check.sh", import.meta.url),
);
const controlledC0 = fileURLToPath(
  new URL(
    "../e2e/fixtures/review-product-revision/controlled-c0.mjs",
    import.meta.url,
  ),
);
function command(executable, args, options = {}) {
  return spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 15000,
    ...options,
  });
}

test("disposable baseline and sandboxed smoke distinguish a real candidate defect", (t) => {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "review-product-live-e2e-"),
  );
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  const created = command(process.execPath, [prepare, source]);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).status, "clean");
  const second = command(process.execPath, [prepare, source]);
  assert.notEqual(
    second.status,
    0,
    "existing source must never be overwritten",
  );
  const baseSmoke = command(check, ["smoke", source]);
  assert.notEqual(
    baseSmoke.status,
    0,
    "baseline is incomplete, not a smoke PASS",
  );
  // Diagnostic C0 fixture, never supplied to the live Worker as a patch.
  fs.appendFileSync(
    path.join(source, "app/records.mjs"),
    `\nexport function groupByLabel(records) {\n  const groups = new Map();\n  for (const record of records) {\n    if (!groups.has(record.label)) groups.set(record.label, []);\n    groups.get(record.label).push(record);\n  }\n  return groups;\n}\n`,
  );
  const smoke = command(check, ["smoke", source]);
  assert.equal(smoke.status, 0, smoke.stderr);
  const red = command(check, ["regression", source]);
  assert.notEqual(
    red.status,
    0,
    "escaping defect must be RED while smoke is GREEN",
  );
});

test("owner-authorized controlled C0 passes smoke but reproduces escaped-field failure in the sandbox", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-product-c0-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  const created = command(process.execPath, [prepare, source]);
  assert.equal(created.status, 0, created.stderr);
  fs.copyFileSync(controlledC0, path.join(source, "app/records.mjs"));
  const changed = command("git", ["-C", source, "diff", "--name-only"]);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(changed.stdout.trim(), "app/records.mjs");
  const smoke = command(check, ["smoke", source]);
  assert.equal(smoke.status, 0, smoke.stderr);
  const red = command(check, ["regression", source]);
  assert.notEqual(red.status, 0, "known escaped-backslash defect must be RED");
  assert.match(red.stderr, /invalid escape|lossless round trip/);
});

test("post-run audit binds the request to the admitted input, not a fixed E2E template", (t) => {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "review-product-request-audit-"),
  );
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const sha = (file) =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const requestFile = path.join(temp, "r7-request.txt");
  const inputFile = path.join(temp, "r7-input.json");
  const observationFile = path.join(temp, "observation.json");
  fs.writeFileSync(requestFile, "r7 independently authorized request\n");
  fs.writeFileSync(inputFile, JSON.stringify({ requestFile }));
  const observation = {
    status: "captured",
    stopReason: "goal-complete",
    processReaped: true,
    exitCode: 0,
    taskDrain: { settled: true },
    taskUsage: { status: "measured" },
    preparation: {
      mode: "request-driven",
      inputFile,
      inputSha256: sha(inputFile),
      requestFile,
      requestSha256: sha(requestFile),
    },
    promptAdmission: { delivery: "verify-only", goalAction: "create" },
    logTruncated: false,
    rawNativeUnresolved: false,
    executionIds: [],
  };
  fs.writeFileSync(observationFile, JSON.stringify(observation));
  assert.match(
    auditReviewProductRevision(observationFile, temp).reason,
    /one original and exactly one successor execution required/,
  );
  observation.preparation.requestFile = path.join(
    temp,
    "different-request.txt",
  );
  fs.writeFileSync(observationFile, JSON.stringify(observation));
  assert.match(
    auditReviewProductRevision(observationFile, temp).reason,
    /request differs from the admitted attempt input/,
  );
});

test("live post-run audit fails closed without native Goal, two executions and E1 receipt", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-product-audit-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const input = path.join(temp, "observation.json");
  fs.writeFileSync(
    input,
    JSON.stringify({
      status: "captured",
      stopReason: "goal-complete",
      executionIds: [],
      acceptance: "not-assessed",
    }),
  );
  const report = auditReviewProductRevision(input, temp);
  assert.equal(report.decision, "blocked");
  assert.equal(report.fullE2EPassed, false);
  assert.ok(report.reason.length > 0, "failure has a bounded diagnostic");
  assert.deepEqual(report.executionIds, []);
});
