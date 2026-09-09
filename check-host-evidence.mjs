// Real host-check CLI, disposable sources/commands; no model or real Goal.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const helper = process.argv[2]
  ? path.resolve(process.argv[2])
  : new URL("./host-evidence.mjs", import.meta.url).pathname;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "team-host-evidence-"));
const source = path.join(scratch, "source.js");
const output = path.join(scratch, "receipts");
fs.mkdirSync(output);
fs.writeFileSync(source, "export const answer = 42;\n");
const request = {
  cwd: scratch,
  sourcePaths: ["source.js"],
  argv: [
    process.execPath,
    "-e",
    "require('node:fs').appendFileSync('counter','x'); console.log('checked')",
  ],
  timeoutMs: 10000,
};
const requestFile = path.join(scratch, "request.json");
fs.writeFileSync(requestFile, JSON.stringify(request));
const receipt = path.join(output, "check.json");
function cli(args) {
  const result = spawnSync(process.execPath, [helper, ...args], {
    encoding: "utf8",
    timeout: 15000,
  });
  assert.ifError(result.error);
  return result;
}
try {
  const checked = cli(["run", requestFile, receipt]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(cli(["verify", requestFile, receipt]).status, 0);
  assert.notEqual(
    cli(["run", requestFile, receipt]).status,
    0,
    "never replay an existing intent",
  );
  assert.equal(fs.readFileSync(path.join(scratch, "counter"), "utf8"), "x");
  fs.appendFileSync(source, "// late formatter change\n");
  assert.notEqual(
    cli(["verify", requestFile, receipt]).status,
    0,
    "late byte drift invalidates the receipt",
  );
  fs.writeFileSync(source, "export const answer = 42;\n");
  fs.appendFileSync(receipt + ".log", "tampered");
  assert.notEqual(
    cli(["verify", requestFile, receipt]).status,
    0,
    "log tampering invalidates evidence",
  );
  const second = path.join(output, "second.json");
  assert.equal(cli(["run", requestFile, second]).status, 0);
  const review = path.join(scratch, "review.md");
  fs.writeFileSync(review, "Fixture review artifact, not a real review.\n");
  const contract = {
    version: "team-evidence/1",
    cwd: scratch,
    goalId: "fixture-goal",
    taskId: "t1",
    criteria: ["observed expected behavior"],
    checks: [{ id: "basic", input: request }],
    requiredEvidence: ["review.md"],
    decision: "decision.json",
  };
  const contractFile = path.join(scratch, "contract.json");
  fs.writeFileSync(contractFile, JSON.stringify(contract));
  const observations = {
    checks: { basic: "receipts/second.json" },
    criterionResults: [
      {
        criterion: contract.criteria[0],
        status: "met",
        entrypoint: "fixture CLI",
        observed: "fixture observation",
        evidence: ["check:basic", "file:review.md"],
      },
    ],
  };
  const observationsFile = path.join(scratch, "observations.json");
  fs.writeFileSync(observationsFile, JSON.stringify(observations));
  assert.notEqual(
    cli(["accept", contractFile]).status,
    0,
    "no sealed decision",
  );
  assert.equal(cli(["seal", contractFile, observationsFile]).status, 0);
  assert.equal(cli(["accept", contractFile]).status, 0);
  const { goalEvidenceBlockReason } = await import(pathToFileURL(helper).href);
  const reference = JSON.parse(
    cli(["reference", contractFile]).stdout,
  ).verificationContract;
  const goal = {
    id: "fixture-goal",
    taskList: {
      tasks: [{ id: "t1", status: "pending", verificationContract: reference }],
    },
  };
  assert.equal(goalEvidenceBlockReason(goal, scratch, "t1"), null);
  fs.appendFileSync(review, "changed");
  assert.notEqual(
    goalEvidenceBlockReason(goal, scratch),
    null,
    "required evidence drift blocks Goal",
  );
  fs.writeFileSync(review, "Fixture review artifact, not a real review.\n");
  // JSON formatting alone does not alter the declared contract identity.
  fs.writeFileSync(contractFile, JSON.stringify(contract, null, 2) + "\n");
  assert.equal(goalEvidenceBlockReason(goal, scratch), null);
  fs.appendFileSync(source, "// source changed after task completion\n");
  assert.notEqual(goalEvidenceBlockReason(goal, scratch), null);
  fs.writeFileSync(source, "export const answer = 42;\n");
  observations.criterionResults[0].status = "indeterminate";
  fs.writeFileSync(observationsFile, JSON.stringify(observations));
  assert.notEqual(cli(["seal", contractFile, observationsFile]).status, 0);
  assert.notEqual(
    cli(["accept", contractFile]).status,
    0,
    "failed re-evaluation invalidates previous ready decision",
  );
  const orphan = path.join(output, "orphan.json");
  fs.writeFileSync(orphan, "{}");
  assert.notEqual(cli(["run", requestFile, orphan]).status, 0);
  assert.equal(fs.readFileSync(path.join(scratch, "counter"), "utf8"), "xx");
  const altered = path.join(scratch, "altered.json");
  fs.writeFileSync(
    altered,
    JSON.stringify({
      ...request,
      argv: [process.execPath, "-e", "process.exit(0)"],
    }),
  );
  assert.notEqual(
    cli(["verify", altered, second]).status,
    0,
    "a different command cannot reuse the receipt",
  );
  fs.symlinkSync(source, path.join(scratch, "linked.js"));
  fs.writeFileSync(
    altered,
    JSON.stringify({ ...request, sourcePaths: ["linked.js"] }),
  );
  assert.notEqual(
    cli(["run", altered, path.join(output, "symlink.json")]).status,
    0,
  );
  assert.equal(fs.existsSync(path.join(output, "symlink.json.intent")), false);
  for (const [name, code, timeoutMs] of [
    ["failure", "process.exit(7)", 10000],
    ["timeout", "setInterval(()=>{},1000)", 100],
    [
      "mutating",
      "require('node:fs').appendFileSync('source.js','// mutated\\n')",
      10000,
    ],
    ["overflow", "process.stdout.write(Buffer.alloc(16*1024*1024,65))", 10000],
  ]) {
    fs.writeFileSync(
      altered,
      JSON.stringify({
        ...request,
        argv: [process.execPath, "-e", code],
        timeoutMs,
      }),
    );
    const failed = path.join(output, name + ".json");
    assert.notEqual(cli(["run", altered, failed]).status, 0, name);
    assert.notEqual(cli(["verify", altered, failed]).status, 0, name);
    assert.notEqual(
      cli(["run", altered, failed]).status,
      0,
      "failed check cannot be replayed under the same intent",
    );
  }
  fs.mkdirSync(path.join(scratch, "src"));
  fs.writeFileSync(path.join(scratch, "src/a.js"), "const a = 1;");
  fs.writeFileSync(
    altered,
    JSON.stringify({
      ...request,
      sourcePaths: ["src"],
      argv: [process.execPath, "--check", "src/a.js"],
    }),
  );
  const directoryReceipt = path.join(output, "directory.json");
  assert.equal(cli(["run", altered, directoryReceipt]).status, 0);
  fs.mkdirSync(path.join(scratch, "src/new-empty-directory"));
  assert.notEqual(
    cli(["verify", altered, directoryReceipt]).status,
    0,
    "directory membership matters even without new file bytes",
  );
  const malformed = {
    id: "fixture-goal",
    taskList: {
      tasks: [
        {
          id: "t1",
          status: "pending",
          verificationContract: "team-evidence/2:unsupported",
        },
      ],
    },
  };
  assert.notEqual(
    goalEvidenceBlockReason(malformed, scratch),
    null,
    "unknown protocol cannot silently become prose-only verification",
  );
  const lightweight = {
    id: "fixture-goal",
    taskList: {
      tasks: [
        {
          id: "parent",
          status: "complete",
          lightweightSubtasks: true,
          subtasks: malformed.taskList.tasks,
        },
      ],
    },
  };
  assert.equal(
    goalEvidenceBlockReason(lightweight, scratch),
    null,
    "lightweight children stay non-enforcing for parent/Goal completion",
  );
  assert.notEqual(
    goalEvidenceBlockReason(lightweight, scratch, "t1"),
    null,
    "explicit child completion must check its own contract",
  );
  console.log(
    JSON.stringify({
      status: "PASS",
      cases: 23,
      modelCalls: 0,
      childAgents: 0,
      limitation:
        "Actual CLI/process/hash checks with fixture judgments and no real Goal mutation or independent review.",
    }),
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
