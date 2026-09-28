// Post-run, read-only native evidence check. The RPC observer only captures
// transport; this separate consumer never replays a check or owns an execution.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readEvidenceBytes, snapshot } from "../../host-evidence.mjs";
import { RuntimeLedger } from "../ledger.mjs";
import { deriveProjectId, readClosedExecutionUsage } from "../orchestrator.mjs";

const hex = /^[0-9a-f]{64}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function usageTotal(value) {
  const parts = ["input", "output", "cacheRead", "cacheWrite"];
  assert.ok(
    parts.every((key) => Number.isSafeInteger(value?.[key]) && value[key] >= 0),
    "usage components unknown",
  );
  const sum = parts.reduce((total, key) => total + value[key], 0);
  assert.ok(
    Number.isSafeInteger(sum) && sum === value.total,
    "usage components differ from total",
  );
  return sum;
}
function parseEvidence(text, label) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`Invalid audit evidence: ${label}`, { cause });
  }
}
function json(file, maximum = 1024 * 1024) {
  return parseEvidence(readEvidenceBytes(file, maximum).toString("utf8"), file);
}
function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `Git readback failed: ${result.stderr}`);
  return result.stdout.trim();
}
function within(root, file) {
  assert.ok(
    path.isAbsolute(file) && file.startsWith(root + path.sep),
    "native evidence outside execution root",
  );
  return file;
}
export function verifyGoalReadback(goal, events, proofs, goalId) {
  assert.equal(goal.id, goalId);
  assert.equal(goal.status, "complete");
  assert.equal(goal.taskList?.tasks?.length, proofs.length);
  for (const proof of proofs) {
    const task = goal.taskList.tasks.find((entry) => entry.id === proof.taskId);
    assert.equal(task?.status, "complete");
    assert.equal(task.evidence, `task-runtime:${proof.acceptanceId}`);
  }
  assert.ok(
    events.some(
      (event) => event.type === "goal_completed" && event.goalId === goal.id,
    ),
  );
  for (const proof of proofs)
    assert.ok(
      events.some(
        (event) =>
          event.type === "task_complete" &&
          event.taskId === proof.taskId &&
          event.evidence === `task-runtime:${proof.acceptanceId}`,
      ),
    );
}
function sameReceipt(receipt, row) {
  for (const key of [
    "acceptanceId",
    "executionId",
    "requestDigest",
    "resultDigest",
    "sourceDigest",
    "receiptRef",
    "controllerEpoch",
    "decision",
    "acceptedAt",
  ])
    assert.equal(receipt[key], row[key], `ledger/receipt ${key} differs`);
}

