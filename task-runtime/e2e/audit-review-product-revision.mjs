// Read-only, post-run audit for the one-shot record-codec review-origin E2E.
// This does not replace host acceptance: compare native ledger, immutable
// artifacts, live Goal readback and a discriminating RED→GREEN behavior.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readEvidenceBytes, snapshot } from "../../host-evidence.mjs";
import { RuntimeLedger } from "../ledger.mjs";
import { digest } from "../contracts.mjs";
import { deriveProjectId, readClosedExecutionUsage } from "../orchestrator.mjs";
import { validateReviewReport } from "../integration-review.mjs";
import { verifyGoalReadback } from "./audit-rpc-attempt.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function parseEvidence(text, file) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`Invalid audit evidence: ${file}`, { cause });
  }
}
const read = (file, max = 1024 * 1024) =>
  parseEvidence(readEvidenceBytes(file, max).toString("utf8"), file);
const rootFor = (runtimeRoot, projectId, executionId) =>
  path.join(runtimeRoot, "projects", projectId, "executions", executionId);
const checkScript = fileURLToPath(
  new URL("./run-review-product-check.sh", import.meta.url),
);
function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(
    result.status,
    0,
    result.stderr || `git ${args.join(" ")} failed`,
  );
  return result.stdout.trim();
}
function reviewWaves(root, expect) {
  const directory = path.join(root, "integration/reviews");
  const keys = fs.readdirSync(directory).sort();
  assert.ok(keys.length > 0, "independent native review absent");
  return keys.map((key) => {
    assert.match(key, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    const file = path.join(directory, key, "complete.json");
    const completion = read(file);
    const plan = read(path.join(directory, key, "plan.json"));
    assert.equal(completion.state, "bound");
    assert.ok(
      expect === "old"
        ? ["pass", "blocked"].includes(completion.verdict)
        : completion.verdict === expect,
    );
    assert.equal(completion.planDigest, plan.planDigest);
    assert.ok(completion.reports.length > 0);
    assert.ok(
      completion.reports.every((row) =>
        expect === "old"
          ? ["pass", "blocked"].includes(row.report?.verdict)
          : row.report?.verdict === expect,
      ),
    );
    assert.ok(plan.wave.runs.every((run) => run.mode === "review"));
    return { key, completion, sha256: hash(readEvidenceBytes(file)) };
  });
}
function receiptCheck(root, check) {
  const file = path.join(root, "integration", `check-${check.commandId}.json`);
  const receipt = read(file);
  assert.equal(receipt.status, "verified", `${check.commandId} failed`);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.signal, null);
  assert.equal(receipt.errorCode, null);
  assert.equal(receipt.before.digest, receipt.after.digest);
  assert.equal(
    hash(readEvidenceBytes(`${file}.log`, 8 * 1024 * 1024)),
    receipt.logSha256,
  );
  return {
    commandId: check.commandId,
    file,
    sha256: hash(readEvidenceBytes(file)),
  };
}
function completeAudit(observation, runtimeRoot) {
  assert.equal(observation.status, "captured", "transport not captured");
  assert.equal(observation.stopReason, "goal-complete");
  assert.equal(observation.processReaped, true);
  assert.equal(observation.exitCode, 0);
  assert.equal(observation.taskDrain?.settled, true, "native drain incomplete");
  assert.equal(
    observation.taskUsage?.status,
    "measured",
    "closed usage unknown",
  );
  assert.equal(observation.preparation?.mode, "request-driven");
  const attemptInput = read(observation.preparation.inputFile);
  assert.equal(
    hash(readEvidenceBytes(observation.preparation.inputFile)),
    observation.preparation.inputSha256,
  );
  assert.equal(
    observation.preparation.requestFile,
    attemptInput.requestFile,
    "request differs from the admitted attempt input",
  );
  assert.equal(
    hash(readEvidenceBytes(attemptInput.requestFile, 65536)),
    observation.preparation.requestSha256,
  );
  assert.equal(observation.promptAdmission?.delivery, "verify-only");
  assert.equal(observation.promptAdmission?.goalAction, "create");
  assert.ok(!observation.logTruncated && !observation.rawNativeUnresolved);
  const ids = observation.executionIds;
  assert.ok(
    Array.isArray(ids) && ids.length === 2 && new Set(ids).size === 2,
    "one original and exactly one successor execution required",
  );
  const source = observation.cwd;
  assert.equal(fs.realpathSync(source), source);
  assert.equal(fs.realpathSync(runtimeRoot), runtimeRoot);
  const projectId = deriveProjectId(source);
  const ledger = new RuntimeLedger(path.join(runtimeRoot, "ledger.sqlite"), {
    readOnly: true,
  });
  let summary;
  try {
    assert.equal(
      ledger.listOpen(projectId).length,
      0,
      "project reservations open",
    );
    assert.equal(
      ledger.getController(projectId)?.ownerSessionId,
      `released:${observation.sessionId}`,
    );
    const [e0, e1] = ids.map((id) => ledger.getExecution(id));
    const [c0, c1] = ids.map((id) => ledger.getContract(id));
    assert.equal(e0.projectId, projectId);
    assert.equal(e1.projectId, projectId);
    assert.equal(e0.goalId, observation.goal?.id);
    assert.equal(e1.goalId, e0.goalId);
    assert.equal(e1.taskId, e0.taskId);
    assert.equal(e0.taskRevision, 1);
    assert.equal(e1.taskRevision, 2);
    assert.equal(e0.ownerSessionId, observation.sessionId);
    assert.equal(e1.ownerSessionId, observation.sessionId);
    assert.equal(e0.state, "CANCELLED");
    assert.equal(e1.state, "ACCEPTED");
    for (const execution of [e0, e1]) {
      assert.equal(execution.reservationOpen, false);
      assert.equal(execution.unresolvedRunCount, 0);
    }
    assert.equal(e1.goalCommitState, "committed");
    assert.equal(
      ledger.getAcceptance(e0.executionId),
      null,
      "old BLOCKED review was accepted",
    );
    assert.equal(c0.policy.reviewProductRevision, "within-scope-once");
    assert.equal(c0.policy.maxProcessRestarts, 1);
    assert.equal(c0.policy.integrationMode, "verify-only");
    assert.deepEqual(c1.policy, c0.policy);
    for (const field of [
      "objective",
      "workspace",
      "criteria",
      "contextRefs",
      "nonGoals",
    ])
      assert.deepEqual(
        c1[field],
        c0[field],
        `${field} changed across review repair`,
      );
    assert.deepEqual(c1.checks.slice(0, c0.checks.length), c0.checks);
    assert.ok(
      c0.checks.some(
        (check) =>
          check.executable === checkScript &&
          JSON.stringify(check.argv) === JSON.stringify(["smoke", "."]),
      ),
    );
    assert.ok(
      c1.checks.some(
        (check) =>
          check.executable === checkScript &&
          JSON.stringify(check.argv) === JSON.stringify(["regression", "."]),
      ),
      "new behavioral regression absent",
    );
    const [r0, r1] = ids.map((id) => rootFor(runtimeRoot, projectId, id));
    c0.checks.forEach((check) => receiptCheck(r0, check));
    const checks = c1.checks.map((check) => receiptCheck(r1, check));
    const oldReviews = reviewWaves(r0, "old");
    const oldFindings = oldReviews.flatMap(({ key, completion }) =>
      completion.reports.flatMap(({ key: reportKey, report }) =>
        report.findings.map((finding, index) => ({
          id: `${key}/${reportKey}:${index}`,
          severity: finding.severity,
        })),
      ),
    );
    assert.ok(
      oldReviews.some((wave) => wave.completion.verdict === "blocked") &&
        oldFindings.some((finding) => finding.severity === "blocker"),
    );
    const intentFile = path.join(r1, "receipts/repair-intent.json");
    const intent = read(intentFile);
    assert.equal(intent.schemaVersion, "teams-candidate-repair-intent/2");
    assert.equal(intent.mode, "blocked-review-product");
    assert.equal(intent.previousExecutionId, e0.executionId);
    assert.equal(
      intent.deadlineAt,
      Date.parse(e0.createdAt) + c0.policy.deadlineMs,
    );
    assert.deepEqual(
      new Set(intent.waves.map((wave) => wave.key)),
      new Set(oldReviews.map((wave) => wave.key)),
    );
    for (const wave of intent.waves) {
      const prior = oldReviews.find((old) => old.key === wave.key);
      assert.equal(wave.completionDigest, digest(prior.completion));
    }
    assert.equal(
      hash(readEvidenceBytes(intent.oldPatchRef, 8 * 1024 * 1024)),
      intent.oldPatchSha256,
    );
    const red = spawnSync(
      checkScript,
      ["regression", path.join(r0, "integration/repo")],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.ok(
      Number.isInteger(red.status) && red.status !== 0,
      "old staged candidate did not reproduce the regression (RED)",
    );
    const reviews = reviewWaves(r1, "pass");
    const newRequest = read(path.join(r1, "integration/review-request.json"));
    assert.equal(newRequest.subject.productRevision.oldTree, intent.oldTree);
    assert.equal(
      newRequest.subject.priorBlockedReview.reports.length,
      oldReviews.reduce((sum, wave) => sum + wave.completion.reports.length, 0),
    );
    for (const wave of reviews)
      for (const entry of wave.completion.reports) {
        validateReviewReport(newRequest, entry.report);
        assert.deepEqual(
          Object.keys(entry.report.priorResolutions).sort(),
          oldFindings.map((f) => f.id).sort(),
        );
        assert.equal(entry.report.verdict, "pass");
      }
    const accepted = ledger.getAcceptance(e1.executionId);
    assert.equal(accepted?.decision, "accepted");
    const receipt = read(accepted.receiptRef);
    assert.equal(receipt.receiptRef, accepted.receiptRef);
    for (const field of [
      "executionId",
      "requestDigest",
      "resultDigest",
      "sourceDigest",
      "decision",
      "controllerEpoch",
      "acceptedAt",
    ])
      assert.equal(
        receipt[field],
        accepted[field],
        `ledger/receipt ${field} changed`,
      );
    assert.equal(receipt.schemaVersion, "teams-task-acceptance/3");
    assert.equal(receipt.acceptedBySessionId, observation.sessionId);
    assert.equal(receipt.acceptanceId, accepted.acceptanceId);
    assert.equal(
      receipt.finalEvidence.productRevision?.schemaVersion,
      "teams-review-product-lineage/1",
    );
    assert.equal(
      receipt.finalEvidence.productRevision.previousExecutionId,
      e0.executionId,
    );
    assert.equal(
      receipt.finalEvidence.productRevision.intentDigest,
      hash(readEvidenceBytes(intentFile)),
    );
    assert.equal(receipt.finalEvidence.productRevision.oldTree, intent.oldTree);
    assert.equal(receipt.finalEvidence.delivery.kind, "verified-patch");
    assert.equal(receipt.finalEvidence.delivery.targetModified, false);
    assert.equal(receipt.finalEvidence.delivery.targetRoot, source);
    assert.equal(
      receipt.finalEvidence.productRevision.repairedTree,
      receipt.finalEvidence.delivery.tree,
    );
    assert.notEqual(intent.oldTree, receipt.finalEvidence.delivery.tree);
    assert.equal(
      hash(
        readEvidenceBytes(
          receipt.finalEvidence.delivery.patchRef,
          8 * 1024 * 1024,
        ),
      ),
      receipt.finalEvidence.delivery.patchDigest,
    );
    assert.equal(git(source, "rev-parse", "HEAD"), c0.workspace.baseCommit);
    assert.equal(
      git(source, "status", "--porcelain=v1", "--untracked-files=all"),
      "",
    );
    assert.equal(
      snapshot(source, c0.workspace.sourcePaths).digest,
      receipt.candidateSourceDigest,
    );
    assert.equal(
      snapshot(path.join(r1, "integration/repo"), c1.workspace.sourcePaths)
        .digest,
      receipt.finalEvidence.sourceDigest,
    );
    assert.equal(
      git(path.join(r1, "integration/repo"), "write-tree"),
      receipt.finalEvidence.delivery.tree,
    );
    assert.equal(receipt.finalEvidence.checks.length, checks.length);
    for (const check of checks)
      assert.ok(
        receipt.finalEvidence.checks.some(
          (item) =>
            item.commandId === check.commandId && item.digest === check.sha256,
        ),
      );
    const native = ids.map((id) => readClosedExecutionUsage(runtimeRoot, id));
    assert.equal(native[0].execution.state, "CANCELLED");
    assert.equal(native[1].execution.state, "ACCEPTED");
    assert.equal(
      native.reduce((sum, row) => sum + row.usage.totals.total, 0),
      observation.taskUsage.totals.total,
    );
    assert.equal(
      native[1].usage.totals.total,
      receipt.finalEvidence.usage.totals.total,
    );
    const accounted =
      observation.history.totals.total +
      observation.parent.usage.total +
      observation.rootUsage.total +
      observation.taskUsage.totals.total;
    assert.equal(observation.reportedTokens, accounted);
    assert.ok(accounted <= observation.maxTokens);
    summary = {
      goalId: e0.goalId,
      taskId: e0.taskId,
      executionIds: ids,
      receiptRef: accepted.receiptRef,
      receiptSha256: hash(readEvidenceBytes(accepted.receiptRef)),
      oldReviewFindings: oldFindings,
      freshReviewKeys: reviews.map((wave) => wave.key),
      checks,
      redExitCode: red.status,
      totalTokens: accounted,
      taskTokens: native.map((row) => row.usage.totals.total),
    };
  } finally {
    ledger.close();
  }
  const archive = path.join(source, ".pi/goals/archived");
  const matches = fs
    .readdirSync(archive)
    .filter((name) => name.endsWith(`_${summary.goalId}.md`));
  assert.equal(matches.length, 1, "Goal archive missing or duplicated");
  const goalFile = path.join(archive, matches[0]);
  const goal = parseEvidence(
    readEvidenceBytes(goalFile, 128 * 1024)
      .toString("utf8")
      .split("\n\n# Goal Prompt")[0],
    goalFile,
  );
  const events = readEvidenceBytes(
    path.join(source, ".pi/goals/goal_events.jsonl"),
    128 * 1024,
  )
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  verifyGoalReadback(
    goal,
    events,
    [
      {
        taskId: summary.taskId,
        acceptanceId: path
          .basename(summary.receiptRef)
          .slice("acceptance-".length, -".json".length),
      },
    ],
    summary.goalId,
  );
  return { ...summary, goalArchive: goalFile };
}

export function auditReviewProductRevision(
  observationFile,
  runtimeRoot = path.join(os.homedir(), ".pi/agent/teams-task-runtime-v1"),
) {
  const basis = {
    path: path.resolve(observationFile),
    sha256: hash(readEvidenceBytes(observationFile, 8 * 1024 * 1024)),
  };
  const observation = read(basis.path, 8 * 1024 * 1024);
  try {
    const evidence = completeAudit(observation, path.resolve(runtimeRoot));
    return {
      schemaVersion: "teams-review-product-live-audit/1",
      decision: "accepted",
      fullE2EPassed: true,
      observation: basis,
      evidence,
    };
  } catch (error) {
    return {
      schemaVersion: "teams-review-product-live-audit/1",
      decision: "blocked",
      fullE2EPassed: false,
      observation: basis,
      reason: String(error.message ?? error).slice(0, 1000),
      executionIds: observation.executionIds ?? [],
      firstReview: observation.executionIds?.[0] ?? null,
    };
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [observation, output, runtime] = process.argv.slice(2);
  assert.ok(
    observation && output && path.isAbsolute(output),
    "observation and new absolute audit output required",
  );
  const audit = auditReviewProductRevision(observation, runtime);
  fs.writeFileSync(output, JSON.stringify(audit, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({ decision: audit.decision, reason: audit.reason, output }),
  );
  process.exitCode = audit.fullE2EPassed ? 0 : 1;
}