function verifyNativeAttempt(observation, runtimeRoot, observationFile) {
  assert.equal(observation.status, "captured", "transport not captured");
  assert.equal(observation.acceptance, "not-assessed");
  assert.equal(Object.hasOwn(observation, "fullE2EPassed"), false);
  assert.equal(observation.stopReason, "goal-complete");
  assert.equal(observation.processReaped, true);
  assert.equal(observation.exitCode, 0);
  assert.equal(observation.signal, null);
  assert.equal(observation.taskDrain?.settled, true, "owner drain incomplete");
  assert.equal(observation.taskUsage?.status, "measured", "Task usage unknown");
  const reported =
    usageTotal(observation.history?.totals) +
    usageTotal(observation.parent?.usage) +
    usageTotal(observation.rootUsage) +
    usageTotal(observation.taskUsage?.totals);
  assert.ok(
    Number.isSafeInteger(reported) &&
      observation.reportedTokens === reported &&
      reported <= observation.maxTokens,
    "campaign usage exceeds admission or is unavailable",
  );
  assert.ok(!observation.logTruncated && !observation.rawNativeUnresolved);
  assert.ok(
    Array.isArray(observation.executionIds) &&
      observation.executionIds.length > 0 &&
      observation.executionIds.length <= 16 &&
      new Set(observation.executionIds).size ===
        observation.executionIds.length,
    "distinct native Task executions required",
  );
  assert.equal(observation.preparation?.mode, "request-driven");
  assert.equal(observation.preparation?.noTaskSpecsProvided, true);
  assert.equal(observation.preparation?.noSolutionPatchProvided, true);
  assert.equal(
    observation.preparation.requestFile,
    path.join(import.meta.dirname, "g1-request.txt"),
    "only the designated G1 request can be audited",
  );
  assert.match(observation.preparation.requestSha256, hex);
  assert.equal(
    hash(readEvidenceBytes(observation.preparation.requestFile, 65536)),
    observation.preparation.requestSha256,
    "original request bytes changed",
  );
  const admission = json(
    path.join(path.dirname(observationFile), "admission.json"),
  );
  for (const key of [
    "preparation",
    "history",
    "maxTokens",
    "taskTokenReservation",
    "authorization",
  ])
    assert.deepEqual(
      observation[key],
      admission[key],
      `admission ${key} changed`,
    );
  assert.equal(
    hash(readEvidenceBytes(observation.preparation.inputFile, 1024 * 1024)),
    observation.preparation.inputSha256,
    "owner input bytes changed",
  );
  const source = observation.cwd;
  assert.equal(
    fs.realpathSync(source),
    source,
    "canonical source root required",
  );
  assert.equal(
    fs.realpathSync(runtimeRoot),
    runtimeRoot,
    "canonical runtime root required",
  );
  const projectId = deriveProjectId(source);
  const ledger = new RuntimeLedger(path.join(runtimeRoot, "ledger.sqlite"), {
    readOnly: true,
  });
  const proofs = [];
  try {
    assert.equal(ledger.listOpen(projectId).length, 0, "project remains open");
    assert.equal(
      ledger.getController(projectId)?.ownerSessionId,
      `released:${observation.sessionId}`,
      "owner was not released",
    );
    for (const executionId of observation.executionIds) {
      const execution = ledger.getExecution(executionId);
      assert.equal(
        execution?.projectId,
        projectId,
        "execution/project mismatch",
      );
      assert.equal(
        execution?.goalId,
        observation.goal?.id,
        "Goal identity changed",
      );
      assert.equal(execution?.state, "ACCEPTED");
      assert.equal(execution.reservationOpen, false);
      assert.equal(execution.unresolvedRunCount, 0);
      assert.equal(execution.goalCommitState, "committed");
      const contract = ledger.getContract(executionId);
      assert.equal(contract.workspace.sourceRoot, source);
      assert.equal(
        contract.workspace.baseCommit,
        observation.preparation.sourceBase,
      );
      assert.equal(contract.policy.integrationMode, "verify-only");
      assert.equal(contract.schemaVersion, "teams-task-runtime/3");
      assert.ok(
        contract.checks.some(
          (check) =>
            check.commandId === "designated-browser-check" &&
            check.executable ===
              path.join(import.meta.dirname, "run-browser-check.sh") &&
            check.cwd === source &&
            JSON.stringify(check.argv) === JSON.stringify([".", "../browser"]),
        ),
        "designated browser host check missing",
      );
      const root = path.join(
        runtimeRoot,
        "projects",
        projectId,
        "executions",
        executionId,
      );
      const row = ledger.getAcceptance(executionId);
      assert.equal(row?.decision, "accepted", "native acceptance missing");
      assert.equal(
        row.receiptRef,
        path.join(root, "receipts", `acceptance-${row.acceptanceId}.json`),
        "receipt path changed",
      );
      const receipt = json(within(root, row.receiptRef));
      sameReceipt(receipt, row);
      const native = readClosedExecutionUsage(runtimeRoot, executionId);
      assert.equal(native.execution.state, "ACCEPTED");
      assert.equal(receipt.schemaVersion, "teams-task-acceptance/3");
      assert.equal(receipt.acceptedBySessionId, observation.sessionId);
      assert.equal(receipt.finalEvidence.delivery.kind, "verified-patch");
      assert.equal(receipt.finalEvidence.delivery.targetModified, false);
      assert.equal(receipt.finalEvidence.delivery.targetRoot, source);
      assert.equal(
        receipt.finalEvidence.usage.totals.total,
        native.usage.totals.total,
        "accepted native usage changed",
      );
      const staged = path.join(root, "integration", "repo");
      assert.equal(receipt.finalEvidence.delivery.sourceRoot, staged);
      assert.equal(
        snapshot(staged, contract.workspace.sourcePaths).digest,
        receipt.finalEvidence.sourceDigest,
        "staged source changed",
      );
      assert.equal(
        snapshot(source, contract.workspace.sourcePaths).digest,
        receipt.candidateSourceDigest,
        "original source changed",
      );
      assert.equal(
        git(source, ["rev-parse", "HEAD"]),
        contract.workspace.baseCommit,
        "target HEAD changed",
      );
      assert.equal(
        git(source, ["status", "--porcelain=v1", "--untracked-files=all"]),
        "",
        "target is dirty",
      );
      const patch = within(root, receipt.finalEvidence.delivery.patchRef);
      assert.equal(
        hash(readEvidenceBytes(patch, 8 * 1024 * 1024)),
        receipt.finalEvidence.delivery.patchDigest,
        "accepted patch changed",
      );
      const candidate = json(
        path.join(root, "integration", "review-candidate.json"),
      );
      const reviewRequest = json(
        path.join(root, "integration", "review-request.json"),
      );
      assert.equal(
        receipt.finalEvidence.reviewBinding.candidateDigest,
        candidate.candidateDigest,
      );
      assert.equal(
        receipt.finalEvidence.reviewBinding.requestDigest,
        reviewRequest.digest,
      );
      assert.equal(
        reviewRequest.subject.tree,
        receipt.finalEvidence.delivery.tree,
      );
      assert.ok(candidate.waves.length > 0, "independent review missing");
      const reviewProofs = candidate.waves.map((wave) => {
        const key = wave.key;
        assert.match(key, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
        const folder = path.join(root, "integration", "reviews", key);
        const completeFile = path.join(folder, "complete.json");
        const complete = json(completeFile);
        const plan = json(path.join(folder, "plan.json"));
        assert.equal(complete.verdict, "pass");
        assert.equal(complete.state, "bound");
        assert.equal(complete.requestDigest, reviewRequest.digest);
        assert.equal(complete.planDigest, wave.planDigest);
        assert.equal(complete.runId, wave.runId);
        assert.equal(plan.planDigest, wave.planDigest);
        assert.ok(complete.reports.length > 0);
        assert.ok(
          complete.reports.every(
            (entry) =>
              entry.report?.verdict === "pass" &&
              entry.report.requestDigest === reviewRequest.digest &&
              entry.report.findings?.length === 0,
          ),
          "independent reviewer verdict unavailable",
        );
        assert.ok(
          plan.wave.runs.every(
            (run) =>
              run.mode === "review" &&
              !reviewRequest.subject.writerRoles.includes(run.role),
          ),
          "writer cannot be final reviewer",
        );
        return { key, sha256: hash(readEvidenceBytes(completeFile)) };
      });
      assert.equal(receipt.criteria.length, contract.criteria.length);
      assert.deepEqual(
        receipt.criteria.map((criterion) => criterion.decision),
        contract.criteria.map(() => "accepted"),
      );
      assert.equal(receipt.finalEvidence.checks.length, contract.checks.length);
      assert.ok(contract.checks.length > 0, "host checks missing");
      const checks = contract.checks.map((check, index) => {
        const bound = receipt.finalEvidence.checks[index];
        assert.match(check.commandId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
        assert.equal(bound.commandId, check.commandId);
        const expected = path.join(
          root,
          "integration",
          `check-${check.commandId}.json`,
        );
        assert.equal(bound.receiptRef, expected);
        assert.equal(hash(readEvidenceBytes(expected)), bound.digest);
        const proof = json(expected);
        assert.equal(proof.status, "verified");
        assert.equal(proof.exitCode, 0);
        assert.equal(proof.signal, null);
        assert.equal(proof.errorCode, null);
        assert.equal(proof.before.digest, proof.after.digest);
        assert.equal(proof.after.digest, receipt.finalEvidence.sourceDigest);
        assert.equal(
          hash(readEvidenceBytes(`${expected}.log`, 8 * 1024 * 1024)),
          proof.logSha256,
        );
        return { commandId: bound.commandId, sha256: bound.digest };
      });
      const browserFile = path.join(
        root,
        "integration",
        "browser",
        "browser-report.json",
      );
      const browser = json(browserFile);
      assert.equal(browser.status, "passed", "designated browser check failed");
      assert.deepEqual(browser.runtimeErrors, []);
      assert.deepEqual(browser.viewports, ["1440x900", "390x844"]);
      assert.ok(
        [
          "empty",
          "empty-state-visibility",
          "create",
          "complete",
          "filter",
          "delete",
          "persistence",
          "responsive",
          "focus",
          "accessible-label",
          "text-not-html",
          "corrupt-storage-recovery",
        ].every((item) => browser.scenarios.includes(item)),
        "required browser scenarios missing",
      );
      assert.ok(
        browser.requests.every(
          (request) =>
            typeof request.path === "string" &&
            request.path.startsWith("/") &&
            !request.path.startsWith("//") &&
            !request.path.includes("://"),
        ),
        "browser made nonlocal requests",
      );
      proofs.push({
        executionId,
        taskId: contract.identity.taskId,
        acceptanceId: row.acceptanceId,
        acceptanceSha256: hash(readEvidenceBytes(row.receiptRef)),
        checks,
        browserSha256: hash(readEvidenceBytes(browserFile)),
        reviews: reviewProofs,
        patchSha256: receipt.finalEvidence.delivery.patchDigest,
        nativeTokens: native.usage.totals.total,
      });
    }
  } finally {
    ledger.close();
  }
  assert.equal(
    proofs.reduce((sum, proof) => sum + proof.nativeTokens, 0),
    observation.taskUsage.totals.total,
    "observed Task usage differs from native closed usage",
  );
  const archived = path.join(source, ".pi", "goals", "archived");
  const matching = fs
    .readdirSync(archived)
    .filter((name) => name.endsWith(`_${observation.goal?.id}.md`));
  assert.equal(matching.length, 1, "one archived Goal required");
  const goalFile = path.join(archived, matching[0]);
  const goalBytes = readEvidenceBytes(goalFile, 128 * 1024);
  const goal = parseEvidence(
    goalBytes.toString("utf8").split("\n\n# Goal Prompt")[0],
    goalFile,
  );
  const eventsFile = path.join(source, ".pi", "goals", "goal_events.jsonl");
  const eventsBytes = readEvidenceBytes(eventsFile, 128 * 1024);
  const events = eventsBytes
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  verifyGoalReadback(goal, events, proofs, observation.goal.id);
  return {
    goalId: goal.id,
    goalArchive: { path: goalFile, sha256: hash(goalBytes) },
    goalEvents: { path: eventsFile, sha256: hash(eventsBytes) },
    executions: proofs,
  };
}

// No authority to relabel earlier RPC observations or Task ledger rows. A
// failure returns a bounded blocker; it never fabricates a success receipt.
export function auditRpcAttempt(
  observationFile,
  runtimeRoot = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "teams-task-runtime-v1",
  ),
) {
  const file = path.resolve(observationFile);
  const bytes = readEvidenceBytes(file, 8 * 1024 * 1024);
  const basis = { path: file, sha256: hash(bytes) };
  try {
    const evidence = verifyNativeAttempt(
      parseEvidence(bytes.toString("utf8"), file),
      path.resolve(runtimeRoot),
      file,
    );
    return {
      schemaVersion: "teams-e2e-main-audit/1",
      decision: "accepted",
      fullE2EPassed: true,
      observation: basis,
      runtimeRoot: path.resolve(runtimeRoot),
      evidence,
    };
  } catch (error) {
    return {
      schemaVersion: "teams-e2e-main-audit/1",
      decision: "blocked",
      fullE2EPassed: false,
      observation: basis,
      runtimeRoot: path.resolve(runtimeRoot),
      reason: String(error.message ?? error).slice(0, 1000),
    };
  }
}

// An explicit new output is a separate audit artifact, never a rewrite of the
// original observation or an accepted Task's ledger/Goal state.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [observationFile, outputFile, runtimeRoot] = process.argv.slice(2);
  if (!observationFile || !outputFile) {
    console.error(
      "Usage: node audit-rpc-attempt.mjs OBSERVATION_FILE NEW_MAIN_AUDIT_FILE [RUNTIME_ROOT]",
    );
    process.exitCode = 2;
  } else {
    const audit = auditRpcAttempt(observationFile, runtimeRoot);
    fs.writeFileSync(
      path.resolve(outputFile),
      `${JSON.stringify(audit, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    console.log(
      JSON.stringify({
        output: path.resolve(outputFile),
        decision: audit.decision,
        fullE2EPassed: audit.fullE2EPassed,
      }),
    );
    process.exitCode = audit.fullE2EPassed ? 0 : 1;
  }
}
